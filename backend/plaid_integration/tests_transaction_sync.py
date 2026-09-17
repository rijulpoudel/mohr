"""Tests for the ``/transactions/sync`` gateway call and safe page normalization.

Covers the ``docs/plaid.md`` section 7 sync-protocol and decimal rules and the
section 10 redaction contract for issue #38 slice B: the exact SDK request
shape (initial cursor omission, incremental cursor pass-through, no enrichment
options, bounded timeout), provider/network/timeout/mutation error mapping, the
structured-only mutation-during-pagination marker, page-metadata validation,
the narrow frozen value objects for transactions/removals, per-row redacted
quarantine with sibling continuation, account outcome carry-forward, and the
repr/log redaction guarantee. Only synthetic provider shapes and fake API
objects are used, plus one compatibility pass over the real official
plaid-python v44 model shapes; the network boundary is never exercised and no
real credentials ever appear.
"""

import dataclasses
import json
import logging
import traceback
from datetime import date, datetime
from decimal import Decimal
from unittest.mock import patch

from django.test import SimpleTestCase
from plaid import ApiException
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.model.transactions_update_status import TransactionsUpdateStatus
from urllib3.exceptions import ProtocolError

from plaid_integration.account_import import (
    ACCOUNT_ID_TOO_LONG,
    INVALID_ACCOUNT_ID,
    MISSING_ACCOUNT_ID,
    UNSUPPORTED_TYPE,
    NormalizationOutcome,
)
from plaid_integration.gateway import (
    PLAID_REQUEST_TIMEOUT_SECONDS,
    PLAID_UNAVAILABLE_DETAIL,
    PlaidGateway,
    PlaidGatewayError,
)
from plaid_integration.tests_account_import import FakeProviderAccount
from plaid_integration.transaction_sync import (
    AMOUNT_OUT_OF_RANGE,
    AMOUNT_PRECISION_EXCEEDED,
    INVALID_AMOUNT,
    INVALID_DATE,
    INVALID_DISPLAY_NAME,
    INVALID_PENDING_FLAG,
    INVALID_PENDING_TRANSACTION_ID,
    INVALID_TRANSACTION_ID,
    MALFORMED_TRANSACTION,
    MISSING_TRANSACTION_ID,
    OP_ADDED,
    OP_MODIFIED,
    OP_REMOVED,
    PLAID_TRANSACTION_ID_MAX_LENGTH,
    PROVIDER_NAME_MAX_LENGTH,
    SYNC_MUTATION_DETAIL,
    TRANSACTION_ID_TOO_LONG,
    ZERO_AMOUNT,
    NormalizedProviderTransaction,
    NormalizedSyncPage,
    PlaidSyncMutationError,
    RemovedProviderTransaction,
    TransactionQuarantineOutcome,
    normalize_provider_transaction,
    normalize_removed_transaction,
    normalize_sync_page,
)

SYNTHETIC_ACCESS_TOKEN = "access-sandbox-00000000-0000-0000-0000-000000000000"
SYNTHETIC_CURSOR = "cursor-opaque-00000000000000000000"
SYNTHETIC_TRANSACTION_ID = "tx-synthetic-0001"
SYNTHETIC_ACCOUNT_ID = "plaid-account-synthetic-0001"
SYNTHETIC_PENDING_ID = "pend-synthetic-0001"

RAW_PROVIDER_BODY_MARKER = "RAW-PROVIDER-BODY-MARKER"


class FakeProviderStatus:
    """Mirrors the plaid-python v44 ``TransactionsUpdateStatus`` ``.value``."""

    def __init__(self, value):
        self.value = value


class FakeProviderTransaction:
    """Synthetic provider transaction mirroring the narrow SDK v44 surface.

    ``date`` is a ``datetime.date`` exactly as the official ``Transaction``
    shape delivers it; ``merchant_name`` and ``pending_transaction_id`` are
    nullable; ``amount`` is a float; ``pending`` is a bool.
    """

    def __init__(
        self,
        *,
        transaction_id=SYNTHETIC_TRANSACTION_ID,
        account_id=SYNTHETIC_ACCOUNT_ID,
        pending_transaction_id=None,
        amount=12.34,
        transaction_date=date(2024, 1, 15),
        name="Synthetic Store",
        merchant_name=None,
        pending=False,
    ):
        self.transaction_id = transaction_id
        self.account_id = account_id
        self.pending_transaction_id = pending_transaction_id
        self.amount = amount
        self.date = transaction_date
        self.name = name
        self.merchant_name = merchant_name
        self.pending = pending


