"""Tests for the authenticated public-token exchange endpoint and its seams.

Covers the ``docs/plaid.md`` section 3 ``POST /api/plaid/exchange/``
contract for issue #37 slice B: the strict request boundary, the atomic
single-use handle claim, the provider gateway calls, encrypted persistence,
duplicate Item safety, and the fixed safe error responses. Only synthetic
credentials, tokens, and SDK objects are used; the network boundary is never
exercised. The real Fernet key ring is replaced with a synthetic test ring so
stored packages can be decrypted and proven to match the plaintext access
token without ever leaking it.
"""

import hashlib
import json
import logging
import secrets
import traceback
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import patch

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from plaid import ApiException
from plaid.model.item_get_request import ItemGetRequest
from plaid.model.item_public_token_exchange_request import (
    ItemPublicTokenExchangeRequest,
)
from rest_framework import status
from rest_framework.test import APIClient, APITestCase
from urllib3.exceptions import ProtocolError

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from plaid_integration.gateway import (
    PLAID_REQUEST_TIMEOUT_SECONDS,
    PLAID_UNAVAILABLE_DETAIL,
    ItemGetResult,
    PlaidExchangeInvalidError,
    PlaidGateway,
    PlaidGatewayError,
    PublicTokenExchangeResult,
)
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    PlaidExchangeHandle,
    PlaidItemRemovalRequest,
    TransactionsUpdateStatus,
)
from plaid_integration.serializers import EXCHANGE_INVALID_DETAIL
from plaid_integration.services import (
    EXCHANGE_INSTITUTION_MAX_LENGTH,
    EXCHANGE_ITEM_ID_MAX_LENGTH,
    UNKNOWN_INSTITUTION,
    PlaidExchangeDuplicateItem,
    PlaidExchangeProviderDataError,
    claim_exchange_handle,
    issue_exchange_handle,
    persist_exchange_connection,
)
from plaid_integration.token_encryption import TokenKeyRing
from transactions.models import Transaction, TransactionSource, TransactionType

SYNTHETIC_ACCESS_TOKEN = "access-sandbox-00000000-0000-0000-0000-000000000000"
SYNTHETIC_PUBLIC_TOKEN = "public-sandbox-00000000-0000-0000-0000-000000000000"
SYNTHETIC_ITEM_ID = "item-sandbox-00000000000000000000000000"

RAW_PROVIDER_BODY_MARKER = "RAW-PROVIDER-BODY-MARKER"

_TEST_KEY = Fernet.generate_key().decode()
SYNTHETIC_RING = TokenKeyRing([("key-a", _TEST_KEY)])

PLAID_API_SETTINGS = {
    "PLAID_ENABLED": True,
    "PLAID_ENV": "sandbox",
    "PLAID_CLIENT_ID": "client-id-test",
    "PLAID_SECRET": "secret-test",
    "PLAID_TOKEN_RING": SYNTHETIC_RING,
}


class FakeExchangeResponse:
    def __init__(
        self,
        access_token=SYNTHETIC_ACCESS_TOKEN,
        item_id=SYNTHETIC_ITEM_ID,
    ):
        self.access_token = access_token
        self.item_id = item_id


class FakeItem:
    def __init__(self, institution_name="Synthetic Test Bank"):
        self.institution_name = institution_name
        self.error = None


class FakeItemGetResponse:
    def __init__(self, institution_name="Synthetic Test Bank"):
        self.item = FakeItem(institution_name)


class MissingExchangeResponse:
    """A provider exchange response carrying neither token nor item id."""


class MissingItemGetResponse:
    """A provider item lookup response without an item object."""


class FakePlaidApi:
    """Records the real SDK request objects without any network access.

    ``before_exchange`` is an optional spy callback invoked inside
    ``item_public_token_exchange`` at the instant the provider call would
    happen, so tests can observe database state mid-request (for example
    that the handle is already consumed before the provider is reached).
    """

    def __init__(
        self,
        *,
        exchange_response=None,
        exchange_error=None,
        item_response=None,
        item_error=None,
        before_exchange=None,
    ):
        self.exchange_response = (
            exchange_response
            if exchange_response is not None
            else FakeExchangeResponse()
        )
        self.exchange_error = exchange_error
        self.item_response = (
            item_response if item_response is not None else FakeItemGetResponse()
        )
        self.item_error = item_error
        self.before_exchange = before_exchange
        self.exchange_calls = []
        self.item_calls = []

    def item_public_token_exchange(
        self, *, item_public_token_exchange_request, _request_timeout=None
    ):
        self.exchange_calls.append(
            (item_public_token_exchange_request, _request_timeout)
        )
        if self.before_exchange is not None:
            self.before_exchange()
        if self.exchange_error is not None:
            raise self.exchange_error
        return self.exchange_response

    def item_get(self, *, item_get_request, _request_timeout=None):
        self.item_calls.append((item_get_request, _request_timeout))
        if self.item_error is not None:
            raise self.item_error
        return self.item_response


def gateway_for(plaid_api):
    return PlaidGateway(
        plaid_api,
        client_id="client-id-test",
        secret="secret-test",
    )


def api_error(status_code, body_payload):
    error = ApiException(status=status_code, reason="PROVIDER", http_resp=None)
    error.body = json.dumps(body_payload)
    return error


