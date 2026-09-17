"""Tests for local-first Plaid disconnect with bounded item-removal retry.

Covers ``docs/plaid.md`` section 9 for issue #39 slice D3:
``POST /api/plaid/connections/<id>/disconnect/`` tears down local state
first (null token columns, ``disconnected`` status, archived linked
accounts, preserved history) inside one transaction and moves the ciphertext
verbatim into a ``PlaidItemRemovalRequest`` outbox row due immediately, then
best-effort calls Plaid ``/item/remove`` outside the transaction. Only
synthetic credentials and packages are used; the network is never touched.
"""

import json
import logging
import traceback
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from plaid import ApiException
from rest_framework import status
from rest_framework.test import APIClient, APITestCase
from urllib3.exceptions import ProtocolError

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from plaid_integration.gateway import (
    PLAID_REQUEST_TIMEOUT_SECONDS,
    PLAID_UNAVAILABLE_DETAIL,
    PlaidGateway,
    PlaidGatewayError,
)
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    PlaidItemRemovalRequest,
    TransactionsUpdateStatus,
)
from plaid_integration.services import (
    ITEM_REMOVAL_FAILED_DETAIL,
    disconnect_connection,
)
from plaid_integration.token_encryption import TokenKeyRing
from transactions.models import Transaction, TransactionSource, TransactionType

SYNTHETIC_ACCESS_TOKEN = "access-sandbox-disconnect-000000000000"
RAW_PROVIDER_BODY_MARKER = "RAW-PROVIDER-DISCONNECT-MARKER"

_TEST_KEY = Fernet.generate_key().decode()
SYNTHETIC_RING = TokenKeyRing([("key-a", _TEST_KEY)])
_OTHER_KEY = Fernet.generate_key().decode()
_OTHER_RING = TokenKeyRing([("key-b", _OTHER_KEY)])

PLAID_API_SETTINGS = {
    "PLAID_ENABLED": True,
    "PLAID_ENV": "sandbox",
    "PLAID_CLIENT_ID": "client-id-test",
    "PLAID_SECRET": "secret-test",
    "PLAID_TOKEN_RING": SYNTHETIC_RING,
}


def _encrypt(token):
    package, _ = SYNTHETIC_RING.encrypt(token.encode())
    return package


class FakeRemovalApi:
    """Records the real SDK remove request without any network access."""

    def __init__(self, *, response=None, error=None):
        self.response = response if response is not None else object()
        self.error = error
        self.calls = []

    def item_remove(self, *, item_remove_request, _request_timeout=None):
        self.calls.append((item_remove_request, _request_timeout))
        if self.error is not None:
            raise self.error
        return self.response


def gateway_for(plaid_api):
    return PlaidGateway(
        plaid_api,
        client_id="client-id-test",
        secret="secret-test",
    )