class FakeSyncResponse:
    """Synthetic ``/transactions/sync`` response with an enum-like status.

    Plain-string statuses are wrapped in ``FakeProviderStatus`` exactly as
    the SDK delivers its enum object; an enum-like object passed in is kept
    as-is. List fields use a sentinel default so tests can pass an explicit
    ``None`` to exercise malformed page shapes.
    """

    _UNSET = object()

    def __init__(
        self,
        *,
        status="INITIAL_UPDATE_COMPLETE",
        accounts=_UNSET,
        added=_UNSET,
        modified=_UNSET,
        removed=_UNSET,
        next_cursor=SYNTHETIC_CURSOR,
        has_more=True,
    ):
        if isinstance(status, str):
            status = FakeProviderStatus(status)
        self.transactions_update_status = status
        self.accounts = [] if accounts is FakeSyncResponse._UNSET else accounts
        self.added = [] if added is FakeSyncResponse._UNSET else added
        self.modified = [] if modified is FakeSyncResponse._UNSET else modified
        self.removed = [] if removed is FakeSyncResponse._UNSET else removed
        self.next_cursor = next_cursor
        self.has_more = has_more


class FakePlaidApi:
    """Records the real SDK request objects without any network access."""

    def __init__(self, response=None, error=None):
        self.response = response if response is not None else FakeSyncResponse()
        self.error = error
        self.sync_calls = []

    def transactions_sync(self, *, transactions_sync_request, _request_timeout=None):
        self.sync_calls.append((transactions_sync_request, _request_timeout))
        if self.error is not None:
            raise self.error
        return self.response


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