class ExchangeGatewayTests(SimpleTestCase):
    def test_exchange_builds_exact_sdk_request_with_bounded_timeout(self):
        fake_api = FakePlaidApi()

        result = gateway_for(fake_api).exchange_public_token(SYNTHETIC_PUBLIC_TOKEN)

        self.assertEqual(len(fake_api.exchange_calls), 1)
        request, timeout = fake_api.exchange_calls[0]
        self.assertIsInstance(request, ItemPublicTokenExchangeRequest)
        self.assertEqual(request.public_token, SYNTHETIC_PUBLIC_TOKEN)
        self.assertEqual(request.client_id, "client-id-test")
        self.assertEqual(request.secret, "secret-test")
        self.assertEqual(timeout, PLAID_REQUEST_TIMEOUT_SECONDS)
        self.assertEqual(result.access_token, SYNTHETIC_ACCESS_TOKEN)
        self.assertEqual(result.item_id, SYNTHETIC_ITEM_ID)

    def test_item_get_builds_exact_sdk_request_with_bounded_timeout(self):
        fake_api = FakePlaidApi()

        result = gateway_for(fake_api).get_item(SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(len(fake_api.item_calls), 1)
        request, timeout = fake_api.item_calls[0]
        self.assertIsInstance(request, ItemGetRequest)
        self.assertEqual(request.access_token, SYNTHETIC_ACCESS_TOKEN)
        self.assertEqual(request.client_id, "client-id-test")
        self.assertEqual(request.secret, "secret-test")
        self.assertEqual(timeout, PLAID_REQUEST_TIMEOUT_SECONDS)
        self.assertEqual(result.institution_name, "Synthetic Test Bank")

    def test_item_get_preserves_null_institution_name(self):
        fake_api = FakePlaidApi(
            item_response=FakeItemGetResponse(institution_name=None)
        )

        result = gateway_for(fake_api).get_item(SYNTHETIC_ACCESS_TOKEN)

        self.assertIsNone(result.institution_name)

    def test_result_repr_never_exposes_access_token(self):
        result = PublicTokenExchangeResult("super-secret-access-token", "item-xyz")

        self.assertNotIn("super-secret-access-token", repr(result))
        self.assertIn("item-xyz", repr(result))

    def test_item_get_result_repr_is_safe(self):
        self.assertIn("Synthetic Test Bank", repr(ItemGetResult("Synthetic Test Bank")))
        self.assertIn("None", repr(ItemGetResult(None)))

    def test_exchange_provider_400_maps_to_invalid_exchange_not_outage(self):
        error = api_error(
            400,
            {
                "error_type": "INVALID_INPUT",
                "error_code": "INVALID_PUBLIC_TOKEN",
                "error_message": "synthetic-public-token-leak",
            },
        )

        with self.assertRaises(PlaidExchangeInvalidError) as raised:
            gateway_for(FakePlaidApi(exchange_error=error)).exchange_public_token(
                SYNTHETIC_PUBLIC_TOKEN
            )

        self.assertNotIn(SYNTHETIC_PUBLIC_TOKEN, str(raised.exception))
        self.assertNotIn("synthetic-public-token-leak", str(raised.exception))

    def test_exchange_provider_outage_maps_to_fixed_safe_error(self):
        error = api_error(
            500,
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": "synthetic-access-token-leak",
            },
        )

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakePlaidApi(exchange_error=error)).exchange_public_token(
                SYNTHETIC_PUBLIC_TOKEN
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_exchange_timeout_maps_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(
                FakePlaidApi(exchange_error=TimeoutError("Connection timed out"))
            ).exchange_public_token(SYNTHETIC_PUBLIC_TOKEN)

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_exchange_transport_error_maps_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(
                FakePlaidApi(exchange_error=ProtocolError("Connection aborted."))
            ).exchange_public_token(SYNTHETIC_PUBLIC_TOKEN)

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_item_get_any_provider_error_maps_to_fixed_safe_error(self):
        for error in (
            api_error(400, {"error_message": "synthetic-leak"}),
            api_error(500, {"error_message": "synthetic-leak"}),
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ):
            with self.subTest(error=error):
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(FakePlaidApi(item_error=error)).get_item(
                        SYNTHETIC_ACCESS_TOKEN
                    )

                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_exchange_malformed_access_token_maps_to_fixed_safe_error(self):
        for access_token in (None, "", 123, ["token"]):
            with self.subTest(access_token=access_token):
                fake_api = FakePlaidApi(
                    exchange_response=FakeExchangeResponse(access_token=access_token)
                )
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(fake_api).exchange_public_token(SYNTHETIC_PUBLIC_TOKEN)

                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
                self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, str(raised.exception))

    def test_exchange_malformed_item_id_maps_to_fixed_safe_error(self):
        for item_id in (None, "", 123, ["item"]):
            with self.subTest(item_id=item_id):
                fake_api = FakePlaidApi(
                    exchange_response=FakeExchangeResponse(item_id=item_id)
                )
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(fake_api).exchange_public_token(SYNTHETIC_PUBLIC_TOKEN)

                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_exchange_missing_response_attributes_map_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(
                FakePlaidApi(exchange_response=MissingExchangeResponse())
            ).exchange_public_token(SYNTHETIC_PUBLIC_TOKEN)

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_item_get_malformed_institution_name_maps_to_fixed_safe_error(self):
        for institution_name in (123, True, ["Bank"], {"name": "Bank"}):
            with self.subTest(institution_name=institution_name):
                fake_api = FakePlaidApi(
                    item_response=FakeItemGetResponse(institution_name=institution_name)
                )
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(fake_api).get_item(SYNTHETIC_ACCESS_TOKEN)

                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
                self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, str(raised.exception))

    def test_item_get_missing_item_object_maps_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakePlaidApi(item_response=MissingItemGetResponse())).get_item(
                SYNTHETIC_ACCESS_TOKEN
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_programmer_defects_propagate(self):
        with self.assertRaises(TypeError) as raised:
            gateway_for(
                FakePlaidApi(exchange_error=TypeError("programmer defect"))
            ).exchange_public_token(SYNTHETIC_PUBLIC_TOKEN)

        self.assertEqual(str(raised.exception), "programmer defect")

    def test_failure_logs_and_errors_never_echo_tokens(self):
        error = api_error(
            500,
            {
                "error_message": (
                    f"{SYNTHETIC_PUBLIC_TOKEN} {SYNTHETIC_ACCESS_TOKEN} "
                    "client-id-test secret-test"
                ),
            },
        )

        with self.assertLogs(
            "plaid_integration.gateway", level=logging.WARNING
        ) as captured:
            with self.assertRaises(PlaidGatewayError):
                gateway_for(FakePlaidApi(exchange_error=error)).exchange_public_token(
                    SYNTHETIC_PUBLIC_TOKEN
                )

        log_text = "\n".join(captured.output)
        for forbidden in (
            SYNTHETIC_PUBLIC_TOKEN,
            SYNTHETIC_ACCESS_TOKEN,
            "client-id-test",
            "secret-test",
        ):
            self.assertNotIn(forbidden, log_text)

    def test_exchange_invalid_400_suppresses_cause_and_never_renders_body(self):
        error = api_error(
            400,
            {
                "error_type": "INVALID_INPUT",
                "error_code": "INVALID_PUBLIC_TOKEN",
                "error_message": (
                    f"{RAW_PROVIDER_BODY_MARKER} {SYNTHETIC_PUBLIC_TOKEN} "
                    f"{SYNTHETIC_ACCESS_TOKEN}"
                ),
                "request_id": "req-invalid-1",
            },
        )

        with self.assertNoLogs("plaid_integration.gateway", level=logging.WARNING):
            with self.assertRaises(PlaidExchangeInvalidError) as raised:
                gateway_for(FakePlaidApi(exchange_error=error)).exchange_public_token(
                    SYNTHETIC_PUBLIC_TOKEN
                )

        exception = raised.exception
        self.assertIsNone(exception.__cause__)
        self.assertEqual(str(exception), "")
        formatted = "".join(traceback.format_exception(exception))
        for forbidden in (
            RAW_PROVIDER_BODY_MARKER,
            SYNTHETIC_PUBLIC_TOKEN,
            SYNTHETIC_ACCESS_TOKEN,
            "req-invalid-1",
        ):
            self.assertNotIn(forbidden, str(exception))
            self.assertNotIn(forbidden, repr(exception))
            self.assertNotIn(forbidden, formatted)

    def test_exchange_outage_and_transport_suppress_cause_and_never_render_body(self):
        outage = api_error(
            500,
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": (
                    f"{RAW_PROVIDER_BODY_MARKER} {SYNTHETIC_PUBLIC_TOKEN} "
                    f"{SYNTHETIC_ACCESS_TOKEN}"
                ),
                "request_id": "req-outage-1",
            },
        )

        for error in (
            outage,
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ):
            with self.subTest(error=error):
                with self.assertLogs(
                    "plaid_integration.gateway", level=logging.WARNING
                ) as captured:
                    with self.assertRaises(PlaidGatewayError) as raised:
                        gateway_for(
                            FakePlaidApi(exchange_error=error)
                        ).exchange_public_token(SYNTHETIC_PUBLIC_TOKEN)

                exception = raised.exception
                self.assertIsNone(exception.__cause__)
                self.assertEqual(str(exception), PLAID_UNAVAILABLE_DETAIL)
                formatted = "".join(traceback.format_exception(exception))
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    SYNTHETIC_PUBLIC_TOKEN,
                    SYNTHETIC_ACCESS_TOKEN,
                    "req-outage-1",
                ):
                    self.assertNotIn(forbidden, str(exception))
                    self.assertNotIn(forbidden, repr(exception))
                    self.assertNotIn(forbidden, formatted)
                log_text = "\n".join(captured.output)
                self.assertEqual(len(captured.output), 1)
                self.assertIn("Plaid public token exchange failed.", log_text)
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    SYNTHETIC_PUBLIC_TOKEN,
                    SYNTHETIC_ACCESS_TOKEN,
                    "req-outage-1",
                ):
                    self.assertNotIn(forbidden, log_text)

    def test_item_get_failures_suppress_cause_and_never_render_body(self):
        errors = [
            api_error(
                500,
                {
                    "error_type": "API_ERROR",
                    "error_code": "PROVIDER_ERROR",
                    "error_message": (
                        f"{RAW_PROVIDER_BODY_MARKER} {SYNTHETIC_ACCESS_TOKEN}"
                    ),
                    "request_id": "req-item-1",
                },
            ),
            api_error(
                400,
                {"error_message": f"{RAW_PROVIDER_BODY_MARKER} invalid token"},
            ),
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ]
        for error in errors:
            with self.subTest(error=error):
                with self.assertLogs(
                    "plaid_integration.gateway", level=logging.WARNING
                ) as captured:
                    with self.assertRaises(PlaidGatewayError) as raised:
                        gateway_for(FakePlaidApi(item_error=error)).get_item(
                            SYNTHETIC_ACCESS_TOKEN
                        )

                exception = raised.exception
                self.assertIsNone(exception.__cause__)
                self.assertEqual(str(exception), PLAID_UNAVAILABLE_DETAIL)
                formatted = "".join(traceback.format_exception(exception))
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    SYNTHETIC_ACCESS_TOKEN,
                    SYNTHETIC_PUBLIC_TOKEN,
                    "req-item-1",
                ):
                    self.assertNotIn(forbidden, str(exception))
                    self.assertNotIn(forbidden, repr(exception))
                    self.assertNotIn(forbidden, formatted)
                log_text = "\n".join(captured.output)
                self.assertEqual(len(captured.output), 1)
                self.assertIn("Plaid item lookup failed.", log_text)
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    SYNTHETIC_ACCESS_TOKEN,
                    SYNTHETIC_PUBLIC_TOKEN,
                    "req-item-1",
                ):
                    self.assertNotIn(forbidden, log_text)


class ClaimExchangeHandleTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="claim-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.other_user = get_user_model().objects.create_user(
            email="claim-other@example.com",
            password="TestOnlyPassword123!",
        )

    def issue(self, user=None, expiration=None):
        return issue_exchange_handle(
            user or self.user,
            expiration
            if expiration is not None
            else timezone.now() + timedelta(hours=2),
        )

    def test_claim_consumes_exactly_one_valid_row(self):
        raw_handle = self.issue()

        claimed = claim_exchange_handle(self.user, raw_handle)

        self.assertTrue(claimed)
        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertIsNotNone(row.consumed_at)
        self.assertEqual(
            PlaidExchangeHandle.objects.filter(
                user=self.user, consumed_at__isnull=False
            ).count(),
            1,
        )

    def test_sequential_replay_returns_false_and_never_resets_consumed_at(self):
        raw_handle = self.issue()
        self.assertTrue(claim_exchange_handle(self.user, raw_handle))
        row = PlaidExchangeHandle.objects.get(user=self.user)
        first_consumed_at = row.consumed_at

        self.assertFalse(claim_exchange_handle(self.user, raw_handle))

        row.refresh_from_db()
        self.assertEqual(row.consumed_at, first_consumed_at)
        self.assertEqual(
            PlaidExchangeHandle.objects.filter(consumed_at__isnull=False).count(),
            1,
        )

    def test_claim_for_unknown_digest_returns_false_without_rows(self):
        self.assertFalse(claim_exchange_handle(self.user, secrets.token_urlsafe(32)))
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)

    def test_claim_for_expired_handle_returns_false_and_leaves_row_unconsumed(self):
        raw_handle = self.issue(expiration=timezone.now() + timedelta(minutes=5))
        PlaidExchangeHandle.objects.filter(user=self.user).update(
            expires_at=timezone.now() - timedelta(minutes=1)
        )

        self.assertFalse(claim_exchange_handle(self.user, raw_handle))

        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertIsNone(row.consumed_at)

    def test_foreign_handle_is_never_claimed_and_row_stays_unconsumed(self):
        raw_handle = self.issue(user=self.other_user)

        self.assertFalse(claim_exchange_handle(self.user, raw_handle))

        row = PlaidExchangeHandle.objects.get(user=self.other_user)
        self.assertIsNone(row.consumed_at)
        self.assertFalse(PlaidExchangeHandle.objects.filter(user=self.user).exists())

    def test_claim_keeps_only_the_digest_as_evidence(self):
        raw_handle = self.issue()
        self.assertTrue(claim_exchange_handle(self.user, raw_handle))

        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertEqual(
            row.digest,
            hashlib.sha256(raw_handle.encode("ascii")).hexdigest(),
        )
        self.assertNotEqual(row.digest, raw_handle)
        self.assertNotIn(raw_handle, str(row))
        self.assertNotIn(raw_handle, repr(row))


class PersistExchangeConnectionTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="persist-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.token_package = "key-a:encrypted-package"
        self.key_id = "key-a"

    def persist(
        self,
        *,
        item_id=SYNTHETIC_ITEM_ID,
        institution_name="Synthetic Test Bank",
    ):
        return persist_exchange_connection(
            self.user,
            item_id,
            institution_name,
            self.token_package,
            self.key_id,
        )

    def test_valid_provider_data_persists_normalized_connection(self):
        result = self.persist()
        connection = result.connection

        self.assertTrue(result.created)
        connection.refresh_from_db()
        self.assertEqual(connection.user, self.user)
        self.assertEqual(connection.item_id, SYNTHETIC_ITEM_ID)
        self.assertEqual(connection.institution_name, "Synthetic Test Bank")
        self.assertEqual(connection.access_token_encrypted, self.token_package)
        self.assertEqual(connection.encryption_key_id, self.key_id)
        self.assertEqual(connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertEqual(
            connection.transactions_update_status,
            TransactionsUpdateStatus.NOT_READY,
        )

    def test_blank_institution_name_normalizes_to_unknown(self):
        for index, institution_name in enumerate((None, "", "   ")):
            with self.subTest(institution_name=institution_name):
                result = self.persist(
                    item_id=f"{SYNTHETIC_ITEM_ID}-blank-{index}",
                    institution_name=institution_name,
                )

                self.assertTrue(result.created)
                self.assertEqual(
                    result.connection.institution_name, UNKNOWN_INSTITUTION
                )

    def test_non_string_or_empty_item_id_raises_provider_data_error(self):
        for item_id in (None, "", 123, ["item"]):
            with self.subTest(item_id=item_id):
                with self.assertRaises(PlaidExchangeProviderDataError):
                    self.persist(item_id=item_id)

        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_overlong_item_id_raises_without_truncation(self):
        with self.assertRaises(PlaidExchangeProviderDataError):
            self.persist(item_id="i" * (EXCHANGE_ITEM_ID_MAX_LENGTH + 1))

        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_non_string_institution_name_raises_provider_data_error(self):
        for institution_name in (123, True, ["Bank"], {"name": "Bank"}):
            with self.subTest(institution_name=institution_name):
                with self.assertRaises(PlaidExchangeProviderDataError):
                    self.persist(institution_name=institution_name)

        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_overlong_institution_name_raises_without_truncation(self):
        with self.assertRaises(PlaidExchangeProviderDataError):
            self.persist(institution_name="b" * (EXCHANGE_INSTITUTION_MAX_LENGTH + 1))

        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_same_user_same_item_heals_preserving_cursor_links_and_history(self):
        synced_at = timezone.now() - timedelta(days=3)
        existing = PlaidConnection.objects.create(
            user=self.user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Existing Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.ERROR,
            sync_cursor="cursor-opaque-heal-001",
            transactions_update_status=(
                TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE
            ),
            last_synced_at=synced_at,
            sync_due=False,
        )
        account = Account.objects.create(
            user=self.user,
            name="Heal Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
            is_archived=True,
        )
        link = PlaidAccountLink.objects.create(
            connection=existing,
            user=self.user,
            account=account,
            plaid_account_id="plaid-account-heal-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )
        category = Category.objects.create(
            user=self.user,
            name="Heal Salary",
            category_type=CategoryType.INCOME,
        )
        synced_tx = Transaction.objects.create(
            user=self.user,
            connection=existing,
            account=account,
            category=category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("25.00"),
            date=date(2026, 9, 1),
            provider_name="Synthetic Payroll",
            source=TransactionSource.PLAID,
            plaid_transaction_id="plaid-tx-heal-0001",
        )
        PlaidItemRemovalRequest.objects.create(
            connection=existing,
            access_token_encrypted="key-a:relocated-package",
            encryption_key_id="key-a",
            status="pending",
        )

        result = persist_exchange_connection(
            self.user,
            SYNTHETIC_ITEM_ID,
            "Healed Bank",
            "key-b:new-package",
            "key-b",
        )

        self.assertFalse(result.created)
        self.assertEqual(PlaidConnection.objects.count(), 1)
        healed = result.connection
        healed.refresh_from_db()
        self.assertEqual(healed.pk, existing.pk)
        self.assertEqual(healed.access_token_encrypted, "key-b:new-package")
        self.assertEqual(healed.encryption_key_id, "key-b")
        self.assertEqual(healed.status, PlaidConnectionStatus.ACTIVE)
        self.assertTrue(healed.sync_due)
        self.assertEqual(healed.institution_name, "Healed Bank")
        # Preserved readiness and history inputs.
        self.assertEqual(healed.sync_cursor, "cursor-opaque-heal-001")
        self.assertEqual(
            healed.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        self.assertEqual(healed.last_synced_at, synced_at)
        self.assertTrue(PlaidAccountLink.objects.filter(pk=link.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=synced_tx.pk).exists())
        # Un-archived own account and deleted the stale removal row.
        account.refresh_from_db()
        self.assertFalse(account.is_archived)
        self.assertFalse(
            PlaidItemRemovalRequest.objects.filter(connection_id=existing.pk).exists()
        )

    def test_heal_preserves_name_on_blank_and_updates_on_bounded(self):
        PlaidConnection.objects.create(
            user=self.user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Stored Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
        )

        for blank in (None, "", "   "):
            with self.subTest(blank=blank):
                result = persist_exchange_connection(
                    self.user,
                    SYNTHETIC_ITEM_ID,
                    blank,
                    "key-b:new-package",
                    "key-b",
                )
                self.assertFalse(result.created)
                result.connection.refresh_from_db()
                self.assertEqual(result.connection.institution_name, "Stored Bank")

        result = persist_exchange_connection(
            self.user,
            SYNTHETIC_ITEM_ID,
            "Bounded New Bank",
            "key-b:new-package-2",
            "key-b",
        )
        self.assertFalse(result.created)
        result.connection.refresh_from_db()
        self.assertEqual(result.connection.institution_name, "Bounded New Bank")

    def test_heal_keeps_stored_name_on_overlong_institution(self):
        PlaidConnection.objects.create(
            user=self.user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Stored Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
        )

        result = persist_exchange_connection(
            self.user,
            SYNTHETIC_ITEM_ID,
            "b" * (EXCHANGE_INSTITUTION_MAX_LENGTH + 1),
            "key-b:new-package",
            "key-b",
        )

        self.assertFalse(result.created)
        result.connection.refresh_from_db()
        self.assertEqual(result.connection.institution_name, "Stored Bank")
        self.assertEqual(result.connection.access_token_encrypted, "key-b:new-package")

    def test_cross_user_same_item_still_raises_duplicate_and_mutates_nothing(self):
        other_user = get_user_model().objects.create_user(
            email="persist-other@example.com",
            password="TestOnlyPassword123!",
        )
        existing = PlaidConnection.objects.create(
            user=other_user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Other Bank",
            access_token_encrypted="key-a:other-package",
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.ERROR,
            sync_cursor="cursor-other-001",
            sync_due=False,
        )

        with self.assertRaises(PlaidExchangeDuplicateItem):
            self.persist()

        existing.refresh_from_db()
        self.assertEqual(existing.access_token_encrypted, "key-a:other-package")
        self.assertEqual(existing.encryption_key_id, "key-a")
        self.assertEqual(existing.institution_name, "Other Bank")
        self.assertEqual(existing.status, PlaidConnectionStatus.ERROR)
        self.assertEqual(existing.sync_cursor, "cursor-other-001")
        self.assertFalse(existing.sync_due)
        self.assertEqual(PlaidConnection.objects.count(), 1)

    def test_named_unique_race_translates_to_duplicate(self):
        """Concurrent-insert race with a named unique diagnostic heals nothing.

        The initial locked lookup observes ``DoesNotExist`` (the concurrent
        winner has not committed yet from this transaction's view), then the
        new-row save raises the exact item-id unique violation. Only the
        named-constraint translation can convert it: the user-mismatch
        branch is unreachable (no existing row was returned) and the save
        mock proves the insert was attempted.
        """
        other_user = get_user_model().objects.create_user(
            email="persist-named-race-other@example.com",
            password="TestOnlyPassword123!",
        )
        existing = PlaidConnection.objects.create(
            user=other_user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Existing Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
        )
        race_marker = "race-named-marker-8f2c"

        class NamedDiag:
            constraint_name = "plaid_connection_item_id_unique"

        def racing_save(*args, **kwargs):
            cause = IntegrityError("synthetic named unique cause")
            cause.diag = NamedDiag()
            raise IntegrityError(
                f"duplicate key value violates unique constraint ({race_marker})"
            ) from cause

        with (
            patch.object(
                PlaidConnection.objects, "select_for_update"
            ) as mock_locked_lookup,
            patch(
                "plaid_integration.services.PlaidConnection.save",
                side_effect=racing_save,
            ) as mock_save,
        ):
            mock_locked_lookup.return_value.get.side_effect = (
                PlaidConnection.DoesNotExist
            )
            with self.assertRaises(PlaidExchangeDuplicateItem) as raised:
                self.persist()
            mock_locked_lookup.assert_called_once_with()
            mock_locked_lookup.return_value.get.assert_called_once_with(
                item_id=SYNTHETIC_ITEM_ID
            )
            mock_save.assert_called_once()

        self.assertNotIn(race_marker, str(raised.exception))
        self.assertNotIn(race_marker, repr(raised.exception))
        existing.refresh_from_db()
        self.assertEqual(existing.access_token_encrypted, "key-a:original-package")
        self.assertEqual(existing.institution_name, "Existing Bank")
        self.assertEqual(PlaidConnection.objects.count(), 1)

    def test_exact_duplicate_translates_without_diagnostic_constraint_name(self):
        """No-diagnostic fallback translates only via the exact item_id row.

        Same race shape as the named test, but the backend yields no
        constraint diagnostic (SQLite): translation happens exclusively
        through the exact-``item_id`` fallback ``.exists()`` against the
        concurrently committed row. Removing that fallback re-raises the
        raw ``IntegrityError`` and this test fails.
        """
        other_user = get_user_model().objects.create_user(
            email="persist-race-other@example.com",
            password="TestOnlyPassword123!",
        )
        existing = PlaidConnection.objects.create(
            user=other_user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Existing Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
        )
        race_marker = "race-fallback-marker-4d1e"

        class NoDiagCause(Exception):
            pass

        def racing_save(*args, **kwargs):
            error = IntegrityError(
                f"UNIQUE constraint failed: plaid_connection.item_id ({race_marker})"
            )
            error.__cause__ = NoDiagCause()
            raise error

        with (
            patch.object(
                PlaidConnection.objects, "select_for_update"
            ) as mock_locked_lookup,
            patch(
                "plaid_integration.services.PlaidConnection.save",
                side_effect=racing_save,
            ) as mock_save,
            patch("plaid_integration.services._constraint_name", return_value=None),
        ):
            mock_locked_lookup.return_value.get.side_effect = (
                PlaidConnection.DoesNotExist
            )
            with self.assertRaises(PlaidExchangeDuplicateItem) as raised:
                self.persist()
            mock_locked_lookup.assert_called_once_with()
            mock_locked_lookup.return_value.get.assert_called_once_with(
                item_id=SYNTHETIC_ITEM_ID
            )
            mock_save.assert_called_once()

        self.assertNotIn(race_marker, str(raised.exception))
        self.assertNotIn(race_marker, repr(raised.exception))
        existing.refresh_from_db()
        self.assertEqual(existing.access_token_encrypted, "key-a:original-package")
        self.assertEqual(existing.institution_name, "Existing Bank")
        self.assertEqual(PlaidConnection.objects.count(), 1)

    def test_no_diagnostic_unrelated_integrity_error_propagates(self):
        # Simulates a backend without a diagnostic constraint name (for
        # example SQLite) raising an unrelated integrity error where no exact
        # item row exists: the error must propagate, never translate.
        class NoDiagCause(Exception):
            pass

        def unrelated_save(*args, **kwargs):
            error = IntegrityError("UNIQUE constraint failed: unrelated.name")
            error.__cause__ = NoDiagCause()
            raise error

        with (
            patch(
                "plaid_integration.services.PlaidConnection.save",
                side_effect=unrelated_save,
            ),
            self.assertRaises(IntegrityError),
        ):
            self.persist()

        self.assertEqual(PlaidConnection.objects.count(), 0)


@override_settings(**PLAID_API_SETTINGS)
class ExchangeAPITests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="exchange-api-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.other_user = get_user_model().objects.create_user(
            email="exchange-api-other@example.com",
            password="TestOnlyPassword123!",
        )
        self.csrf_client = APIClient(enforce_csrf_checks=True)
        self.csrf_client.force_login(self.user)
        csrf_response = self.csrf_client.get(reverse("auth-csrf"))
        self.csrf_token = csrf_response.cookies["csrftoken"].value

    def issue(self, user=None, expiration=None):
        return issue_exchange_handle(
            user or self.user,
            expiration
            if expiration is not None
            else timezone.now() + timedelta(hours=2),
        )

    def post_exchange(self, client=None, *, data=None, csrf_token=None, **extra):
        client = client if client is not None else self.csrf_client
        return client.post(
            reverse("plaid-exchange"),
            data if data is not None else {},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token if csrf_token is not None else self.csrf_token,
            **extra,
        )

    def patched_gateway(self, fake_api):
        return patch(
            "plaid_integration.views.PlaidGateway.from_settings",
            return_value=gateway_for(fake_api),
        )

    def assert_generic_400(self, response):
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.json(), {"detail": EXCHANGE_INVALID_DETAIL})

    def valid_payload(self, handle=None):
        return {
            "public_token": SYNTHETIC_PUBLIC_TOKEN,
            "exchange_handle": handle if handle is not None else self.issue(),
        }

    def handle_row(self, handle):
        return PlaidExchangeHandle.objects.get(
            digest=hashlib.sha256(handle.encode("ascii")).hexdigest()
        )

    def test_authenticated_exchange_returns_exact_201_connection_shape(self):
        fake_api = FakePlaidApi()

        with self.patched_gateway(fake_api):
            response = self.post_exchange(data=self.valid_payload())

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            set(response.data.keys()),
            {"connection"},
        )
        connection = response.data["connection"]
        self.assertEqual(
            set(connection.keys()),
            {"id", "institution_name", "status", "linked_accounts"},
        )
        self.assertEqual(connection["institution_name"], "Synthetic Test Bank")
        self.assertEqual(connection["status"], PlaidConnectionStatus.ACTIVE)
        self.assertEqual(connection["linked_accounts"], [])
        self.assertIsInstance(connection["id"], int)
        self.assertEqual(len(fake_api.exchange_calls), 1)
        self.assertEqual(len(fake_api.item_calls), 1)

    def test_success_persists_encrypted_token_that_decrypts_to_plaintext(self):
        with self.patched_gateway(FakePlaidApi()):
            response = self.post_exchange(data=self.valid_payload())

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        connection = PlaidConnection.objects.get(user=self.user)
        self.assertEqual(connection.item_id, SYNTHETIC_ITEM_ID)
        self.assertEqual(connection.institution_name, "Synthetic Test Bank")
        self.assertEqual(connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertEqual(
            connection.transactions_update_status,
            TransactionsUpdateStatus.NOT_READY,
        )
        self.assertEqual(connection.encryption_key_id, SYNTHETIC_RING.primary_key_id)
        decrypted = SYNTHETIC_RING.decrypt(
            connection.access_token_encrypted,
            connection.encryption_key_id,
        )
        self.assertEqual(
            decrypted.plaintext.decode("ascii"),
            SYNTHETIC_ACCESS_TOKEN,
        )

        raw = response.content.decode()
        for forbidden in (
            SYNTHETIC_ACCESS_TOKEN,
            SYNTHETIC_PUBLIC_TOKEN,
            "access_token",
            "public_token",
            "item_id",
            "secret-test",
            "client-id-test",
        ):
            self.assertNotIn(forbidden, raw)

    def test_success_leaves_no_plaintext_token_in_any_database_field(self):
        with self.patched_gateway(FakePlaidApi()):
            self.post_exchange(data=self.valid_payload())

        connection = PlaidConnection.objects.get(user=self.user)
        for field in connection._meta.fields:
            value = getattr(connection, field.name)
            if isinstance(value, str):
                for forbidden in (
                    SYNTHETIC_ACCESS_TOKEN,
                    SYNTHETIC_PUBLIC_TOKEN,
                ):
                    self.assertNotIn(forbidden, value)
        self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, connection.access_token_encrypted)
        self.assertNotIn(
            SYNTHETIC_ACCESS_TOKEN,
            repr(
                SYNTHETIC_RING.decrypt(
                    connection.access_token_encrypted,
                    connection.encryption_key_id,
                )
            ),
        )

    def test_success_logs_nothing_sensitive(self):
        fake_api = FakePlaidApi()

        with (
            self.patched_gateway(fake_api),
            self.assertNoLogs("plaid_integration", level=logging.WARNING),
        ):
            response = self.post_exchange(data=self.valid_payload())

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)

    def test_null_or_blank_institution_name_normalizes_to_unknown(self):
        for index, institution_name in enumerate((None, "", "   ")):
            with self.subTest(institution_name=institution_name):
                fake_api = FakePlaidApi(
                    exchange_response=FakeExchangeResponse(
                        item_id=f"{SYNTHETIC_ITEM_ID}-{index}"
                    ),
                    item_response=FakeItemGetResponse(
                        institution_name=institution_name
                    ),
                )
                with self.patched_gateway(fake_api):
                    response = self.post_exchange(data=self.valid_payload())

                self.assertEqual(response.status_code, status.HTTP_201_CREATED)
                connection = PlaidConnection.objects.get(
                    user=self.user,
                    item_id=f"{SYNTHETIC_ITEM_ID}-{index}",
                )
                self.assertEqual(connection.institution_name, "Unknown institution")

    def test_invalid_requests_return_same_generic_400_without_any_mutation(self):
        malformed_payloads = [
            {},
            {"public_token": SYNTHETIC_PUBLIC_TOKEN},
            {"exchange_handle": self.issue()},
            {"public_token": "", "exchange_handle": self.issue()},
            {"public_token": "   ", "exchange_handle": self.issue()},
            {"public_token": 42, "exchange_handle": self.issue()},
            {"public_token": None, "exchange_handle": self.issue()},
            {"public_token": "p" * 201, "exchange_handle": self.issue()},
            {"public_token": SYNTHETIC_PUBLIC_TOKEN, "exchange_handle": ""},
            {"public_token": SYNTHETIC_PUBLIC_TOKEN, "exchange_handle": "a" * 42},
            {"public_token": SYNTHETIC_PUBLIC_TOKEN, "exchange_handle": "a" * 44},
            {"public_token": SYNTHETIC_PUBLIC_TOKEN, "exchange_handle": "short"},
            {"public_token": SYNTHETIC_PUBLIC_TOKEN, "exchange_handle": "bad id!"},
            {
                "public_token": SYNTHETIC_PUBLIC_TOKEN,
                "exchange_handle": self.issue(),
                "extra": "x",
            },
        ]
        handle_count_before = PlaidExchangeHandle.objects.count()
        for payload in malformed_payloads:
            with (
                self.subTest(payload=payload),
                patch("plaid_integration.views.PlaidGateway") as gateway_class,
            ):
                response = self.post_exchange(data=payload)

            self.assert_generic_400(response)
            gateway_class.from_settings.assert_not_called()
            self.assertEqual(PlaidConnection.objects.count(), 0)
            self.assertFalse(
                PlaidExchangeHandle.objects.filter(consumed_at__isnull=False).exists()
            )
        self.assertEqual(PlaidExchangeHandle.objects.count(), handle_count_before)

    def test_non_object_and_wrong_shape_bodies_return_generic_400_without_mutation(
        self,
    ):
        handle = self.issue()
        raw_json_bodies = [
            "[1, 2, 3]",
            "[]",
            '"hello"',
            "42",
            "true",
            "null",
        ]
        mapping_payloads = [
            {"public_token": {"nested": "object"}, "exchange_handle": handle},
            {"public_token": ["array"], "exchange_handle": handle},
            {"public_token": True, "exchange_handle": handle},
            {"public_token": 1.5, "exchange_handle": handle},
            {
                "public_token": SYNTHETIC_PUBLIC_TOKEN,
                "exchange_handle": {"nested": "object"},
            },
            {"public_token": SYNTHETIC_PUBLIC_TOKEN, "exchange_handle": ["array"]},
        ]
        handle_count_before = PlaidExchangeHandle.objects.count()
        for body in raw_json_bodies:
            with (
                self.subTest(body=body),
                patch("plaid_integration.views.PlaidGateway") as gateway_class,
            ):
                response = self.csrf_client.post(
                    reverse("plaid-exchange"),
                    data=body,
                    content_type="application/json",
                    HTTP_X_CSRFTOKEN=self.csrf_token,
                )

            self.assert_generic_400(response)
            gateway_class.from_settings.assert_not_called()
        for payload in mapping_payloads:
            with (
                self.subTest(payload=payload),
                patch("plaid_integration.views.PlaidGateway") as gateway_class,
            ):
                response = self.post_exchange(data=payload)

            self.assert_generic_400(response)
            gateway_class.from_settings.assert_not_called()

        self.assertEqual(PlaidConnection.objects.count(), 0)
        self.assertEqual(PlaidExchangeHandle.objects.count(), handle_count_before)
        self.assertFalse(
            PlaidExchangeHandle.objects.filter(consumed_at__isnull=False).exists()
        )

    def test_expired_consumed_foreign_and_nonexistent_handles_return_same_400(self):
        expired_handle = self.issue(expiration=timezone.now() + timedelta(minutes=5))
        PlaidExchangeHandle.objects.filter(user=self.user).update(
            expires_at=timezone.now() - timedelta(minutes=1)
        )
        consumed_handle = self.issue()
        self.assertTrue(claim_exchange_handle(self.user, consumed_handle))
        foreign_handle = self.issue(user=self.other_user)
        nonexistent_handle = secrets.token_urlsafe(32)
        valid_shape_unknown = "a" * 43

        for handle in (
            expired_handle,
            consumed_handle,
            foreign_handle,
            nonexistent_handle,
            valid_shape_unknown,
        ):
            fake_api = FakePlaidApi()
            with (
                self.subTest(handle=handle),
                self.patched_gateway(fake_api),
            ):
                response = self.post_exchange(data=self.valid_payload(handle))

            self.assert_generic_400(response)
            self.assertEqual(len(fake_api.exchange_calls), 0)
            self.assertEqual(len(fake_api.item_calls), 0)

        self.assertEqual(PlaidConnection.objects.count(), 0)
        self.assertEqual(
            PlaidExchangeHandle.objects.filter(consumed_at__isnull=False).count(),
            1,
        )
        foreign_row = PlaidExchangeHandle.objects.get(user=self.other_user)
        self.assertIsNone(foreign_row.consumed_at)

    def test_handle_is_consumed_before_provider_call_and_replay_creates_nothing(self):
        handle = self.issue()
        fake_api = FakePlaidApi()

        with self.patched_gateway(fake_api):
            first = self.post_exchange(data=self.valid_payload(handle))
            second = self.post_exchange(data=self.valid_payload(handle))

        self.assertEqual(first.status_code, status.HTTP_201_CREATED)
        self.assert_generic_400(second)
        self.assertEqual(len(fake_api.exchange_calls), 1)
        self.assertEqual(len(fake_api.item_calls), 1)
        self.assertEqual(PlaidConnection.objects.count(), 1)

    def test_handle_is_already_consumed_at_the_instant_of_provider_exchange_call(self):
        handle = self.issue()
        observed = {}

        def check_consumed_at_provider_call():
            row = PlaidExchangeHandle.objects.get(user=self.user)
            observed["consumed_at"] = row.consumed_at

        fake_api = FakePlaidApi(before_exchange=check_consumed_at_provider_call)
        with self.patched_gateway(fake_api):
            response = self.post_exchange(data=self.valid_payload(handle))

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertIsNotNone(observed["consumed_at"])
        self.assertEqual(observed["consumed_at"], self.handle_row(handle).consumed_at)
        self.assertEqual(len(fake_api.exchange_calls), 1)
        self.assertEqual(PlaidConnection.objects.count(), 1)

    def test_provider_400_from_exchange_returns_generic_400_handle_stays_consumed(self):
        error = api_error(400, {"error_code": "INVALID_PUBLIC_TOKEN"})
        fake_api = FakePlaidApi(exchange_error=error)

        with self.patched_gateway(fake_api):
            response = self.post_exchange(data=self.valid_payload())

        self.assert_generic_400(response)
        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertIsNotNone(row.consumed_at)
        self.assertEqual(PlaidConnection.objects.count(), 0)
        self.assertNotIn(SYNTHETIC_PUBLIC_TOKEN, response.content.decode())

    def test_provider_outage_and_timeout_return_503_handle_stays_consumed(self):
        for error in (
            api_error(500, {"error_message": SYNTHETIC_ACCESS_TOKEN}),
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ):
            handle = self.issue()
            with (
                self.subTest(error=error),
                self.patched_gateway(FakePlaidApi(exchange_error=error)),
            ):
                response = self.post_exchange(data=self.valid_payload(handle))

            self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
            self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
            row = self.handle_row(handle)
            self.assertIsNotNone(row.consumed_at)
            self.assertEqual(PlaidConnection.objects.count(), 0)
            self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, response.content.decode())
            self.assertNotIn(SYNTHETIC_PUBLIC_TOKEN, response.content.decode())

    def test_item_get_failure_after_exchange_returns_503_no_connection(self):
        for error in (
            api_error(400, {"error_message": "synthetic-leak"}),
            api_error(500, {"error_message": "synthetic-leak"}),
            TimeoutError("Connection timed out"),
        ):
            handle = self.issue()
            with (
                self.subTest(error=error),
                self.patched_gateway(FakePlaidApi(item_error=error)),
            ):
                response = self.post_exchange(data=self.valid_payload(handle))

            self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
            self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
            row = self.handle_row(handle)
            self.assertIsNotNone(row.consumed_at)
            self.assertEqual(PlaidConnection.objects.count(), 0)
            self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, response.content.decode())

    def test_invalid_environment_returns_503_handle_unconsumed_no_sdk_client(self):
        for plaid_env in ("production", "development", "", "Sandbox"):
            handle = self.issue()
            with (
                self.subTest(plaid_env=plaid_env),
                override_settings(PLAID_ENV=plaid_env),
                patch("plaid_integration.gateway.PlaidApi") as plaid_api_class,
                patch("plaid_integration.gateway.ApiClient") as api_client_class,
            ):
                response = self.post_exchange(data=self.valid_payload(handle))

            self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
            self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
            plaid_api_class.assert_not_called()
            api_client_class.assert_not_called()
            row = self.handle_row(handle)
            self.assertIsNone(row.consumed_at)

        self.assertEqual(PlaidConnection.objects.count(), 0)

    @override_settings(PLAID_ENABLED=False)
    def test_disabled_integration_returns_503_without_claim_or_provider_call(self):
        handle = self.issue()

        with patch("plaid_integration.views.PlaidGateway") as gateway_class:
            response = self.post_exchange(data=self.valid_payload(handle))

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.exchange_public_token.assert_not_called()
        gateway_class.return_value.get_item.assert_not_called()
        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertIsNone(row.consumed_at)
        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_same_user_same_item_heals_with_200_and_exact_shape(self):
        synced_at = timezone.now() - timedelta(days=3)
        existing = PlaidConnection.objects.create(
            user=self.user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Existing Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.ERROR,
            sync_cursor="cursor-opaque-heal-001",
            transactions_update_status=(
                TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE
            ),
            last_synced_at=synced_at,
            sync_due=False,
        )
        account = Account.objects.create(
            user=self.user,
            name="Heal Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
            is_archived=True,
        )
        link = PlaidAccountLink.objects.create(
            connection=existing,
            user=self.user,
            account=account,
            plaid_account_id="plaid-account-heal-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )
        category = Category.objects.create(
            user=self.user,
            name="Heal Salary",
            category_type=CategoryType.INCOME,
        )
        synced_tx = Transaction.objects.create(
            user=self.user,
            connection=existing,
            account=account,
            category=category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("25.00"),
            date=date(2026, 9, 1),
            provider_name="Synthetic Payroll",
            source=TransactionSource.PLAID,
            plaid_transaction_id="plaid-tx-heal-0001",
        )
        PlaidItemRemovalRequest.objects.create(
            connection=existing,
            access_token_encrypted="key-a:relocated-package",
            encryption_key_id="key-a",
            status="pending",
        )

        with self.patched_gateway(FakePlaidApi()):
            with self.assertNoLogs("plaid_integration", level=logging.WARNING):
                response = self.post_exchange(data=self.valid_payload())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(set(response.data.keys()), {"connection"})
        body = response.data["connection"]
        self.assertEqual(
            set(body.keys()),
            {"id", "institution_name", "status", "linked_accounts"},
        )
        self.assertEqual(body["id"], existing.pk)
        self.assertEqual(body["institution_name"], "Synthetic Test Bank")
        self.assertEqual(body["status"], PlaidConnectionStatus.ACTIVE)
        self.assertEqual(body["linked_accounts"], [])
        self.assertEqual(PlaidConnection.objects.count(), 1)
        existing.refresh_from_db()
        decrypted = SYNTHETIC_RING.decrypt(
            existing.access_token_encrypted,
            existing.encryption_key_id,
        )
        self.assertEqual(decrypted.plaintext.decode("ascii"), SYNTHETIC_ACCESS_TOKEN)
        self.assertNotEqual(existing.access_token_encrypted, "key-a:original-package")
        self.assertNotEqual(existing.access_token_encrypted, "key-a:relocated-package")
        self.assertEqual(existing.status, PlaidConnectionStatus.ACTIVE)
        self.assertTrue(existing.sync_due)
        self.assertEqual(existing.sync_cursor, "cursor-opaque-heal-001")
        self.assertEqual(
            existing.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        self.assertEqual(existing.last_synced_at, synced_at)
        self.assertTrue(PlaidAccountLink.objects.filter(pk=link.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=synced_tx.pk).exists())
        account.refresh_from_db()
        self.assertFalse(account.is_archived)
        self.assertFalse(
            PlaidItemRemovalRequest.objects.filter(connection_id=existing.pk).exists()
        )
        raw = response.content.decode()
        for forbidden in (
            SYNTHETIC_ACCESS_TOKEN,
            SYNTHETIC_PUBLIC_TOKEN,
            "access_token",
            "public_token",
            "item_id",
            SYNTHETIC_ITEM_ID,
            "cursor-opaque-heal-001",
            "key-a",
            "secret-test",
            "client-id-test",
        ):
            self.assertNotIn(forbidden, raw)

    def test_heal_unarchives_own_accounts_only(self):
        existing = PlaidConnection.objects.create(
            user=self.user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Existing Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
        )
        own_account = Account.objects.create(
            user=self.user,
            name="Own Archived",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("10.00"),
            is_archived=True,
        )
        PlaidAccountLink.objects.create(
            connection=existing,
            user=self.user,
            account=own_account,
            plaid_account_id="plaid-account-own-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="2222",
        )
        other_connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-other-connection-0001",
            institution_name="Other Connection Bank",
            access_token_encrypted="key-a:other-package",
            encryption_key_id="key-a",
        )
        foreign_archived = Account.objects.create(
            user=self.user,
            name="Foreign Archived",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("20.00"),
            is_archived=True,
        )
        PlaidAccountLink.objects.create(
            connection=other_connection,
            user=self.user,
            account=foreign_archived,
            plaid_account_id="plaid-account-foreign-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="3333",
        )

        with self.patched_gateway(FakePlaidApi()):
            response = self.post_exchange(data=self.valid_payload())

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        own_account.refresh_from_db()
        foreign_archived.refresh_from_db()
        self.assertFalse(own_account.is_archived)
        self.assertTrue(foreign_archived.is_archived)

    def test_heal_preserves_name_on_blank_and_updates_on_bounded(self):
        existing = PlaidConnection.objects.create(
            user=self.user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Stored Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
        )
        for blank in (None, "", "   "):
            with self.subTest(blank=blank):
                fake_api = FakePlaidApi(
                    item_response=FakeItemGetResponse(institution_name=blank)
                )
                with self.patched_gateway(fake_api):
                    response = self.post_exchange(data=self.valid_payload())
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                existing.refresh_from_db()
                self.assertEqual(existing.institution_name, "Stored Bank")
                self.assertEqual(
                    response.data["connection"]["institution_name"],
                    "Stored Bank",
                )

        with self.patched_gateway(
            FakePlaidApi(
                item_response=FakeItemGetResponse(institution_name="Bounded Bank")
            )
        ):
            response = self.post_exchange(data=self.valid_payload())
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        existing.refresh_from_db()
        self.assertEqual(existing.institution_name, "Bounded Bank")

    def test_cross_user_same_item_returns_400_and_mutates_nothing(self):
        existing = PlaidConnection.objects.create(
            user=self.other_user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Other Bank",
            access_token_encrypted="key-a:other-package",
            encryption_key_id="key-a",
            status=PlaidConnectionStatus.ERROR,
            sync_cursor="cursor-other-001",
            sync_due=False,
        )
        before = list(PlaidConnection.objects.order_by("pk").values())

        with self.patched_gateway(FakePlaidApi()):
            response = self.post_exchange(data=self.valid_payload())

        self.assert_generic_400(response)
        existing.refresh_from_db()
        self.assertEqual(existing.access_token_encrypted, "key-a:other-package")
        self.assertEqual(existing.status, PlaidConnectionStatus.ERROR)
        self.assertEqual(existing.sync_cursor, "cursor-other-001")
        self.assertFalse(existing.sync_due)
        self.assertFalse(self.user.plaid_connections.exists())
        self.assertEqual(list(PlaidConnection.objects.order_by("pk").values()), before)
        self.assertEqual(PlaidConnection.objects.count(), 1)

    def test_new_item_id_still_creates_with_201(self):
        with self.patched_gateway(FakePlaidApi()):
            response = self.post_exchange(data=self.valid_payload())

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(PlaidConnection.objects.count(), 1)
        created = PlaidConnection.objects.get(user=self.user)
        self.assertEqual(created.item_id, SYNTHETIC_ITEM_ID)

    def test_duplicate_item_for_other_user_returns_400_and_preserves_their_row(self):
        existing = PlaidConnection.objects.create(
            user=self.other_user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Other Bank",
            access_token_encrypted="key-a:other-package",
            encryption_key_id="key-a",
        )

        with self.patched_gateway(FakePlaidApi()):
            response = self.post_exchange(data=self.valid_payload())

        self.assert_generic_400(response)
        existing.refresh_from_db()
        self.assertEqual(existing.access_token_encrypted, "key-a:other-package")
        self.assertFalse(self.user.plaid_connections.exists())

    def test_duplicate_item_race_surfaces_generic_400_and_preserves_row(self):
        existing = PlaidConnection.objects.create(
            user=self.other_user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Existing Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
        )

        with (
            self.patched_gateway(FakePlaidApi()),
            patch(
                "plaid_integration.services.PlaidConnection.full_clean",
                side_effect=lambda *args, **kwargs: None,
            ),
        ):
            response = self.post_exchange(data=self.valid_payload())

        self.assert_generic_400(response)
        existing.refresh_from_db()
        self.assertEqual(existing.access_token_encrypted, "key-a:original-package")
        self.assertEqual(PlaidConnection.objects.count(), 1)

    def test_unrelated_integrity_error_propagates(self):
        handle = self.issue()

        with (
            self.patched_gateway(FakePlaidApi()),
            patch(
                "plaid_integration.services.PlaidConnection.save",
                side_effect=IntegrityError("unrelated constraint"),
            ),
        ):
            with self.assertRaises(IntegrityError):
                self.post_exchange(data=self.valid_payload(handle))

        self.assertEqual(PlaidConnection.objects.count(), 0)
        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertIsNotNone(row.consumed_at)

    def test_duplicate_item_without_diagnostic_constraint_returns_400_and_preserves_row(
        self,
    ):
        existing = PlaidConnection.objects.create(
            user=self.other_user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Existing Bank",
            access_token_encrypted="key-a:original-package",
            encryption_key_id="key-a",
        )

        with (
            self.patched_gateway(FakePlaidApi()),
            patch("plaid_integration.services._constraint_name", return_value=None),
        ):
            response = self.post_exchange(data=self.valid_payload())

        self.assert_generic_400(response)
        existing.refresh_from_db()
        self.assertEqual(existing.access_token_encrypted, "key-a:original-package")
        self.assertEqual(existing.institution_name, "Existing Bank")
        self.assertEqual(PlaidConnection.objects.count(), 1)

    def test_overlong_provider_item_id_fails_closed_without_persistence(self):
        fake_api = FakePlaidApi(
            exchange_response=FakeExchangeResponse(item_id="i" * 101),
        )

        with self.patched_gateway(fake_api):
            response = self.post_exchange(data=self.valid_payload())

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertIsNotNone(row.consumed_at)
        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_overlong_provider_institution_name_fails_closed_without_persistence(self):
        fake_api = FakePlaidApi(
            item_response=FakeItemGetResponse(institution_name="b" * 201),
        )

        with self.patched_gateway(fake_api):
            response = self.post_exchange(data=self.valid_payload())

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertIsNotNone(row.consumed_at)
        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_malformed_exchange_response_returns_503_handle_consumed_no_connection(
        self,
    ):
        malformed = [
            FakeExchangeResponse(access_token=None),
            FakeExchangeResponse(access_token=""),
            FakeExchangeResponse(access_token=123),
            FakeExchangeResponse(item_id=None),
            FakeExchangeResponse(item_id=""),
            FakeExchangeResponse(item_id=123),
            MissingExchangeResponse(),
        ]
        for exchange_response in malformed:
            handle = self.issue()
            with (
                self.subTest(exchange_response=exchange_response),
                self.patched_gateway(FakePlaidApi(exchange_response=exchange_response)),
            ):
                response = self.post_exchange(data=self.valid_payload(handle))

            self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
            self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
            row = self.handle_row(handle)
            self.assertIsNotNone(row.consumed_at)
            self.assertEqual(PlaidConnection.objects.count(), 0)
            raw = response.content.decode()
            self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, raw)
            self.assertNotIn(SYNTHETIC_PUBLIC_TOKEN, raw)

    def test_malformed_item_response_returns_503_handle_consumed_no_connection(self):
        malformed = [
            FakeItemGetResponse(institution_name=123),
            FakeItemGetResponse(institution_name=True),
            FakeItemGetResponse(institution_name=["Bank"]),
            FakeItemGetResponse(institution_name={"name": "Bank"}),
            MissingItemGetResponse(),
        ]
        for item_response in malformed:
            handle = self.issue()
            with (
                self.subTest(item_response=item_response),
                self.patched_gateway(FakePlaidApi(item_response=item_response)),
            ):
                response = self.post_exchange(data=self.valid_payload(handle))

            self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
            self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
            row = self.handle_row(handle)
            self.assertIsNotNone(row.consumed_at)
            self.assertEqual(PlaidConnection.objects.count(), 0)
            raw = response.content.decode()
            self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, raw)
            self.assertNotIn(SYNTHETIC_PUBLIC_TOKEN, raw)

    def test_anonymous_post_returns_401_without_provider_call_or_rows(self):
        with patch("plaid_integration.views.PlaidGateway") as gateway_class:
            response = self.client.post(reverse("plaid-exchange"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.exchange_public_token.assert_not_called()
        gateway_class.return_value.get_item.assert_not_called()
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)
        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_authenticated_post_without_csrf_returns_403_without_side_effects(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        with patch("plaid_integration.views.PlaidGateway") as gateway_class:
            response = csrf_client.post(reverse("plaid-exchange"))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.exchange_public_token.assert_not_called()
        gateway_class.return_value.get_item.assert_not_called()
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)
        self.assertEqual(PlaidConnection.objects.count(), 0)

    def test_unsupported_methods_return_405_without_side_effects(self):
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.csrf_client, method)(
                    reverse("plaid-exchange"),
                    HTTP_X_CSRFTOKEN=self.csrf_token,
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)
        self.assertEqual(PlaidConnection.objects.count(), 0)
