"""Tests for the authenticated update-completion handshake endpoint.

Covers the frozen update-mode repair completion contract for
``POST /api/plaid/connections/<id>/update-complete/``: an authenticated,
CSRF-protected endpoint that owner-scopes the connection lookup before any
decrypt or provider work, decrypts the stored access token server-side,
verifies Item health through ``/item/get`` (reporting ``has_error`` without
exposing the provider error), and only after a healthy provider response
re-reads the connection under a row lock and transitions
``updating``/``error``/``revoked`` to ``active`` with ``sync_due=True`` and
the owned error cleared. An already-``active`` row is an idempotent
race-safe success that also guarantees ``sync_due=True``; ``disconnected``
is terminal and fails fixed-safe even when a disconnect raced the provider
call. The exact response is ``200 {connection_id, status: "active",
sync_pending: true}`` with no Item id, cursor, token, provider body, or
institution metadata. Only synthetic credentials and token packages are
used; the network boundary is never exercised.
"""

import json
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from plaid import ApiException
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from plaid_integration.gateway import (
    PLAID_UNAVAILABLE_DETAIL,
    PlaidGatewayError,
)
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    TransactionsUpdateStatus,
)
from plaid_integration.services import (
    UpdateCompleteResult,
    complete_connection_update,
)
from plaid_integration.tests_exchange import FakeItemGetResponse, gateway_for
from plaid_integration.tests_sync_run import (
    PLAID_API_SETTINGS,
    SYNTHETIC_ACCESS_TOKEN,
    _encrypt,
)
from plaid_integration.token_encryption import TokenKeyRing
from transactions.models import Transaction, TransactionSource, TransactionType

RAW_PROVIDER_BODY_MARKER = "RAW-PROVIDER-UPDATE-COMPLETE-BODY-MARKER"

_OTHER_KEY = Fernet.generate_key().decode()
_OTHER_RING = TokenKeyRing([("key-b", _OTHER_KEY)])


class _FakeItemApi:
    """Records the real SDK item request object without any network access."""

    def __init__(self, *, response=None, error=None):
        self.response = response if response is not None else FakeItemGetResponse()
        self.error = error
        self.calls = []

    def item_get(self, *, item_get_request, _request_timeout=None):
        self.calls.append((item_get_request, _request_timeout))
        if self.error is not None:
            raise self.error
        return self.response


class _FakeItemWithError:
    def __init__(self, error):
        self.institution_name = "Synthetic Error Bank"
        self.error = error


class _FakeItemGetResponseWithError:
    def __init__(self, error):
        self.item = _FakeItemWithError(error)


