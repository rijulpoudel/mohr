"""Tests for the connection-scoped update-mode Link token endpoint.

Covers the frozen ``docs/plaid.md`` section 3 update-mode boundary for issue
#39 slice D1: ``POST /api/plaid/connections/<id>/link-token/`` is an
authenticated, CSRF-protected endpoint that owner-scopes the connection
lookup before decrypting or calling Plaid, decrypts the stored access token
with the configured key ring, calls a narrow update-mode gateway method that
builds the official SDK request WITHOUT ``products`` or a Transactions-days
request, returns exactly ``200 {link_token, expiration}`` with no exchange
handle, and never mutates connection, link, cursor, or transaction state.
Only synthetic credentials and token packages are used; the network boundary
is never exercised.
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
from plaid.model.country_code import CountryCode
from rest_framework import status
from rest_framework.test import APIClient, APITestCase
from urllib3.exceptions import ProtocolError

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from plaid_integration.gateway import (
    PLAID_REQUEST_TIMEOUT_SECONDS,
    PLAID_UNAVAILABLE_DETAIL,
    PlaidGatewayError,
)
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    PlaidExchangeHandle,
    TransactionsUpdateStatus,
)
from plaid_integration.services import plaid_client_user_id
from plaid_integration.tests_link_token import (
    FakeLinkTokenResponse,
    FakePlaidApi,
    gateway_for,
)
from plaid_integration.tests_sync_run import (
    PLAID_API_SETTINGS,
    SYNTHETIC_ACCESS_TOKEN,
    _encrypt,
)
from plaid_integration.token_encryption import TokenKeyRing
from transactions.models import Transaction, TransactionSource, TransactionType

RAW_PROVIDER_BODY_MARKER = "RAW-PROVIDER-UPDATE-BODY-MARKER"

_OTHER_KEY = Fernet.generate_key().decode()
_OTHER_RING = TokenKeyRing([("key-b", _OTHER_KEY)])


class ConnectionLinkTokenGatewayTests(SimpleTestCase):
    def test_create_update_link_token_builds_exact_sdk_request(self):
        fake_api = FakePlaidApi()

        gateway_for(fake_api).create_update_link_token(
            "opaque-client-user-id", SYNTHETIC_ACCESS_TOKEN
        )

        self.assertEqual(len(fake_api.calls), 1)
        request, timeout = fake_api.calls[0]
        self.assertEqual(request.client_name, "Mohr")
        self.assertEqual(request.language, "en")
        self.assertEqual(request.country_codes, [CountryCode("US")])
        self.assertEqual(request.user.client_user_id, "opaque-client-user-id")
        self.assertEqual(request.access_token, SYNTHETIC_ACCESS_TOKEN)
        self.assertFalse(hasattr(request, "products"))
        self.assertFalse(hasattr(request, "transactions"))
        self.assertIsInstance(timeout, (int, float))
        self.assertGreater(timeout, 0)
        self.assertEqual(timeout, PLAID_REQUEST_TIMEOUT_SECONDS)

    def test_api_error_translates_to_fixed_safe_error(self):
        error = ApiException(status=400, reason="Invalid Input", http_resp=None)
        error.body = json.dumps(
            {"error_code": "INVALID_SECRET", "error_message": "synthetic-leak"}
        )

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakePlaidApi(error=error)).create_update_link_token(
                "opaque-client-user-id", SYNTHETIC_ACCESS_TOKEN
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_transport_timeout_translates_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(
                FakePlaidApi(error=TimeoutError("Connection timed out"))
            ).create_update_link_token("opaque-client-user-id", SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_urllib3_transport_error_translates_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(
                FakePlaidApi(error=ProtocolError("Connection aborted."))
            ).create_update_link_token("opaque-client-user-id", SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_unexpected_programmer_error_propagates(self):
        with self.assertRaises(TypeError) as raised:
            gateway_for(
                FakePlaidApi(error=TypeError("programmer defect"))
            ).create_update_link_token("opaque-client-user-id", SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(str(raised.exception), "programmer defect")

    def test_failure_logs_and_error_never_echo_sdk_details(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps(
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": (
                    "synthetic-secret-test client-id-test link-sandbox-leak "
                    "opaque-client-user-id"
                ),
            }
        )

        with self.assertLogs(
            "plaid_integration.gateway", level=logging.WARNING
        ) as captured:
            with self.assertRaises(PlaidGatewayError):
                gateway_for(FakePlaidApi(error=error)).create_update_link_token(
                    "opaque-client-user-id", SYNTHETIC_ACCESS_TOKEN
                )

        log_text = "\n".join(captured.output)
        self.assertEqual(len(captured.output), 1)
        self.assertIn("Plaid update-mode link token creation failed.", log_text)
        for forbidden in (
            "synthetic-secret-test",
            "client-id-test",
            "link-sandbox-leak",
            "opaque-client-user-id",
            SYNTHETIC_ACCESS_TOKEN,
        ):
            self.assertNotIn(forbidden, log_text)

    def test_failures_suppress_cause_and_never_render_provider_body(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps(
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": (
                    f"{RAW_PROVIDER_BODY_MARKER} link-sandbox-leak "
                    "opaque-client-user-id"
                ),
                "request_id": "req-link-leak",
            }
        )

        for provider_error in (
            error,
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ):
            with self.subTest(provider_error=provider_error):
                with self.assertLogs(
                    "plaid_integration.gateway", level=logging.WARNING
                ) as captured:
                    with self.assertRaises(PlaidGatewayError) as raised:
                        gateway_for(
                            FakePlaidApi(error=provider_error)
                        ).create_update_link_token(
                            "opaque-client-user-id", SYNTHETIC_ACCESS_TOKEN
                        )

                exception = raised.exception
                self.assertIsNone(exception.__cause__)
                self.assertEqual(str(exception), PLAID_UNAVAILABLE_DETAIL)
                formatted = "".join(traceback.format_exception(exception))
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    "link-sandbox-leak",
                    "opaque-client-user-id",
                    "req-link-leak",
                    SYNTHETIC_ACCESS_TOKEN,
                ):
                    self.assertNotIn(forbidden, str(exception))
                    self.assertNotIn(forbidden, repr(exception))
                    self.assertNotIn(forbidden, formatted)
                log_text = "\n".join(captured.output)
                self.assertEqual(len(captured.output), 1)
                self.assertIn("Plaid update-mode link token creation failed.", log_text)
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    "link-sandbox-leak",
                    "opaque-client-user-id",
                    "req-link-leak",
                    SYNTHETIC_ACCESS_TOKEN,
                ):
                    self.assertNotIn(forbidden, log_text)


@override_settings(**PLAID_API_SETTINGS)
class ConnectionLinkTokenAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="conn-link-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="conn-link-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.checking = Account.objects.create(
            user=cls.user,
            name="Update Link Checking",
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
            item_id="item-sandbox-conn-link-00001",
            institution_name="Update Link Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
            sync_cursor="cursor-opaque-stored",
            transactions_update_status=TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
            last_synced_at=timezone.now(),
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-conn-link-00002",
            institution_name="Other Update Link Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )
        cls.link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.checking,
            plaid_account_id="plaid-account-conn-link-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1234",
            anchor_provider_current_balance=Decimal("500.00"),
            anchor_applied_at=timezone.now(),
        )
        cls.category = Category.objects.create(
            user=cls.user,
            name="Update Link Salary",
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
            plaid_transaction_id="plaid-tx-conn-link-0001",
        )

    def setUp(self):
        self.csrf_client = APIClient(enforce_csrf_checks=True)
        self.csrf_client.force_login(self.user)
        csrf_response = self.csrf_client.get(reverse("auth-csrf"))
        self.csrf_token = csrf_response.cookies["csrftoken"].value

    def link_token_url(self, connection_pk):
        return reverse("plaid-connection-link-token", args=[connection_pk])

    def post_link_token(self, connection_pk, client=None, *, csrf_token=None, **extra):
        client = client if client is not None else self.csrf_client
        return client.post(
            self.link_token_url(connection_pk),
            data={},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token if csrf_token is not None else self.csrf_token,
            **extra,
        )

    def patched_gateway(self, fake_api):
        return patch(
            "plaid_integration.views.PlaidGateway.from_settings",
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

    def test_authenticated_update_mode_link_token_creation_succeeds(self):
        expiration = timezone.now() + timedelta(hours=1)
        fake_api = FakePlaidApi(
            response=FakeLinkTokenResponse("link-sandbox-update-test", expiration)
        )

        with self.patched_gateway(fake_api):
            response = self.post_link_token(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["link_token"], "link-sandbox-update-test")
        self.assertEqual(response.data["expiration"], expiration)
        self.assertEqual(set(response.data.keys()), {"link_token", "expiration"})
        self.assertEqual(len(fake_api.calls), 1)
        request, timeout = fake_api.calls[0]
        self.assertEqual(request.access_token, SYNTHETIC_ACCESS_TOKEN)
        self.assertFalse(hasattr(request, "products"))
        self.assertFalse(hasattr(request, "transactions"))
        self.assertEqual(request.user.client_user_id, plaid_client_user_id(self.user))
        self.assertEqual(timeout, PLAID_REQUEST_TIMEOUT_SECONDS)

    def test_response_contains_exactly_the_safe_fields_and_no_exchange_handle(self):
        fake_api = FakePlaidApi()

        with self.patched_gateway(fake_api):
            response = self.post_link_token(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            set(response.data.keys()),
            {"link_token", "expiration"},
        )
        self.assertNotIn("exchange_handle", response.data)
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)
        raw = response.content.decode()
        for forbidden in (
            "access_token",
            "public_token",
            "item_id",
            "cursor-opaque-stored",
            "client_id",
            "secret",
            SYNTHETIC_ACCESS_TOKEN,
        ):
            self.assertNotIn(forbidden, raw)

    def test_anonymous_post_returns_401_without_decrypt_or_provider_call(self):
        with (
            patch("plaid_integration.views.decrypt_connection_access_token") as decrypt,
            patch("plaid_integration.views.PlaidGateway") as gateway_class,
        ):
            response = self.client.post(self.link_token_url(self.connection.pk))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        decrypt.assert_not_called()
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.create_update_link_token.assert_not_called()

    def test_authenticated_post_without_csrf_returns_403_without_decrypt_or_call(
        self,
    ):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        with (
            patch("plaid_integration.views.decrypt_connection_access_token") as decrypt,
            patch("plaid_integration.views.PlaidGateway") as gateway_class,
        ):
            response = csrf_client.post(self.link_token_url(self.connection.pk))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        decrypt.assert_not_called()
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.create_update_link_token.assert_not_called()

    def test_missing_and_foreign_connection_ids_return_indistinguishable_404(
        self,
    ):
        with (
            patch("plaid_integration.views.decrypt_connection_access_token") as decrypt,
            patch("plaid_integration.views.PlaidGateway") as gateway_class,
        ):
            missing = self.post_link_token(999999)
            foreign = self.post_link_token(self.other_connection.pk)

        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            missing.json(),
            {"detail": "No PlaidConnection matches the given query."},
        )
        self.assertEqual(missing.json(), foreign.json())
        decrypt.assert_not_called()
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.create_update_link_token.assert_not_called()

    def test_disabled_integration_returns_fixed_503_without_any_work_or_write(
        self,
    ):
        before = self.snapshot_rows()
        with (
            override_settings(PLAID_ENABLED=False),
            patch("plaid_integration.views.decrypt_connection_access_token") as decrypt,
            patch("plaid_integration.views.PlaidGateway") as gateway_class,
        ):
            response = self.post_link_token(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        decrypt.assert_not_called()
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.create_update_link_token.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

    def test_non_sandbox_runtime_override_returns_fixed_503_without_sdk_client(self):
        for plaid_env in ("production", "development", "", "Sandbox"):
            with (
                self.subTest(plaid_env=plaid_env),
                override_settings(PLAID_ENV=plaid_env),
            ):
                with (
                    patch("plaid_integration.gateway.PlaidApi") as plaid_api_class,
                    patch("plaid_integration.gateway.ApiClient") as api_client_class,
                ):
                    response = self.post_link_token(self.connection.pk)

                self.assertEqual(
                    response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE
                )
                self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
                plaid_api_class.assert_not_called()
                api_client_class.assert_not_called()

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
                    item_id=f"item-sandbox-conn-link-bad-{label}",
                    institution_name="Bad Token Bank",
                    **fields,
                )
                before = self.snapshot_rows()
                with self.patched_gateway(FakePlaidApi()) as from_settings:
                    response = self.post_link_token(connection.pk)

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
            self.patched_gateway(FakePlaidApi()) as from_settings,
        ):
            response = self.post_link_token(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        from_settings.assert_not_called()
        self.assertEqual(self.snapshot_rows(), before)

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
            }
        )

        with self.patched_gateway(FakePlaidApi(error=error)):
            response = self.post_link_token(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        raw = response.content.decode()
        for forbidden in (
            RAW_PROVIDER_BODY_MARKER,
            "synthetic-secret-test",
            "client-id-test",
            "link-sandbox-leak",
        ):
            self.assertNotIn(forbidden, raw)
        self.assertEqual(self.snapshot_rows(), before)

    def test_unexpected_programmer_error_propagates(self):
        error = TypeError("programmer defect")
        fake_api = FakePlaidApi(error=error)
        raising_client = APIClient(raise_request_exception=False)
        raising_client.force_login(self.user)
        csrf_response = raising_client.get(reverse("auth-csrf"))
        csrf_token = csrf_response.cookies["csrftoken"].value

        with self.patched_gateway(fake_api):
            response = raising_client.post(
                self.link_token_url(self.connection.pk),
                data={},
                format="json",
                HTTP_X_CSRFTOKEN=csrf_token,
            )

        self.assertEqual(response.status_code, status.HTTP_500_INTERNAL_SERVER_ERROR)

    def test_no_lifecycle_mutation_on_success(self):
        before = self.snapshot_rows()
        fake_api = FakePlaidApi(
            response=FakeLinkTokenResponse(
                "link-sandbox-no-mutation",
                timezone.now() + timedelta(hours=1),
            )
        )

        with self.patched_gateway(fake_api):
            response = self.post_link_token(self.connection.pk)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(self.snapshot_rows(), before)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertEqual(self.connection.sync_cursor, "cursor-opaque-stored")
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        self.assertEqual(self.connection.last_sync_error, "")
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)

    def test_every_owned_status_with_a_token_permits_issuance(self):
        for label, status_value in (
            ("active", PlaidConnectionStatus.ACTIVE),
            ("updating", PlaidConnectionStatus.UPDATING),
            ("error", PlaidConnectionStatus.ERROR),
            ("revoked", PlaidConnectionStatus.REVOKED),
        ):
            with self.subTest(status=status_value):
                connection = PlaidConnection.objects.create(
                    user=self.user,
                    item_id=f"item-sandbox-conn-link-status-{label}",
                    institution_name="Status Bank",
                    access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
                    encryption_key_id="key-a",
                    status=status_value,
                )
                fake_api = FakePlaidApi(
                    response=FakeLinkTokenResponse(
                        f"link-sandbox-status-{label}",
                        timezone.now() + timedelta(hours=1),
                    )
                )

                with self.patched_gateway(fake_api):
                    response = self.post_link_token(connection.pk)

                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.assertEqual(
                    response.data["link_token"], f"link-sandbox-status-{label}"
                )
                self.assertEqual(len(fake_api.calls), 1)

    def test_disconnected_connection_without_token_returns_fixed_503(self):
        disconnected = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-conn-link-disconnected",
            institution_name="Disconnected Bank",
            status=PlaidConnectionStatus.DISCONNECTED,
            access_token_encrypted=None,
            encryption_key_id=None,
        )

        with self.patched_gateway(FakePlaidApi()) as from_settings:
            response = self.post_link_token(disconnected.pk)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        from_settings.assert_not_called()

    def test_unsupported_methods_return_405_without_side_effects(self):
        before = self.snapshot_rows()
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.csrf_client, method)(
                    self.link_token_url(self.connection.pk),
                    HTTP_X_CSRFTOKEN=self.csrf_token,
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        self.assertEqual(self.snapshot_rows(), before)
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)