class SyncGatewayRequestTests(SimpleTestCase):
    def test_initial_call_builds_exact_sdk_request_without_cursor_or_options(self):
        fake_api = FakePlaidApi()

        result = gateway_for(fake_api).sync_transactions(SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(len(fake_api.sync_calls), 1)
        request, timeout = fake_api.sync_calls[0]
        self.assertIsInstance(request, TransactionsSyncRequest)
        sent = request.to_dict()
        self.assertEqual(
            sent,
            {
                "access_token": SYNTHETIC_ACCESS_TOKEN,
                "client_id": "client-id-test",
                "secret": "secret-test",
            },
        )
        self.assertNotIn("cursor", sent)
        self.assertNotIn("options", sent)
        self.assertNotIn("count", sent)
        self.assertEqual(timeout, PLAID_REQUEST_TIMEOUT_SECONDS)
        self.assertEqual(timeout, 30.0)
        self.assertIsInstance(result, NormalizedSyncPage)

    def test_incremental_call_sends_exact_opaque_cursor(self):
        fake_api = FakePlaidApi()

        result = gateway_for(fake_api).sync_transactions(
            SYNTHETIC_ACCESS_TOKEN, cursor=SYNTHETIC_CURSOR
        )

        request, _ = fake_api.sync_calls[0]
        self.assertEqual(request.cursor, SYNTHETIC_CURSOR)
        self.assertNotIn("options", request.to_dict())
        self.assertEqual(result.next_cursor, SYNTHETIC_CURSOR)

    def test_gateway_returns_only_normalized_page_never_the_raw_response(self):
        fake_api = FakePlaidApi(
            response=FakeSyncResponse(
                added=[FakeProviderTransaction()],
            )
        )

        result = gateway_for(fake_api).sync_transactions(SYNTHETIC_ACCESS_TOKEN)

        self.assertIsInstance(result, NormalizedSyncPage)
        self.assertEqual(len(result.added), 1)
        self.assertIsInstance(result.added[0], NormalizedProviderTransaction)
        self.assertIsNot(result.added[0], fake_api.response.added[0])
        self.assertEqual(
            {entry.name for entry in dataclasses.fields(result)},
            {
                "added",
                "modified",
                "removed",
                "account_outcomes",
                "quarantines",
                "next_cursor",
                "has_more",
                "transactions_update_status",
                "quarantined",
            },
        )


class SyncGatewayErrorTests(SimpleTestCase):
    MUTATION_BODY = {
        "display_message": None,
        "error_code": "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
        "error_message": "synthetic-mutation-body-secret",
        "error_type": "API_ERROR",
        "request_id": "req-mutation-1",
    }

    def test_mutation_error_raises_dedicated_marker_with_no_payload(self):
        error = api_error(400, self.MUTATION_BODY)

        with self.assertRaises(PlaidSyncMutationError) as raised:
            gateway_for(FakePlaidApi(error=error)).sync_transactions(
                SYNTHETIC_ACCESS_TOKEN
            )

        self.assertEqual(str(raised.exception), SYNC_MUTATION_DETAIL)
        for forbidden in (
            "synthetic-mutation-body-secret",
            SYNTHETIC_ACCESS_TOKEN,
            "req-mutation-1",
            "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
            "cursor",
        ):
            self.assertNotIn(forbidden, str(raised.exception))
            self.assertNotIn(forbidden, repr(raised.exception))
        self.assertIsNone(raised.exception.__cause__)
        # A formatted traceback must not render the handled ApiException either:
        # omitting ``from None`` would leave it as ``__context__`` and print the
        # raw provider body (docs/plaid.md section 10).
        self.assertTrue(raised.exception.__suppress_context__)
        formatted = "".join(traceback.format_exception(raised.exception))
        for forbidden in (
            "synthetic-mutation-body-secret",
            SYNTHETIC_ACCESS_TOKEN,
            "req-mutation-1",
        ):
            self.assertNotIn(forbidden, formatted)

    def test_mutation_error_is_not_a_generic_gateway_error(self):
        self.assertFalse(isinstance(PlaidSyncMutationError(), PlaidGatewayError))

    def test_malformed_error_bodies_stay_generic_safe_failures(self):
        bodies = [
            "not-json-at-all",
            "",
            json.dumps(["error_code", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"]),
            json.dumps({"error_message": "no code field"}),
            json.dumps({"error_code": "SOME_OTHER_ERROR"}),
            json.dumps({"error_code": 12345}),
        ]
        for body in bodies:
            with self.subTest(body=body):
                error = ApiException(status=400, reason="PROVIDER", http_resp=None)
                error.body = body
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(FakePlaidApi(error=error)).sync_transactions(
                        SYNTHETIC_ACCESS_TOKEN
                    )
                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
                if body:
                    self.assertNotIn(body, str(raised.exception))

    def test_provider_outage_maps_to_fixed_safe_error(self):
        error = api_error(
            500,
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": "synthetic-outage-body-secret",
            },
        )

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakePlaidApi(error=error)).sync_transactions(
                SYNTHETIC_ACCESS_TOKEN
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
        self.assertNotIn("synthetic-outage-body-secret", str(raised.exception))

    def test_timeout_and_transport_errors_map_to_fixed_safe_error(self):
        for error in (
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ):
            with self.subTest(error=error):
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(FakePlaidApi(error=error)).sync_transactions(
                        SYNTHETIC_ACCESS_TOKEN
                    )
                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_provider_failures_suppress_cause_and_never_render_body(self):
        outage = api_error(
            500,
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": (
                    f"{RAW_PROVIDER_BODY_MARKER} {SYNTHETIC_ACCESS_TOKEN}"
                ),
                "request_id": "req-sync-1",
            },
        )

        for error in (
            outage,
            api_error(
                400,
                {"error_message": f"{RAW_PROVIDER_BODY_MARKER} not a mutation"},
            ),
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ):
            with self.subTest(error=error):
                with self.assertLogs(
                    "plaid_integration.gateway", level=logging.WARNING
                ) as captured:
                    with self.assertRaises(PlaidGatewayError) as raised:
                        gateway_for(FakePlaidApi(error=error)).sync_transactions(
                            SYNTHETIC_ACCESS_TOKEN
                        )

                exception = raised.exception
                self.assertIsNone(exception.__cause__)
                self.assertEqual(str(exception), PLAID_UNAVAILABLE_DETAIL)
                formatted = "".join(traceback.format_exception(exception))
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    SYNTHETIC_ACCESS_TOKEN,
                    SYNTHETIC_CURSOR,
                    "req-sync-1",
                ):
                    self.assertNotIn(forbidden, str(exception))
                    self.assertNotIn(forbidden, repr(exception))
                    self.assertNotIn(forbidden, formatted)
                log_text = "\n".join(captured.output)
                self.assertEqual(len(captured.output), 1)
                self.assertIn("Plaid transaction sync failed.", log_text)
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    SYNTHETIC_ACCESS_TOKEN,
                    SYNTHETIC_CURSOR,
                    "req-sync-1",
                ):
                    self.assertNotIn(forbidden, log_text)

    def test_provider_failures_log_only_fixed_message_never_raw_data(self):
        error = api_error(
            500,
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": "leak-me-body",
                "request_id": "req-leak-1",
            },
        )

        with self.assertLogs(
            "plaid_integration.gateway", level=logging.WARNING
        ) as logs:
            with self.assertRaises(PlaidGatewayError):
                gateway_for(FakePlaidApi(error=error)).sync_transactions(
                    SYNTHETIC_ACCESS_TOKEN
                )

        for forbidden in (
            "leak-me-body",
            "req-leak-1",
            SYNTHETIC_ACCESS_TOKEN,
        ):
            self.assertNotIn(forbidden, "".join(logs.output))
        self.assertEqual(len(logs.output), 1)
        self.assertIn("Plaid transaction sync failed.", logs.output[0])

    def test_mutation_failure_logs_nothing_raw(self):
        error = api_error(400, self.MUTATION_BODY)

        with self.assertNoLogs("plaid_integration.gateway", level=logging.WARNING):
            with self.assertRaises(PlaidSyncMutationError):
                gateway_for(FakePlaidApi(error=error)).sync_transactions(
                    SYNTHETIC_ACCESS_TOKEN
                )

    def test_programmer_defects_propagate_unswallowed(self):
        for defect in (
            ValueError("programmer defect"),
            RuntimeError("boom"),
            TypeError(),
        ):
            with self.subTest(defect=defect):
                with self.assertRaises(type(defect)):
                    gateway_for(FakePlaidApi(error=defect)).sync_transactions(
                        SYNTHETIC_ACCESS_TOKEN
                    )