class ItemGetHealthGatewayTests(SimpleTestCase):
    def test_healthy_item_reports_has_error_false(self):
        fake_api = _FakeItemApi()

        result = gateway_for(fake_api).get_item(SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(len(fake_api.calls), 1)
        self.assertFalse(result.has_error)
        self.assertEqual(result.institution_name, "Synthetic Test Bank")

    def test_item_without_an_error_attribute_fails_closed(self):
        class _NoErrorItem:
            institution_name = "Plain Bank"

        class _NoErrorResponse:
            item = _NoErrorItem()

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(_FakeItemApi(response=_NoErrorResponse())).get_item(
                SYNTHETIC_ACCESS_TOKEN
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
        self.assertIsNone(raised.exception.__cause__)

    def test_item_with_a_non_provider_error_shape_fails_closed(self):
        class _BadErrorItem:
            institution_name = "Bad Error Bank"
            error = "not-an-error"

        class _BadErrorResponse:
            item = _BadErrorItem()

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(_FakeItemApi(response=_BadErrorResponse())).get_item(
                SYNTHETIC_ACCESS_TOKEN
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
        self.assertIsNone(raised.exception.__cause__)

    def test_item_carrying_a_provider_error_reports_has_error_true_without_exposing_it(
        self,
    ):
        provider_error = {
            "error_type": "ITEM_ERROR",
            "error_code": "ITEM_LOGIN_REQUIRED",
            "error_message": "synthetic-secret-leak",
            "request_id": "req-update-complete-leak",
        }
        fake_api = _FakeItemApi(response=_FakeItemGetResponseWithError(provider_error))

        result = gateway_for(fake_api).get_item(SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(len(fake_api.calls), 1)
        self.assertTrue(result.has_error)
        for forbidden in (
            "ITEM_LOGIN_REQUIRED",
            "synthetic-secret-leak",
            "req-update-complete-leak",
        ):
            self.assertNotIn(forbidden, str(result))
            self.assertNotIn(forbidden, repr(result))

    def test_provider_failure_still_raises_fixed_safe_error(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps(
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": "synthetic-secret-leak",
            }
        )

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(_FakeItemApi(error=error)).get_item(SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
        self.assertIsNone(raised.exception.__cause__)


@override_settings(**PLAID_API_SETTINGS)
class CompleteConnectionUpdateServiceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="update-complete-service@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-update-complete-service-00001",
            institution_name="Update Complete Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.UPDATING,
            sync_cursor="cursor-opaque-update-complete",
            transactions_update_status=TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
            last_synced_at=timezone.now(),
            last_sync_error="transaction-sync: fixed redacted reason",
        )

    def test_healthy_provider_transitions_repair_state_under_lock(self):
        fake_api = _FakeItemApi()
        original_package = self.connection.access_token_encrypted

        result = complete_connection_update(
            self.connection, gateway=gateway_for(fake_api)
        )

        self.assertFalse(result.blocked)
        self.assertEqual(result.connection_id, self.connection.pk)
        self.assertEqual(len(fake_api.calls), 1)
        request, _ = fake_api.calls[0]
        self.assertEqual(request.access_token, SYNTHETIC_ACCESS_TOKEN)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertTrue(self.connection.sync_due)
        self.assertEqual(self.connection.last_sync_error, "")
        self.assertEqual(
            self.connection.access_token_encrypted,
            original_package,
        )
        self.assertEqual(self.connection.encryption_key_id, "key-a")
        self.assertEqual(self.connection.sync_cursor, "cursor-opaque-update-complete")
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )

    def test_disconnect_racing_the_provider_call_never_resurrects(self):
        gateway = gateway_for(_FakeItemApi())
        original_get_item = gateway.get_item

        def get_item_and_disconnect(access_token):
            item = original_get_item(access_token)
            PlaidConnection.objects.filter(pk=self.connection.pk).update(
                status=PlaidConnectionStatus.DISCONNECTED
            )
            return item

        gateway.get_item = get_item_and_disconnect

        result = complete_connection_update(self.connection, gateway=gateway)

        self.assertTrue(result.blocked)
        self.assertIsNone(result.connection_id)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.DISCONNECTED)

    def test_disconnected_connection_with_healthy_provider_fails_fixed_safe(self):
        self.connection.status = PlaidConnectionStatus.DISCONNECTED
        self.connection.save(update_fields=["status"])

        result = complete_connection_update(
            self.connection, gateway=gateway_for(_FakeItemApi())
        )

        self.assertTrue(result.blocked)
        self.assertIsNone(result.connection_id)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.DISCONNECTED)
        self.assertFalse(self.connection.sync_due)

    def test_provider_error_on_the_item_fails_fixed_safe_without_mutation(self):
        self.connection.status = PlaidConnectionStatus.UPDATING
        self.connection.sync_due = False
        self.connection.save(update_fields=["status", "sync_due"])
        fake_api = _FakeItemApi(
            response=_FakeItemGetResponseWithError(
                {"error_code": "ITEM_LOGIN_REQUIRED"}
            )
        )

        result = complete_connection_update(
            self.connection, gateway=gateway_for(fake_api)
        )

        self.assertTrue(result.blocked)
        self.assertIsNone(result.connection_id)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.UPDATING)
        self.assertFalse(self.connection.sync_due)
        self.assertNotEqual(self.connection.last_sync_error, "")

    def test_provider_transport_failure_fails_fixed_safe_without_mutation(self):
        self.connection.status = PlaidConnectionStatus.UPDATING
        self.connection.sync_due = False
        self.connection.save(update_fields=["status", "sync_due"])
        fake_api = _FakeItemApi(error=TimeoutError("Connection timed out"))

        result = complete_connection_update(
            self.connection, gateway=gateway_for(fake_api)
        )

        self.assertTrue(result.blocked)
        self.assertIsNone(result.connection_id)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.UPDATING)
        self.assertFalse(self.connection.sync_due)

    def test_undecryptable_token_fails_fixed_safe_without_provider_call(self):
        wrong_package, _ = _OTHER_RING.encrypt(SYNTHETIC_ACCESS_TOKEN.encode())
        self.connection.access_token_encrypted = wrong_package
        self.connection.save(update_fields=["access_token_encrypted"])
        fake_api = _FakeItemApi()

        result = complete_connection_update(
            self.connection, gateway=gateway_for(fake_api)
        )

        self.assertTrue(result.blocked)
        self.assertIsNone(result.connection_id)
        self.assertEqual(len(fake_api.calls), 0)

    def test_gateway_factory_failure_fails_fixed_safe_without_mutation(self):
        self.connection.status = PlaidConnectionStatus.UPDATING
        self.connection.sync_due = False
        self.connection.save(update_fields=["status", "sync_due"])

        with patch(
            "plaid_integration.services.PlaidGateway.from_settings",
            side_effect=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL),
        ):
            result = complete_connection_update(self.connection)

        self.assertTrue(result.blocked)
        self.assertIsNone(result.connection_id)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.UPDATING)
        self.assertFalse(self.connection.sync_due)
        self.assertEqual(
            self.connection.last_sync_error,
            "transaction-sync: fixed redacted reason",
        )

    def test_delete_racing_the_provider_call_returns_blocked_without_resurrecting(
        self,
    ):
        gateway = gateway_for(_FakeItemApi())
        original_get_item = gateway.get_item

        def get_item_and_delete(access_token):
            item = original_get_item(access_token)
            PlaidConnection.objects.filter(pk=self.connection.pk).delete()
            return item

        gateway.get_item = get_item_and_delete

        result = complete_connection_update(self.connection, gateway=gateway)

        self.assertTrue(result.blocked)
        self.assertIsNone(result.connection_id)
        self.assertFalse(PlaidConnection.objects.filter(pk=self.connection.pk).exists())