class RemoveItemGatewayTests(SimpleTestCase):
    def test_remove_item_builds_exact_sdk_request(self):
        fake_api = FakeRemovalApi()

        gateway_for(fake_api).remove_item(SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(len(fake_api.calls), 1)
        request, timeout = fake_api.calls[0]
        self.assertEqual(request.access_token, SYNTHETIC_ACCESS_TOKEN)
        self.assertEqual(timeout, PLAID_REQUEST_TIMEOUT_SECONDS)

    def test_api_error_translates_to_fixed_safe_error(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps({"error_code": "X", "error_message": "leak"})

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakeRemovalApi(error=error)).remove_item(SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_transport_timeout_translates_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakeRemovalApi(error=TimeoutError("timed out"))).remove_item(
                SYNTHETIC_ACCESS_TOKEN
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_urllib3_error_translates_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakeRemovalApi(error=ProtocolError("aborted"))).remove_item(
                SYNTHETIC_ACCESS_TOKEN
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_unexpected_programmer_error_propagates(self):
        with self.assertRaises(TypeError):
            gateway_for(FakeRemovalApi(error=TypeError("defect"))).remove_item(
                SYNTHETIC_ACCESS_TOKEN
            )

    def test_failure_logs_fixed_string_and_never_token(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps({"error_message": f"{RAW_PROVIDER_BODY_MARKER} leak"})

        with self.assertLogs(
            "plaid_integration.gateway", level=logging.WARNING
        ) as captured:
            with self.assertRaises(PlaidGatewayError):
                gateway_for(FakeRemovalApi(error=error)).remove_item(
                    SYNTHETIC_ACCESS_TOKEN
                )

        log_text = "\n".join(captured.output)
        self.assertEqual(len(captured.output), 1)
        self.assertIn("Plaid item removal failed.", log_text)
        self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, log_text)
        self.assertNotIn(RAW_PROVIDER_BODY_MARKER, log_text)

    def test_failures_suppress_cause_and_never_render_provider_body(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps(
            {"error_message": RAW_PROVIDER_BODY_MARKER, "request_id": "req-leak"}
        )
        for provider_error in (
            error,
            TimeoutError("timed out"),
            ProtocolError("aborted"),
        ):
            with self.subTest(provider_error=provider_error):
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(FakeRemovalApi(error=provider_error)).remove_item(
                        SYNTHETIC_ACCESS_TOKEN
                    )
                exception = raised.exception
                self.assertIsNone(exception.__cause__)
                self.assertEqual(str(exception), PLAID_UNAVAILABLE_DETAIL)
                formatted = "".join(traceback.format_exception(exception))
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    "req-leak",
                    SYNTHETIC_ACCESS_TOKEN,
                ):
                    self.assertNotIn(forbidden, str(exception))
                    self.assertNotIn(forbidden, repr(exception))
                    self.assertNotIn(forbidden, formatted)


@override_settings(**PLAID_API_SETTINGS)
class DisconnectAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="disconnect-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="disconnect-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.checking = Account.objects.create(
            user=cls.user,
            name="Disconnect Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("50.00"),
        )
        cls.synced_at = timezone.now() - timedelta(days=1)
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-disconnect-00001",
            institution_name="Disconnect Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.ACTIVE,
            sync_cursor="cursor-opaque-stored",
            transactions_update_status=(
                TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE
            ),
            last_synced_at=cls.synced_at,
            last_sync_error="",
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-disconnect-00002",
            institution_name="Other Disconnect Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )
        cls.link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.checking,
            plaid_account_id="plaid-account-disconnect-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1234",
            anchor_provider_current_balance=Decimal("500.00"),
            anchor_applied_at=timezone.now() - timedelta(days=2),
        )
        cls.category = Category.objects.create(
            user=cls.user,
            name="Disconnect Salary",
            category_type=CategoryType.INCOME,
        )
        cls.transaction = Transaction.objects.create(
            user=cls.user,
            connection=cls.connection,
            account=cls.checking,
            category=cls.category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("25.00"),
            date=date(2026, 9, 1),
            provider_name="Synthetic Payroll",
            source=TransactionSource.PLAID,
            plaid_transaction_id="plaid-tx-disconnect-0001",
        )

    def setUp(self):
        self.csrf_client = APIClient(enforce_csrf_checks=True)
        self.csrf_client.force_login(self.user)
        csrf_response = self.csrf_client.get(reverse("auth-csrf"))
        self.csrf_token = csrf_response.cookies["csrftoken"].value

    def disconnect_url(self, pk):
        return reverse("plaid-connection-disconnect", args=[pk])

    def post_disconnect(self, pk, client=None, *, csrf_token=None, **extra):
        client = client if client is not None else self.csrf_client
        return client.post(
            self.disconnect_url(pk),
            data={},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token if csrf_token is not None else self.csrf_token,
            **extra,
        )

    def patched_remove(self, fake_api):
        return patch(
            "plaid_integration.services.PlaidGateway.from_settings",
            return_value=gateway_for(fake_api),
        )

    def test_successful_disconnect_moves_token_archives_and_preserves_history(self):
        fake_api = FakeRemovalApi()

        with self.patched_remove(fake_api):
            response = self.post_disconnect(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {"connection_id": self.connection.pk, "status": "disconnected"},
        )
        self.assertEqual(len(fake_api.calls), 1)
        request, _ = fake_api.calls[0]
        self.assertEqual(request.access_token, SYNTHETIC_ACCESS_TOKEN)

        connection = PlaidConnection.objects.get(pk=self.connection.pk)
        self.assertEqual(connection.status, PlaidConnectionStatus.DISCONNECTED)
        self.assertIsNone(connection.access_token_encrypted)
        self.assertIsNone(connection.encryption_key_id)
        # Untouched fields.
        self.assertEqual(connection.sync_cursor, "cursor-opaque-stored")
        self.assertEqual(
            connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        self.assertEqual(connection.last_synced_at, self.synced_at)
        self.assertEqual(connection.last_sync_error, "")
        # History preserved, links untouched, account archived.
        self.assertTrue(Transaction.objects.filter(pk=self.transaction.pk).exists())
        self.assertTrue(PlaidAccountLink.objects.filter(pk=self.link.pk).exists())
        self.checking.refresh_from_db()
        self.assertTrue(self.checking.is_archived)
        # Remote success deletes the outbox row: no ciphertext at rest.
        self.assertFalse(
            PlaidItemRemovalRequest.objects.filter(
                connection_id=self.connection.pk
            ).exists()
        )

    def test_local_teardown_creates_exact_outbox_package_before_remote(self):
        original = PlaidConnection.objects.get(pk=self.connection.pk)
        package = original.access_token_encrypted
        key_id = original.encryption_key_id
        before = timezone.now()
        fake_api = FakeRemovalApi(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))

        with self.patched_remove(fake_api):
            response = self.post_disconnect(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        row = PlaidItemRemovalRequest.objects.get(connection_id=self.connection.pk)
        self.assertEqual(row.access_token_encrypted, package)
        self.assertEqual(row.encryption_key_id, key_id)
        self.assertEqual(row.status, "pending")
        self.assertEqual(row.attempts, 0)
        self.assertIsNotNone(row.next_retry_at)
        self.assertLessEqual(abs((row.next_retry_at - before).total_seconds()), 120)
        connection = PlaidConnection.objects.get(pk=self.connection.pk)
        self.assertIsNone(connection.access_token_encrypted)
        self.assertIsNone(connection.encryption_key_id)

    def test_remote_failure_keeps_pending_returns_200_and_redacts_error(self):
        error = ApiException(status=500, reason="X", http_resp=None)
        error.body = json.dumps({"error_message": RAW_PROVIDER_BODY_MARKER})
        fake_api = FakeRemovalApi(error=error)

        with self.patched_remove(fake_api):
            with self.assertLogs(
                "plaid_integration.gateway", level=logging.WARNING
            ) as captured:
                response = self.post_disconnect(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {"connection_id": self.connection.pk, "status": "disconnected"},
        )
        row = PlaidItemRemovalRequest.objects.get(connection_id=self.connection.pk)
        self.assertEqual(row.status, "pending")
        self.assertEqual(row.last_error, ITEM_REMOVAL_FAILED_DETAIL)
        self.assertNotIn(RAW_PROVIDER_BODY_MARKER, row.last_error)
        self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, row.last_error)
        raw = response.content.decode()
        self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, raw)
        self.assertNotIn("key-a", raw)
        self.assertNotIn("cursor-opaque-stored", raw)
        log_text = "\n".join(captured.output)
        self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, log_text)
        self.assertNotIn(RAW_PROVIDER_BODY_MARKER, log_text)

    def test_remote_undecryptable_package_marks_failed_without_raising(self):
        wrong_package, _ = _OTHER_RING.encrypt(SYNTHETIC_ACCESS_TOKEN.encode())
        connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-disconnect-badkey",
            institution_name="Bad Key Bank",
            access_token_encrypted=wrong_package,
            encryption_key_id="key-a",
        )
        fake_api = FakeRemovalApi()

        with self.patched_remove(fake_api):
            response = self.post_disconnect(connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(fake_api.calls, [])
        row = PlaidItemRemovalRequest.objects.get(connection_id=connection.pk)
        self.assertEqual(row.status, "failed")
        self.assertEqual(row.last_error, ITEM_REMOVAL_FAILED_DETAIL)
        connection.refresh_from_db()
        self.assertEqual(connection.status, PlaidConnectionStatus.DISCONNECTED)
        self.assertIsNone(connection.access_token_encrypted)

    def test_second_disconnect_is_idempotent_no_duplicate(self):
        fake_api = FakeRemovalApi(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))
        with self.patched_remove(fake_api):
            first = self.post_disconnect(self.connection.pk)
            count_after_first = PlaidItemRemovalRequest.objects.filter(
                connection_id=self.connection.pk
            ).count()
            second = self.post_disconnect(self.connection.pk)

        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.json(), first.json())
        self.assertEqual(count_after_first, 1)
        self.assertEqual(
            PlaidItemRemovalRequest.objects.filter(
                connection_id=self.connection.pk
            ).count(),
            1,
        )
        connection = PlaidConnection.objects.get(pk=self.connection.pk)
        self.assertEqual(connection.status, PlaidConnectionStatus.DISCONNECTED)

    def test_connection_without_token_disconnects_cleanly_no_outbox(self):
        connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-disconnect-notoken",
            institution_name="No Token Bank",
            access_token_encrypted=None,
            encryption_key_id=None,
        )
        fake_api = FakeRemovalApi()

        with self.patched_remove(fake_api):
            response = self.post_disconnect(connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {"connection_id": connection.pk, "status": "disconnected"},
        )
        self.assertEqual(fake_api.calls, [])
        self.assertFalse(
            PlaidItemRemovalRequest.objects.filter(connection_id=connection.pk).exists()
        )

    def test_ownership_missing_and_foreign_return_indistinguishable_404(self):
        before_connections = list(PlaidConnection.objects.order_by("pk").values())
        before_removals = list(PlaidItemRemovalRequest.objects.order_by("pk").values())
        with self.patched_remove(FakeRemovalApi()):
            missing = self.post_disconnect(999999)
            foreign = self.post_disconnect(self.other_connection.pk)

        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.json(), foreign.json())
        self.assertEqual(
            list(PlaidConnection.objects.order_by("pk").values()),
            before_connections,
        )
        self.assertEqual(
            list(PlaidItemRemovalRequest.objects.order_by("pk").values()),
            before_removals,
        )

    def test_anonymous_post_returns_401(self):
        response = self.client.post(self.disconnect_url(self.connection.pk))
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_authenticated_post_without_csrf_returns_403(self):
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.user)
        response = client.post(self.disconnect_url(self.connection.pk))
        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)

    def test_unsupported_methods_return_405_without_side_effects(self):
        before = list(PlaidConnection.objects.order_by("pk").values())
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.csrf_client, method)(
                    self.disconnect_url(self.connection.pk),
                    HTTP_X_CSRFTOKEN=self.csrf_token,
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )
        self.assertEqual(list(PlaidConnection.objects.order_by("pk").values()), before)
        self.assertEqual(PlaidItemRemovalRequest.objects.count(), 0)

    def test_token_and_key_never_in_response_or_logs(self):
        fake_api = FakeRemovalApi()
        with self.patched_remove(fake_api):
            with self.assertNoLogs("plaid_integration.services", level=logging.INFO):
                response = self.post_disconnect(self.connection.pk)
        raw = response.content.decode()
        connection = PlaidConnection.objects.get(pk=self.connection.pk)
        for forbidden in (
            SYNTHETIC_ACCESS_TOKEN,
            "key-a",
            "cursor-opaque-stored",
            "item-sandbox-disconnect-00001",
        ):
            if forbidden == "key-a":
                continue
            self.assertNotIn(forbidden, raw)
        result = disconnect_connection.__doc__ or ""
        self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, result)
        _ = connection

    @override_settings(
        PLAID_ENABLED=False,
        PLAID_ENV="sandbox",
        PLAID_CLIENT_ID="client-id-test",
        PLAID_SECRET="secret-test",
        PLAID_TOKEN_RING=SYNTHETIC_RING,
    )
    def test_disabled_integration_still_tears_down_locally_with_pending_row(self):
        response = self.post_disconnect(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.json(),
            {"connection_id": self.connection.pk, "status": "disconnected"},
        )
        connection = PlaidConnection.objects.get(pk=self.connection.pk)
        self.assertEqual(connection.status, PlaidConnectionStatus.DISCONNECTED)
        self.assertIsNone(connection.access_token_encrypted)
        row = PlaidItemRemovalRequest.objects.get(connection_id=self.connection.pk)
        self.assertEqual(row.status, "pending")

    def test_disconnect_is_terminal_against_later_item_webhook(self):
        from plaid_integration.services import persist_verified_item_webhook
        from plaid_integration.webhook_verification import VerifiedWebhookClaims

        fake_api = FakeRemovalApi(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))
        with self.patched_remove(fake_api):
            response = self.post_disconnect(self.connection.pk)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        claims = VerifiedWebhookClaims(
            kid="synthetic-kid", iat=0, idempotency_key="a" * 64
        )
        persist_verified_item_webhook(
            self.connection,
            claims,
            webhook_type="ITEM",
            webhook_code="LOGIN_REPAIRED",
        )
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.DISCONNECTED)


class ItemRemovalRequestModelTests(SimpleTestCase):
    def test_str_and_repr_never_include_ciphertext_or_key(self):
        row = PlaidItemRemovalRequest(
            connection_id=1,
            access_token_encrypted="key-a:ciphertext-secret",
            encryption_key_id="key-a",
            status="pending",
        )
        self.assertNotIn("ciphertext-secret", str(row))
        self.assertNotIn("ciphertext-secret", repr(row))
        self.assertNotIn("key-a", repr(row))