class NormalizeProviderTransactionTests(SimpleTestCase):
    def normalize(self, operation=OP_ADDED, **overrides):
        return normalize_provider_transaction(
            FakeProviderTransaction(**overrides), operation
        )

    def assert_normalized(self, outcome, **expected):
        self.assertFalse(outcome.skipped)
        self.assertIsNone(outcome.quarantine)
        transaction = outcome.transaction
        self.assertIsInstance(transaction, NormalizedProviderTransaction)
        for name, value in expected.items():
            self.assertEqual(getattr(transaction, name), value)
        return transaction

    def assert_quarantined(self, outcome, operation, reason):
        self.assertTrue(outcome.skipped)
        self.assertIsNone(outcome.transaction)
        self.assertEqual(
            outcome.quarantine,
            TransactionQuarantineOutcome(operation=operation, reason=reason),
        )

    def test_positive_amount_is_expense_with_positive_decimal(self):
        transaction = self.assert_normalized(
            self.normalize(amount=12.34),
            amount=Decimal("12.34"),
            transaction_type="expense",
        )
        self.assertTrue(transaction.amount > 0)

    def test_negative_amount_is_income_with_positive_decimal(self):
        transaction = self.assert_normalized(
            self.normalize(amount=-45.5),
            amount=Decimal("45.50"),
            transaction_type="income",
        )
        self.assertTrue(transaction.amount > 0)

    def test_string_amount_parses_decimal_safe(self):
        self.assert_normalized(
            self.normalize(amount="12.34"),
            amount=Decimal("12.34"),
            transaction_type="expense",
        )

    def test_binary_boundary_parsing_discriminates_safe_str_serialization(self):
        exact_tenth = self.assert_normalized(
            self.normalize(amount=0.1),
            amount=Decimal("0.10"),
            transaction_type="expense",
        )
        self.assertEqual(exact_tenth.amount, Decimal("0.10"))
        self.assert_quarantined(
            self.normalize(amount=0.1 + 0.2),
            OP_ADDED,
            AMOUNT_PRECISION_EXCEEDED,
        )

    def test_zero_amount_is_quarantined(self):
        for zero in (0, 0.0, "0.00", Decimal("0.000")):
            with self.subTest(zero=zero):
                self.assert_quarantined(
                    self.normalize(amount=zero),
                    OP_ADDED,
                    ZERO_AMOUNT,
                )

    def test_fractional_amounts_beyond_cents_are_quarantined_not_rounded(self):
        for amount in (12.345, "1.005", -7.999):
            with self.subTest(amount=amount):
                self.assert_quarantined(
                    self.normalize(amount=amount),
                    OP_ADDED,
                    AMOUNT_PRECISION_EXCEEDED,
                )

    def test_bool_and_non_finite_and_unparseable_amounts_are_quarantined(self):
        for amount in (True, False, float("nan"), float("inf"), float("-inf"), "abc"):
            with self.subTest(amount=amount):
                self.assert_quarantined(
                    self.normalize(amount=amount),
                    OP_ADDED,
                    INVALID_AMOUNT,
                )

    def test_amount_out_of_model_range_is_quarantined(self):
        self.assert_quarantined(
            self.normalize(amount="10000000000.00"),
            OP_ADDED,
            AMOUNT_OUT_OF_RANGE,
        )
        self.assert_quarantined(
            self.normalize(amount="1E+1000"),
            OP_ADDED,
            AMOUNT_OUT_OF_RANGE,
        )
        self.assert_quarantined(
            self.normalize(amount=1e1000),
            OP_ADDED,
            INVALID_AMOUNT,
        )
        self.assert_normalized(
            self.normalize(amount="9999999999.99"),
            amount=Decimal("9999999999.99"),
            transaction_type="expense",
        )

    def test_date_uses_posted_date_object(self):
        self.assert_normalized(
            self.normalize(transaction_date=date(2024, 6, 30)),
            date=date(2024, 6, 30),
        )

    def test_datetime_and_iso_string_dates_become_python_dates(self):
        self.assert_normalized(
            self.normalize(transaction_date=datetime(2024, 6, 30, 14, 5)),
            date=date(2024, 6, 30),
        )
        self.assert_normalized(
            self.normalize(transaction_date="2024-06-30"),
            date=date(2024, 6, 30),
        )

    def test_invalid_dates_are_quarantined(self):
        for value in (None, "2024-13-01", "yesterday", 12345, []):
            with self.subTest(value=value):
                self.assert_quarantined(
                    self.normalize(transaction_date=value),
                    OP_ADDED,
                    INVALID_DATE,
                )

    def test_display_name_prefers_merchant_name_when_nonblank(self):
        self.assert_normalized(
            self.normalize(name="Store Name", merchant_name="Merchant X"),
            name="Merchant X",
        )

    def test_display_name_falls_back_to_name_when_merchant_blank(self):
        for merchant in (None, "", "   "):
            with self.subTest(merchant=merchant):
                self.assert_normalized(
                    self.normalize(name="Store Name", merchant_name=merchant),
                    name="Store Name",
                )

    def test_display_name_is_bounded_to_provider_name_model_max(self):
        transaction = self.assert_normalized(
            self.normalize(
                name="n" * 500,
                merchant_name="m" * 300,
            ),
            name="m" * PROVIDER_NAME_MAX_LENGTH,
        )
        self.assertEqual(len(transaction.name), PROVIDER_NAME_MAX_LENGTH)
        fallback = self.assert_normalized(
            self.normalize(name="n" * 300, merchant_name=None),
            name="n" * PROVIDER_NAME_MAX_LENGTH,
        )
        self.assertEqual(len(fallback.name), PROVIDER_NAME_MAX_LENGTH)

    def test_blank_or_missing_display_name_is_quarantined(self):
        for name, merchant in ((None, None), ("", None), ("   ", None), (123, None)):
            with self.subTest(name=name):
                self.assert_quarantined(
                    self.normalize(name=name, merchant_name=merchant),
                    OP_ADDED,
                    INVALID_DISPLAY_NAME,
                )

    def test_transaction_id_must_be_exact_nonblank_string(self):
        for value, reason in (
            (None, MISSING_TRANSACTION_ID),
            ("", INVALID_TRANSACTION_ID),
            ("   ", INVALID_TRANSACTION_ID),
            (" padded-id", INVALID_TRANSACTION_ID),
            ("padded-id ", INVALID_TRANSACTION_ID),
            (123, INVALID_TRANSACTION_ID),
            (["id"], INVALID_TRANSACTION_ID),
        ):
            with self.subTest(value=value):
                self.assert_quarantined(
                    self.normalize(transaction_id=value),
                    OP_ADDED,
                    reason,
                )

    def test_transaction_id_within_model_bound_passes_exact(self):
        self.assert_normalized(
            self.normalize(
                transaction_id="t" * PLAID_TRANSACTION_ID_MAX_LENGTH,
                name="Boundary",
            ),
            transaction_id="t" * PLAID_TRANSACTION_ID_MAX_LENGTH,
        )
        self.assert_quarantined(
            self.normalize(transaction_id="t" * (PLAID_TRANSACTION_ID_MAX_LENGTH + 1)),
            OP_ADDED,
            TRANSACTION_ID_TOO_LONG,
        )

    def test_account_id_must_be_exact_nonblank_string(self):
        for value, reason in (
            (None, MISSING_ACCOUNT_ID),
            ("", INVALID_ACCOUNT_ID),
            (" padded", INVALID_ACCOUNT_ID),
            ("padded ", INVALID_ACCOUNT_ID),
            (123, INVALID_ACCOUNT_ID),
        ):
            with self.subTest(value=value):
                self.assert_quarantined(
                    self.normalize(account_id=value),
                    OP_ADDED,
                    reason,
                )
        self.assert_quarantined(
            self.normalize(account_id="a" * 101),
            OP_ADDED,
            ACCOUNT_ID_TOO_LONG,
        )

    def test_pending_transaction_id_is_preserved_when_nullable_or_valid(self):
        self.assert_normalized(
            self.normalize(pending_transaction_id=None),
            pending_transaction_id=None,
        )
        self.assert_normalized(
            self.normalize(pending_transaction_id=SYNTHETIC_PENDING_ID),
            pending_transaction_id=SYNTHETIC_PENDING_ID,
        )

    def test_malformed_pending_transaction_id_quarantines_the_row(self):
        for value in ("", " padded", "padded ", 123, "p" * 101):
            with self.subTest(value=value):
                self.assert_quarantined(
                    self.normalize(pending_transaction_id=value),
                    OP_ADDED,
                    INVALID_PENDING_TRANSACTION_ID,
                )

    def test_pending_flag_must_be_bool(self):
        self.assert_normalized(self.normalize(pending=True), is_pending=True)
        self.assert_normalized(self.normalize(pending=False), is_pending=False)
        for value in (None, 1, "yes"):
            with self.subTest(value=value):
                self.assert_quarantined(
                    self.normalize(pending=value),
                    OP_ADDED,
                    INVALID_PENDING_FLAG,
                )

    def test_malformed_provider_row_is_quarantined(self):
        outcome = normalize_provider_transaction(None, OP_ADDED)
        self.assert_quarantined(outcome, OP_ADDED, MALFORMED_TRANSACTION)

    def test_operation_kind_is_carried_into_quarantine(self):
        self.assert_quarantined(
            self.normalize(operation=OP_MODIFIED, amount=0),
            OP_MODIFIED,
            ZERO_AMOUNT,
        )

    def test_value_object_extracts_only_the_frozen_field_set(self):
        transaction = self.assert_normalized(self.normalize())
        self.assertEqual(
            {entry.name for entry in dataclasses.fields(transaction)},
            {
                "transaction_id",
                "account_id",
                "pending_transaction_id",
                "amount",
                "transaction_type",
                "date",
                "name",
                "is_pending",
            },
        )

    def test_value_object_repr_never_exposes_provider_values(self):
        transaction = self.assert_normalized(
            self.normalize(
                transaction_id="secret-tx-id",
                account_id="secret-account-id",
                pending_transaction_id="secret-pending-id",
                amount=9876.54,
                transaction_date=date(2024, 1, 1),
                name="Secret Merchant Name",
                pending=True,
            )
        )
        for forbidden in (
            "secret-tx-id",
            "secret-account-id",
            "secret-pending-id",
            "9876.54",
            "2024-01-01",
            "Secret Merchant Name",
        ):
            self.assertNotIn(forbidden, repr(transaction))

    def test_quarantine_outcome_repr_carries_only_operation_and_reason(self):
        quarantine = TransactionQuarantineOutcome(
            operation=OP_ADDED, reason=AMOUNT_PRECISION_EXCEEDED
        )
        self.assertEqual(
            repr(quarantine),
            "TransactionQuarantineOutcome(operation='added', "
            "reason='amount precision exceeded')",
        )