@override_settings(**PLAID_API_SETTINGS)
class ConnectionUpdateCompleteAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="update-complete-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="update-complete-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.checking = Account.objects.create(
            user=cls.user,
            name="Update Complete Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-update-complete-00001",
            institution_name="Update Complete Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.UPDATING,
            sync_cursor="cursor-opaque-update-complete",
            transactions_update_status=TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
            last_synced_at=timezone.now(),
            last_sync_error="transaction-sync: fixed redacted reason",
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-update-complete-00002",
            institution_name="Other Update Complete Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )
        cls.link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.checking,
            plaid_account_id="plaid-account-update-complete-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1234",
            anchor_provider_current_balance=Decimal("500.00"),
            anchor_applied_at=timezone.now(),
        )
        cls.category = Category.objects.create(
            user=cls.user,
            name="Update Complete Salary",
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
            plaid_transaction_id="plaid-tx-update-complete-0001",
        )

    def setUp(self):
        self.csrf_client = APIClient(enforce_csrf_checks=True)
        self.csrf_client.force_login(self.user)
        csrf_response = self.csrf_client.get(reverse("auth-csrf"))
        self.csrf_token = csrf_response.cookies["csrftoken"].value

    def update_complete_url(self, connection_pk):
        return reverse("plaid-connection-update-complete", args=[connection_pk])

    def post_update_complete(
        self, connection_pk, client=None, *, csrf_token=None, **extra
    ):
        client = client if client is not None else self.csrf_client
        return client.post(
            self.update_complete_url(connection_pk),
            data={},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token if csrf_token is not None else self.csrf_token,
            **extra,
        )

    def patched_gateway(self, fake_api):
        return patch(
            "plaid_integration.services.PlaidGateway.from_settings",
            return_value=gateway_for(fake_api),
        )

    def snapshot_rows(self):
        return {
            "connections": list(PlaidConnection.objects.order_by("pk").values()),
            "links": list(PlaidAccountLink.objects.order_by("pk").values()),
            "transactions": list(Transaction.objects.order_by("pk").values()),
            "accounts": list(Account.objects.order_by("pk").values()),
            "categories": list(Category.objects.order_by("pk").values()),
        }

    def test_authenticated_completion_returns_exact_response_and_mutates_only_lifecycle(
        self,
    ):
        fake_api = _FakeItemApi()
        original_package = self.connection.access_token_encrypted

        with self.patched_gateway(fake_api):
            response = self.post_update_complete(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data,
            {
                "connection_id": self.connection.pk,
                "status": "active",
                "sync_pending": True,
            },
        )
        self.assertEqual(len(fake_api.calls), 1)
        request, _ = fake_api.calls[0]
        self.assertEqual(request.access_token, SYNTHETIC_ACCESS_TOKEN)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertTrue(self.connection.sync_due)
        self.assertEqual(self.connection.last_sync_error, "")
        self.assertEqual(
            self.connection.access_token_encrypted,
            original_package,
        )
        self.assertEqual(self.connection.encryption_key_id, "key-a")
        self.assertEqual(self.connection.sync_cursor, "cursor-opaque-update-complete")
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        self.assertIsNotNone(self.connection.last_synced_at)

    def test_response_contains_exactly_the_frozen_fields_and_no_leaks(self):
        fake_api = _FakeItemApi()

        with self.patched_gateway(fake_api):
            response = self.post_update_complete(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            set(response.data.keys()),
            {"connection_id", "status", "sync_pending"},
        )
        raw = response.content.decode()
        for forbidden in (
            "access_token",
            "public_token",
            "item_id",
            "cursor-opaque-update-complete",
            "Update Complete Bank",
            "client_id",
            "secret",
            SYNTHETIC_ACCESS_TOKEN,
        ):
            self.assertNotIn(forbidden, raw)

    def test_every_repair_status_becomes_active_with_sync_due(self):
        for label, status_value in (
            ("updating", PlaidConnectionStatus.UPDATING),
            ("error", PlaidConnectionStatus.ERROR),
            ("revoked", PlaidConnectionStatus.REVOKED),
        ):
            with self.subTest(status=status_value):
                connection = PlaidConnection.objects.create(
                    user=self.user,
                    item_id=f"item-sandbox-update-complete-status-{label}",
                    institution_name="Repair Status Bank",
                    access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
                    encryption_key_id="key-a",
                    status=status_value,
                    last_sync_error="transaction-sync: stale repair reason",
                )
                fake_api = _FakeItemApi()

                with self.patched_gateway(fake_api):
                    response = self.post_update_complete(connection.pk)

                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.assertEqual(
                    response.data,
                    {
                        "connection_id": connection.pk,
                        "status": "active",
                        "sync_pending": True,
                    },
                )
                connection.refresh_from_db()
                self.assertEqual(connection.status, PlaidConnectionStatus.ACTIVE)
                self.assertTrue(connection.sync_due)
                self.assertEqual(connection.last_sync_error, "")

    def test_already_active_row_is_an_idempotent_race_safe_success(self):
        connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-update-complete-already-active",
            institution_name="Already Active Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.ACTIVE,
            sync_due=False,
            sync_cursor="cursor-opaque-already-active",
            transactions_update_status=TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )
        fake_api = _FakeItemApi()

        with self.patched_gateway(fake_api):
            response = self.post_update_complete(connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data,
            {
                "connection_id": connection.pk,
                "status": "active",
                "sync_pending": True,
            },
        )
        connection.refresh_from_db()
        self.assertEqual(connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertTrue(connection.sync_due)
        self.assertEqual(connection.sync_cursor, "cursor-opaque-already-active")
        self.assertEqual(
            connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )

    def test_disconnected_connection_with_healthy_provider_fails_fixed_safe(self):
        disconnected = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-update-complete-disconnected",
            institution_name="Disconnected Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.DISCONNECTED,
        )
        before = self.snapshot_rows()

        with self.patched_gateway(_FakeItemApi()):
            response = self.post_update_complete(disconnected.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        disconnected.refresh_from_db()
        self.assertEqual(disconnected.status, PlaidConnectionStatus.DISCONNECTED)
        self.assertFalse(disconnected.sync_due)
        self.assertEqual(self.snapshot_rows(), before)

    def test_provider_item_error_returns_fixed_503_with_zero_mutation(self):
        before = self.snapshot_rows()
        fake_api = _FakeItemApi(
            response=_FakeItemGetResponseWithError(
                {
                    "error_type": "ITEM_ERROR",
                    "error_code": "ITEM_LOGIN_REQUIRED",
                    "error_message": f"{RAW_PROVIDER_BODY_MARKER} synthetic-secret-test",
                }
            )
        )

        with self.patched_gateway(fake_api):
            response = self.post_update_complete(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        raw = response.content.decode()
        for forbidden in (
            RAW_PROVIDER_BODY_MARKER,
            "ITEM_LOGIN_REQUIRED",
            "synthetic-secret-test",
        ):
            self.assertNotIn(forbidden, raw)
        self.assertEqual(self.snapshot_rows(), before)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.UPDATING)
        self.assertEqual(
            self.connection.last_sync_error, "transaction-sync: fixed redacted reason"
        )

    def test_provider_failure_returns_fixed_503_without_leaks_or_mutation(self):
        before = self.snapshot_rows()
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps(
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": (
                    f"{RAW_PROVIDER_BODY_MARKER} synthetic-secret-test "
                    "client-id-test link-sandbox-leak"
                ),
                "request_id": "req-update-complete-leak",
            }
        )

        with self.patched_gateway(_FakeItemApi(error=error)):
            response = self.post_update_complete(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        raw = response.content.decode()
        for forbidden in (
            RAW_PROVIDER_BODY_MARKER,
            "synthetic-secret-test",
            "client-id-test",
            "link-sandbox-leak",
            "req-update-complete-leak",
        ):
            self.assertNotIn(forbidden, raw)
        self.assertEqual(self.snapshot_rows(), before)

    def test_cleared_or_undecryptable_token_returns_fixed_503_without_call_or_write(
        self,
    ):
        wrong_key_package, _ = _OTHER_RING.encrypt(SYNTHETIC_ACCESS_TOKEN.encode())
        cases = [
            ("cleared", {"access_token_encrypted": None, "encryption_key_id": None}),
            (
                "wrong-key",
                {
                    "access_token_encrypted": wrong_key_package,
                    "encryption_key_id": "key-a",
                },
            ),
            (
                "malformed",
                {
                    "access_token_encrypted": "no-separator",
                    "encryption_key_id": "key-a",
                },
            ),
            (
                "undecryptable",
                {
                    "access_token_encrypted": "key-a:not-a-fernet-token",
                    "encryption_key_id": "key-a",
                },
            ),
        ]
        for label, fields in cases:
            with self.subTest(label=label):
                connection = PlaidConnection.objects.create(
                    user=self.user,
                    item_id=f"item-sandbox-update-complete-bad-{label}",
                    institution_name="Bad Token Bank",
                    status=PlaidConnectionStatus.UPDATING,
                    **fields,
                )
                before = self.snapshot_rows()
                with self.patched_gateway(_FakeItemApi()) as from_settings:
                    response = self.post_update_complete(connection.pk)

                self.assertEqual(
                    response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE
                )
                self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
                from_settings.assert_not_called()
                self.assertEqual(self.snapshot_rows(), before)

    def test_missing_key_ring_returns_fixed_503_without_provider_call_or_write(self):
        before = self.snapshot_rows()
        with (
            override_settings(PLAID_TOKEN_RING=None),
            self.patched_gateway(_FakeItemApi()) as from_settings,
        ):
            response = self.post_update_complete(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_gateway_factory_failure_returns_fixed_503_without_mutation(self):
        before = self.snapshot_rows()
        with patch(
            "plaid_integration.services.PlaidGateway.from_settings",
            side_effect=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL),
        ):
            response = self.post_update_complete(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        self.assertEqual(self.snapshot_rows(), before)

    def test_disabled_integration_returns_fixed_503_without_any_work_or_write(self):
        before = self.snapshot_rows()
        with (
            override_settings(PLAID_ENABLED=False),
            patch("plaid_integration.views.complete_connection_update") as complete,
        ):
            response = self.post_update_complete(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        complete.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_anonymous_post_returns_401_without_decrypt_or_provider_call(self):
        with patch("plaid_integration.views.complete_connection_update") as complete:
            response = self.client.post(self.update_complete_url(self.connection.pk))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        complete.assert_not_called()

    def test_authenticated_post_without_csrf_returns_403_without_service_call(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        with patch("plaid_integration.views.complete_connection_update") as complete:
            response = csrf_client.post(self.update_complete_url(self.connection.pk))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        complete.assert_not_called()

    def test_missing_and_foreign_connection_ids_return_indistinguishable_404(self):
        with patch("plaid_integration.views.complete_connection_update") as complete:
            missing = self.post_update_complete(999999)
            foreign = self.post_update_complete(self.other_connection.pk)

        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            missing.json(),
            {"detail": "No PlaidConnection matches the given query."},
        )
        self.assertEqual(missing.json(), foreign.json())
        complete.assert_not_called()

    def test_unsupported_methods_return_405_without_side_effects(self):
        before = self.snapshot_rows()
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.csrf_client, method)(
                    self.update_complete_url(self.connection.pk),
                    HTTP_X_CSRFTOKEN=self.csrf_token,
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        self.assertEqual(self.snapshot_rows(), before)

    def test_unexpected_programmer_error_propagates(self):
        fake_api = _FakeItemApi(error=TypeError("programmer defect"))
        raising_client = APIClient(raise_request_exception=False)
        raising_client.force_login(self.user)
        csrf_response = raising_client.get(reverse("auth-csrf"))
        csrf_token = csrf_response.cookies["csrftoken"].value

        with self.patched_gateway(fake_api):
            response = raising_client.post(
                self.update_complete_url(self.connection.pk),
                data={},
                format="json",
                HTTP_X_CSRFTOKEN=csrf_token,
            )

        self.assertEqual(response.status_code, status.HTTP_500_INTERNAL_SERVER_ERROR)


class UpdateCompleteResultSafetyTests(SimpleTestCase):
    def test_blocked_result_carries_no_connection_id(self):
        result = UpdateCompleteResult(blocked=True)

        self.assertIsNone(result.connection_id)
        self.assertTrue(result.blocked)

    def test_success_result_carries_only_the_owned_connection_id(self):
        result = UpdateCompleteResult(connection_id=7)

        self.assertEqual(result.connection_id, 7)
        self.assertFalse(result.blocked)