class NormalizeRemovedTransactionTests(SimpleTestCase):
    def test_valid_removal_normalizes_to_exact_transaction_id(self):
        outcome = normalize_removed_transaction(
            FakeProviderTransaction(
                transaction_id=SYNTHETIC_TRANSACTION_ID,
                name="Any Shape",
            )
        )

        self.assertFalse(outcome.skipped)
        self.assertIsNone(outcome.quarantine)
        self.assertEqual(
            outcome.transaction,
            RemovedProviderTransaction(transaction_id=SYNTHETIC_TRANSACTION_ID),
        )

    def test_malformed_removal_becomes_per_row_quarantine(self):
        for value in (None, "", "   ", " padded", "padded ", 123, "r" * 101):
            with self.subTest(value=value):
                outcome = normalize_removed_transaction(
                    FakeProviderTransaction(transaction_id=value)
                )
                self.assertTrue(outcome.skipped)
                self.assertIsNone(outcome.transaction)
                self.assertEqual(outcome.quarantine.operation, OP_REMOVED)
                self.assertIsNotNone(outcome.quarantine.reason)
                if value:
                    self.assertNotIn(str(value), repr(outcome.quarantine))

    def test_removal_value_object_repr_is_safe(self):
        outcome = normalize_removed_transaction(
            FakeProviderTransaction(transaction_id="secret-removed-id")
        )
        self.assertNotIn("secret-removed-id", repr(outcome.transaction))


class NormalizeSyncPageTests(SimpleTestCase):
    def build_page(self, **overrides):
        defaults = dict(
            status="HISTORICAL_UPDATE_COMPLETE",
            accounts=[FakeProviderAccount()],
            added=[FakeProviderTransaction()],
            modified=[],
            removed=[],
        )
        defaults.update(overrides)
        return normalize_sync_page(FakeSyncResponse(**defaults))

    def test_accepts_every_supported_update_status(self):
        for status in (
            "NOT_READY",
            "INITIAL_UPDATE_COMPLETE",
            "HISTORICAL_UPDATE_COMPLETE",
        ):
            with self.subTest(status=status):
                page = self.build_page(status=status)
                self.assertEqual(page.transactions_update_status, status)

    def test_accepts_status_from_sdk_enum_value_attribute(self):
        response = FakeSyncResponse(status=FakeProviderStatus("NOT_READY"))
        self.assertEqual(
            normalize_sync_page(response).transactions_update_status, "NOT_READY"
        )

    def test_unsupported_or_malformed_status_fails_the_page(self):
        for status in ("TRANSACTIONS_UPDATE_STATUS_UNKNOWN", None, 123, ["NOT_READY"]):
            with self.subTest(status=status):
                with self.assertRaises(PlaidGatewayError) as raised:
                    self.build_page(status=status)
                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_non_list_arrays_fail_the_page(self):
        for name in ("added", "modified", "removed", "accounts"):
            for value in (None, "not-a-list", (FakeProviderTransaction(),), 5):
                with self.subTest(name=name, value=value):
                    overrides = {name: value}
                    with self.assertRaises(PlaidGatewayError):
                        self.build_page(**overrides)

    def test_next_cursor_must_be_nonempty_string(self):
        for cursor in ("", None, 123, ["cursor"]):
            with self.subTest(cursor=cursor):
                with self.assertRaises(PlaidGatewayError):
                    self.build_page(next_cursor=cursor)

    def test_has_more_must_be_bool(self):
        for value in (None, 1, 0, "true"):
            with self.subTest(value=value):
                with self.assertRaises(PlaidGatewayError):
                    self.build_page(has_more=value)

    def test_page_failure_never_leaks_raw_values(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            self.build_page(next_cursor=12345)
        for forbidden in ("12345", "HISTORICAL_UPDATE_COMPLETE"):
            self.assertNotIn(forbidden, str(raised.exception))

    def test_malformed_row_quarantines_while_valid_siblings_survive(self):
        page = self.build_page(
            added=[
                FakeProviderTransaction(transaction_id="tx-good-1", amount=10.00),
                FakeProviderTransaction(transaction_id="tx-bad-1", amount=0),
                FakeProviderTransaction(transaction_id="tx-bad-2", amount=0.1 + 0.2),
            ],
            modified=[
                FakeProviderTransaction(
                    transaction_id="tx-mod-1", amount=5.00, pending=True
                ),
                FakeProviderTransaction(
                    transaction_id="tx-mod-bad", transaction_date="not-a-date"
                ),
            ],
            removed=[
                FakeProviderTransaction(transaction_id="tx-removed-1"),
                FakeProviderTransaction(transaction_id=" padded"),
            ],
        )

        self.assertEqual(
            [t.transaction_id for t in page.added],
            ["tx-good-1"],
        )
        self.assertEqual(
            [t.transaction_id for t in page.modified],
            ["tx-mod-1"],
        )
        self.assertEqual(
            [t.transaction_id for t in page.removed],
            ["tx-removed-1"],
        )
        self.assertEqual(page.quarantined, 4)
        operations = {q.operation for q in page.quarantines}
        self.assertEqual(operations, {OP_ADDED, OP_MODIFIED, OP_REMOVED})
        for quarantine in page.quarantines:
            for forbidden in (
                "tx-bad-1",
                "tx-bad-2",
                "tx-mod-bad",
                "not-a-date",
                " padded",
                "0.30000000000000004",
            ):
                self.assertNotIn(forbidden, repr(quarantine))
                self.assertNotIn(forbidden, str(quarantine))

    def test_account_outcomes_are_carried_forward(self):
        page = self.build_page(
            accounts=[
                FakeProviderAccount(),
                FakeProviderAccount(
                    account_id="plaid-account-loan-1",
                    account_type="loan",
                    subtype="auto",
                ),
            ]
        )

        self.assertEqual(len(page.account_outcomes), 2)
        self.assertIsInstance(page.account_outcomes[0], NormalizationOutcome)
        self.assertFalse(page.account_outcomes[0].skipped)
        self.assertIsNotNone(page.account_outcomes[0].account)
        self.assertTrue(page.account_outcomes[1].skipped)
        self.assertEqual(page.account_outcomes[1].reason, UNSUPPORTED_TYPE)

    def test_page_repr_shows_only_safe_status_booleans_and_counts(self):
        page = self.build_page(
            status="INITIAL_UPDATE_COMPLETE",
            added=[
                FakeProviderTransaction(
                    transaction_id="secret-page-tx",
                    account_id="secret-page-account",
                    amount=1234.56,
                    transaction_date=date(2024, 1, 1),
                    name="Secret Page Name",
                )
            ],
            removed=[FakeProviderTransaction(transaction_id="secret-removed")],
            next_cursor="secret-page-cursor",
        )
        text = repr(page)
        self.assertIn("has_more=True", text)
        self.assertIn("transactions_update_status='INITIAL_UPDATE_COMPLETE'", text)
        self.assertIn("quarantined=0", text)
        for forbidden in (
            "secret-page-tx",
            "secret-page-account",
            "1234.56",
            "2024-01-01",
            "Secret Page Name",
            "secret-removed",
            "secret-page-cursor",
        ):
            self.assertNotIn(forbidden, text)

    def test_page_never_retains_raw_payload(self):
        page = self.build_page()
        for entry in dataclasses.fields(page):
            value = getattr(page, entry.name)
            if isinstance(value, tuple):
                for item in value:
                    self.assertNotIsInstance(item, FakeProviderTransaction)
                    self.assertNotIsInstance(item, FakeProviderAccount)
                    self.assertNotIsInstance(item, FakeSyncResponse)
            else:
                self.assertNotIsInstance(value, FakeSyncResponse)

    def test_normalization_logs_nothing(self):
        with self.assertNoLogs(
            "plaid_integration.transaction_sync", level=logging.WARNING
        ):
            self.build_page(
                added=[
                    FakeProviderTransaction(transaction_id="tx-quiet-1", amount=1.0),
                    FakeProviderTransaction(transaction_id="tx-quiet-2", amount=0),
                ],
                accounts=[
                    FakeProviderAccount(),
                    FakeProviderAccount(account_type="loan", subtype="auto"),
                ],
            )

    def test_empty_page_normalizes_with_zero_counts(self):
        page = self.build_page(accounts=[], added=[], modified=[], removed=[])
        self.assertEqual((page.added, page.modified, page.removed), ((), (), ()))
        self.assertEqual(page.account_outcomes, ())
        self.assertEqual(page.quarantined, 0)


class RealSdkShapeCompatibilityTests(SimpleTestCase):
    """Instantiate the official v44 model shapes to prove compatibility."""

    def test_real_request_shape_with_omitted_and_set_cursor(self):
        request = TransactionsSyncRequest(
            access_token=SYNTHETIC_ACCESS_TOKEN,
            client_id="client-id-test",
            secret="secret-test",
        )
        self.assertEqual(
            request.to_dict(),
            {
                "access_token": SYNTHETIC_ACCESS_TOKEN,
                "client_id": "client-id-test",
                "secret": "secret-test",
            },
        )
        request.cursor = SYNTHETIC_CURSOR
        self.assertEqual(request.cursor, SYNTHETIC_CURSOR)

    def test_real_response_objects_normalize_through_the_gateway(self):
        from plaid.model.account_balance import AccountBalance
        from plaid.model.account_base import AccountBase
        from plaid.model.account_subtype import AccountSubtype
        from plaid.model.account_type import AccountType
        from plaid.model.location import Location
        from plaid.model.payment_meta import PaymentMeta
        from plaid.model.personal_finance_category import PersonalFinanceCategory
        from plaid.model.transaction import Transaction
        from plaid.model.transactions_sync_response import TransactionsSyncResponse

        location = Location(
            address=None,
            city=None,
            country=None,
            lat=None,
            lon=None,
            postal_code=None,
            region=None,
            store_number=None,
        )
        payment_meta = PaymentMeta(
            reference_number=None,
            ppd_id=None,
            payee=None,
            by_order_of=None,
            payer=None,
            payment_method=None,
            payment_processor=None,
            reason=None,
            payee_street_address=None,
            payee_city=None,
            payee_state=None,
            payee_postal_code=None,
            payee_country=None,
            payer_street_address=None,
            payer_city=None,
            payer_state=None,
            payer_postal_code=None,
            payer_country=None,
        )
        transaction = Transaction(
            account_id=SYNTHETIC_ACCOUNT_ID,
            amount=-42.5,
            iso_currency_code="USD",
            unofficial_currency_code=None,
            date=date(2024, 2, 29),
            location=location,
            name="Real SDK Store",
            payment_meta=payment_meta,
            pending=True,
            pending_transaction_id=SYNTHETIC_PENDING_ID,
            account_owner=None,
            transaction_id=SYNTHETIC_TRANSACTION_ID,
            authorized_date=None,
            authorized_datetime=None,
            datetime=None,
            payment_channel="in store",
            transaction_code=None,
            category=None,
            category_id=None,
            check_number=None,
            merchant_name="Real SDK Merchant",
            original_description=None,
            transaction_type="place",
            logo_url=None,
            website=None,
            personal_finance_category=PersonalFinanceCategory(
                primary="GENERAL_MERCHANDISE",
                detailed="GENERAL_MERCHANDISE_OTHER",
            ),
            business_finance_category=None,
            personal_finance_category_icon_url="",
            counterparties=[],
            merchant_entity_id=None,
            merchant_category_code=None,
            running_balance=None,
            client_customization=None,
        )
        response = TransactionsSyncResponse(
            transactions_update_status=TransactionsUpdateStatus(
                "HISTORICAL_UPDATE_COMPLETE"
            ),
            accounts=[
                AccountBase(
                    account_id=SYNTHETIC_ACCOUNT_ID,
                    balances=AccountBalance(
                        available=10.0,
                        current=100.0,
                        iso_currency_code="USD",
                        unofficial_currency_code=None,
                        limit=None,
                    ),
                    mask="1234",
                    name="Checking",
                    official_name=None,
                    type=AccountType("depository"),
                    subtype=AccountSubtype("checking"),
                    verification_status="",
                    persistent_account_id="",
                )
            ],
            added=[transaction],
            modified=[],
            removed=[],
            next_cursor=SYNTHETIC_CURSOR,
            has_more=True,
            request_id="req-real-1",
        )

        fake_api = FakePlaidApi(response=response)
        page = gateway_for(fake_api).sync_transactions(SYNTHETIC_ACCESS_TOKEN)

        self.assertEqual(page.transactions_update_status, "HISTORICAL_UPDATE_COMPLETE")
        self.assertTrue(page.has_more)
        self.assertEqual(page.next_cursor, SYNTHETIC_CURSOR)
        self.assertEqual(len(page.account_outcomes), 1)
        self.assertFalse(page.account_outcomes[0].skipped)
        self.assertEqual(len(page.added), 1)
        normalized = page.added[0]
        self.assertEqual(normalized.transaction_id, SYNTHETIC_TRANSACTION_ID)
        self.assertEqual(normalized.amount, Decimal("42.50"))
        self.assertEqual(normalized.transaction_type, "income")
        self.assertEqual(normalized.date, date(2024, 2, 29))
        self.assertEqual(normalized.name, "Real SDK Merchant")
        self.assertEqual(normalized.is_pending, True)
        self.assertEqual(normalized.pending_transaction_id, SYNTHETIC_PENDING_ID)
        self.assertEqual(page.quarantined, 0)

    def test_real_mutation_error_body_is_recognized(self):
        error = api_error(
            400,
            {
                "display_message": None,
                "error_code": "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
                "error_message": "cursor is stale",
                "error_type": "API_ERROR",
                "request_id": "req-mutation-real",
            },
        )

        with self.assertRaises(PlaidSyncMutationError):
            gateway_for(FakePlaidApi(error=error)).sync_transactions(
                SYNTHETIC_ACCESS_TOKEN
            )

    def test_missing_response_attributes_fail_the_page_safely(self):
        class DefectiveResponse:
            transactions_update_status = FakeProviderStatus("NOT_READY")

        with self.assertRaises(PlaidGatewayError):
            gateway_for(FakePlaidApi(response=DefectiveResponse())).sync_transactions(
                SYNTHETIC_ACCESS_TOKEN
            )

    def test_normalization_defects_propagate_through_the_gateway(self):
        with patch(
            "plaid_integration.transaction_sync.normalize_sync_page",
            side_effect=ValueError("normalizer defect"),
        ):
            with self.assertRaises(ValueError):
                gateway_for(FakePlaidApi()).sync_transactions(SYNTHETIC_ACCESS_TOKEN)
