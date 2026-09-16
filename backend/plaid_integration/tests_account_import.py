"""Tests for provider-account normalization and idempotent account import.

Covers the ``docs/plaid.md`` section 4 account-type mapping, the section 5
anchor capture, and the section 10 redaction contract for issue #38 slice A:
the narrow value object at the Plaid integration boundary, decimal-safe
balance parsing, mask minimization, idempotent replay, ownership fail-closed
rollback, and the bounded safe connection error summary. Only synthetic
provider shapes are used; the fakes mirror the attribute surface of the
official plaid-python v44 ``AccountBase`` objects (``type``/``subtype``
enums expose ``.value``, balances expose ``.current``/``.available``) that
arrive in the ``accounts`` array of a ``/transactions/sync`` response. The
network boundary is never exercised.
"""

import dataclasses
import logging
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import SimpleTestCase, TestCase

from accounts.models import Account, AccountType
from plaid_integration.account_import import (
    ACCOUNT_ID_TOO_LONG,
    ACCOUNT_IMPORT_ERROR_MAX_LENGTH,
    ACCOUNT_IMPORT_ERROR_TAG,
    BALANCE_OUT_OF_RANGE,
    INVALID_ACCOUNT_ID,
    INVALID_AVAILABLE_BALANCE,
    INVALID_CURRENT_BALANCE,
    INVALID_MASK,
    INVALID_NAME,
    INVALID_TYPE,
    MALFORMED_ACCOUNT,
    MISSING_ACCOUNT_ID,
    MISSING_CURRENT_BALANCE,
    MISSING_SUBTYPE,
    UNSUPPORTED_SUBTYPE,
    UNSUPPORTED_TYPE,
    AccountImportError,
    AccountImportResult,
    NormalizedProviderAccount,
    import_provider_accounts,
    normalize_provider_account,
)
from plaid_integration.models import PlaidAccountLink, PlaidConnection

SYNTHETIC_ACCOUNT_ID = "plaid-account-synthetic-0001"
SYNTHETIC_ITEM_ID = "item-sandbox-account-import-00001"
SYNTHETIC_LINK_CONSTRAINT = "plaid_account_link_connection_plaid_account_id_unique"


class FakeProviderType:
    def __init__(self, value):
        self.value = value


class FakeProviderSubtype:
    def __init__(self, value):
        self.value = value


class FakeBalances:
    def __init__(self, current=None, available=None):
        self.current = current
        self.available = available


class FakeProviderAccount:
    """Synthetic provider account mirroring plaid-python v44 ``AccountBase``.

    ``type`` and ``subtype`` behave like the SDK enum objects (a ``.value``
    attribute), ``balances`` like ``AccountBalance``, and ``mask`` is a
    nullable string, exactly as the official shapes expose them.
    """

    def __init__(
        self,
        *,
        account_id=SYNTHETIC_ACCOUNT_ID,
        name="Everyday Checking",
        account_type="depository",
        subtype="checking",
        mask="4321",
        current=123.45,
        available=None,
    ):
        self.account_id = account_id
        self.name = name
        self.type = FakeProviderType(account_type)
        self.subtype = FakeProviderSubtype(subtype) if subtype is not None else None
        self.mask = mask
        self.balances = FakeBalances(current=current, available=available)


class FakeBalancesWithoutCurrent:
    pass


class _Diag:
    def __init__(self, constraint_name):
        self.constraint_name = constraint_name


class _DiagnosticCause(Exception):
    def __init__(self, constraint_name):
        self.diag = _Diag(constraint_name)


def _integrity_error(constraint_name):
    error = IntegrityError("constraint failed")
    error.__cause__ = _DiagnosticCause(constraint_name)
    return error


class NormalizeProviderAccountTests(SimpleTestCase):
    def normalize(self, **overrides):
        return normalize_provider_account(FakeProviderAccount(**overrides))

    def assert_imported(self, normalization, **expected):
        self.assertFalse(normalization.skipped)
        self.assertIsNone(normalization.reason)
        account = normalization.account
        self.assertIsInstance(account, NormalizedProviderAccount)
        for name, value in expected.items():
            self.assertEqual(getattr(account, name), value)
        return account

    def assert_skipped(self, normalization, reason):
        self.assertTrue(normalization.skipped)
        self.assertIsNone(normalization.account)
        self.assertEqual(normalization.reason, reason)

    def test_maps_depository_checking_to_mohr_checking(self):
        account = self.assert_imported(
            self.normalize(),
            plaid_account_id=SYNTHETIC_ACCOUNT_ID,
            name="Everyday Checking",
            mask="4321",
            account_type=AccountType.CHECKING,
            plaid_type="depository",
            plaid_subtype="checking",
            current_balance=Decimal("123.45"),
            available_balance=None,
        )
        self.assertEqual(account.account_type, "checking")

    def test_maps_depository_savings_to_mohr_savings(self):
        account = self.assert_imported(
            self.normalize(
                account_id="plaid-account-savings-1",
                name="High Yield Savings",
                subtype="savings",
                mask="1111",
                current=2500.00,
            ),
            account_type=AccountType.SAVINGS,
            plaid_subtype="savings",
        )
        self.assertEqual(account.account_type, "savings")

    def test_maps_credit_credit_card_to_mohr_credit_card(self):
        account = self.assert_imported(
            self.normalize(
                account_id="plaid-account-card-1",
                name="Travel Rewards Card",
                account_type="credit",
                subtype="credit card",
                mask="9999",
                current=400.00,
                available=1600.00,
            ),
            account_type=AccountType.CREDIT_CARD,
            plaid_type="credit",
            plaid_subtype="credit card",
            current_balance=Decimal("400.00"),
            available_balance=Decimal("1600.00"),
        )
        self.assertEqual(account.account_type, "credit_card")

    def test_accepts_plain_string_type_and_subtype_shapes(self):
        account = FakeProviderAccount()
        account.type = "depository"
        account.subtype = "checking"

        normalization = normalize_provider_account(account)

        self.assert_imported(
            normalization,
            account_type=AccountType.CHECKING,
            plaid_type="depository",
            plaid_subtype="checking",
        )

    def test_never_maps_any_provider_shape_to_cash(self):
        combos = [
            ("depository", "cash management"),
            ("depository", "hsa"),
            ("depository", "paypal"),
            ("depository", "money market"),
            ("credit", "charge card"),
            ("credit", "line of credit"),
            ("loan", "auto"),
            ("investment", "ira"),
            ("other", "other"),
            ("brokerage", "brokerage"),
        ]
        for account_type, subtype in combos:
            with self.subTest(account_type=account_type, subtype=subtype):
                self.assertTrue(
                    self.normalize(account_type=account_type, subtype=subtype).skipped
                )

        self.assertNotIn(
            AccountType.CASH,
            {
                value
                for value in (
                    ("depository", "checking"),
                    ("depository", "savings"),
                    ("credit", "credit card"),
                )
            },
        )

    def test_skips_missing_or_non_string_type(self):
        account = FakeProviderAccount()
        account.type = None
        self.assert_skipped(normalize_provider_account(account), INVALID_TYPE)
        account.type = 123
        self.assert_skipped(normalize_provider_account(account), INVALID_TYPE)

    def test_skips_unsupported_account_types_without_guessing(self):
        for account_type in ("loan", "investment", "brokerage", "other", "crypto"):
            with self.subTest(account_type=account_type):
                self.assert_skipped(
                    self.normalize(account_type=account_type, subtype="checking"),
                    UNSUPPORTED_TYPE,
                )

    def test_skips_unknown_depository_subtypes(self):
        for subtype in ("money market", "hsa", "cash management", "paypal"):
            with self.subTest(subtype=subtype):
                self.assert_skipped(
                    self.normalize(subtype=subtype),
                    UNSUPPORTED_SUBTYPE,
                )

    def test_skips_unknown_credit_subtypes(self):
        for subtype in ("charge card", "line of credit", None):
            with self.subTest(subtype=subtype):
                normalization = self.normalize(account_type="credit", subtype=subtype)
                self.assertTrue(normalization.skipped)
                self.assertIsNotNone(normalization.reason)

    def test_skips_missing_subtype(self):
        self.assert_skipped(self.normalize(subtype=None), MISSING_SUBTYPE)

    def test_skips_missing_blank_and_non_string_account_ids(self):
        for account_id in (None, "", "   ", 123, ["id"]):
            with self.subTest(account_id=account_id):
                normalization = self.normalize(account_id=account_id)
                self.assertTrue(normalization.skipped)
                expected = (
                    MISSING_ACCOUNT_ID if account_id is None else INVALID_ACCOUNT_ID
                )
                self.assertEqual(normalization.reason, expected)

    def test_skips_overlong_account_id_without_truncation(self):
        self.assert_skipped(
            self.normalize(account_id="p" * 101),
            ACCOUNT_ID_TOO_LONG,
        )

    def test_skips_account_ids_with_leading_or_trailing_whitespace(self):
        for account_id in (" padded-id", "padded-id ", "  padded-id  "):
            with self.subTest(account_id=account_id):
                self.assert_skipped(
                    self.normalize(account_id=account_id),
                    INVALID_ACCOUNT_ID,
                )

    def test_stores_internal_whitespace_account_ids_exactly(self):
        account = self.assert_imported(
            self.normalize(account_id="plaid-account with spaces-1"),
            plaid_account_id="plaid-account with spaces-1",
        )
        self.assertEqual(account.plaid_account_id, "plaid-account with spaces-1")

    def test_skips_missing_blank_or_non_string_display_name(self):
        for name in (None, "", "   ", 123, ["name"]):
            with self.subTest(name=name):
                self.assert_skipped(self.normalize(name=name), INVALID_NAME)

    def test_bounds_overlong_display_name_to_account_field_limit(self):
        account = self.assert_imported(
            self.normalize(name="n" * 150),
            name="n" * 100,
        )
        self.assertEqual(len(account.name), 100)

    def test_mask_is_minimized_to_last_four_characters(self):
        for mask, expected in (("123456", "3456"), ("12", "12"), ("4321", "4321")):
            with self.subTest(mask=mask):
                self.assert_imported(self.normalize(mask=mask), mask=expected)

    def test_missing_mask_normalizes_to_empty_string(self):
        self.assert_imported(self.normalize(mask=None), mask="")

    def test_skips_non_string_mask(self):
        for mask in (1234, True, ["1234"]):
            with self.subTest(mask=mask):
                self.assert_skipped(self.normalize(mask=mask), INVALID_MASK)

    def test_requires_current_balance(self):
        self.assert_skipped(self.normalize(current=None), MISSING_CURRENT_BALANCE)
        self.assert_skipped(self.normalize(current="  "), INVALID_CURRENT_BALANCE)

    def test_skips_account_without_balances_object(self):
        account = FakeProviderAccount()
        account.balances = None
        normalization = normalize_provider_account(account)
        self.assert_skipped(normalization, MISSING_CURRENT_BALANCE)

    def test_skips_account_when_balances_lack_current_attribute(self):
        account = FakeProviderAccount()
        account.balances = FakeBalancesWithoutCurrent()
        normalization = normalize_provider_account(account)
        self.assert_skipped(normalization, MISSING_CURRENT_BALANCE)

    def test_rejects_unsafe_current_balances(self):
        for current in (True, False, "abc", float("nan"), float("inf"), float("-inf")):
            with self.subTest(current=current):
                self.assert_skipped(
                    self.normalize(current=current),
                    INVALID_CURRENT_BALANCE,
                )

    def test_rejects_current_balance_out_of_field_range(self):
        self.assert_skipped(
            self.normalize(current="1000000000000.00"),
            BALANCE_OUT_OF_RANGE,
        )
        self.assert_skipped(
            self.normalize(current=1e13),
            BALANCE_OUT_OF_RANGE,
        )
        self.assert_imported(
            self.normalize(current="999999999999.99"),
            current_balance=Decimal("999999999999.99"),
        )

    def test_null_available_balance_is_allowed(self):
        self.assert_imported(self.normalize(available=None), available_balance=None)

    def test_rejects_unsafe_available_balances(self):
        for available in (True, False, "abc", float("nan"), float("inf")):
            with self.subTest(available=available):
                self.assert_skipped(
                    self.normalize(available=available),
                    INVALID_AVAILABLE_BALANCE,
                )

    def test_parses_balances_decimal_safe_without_binary_float_arithmetic(self):
        cases = (
            (0.1, None, "0.10", None),
            (2.675, None, "2.68", None),
            ("123.456", None, "123.46", None),
            ("1.005", None, "1.01", None),
            ("10", None, "10.00", None),
            ("-250.755", None, "-250.76", None),
            ("12.345", "0.004", "12.35", "0.00"),
        )
        for current, available, expected_current, expected_available in cases:
            with self.subTest(current=current, available=available):
                account = self.assert_imported(
                    self.normalize(current=current, available=available),
                    current_balance=Decimal(expected_current),
                )
                if expected_available is None:
                    self.assertIsNone(account.available_balance)
                else:
                    self.assertEqual(
                        account.available_balance,
                        Decimal(expected_available),
                    )

    def test_overlong_provider_subtype_never_stored(self):
        self.assert_skipped(
            self.normalize(subtype="s" * 60),
            UNSUPPORTED_SUBTYPE,
        )

    def test_malformed_provider_account_element_is_skipped(self):
        normalization = normalize_provider_account(None)
        self.assert_skipped(normalization, MALFORMED_ACCOUNT)

    def test_value_object_extracts_only_the_frozen_field_set(self):
        account = self.assert_imported(self.normalize())
        self.assertEqual(
            {entry.name for entry in dataclasses.fields(account)},
            {
                "plaid_account_id",
                "name",
                "mask",
                "account_type",
                "plaid_type",
                "plaid_subtype",
                "current_balance",
                "available_balance",
            },
        )

    def test_value_object_repr_never_exposes_provider_values(self):
        normalization = self.normalize(
            account_id="plaid-id-xyz",
            name="Name Xyz",
            mask="1234",
            current=12345.67,
            available=678.90,
        )
        repr_text = repr(normalization)
        for forbidden in (
            "plaid-id-xyz",
            "Name Xyz",
            "1234",
            "12345.67",
            "678.90",
            "balances",
        ):
            self.assertNotIn(forbidden, repr_text)


class ImportProviderAccountsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="account-import-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="account-import-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Import Bank",
        )

    def import_accounts(self, *accounts):
        return import_provider_accounts(self.connection, list(accounts))

    def test_import_creates_linked_account_with_zero_opening_balance(self):
        result = self.import_accounts(FakeProviderAccount())

        self.assertEqual(
            result,
            AccountImportResult(
                imported=1,
                reused=0,
                skipped=0,
                reasons=(),
            ),
        )
        account = Account.objects.get()
        self.assertEqual(account.user, self.user)
        self.assertEqual(account.name, "Everyday Checking")
        self.assertEqual(account.account_type, AccountType.CHECKING)
        self.assertEqual(account.opening_balance, Decimal("0.00"))
        self.assertFalse(account.is_archived)
        link = PlaidAccountLink.objects.get()
        self.assertEqual(link.user, self.user)
        self.assertEqual(link.connection, self.connection)
        self.assertEqual(link.account, account)
        self.assertEqual(link.plaid_account_id, SYNTHETIC_ACCOUNT_ID)
        self.assertEqual(link.plaid_type, "depository")
        self.assertEqual(link.plaid_subtype, "checking")
        self.assertEqual(link.mask, "4321")
        self.assertEqual(link.anchor_provider_current_balance, Decimal("123.45"))
        self.assertEqual(link.provider_current_balance, Decimal("123.45"))
        self.assertIsNone(link.provider_available_balance)
        self.assertIsNone(link.anchor_applied_at)
        self.assertEqual(self.connection.last_sync_error, "")

    def test_import_maps_all_three_supported_account_types(self):
        self.import_accounts(
            FakeProviderAccount(
                account_id="plaid-account-check-1",
                name="Checking",
                account_type="depository",
                subtype="checking",
                current=100.00,
            ),
            FakeProviderAccount(
                account_id="plaid-account-save-1",
                name="Savings",
                account_type="depository",
                subtype="savings",
                current=200.00,
            ),
            FakeProviderAccount(
                account_id="plaid-account-card-1",
                name="Card",
                account_type="credit",
                subtype="credit card",
                current=300.00,
                available=700.00,
            ),
        )

        self.assertEqual(
            {account.account_type for account in Account.objects.all()},
            {"checking", "savings", "credit_card"},
        )
        self.assertEqual(
            {
                (link.plaid_type, link.plaid_subtype)
                for link in PlaidAccountLink.objects.all()
            },
            {
                ("depository", "checking"),
                ("depository", "savings"),
                ("credit", "credit card"),
            },
        )
        card = PlaidAccountLink.objects.get(plaid_account_id="plaid-account-card-1")
        self.assertEqual(card.anchor_provider_current_balance, Decimal("300.00"))
        self.assertEqual(card.provider_available_balance, Decimal("700.00"))
        self.assertEqual(Account.objects.count(), 3)

    def test_anchor_is_captured_from_current_balance_on_first_import(self):
        self.import_accounts(FakeProviderAccount(current=888.88, available=111.11))

        link = PlaidAccountLink.objects.get()
        self.assertEqual(link.anchor_provider_current_balance, Decimal("888.88"))
        self.assertEqual(link.provider_current_balance, Decimal("888.88"))
        self.assertEqual(link.provider_available_balance, Decimal("111.11"))

    def test_replay_is_idempotent_and_counts_reused(self):
        first = self.import_accounts(FakeProviderAccount())
        second = self.import_accounts(FakeProviderAccount())

        self.assertEqual((first.imported, first.reused), (1, 0))
        self.assertEqual((second.imported, second.reused), (0, 1))
        self.assertEqual(Account.objects.count(), 1)
        self.assertEqual(PlaidAccountLink.objects.count(), 1)

    def test_replay_refreshes_only_safe_provider_snapshot_fields(self):
        self.import_accounts(
            FakeProviderAccount(
                account_id="plaid-account-refresh-1",
                name="Checking",
                subtype="checking",
                mask="1111",
                current=100.00,
                available=50.00,
            )
        )
        link = PlaidAccountLink.objects.get(plaid_account_id="plaid-account-refresh-1")
        account = link.account

        self.import_accounts(
            FakeProviderAccount(
                account_id="plaid-account-refresh-1",
                name="Provider Renamed",
                subtype="checking",
                mask="2222",
                current=150.00,
                available=None,
            )
        )

        link.refresh_from_db()
        self.assertEqual(link.plaid_subtype, "checking")
        self.assertEqual(link.mask, "2222")
        self.assertEqual(link.provider_current_balance, Decimal("150.00"))
        self.assertIsNone(link.provider_available_balance)
        self.assertEqual(link.anchor_provider_current_balance, Decimal("100.00"))
        self.assertEqual(link.plaid_account_id, "plaid-account-refresh-1")
        self.assertEqual(link.user, self.user)
        self.assertEqual(link.connection, self.connection)
        account.refresh_from_db()
        self.assertEqual(account.account_type, AccountType.CHECKING)
        self.assertEqual(account.opening_balance, Decimal("0.00"))
        self.assertEqual(account.name, "Checking")

    def test_replay_with_conflicting_mapping_fails_closed_and_rolls_back_batch(self):
        self.import_accounts(
            FakeProviderAccount(
                account_id="plaid-account-mapping-1",
                name="Checking",
                subtype="checking",
                mask="1111",
                current=100.00,
            )
        )
        link = PlaidAccountLink.objects.get(plaid_account_id="plaid-account-mapping-1")
        self.assertEqual(link.account.account_type, AccountType.CHECKING)
        accounts_before = Account.objects.count()

        with self.assertRaises(AccountImportError) as raised:
            self.import_accounts(
                FakeProviderAccount(
                    account_id="plaid-account-mapping-1",
                    name="Provider Renamed",
                    subtype="savings",
                    current=150.00,
                ),
                FakeProviderAccount(
                    account_id="plaid-account-new-1",
                    name="New Sibling",
                ),
            )

        self.assertEqual(Account.objects.count(), accounts_before)
        self.assertFalse(
            PlaidAccountLink.objects.filter(
                plaid_account_id="plaid-account-new-1"
            ).exists()
        )
        link.refresh_from_db()
        self.assertEqual(link.plaid_subtype, "checking")
        self.assertEqual(link.account.account_type, AccountType.CHECKING)
        self.assertEqual(link.provider_current_balance, Decimal("100.00"))
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.last_sync_error, "")
        for forbidden in ("plaid-account-mapping-1", "plaid-account-new-1", "Checking"):
            self.assertNotIn(forbidden, str(raised.exception))
            self.assertNotIn(forbidden, repr(raised.exception))

    def test_replay_preserves_user_renamed_account_name(self):
        self.import_accounts(FakeProviderAccount())
        Account.objects.filter(user=self.user).update(name="My Renamed Account")

        self.import_accounts(FakeProviderAccount(name="Provider New Name"))

        account = Account.objects.get()
        self.assertEqual(account.name, "My Renamed Account")

    def test_anchor_is_immutable_across_replays(self):
        self.import_accounts(
            FakeProviderAccount(account_id="plaid-account-anchor-1", current=100.00)
        )
        link = PlaidAccountLink.objects.get(plaid_account_id="plaid-account-anchor-1")

        self.import_accounts(
            FakeProviderAccount(account_id="plaid-account-anchor-1", current=900.00)
        )

        link.refresh_from_db()
        self.assertEqual(link.anchor_provider_current_balance, Decimal("100.00"))
        self.assertEqual(link.provider_current_balance, Decimal("900.00"))

    def test_replay_fills_null_anchor_once(self):
        account = Account.objects.create(
            user=self.user,
            name="Legacy Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=account,
            plaid_account_id="plaid-account-legacy-1",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )

        result = self.import_accounts(
            FakeProviderAccount(account_id="plaid-account-legacy-1", current=777.77)
        )

        self.assertEqual((result.imported, result.reused, result.skipped), (0, 1, 0))
        link = PlaidAccountLink.objects.get(plaid_account_id="plaid-account-legacy-1")
        self.assertEqual(link.anchor_provider_current_balance, Decimal("777.77"))

        self.import_accounts(
            FakeProviderAccount(account_id="plaid-account-legacy-1", current=888.88)
        )
        link.refresh_from_db()
        self.assertEqual(link.anchor_provider_current_balance, Decimal("777.77"))
        self.assertEqual(link.provider_current_balance, Decimal("888.88"))
        self.assertEqual(Account.objects.count(), 1)

    def test_skipped_accounts_create_nothing_and_valid_siblings_import(self):
        result = self.import_accounts(
            FakeProviderAccount(account_id="plaid-account-valid-1", name="Valid"),
            FakeProviderAccount(
                account_id="plaid-account-loan-1",
                name="Auto Loan",
                account_type="loan",
                subtype="auto",
            ),
            FakeProviderAccount(
                account_id="plaid-account-nobal-1",
                name="No Balance",
                current=None,
            ),
        )

        self.assertEqual(result.imported, 1)
        self.assertEqual(result.reused, 0)
        self.assertEqual(result.skipped, 2)
        self.assertEqual(result.reasons, (UNSUPPORTED_TYPE, MISSING_CURRENT_BALANCE))
        self.assertEqual(Account.objects.count(), 1)
        self.assertEqual(PlaidAccountLink.objects.count(), 1)
        self.assertTrue(
            PlaidAccountLink.objects.filter(
                plaid_account_id="plaid-account-valid-1"
            ).exists()
        )
        self.connection.refresh_from_db()
        error = self.connection.last_sync_error
        self.assertTrue(error.startswith(ACCOUNT_IMPORT_ERROR_TAG))
        self.assertIn("skipped 2 account(s)", error)
        self.assertIn(UNSUPPORTED_TYPE, error)
        self.assertIn(MISSING_CURRENT_BALANCE, error)

    def test_all_skipped_imports_nothing_and_records_summary(self):
        result = self.import_accounts(
            FakeProviderAccount(
                account_id="plaid-account-invest-1",
                account_type="investment",
                subtype="ira",
            )
        )

        self.assertEqual(result, AccountImportResult(0, 0, 1, (UNSUPPORTED_TYPE,)))
        self.assertFalse(Account.objects.exists())
        self.assertFalse(PlaidAccountLink.objects.exists())
        self.connection.refresh_from_db()
        self.assertIn("skipped 1 account(s)", self.connection.last_sync_error)

    def test_skip_summary_is_bounded_and_redacted(self):
        self.import_accounts(
            FakeProviderAccount(
                account_id="secret-plaid-id-1",
                name="Secret Account Name One",
                mask="1234",
                account_type="loan",
                subtype="auto",
            ),
            FakeProviderAccount(
                account_id="secret-plaid-id-2",
                name="Secret Account Name Two",
                current=None,
            ),
            FakeProviderAccount(
                account_id="secret-plaid-id-3",
                name="Secret Account Name Three",
                account_type="credit",
                subtype="charge card",
            ),
        )

        self.connection.refresh_from_db()
        error = self.connection.last_sync_error
        self.assertTrue(error.startswith(ACCOUNT_IMPORT_ERROR_TAG))
        self.assertIn("skipped 3 account(s)", error)
        for forbidden in (
            "secret-plaid-id-1",
            "secret-plaid-id-2",
            "secret-plaid-id-3",
            "Secret Account Name One",
            "Secret Account Name Two",
            "Secret Account Name Three",
            "1234",
            SYNTHETIC_ITEM_ID,
        ):
            self.assertNotIn(forbidden, error)
        self.assertLessEqual(len(error), ACCOUNT_IMPORT_ERROR_MAX_LENGTH)

    def test_clean_pass_clears_only_account_import_owned_error(self):
        self.connection.last_sync_error = (
            f"{ACCOUNT_IMPORT_ERROR_TAG} skipped 1 account(s): {UNSUPPORTED_TYPE}"
        )
        self.connection.save()

        self.import_accounts(FakeProviderAccount())

        self.connection.refresh_from_db()
        self.assertEqual(self.connection.last_sync_error, "")

    def test_clean_pass_preserves_unrelated_sync_error(self):
        self.connection.last_sync_error = "cursor lost after provider outage"
        self.connection.save()

        self.import_accounts(FakeProviderAccount())

        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.last_sync_error,
            "cursor lost after provider outage",
        )

    def test_skip_pass_preserves_unrelated_sync_error(self):
        self.connection.last_sync_error = "cursor lost after provider outage"
        self.connection.save()

        result = self.import_accounts(
            FakeProviderAccount(account_type="loan", subtype="auto")
        )

        self.assertEqual(result.skipped, 1)
        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.last_sync_error,
            "cursor lost after provider outage",
        )

    def test_skip_pass_replaces_previous_account_import_summary(self):
        self.connection.last_sync_error = (
            f"{ACCOUNT_IMPORT_ERROR_TAG} skipped 1 account(s): {UNSUPPORTED_TYPE}"
        )
        self.connection.save()

        self.import_accounts(FakeProviderAccount(current=None))

        self.connection.refresh_from_db()
        error = self.connection.last_sync_error
        self.assertTrue(error.startswith(ACCOUNT_IMPORT_ERROR_TAG))
        self.assertIn("skipped 1 account(s)", error)
        self.assertIn(MISSING_CURRENT_BALANCE, error)
        self.assertNotIn(UNSUPPORTED_TYPE, error)

    def test_skip_pass_records_summary_when_no_prior_error_exists(self):
        self.connection.last_sync_error = ""
        self.connection.save()

        self.import_accounts(FakeProviderAccount(account_type="loan", subtype="auto"))

        self.connection.refresh_from_db()
        self.assertTrue(
            self.connection.last_sync_error.startswith(ACCOUNT_IMPORT_ERROR_TAG)
        )
        self.assertIn("skipped 1 account(s)", self.connection.last_sync_error)

    def test_cross_user_existing_link_fails_closed_and_rolls_back_batch(self):
        other_account = Account.objects.create(
            user=self.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.other_user,
            account=other_account,
            plaid_account_id="plaid-account-foreign-link",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="7777",
        )
        accounts_before = Account.objects.count()

        with self.assertRaises(AccountImportError) as raised:
            self.import_accounts(
                FakeProviderAccount(
                    account_id="plaid-account-good-1",
                    name="Good Checking",
                ),
                FakeProviderAccount(
                    account_id="plaid-account-foreign-link",
                    name="Colliding",
                ),
            )

        self.assertEqual(Account.objects.count(), accounts_before)
        self.assertFalse(
            PlaidAccountLink.objects.filter(
                plaid_account_id="plaid-account-good-1"
            ).exists()
        )
        other_account.refresh_from_db()
        self.assertEqual(other_account.user, self.other_user)
        self.assertEqual(other_account.name, "Their Checking")
        self.assertEqual(other_account.opening_balance, Decimal("0.00"))
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.last_sync_error, "")
        for forbidden in (
            "plaid-account-foreign-link",
            "Their Checking",
            "plaid-account-good-1",
            self.other_user.email,
        ):
            self.assertNotIn(forbidden, str(raised.exception))
            self.assertNotIn(forbidden, repr(raised.exception))

    def test_cross_user_account_on_existing_link_fails_closed(self):
        other_account = Account.objects.create(
            user=self.other_user,
            name="Their Savings",
            account_type=AccountType.SAVINGS,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=other_account,
            plaid_account_id="plaid-account-foreign-account",
            plaid_type="depository",
            plaid_subtype="savings",
            mask="6666",
        )

        with self.assertRaises(AccountImportError):
            self.import_accounts(
                FakeProviderAccount(
                    account_id="plaid-account-foreign-account",
                    name="Spoof",
                )
            )

        other_account.refresh_from_db()
        self.assertEqual(other_account.user, self.other_user)
        self.assertEqual(
            PlaidAccountLink.objects.filter(
                plaid_account_id="plaid-account-foreign-account"
            ).count(),
            1,
        )

    def test_link_write_failure_leaves_no_orphan_account(self):
        with (
            patch(
                "plaid_integration.account_import.PlaidAccountLink.save",
                side_effect=IntegrityError("unrelated failure"),
            ),
            self.assertRaises(IntegrityError),
        ):
            self.import_accounts(FakeProviderAccount())

        self.assertEqual(Account.objects.count(), 0)
        self.assertEqual(PlaidAccountLink.objects.count(), 0)

    def test_unrelated_named_integrity_error_propagates_and_rolls_back(self):
        def unrelated_save(*args, **kwargs):
            raise _integrity_error("some_other_constraint")

        with (
            patch(
                "plaid_integration.account_import.PlaidAccountLink.save",
                side_effect=unrelated_save,
            ),
            self.assertRaises(IntegrityError),
        ):
            self.import_accounts(FakeProviderAccount())

        self.assertEqual(Account.objects.count(), 0)
        self.assertEqual(PlaidAccountLink.objects.count(), 0)

    def test_duplicate_race_translates_to_reuse_without_orphan(self):
        existing_account = Account.objects.create(
            user=self.user,
            name="Existing Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        existing_link = PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=existing_account,
            plaid_account_id="plaid-account-race-1",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
            provider_current_balance=Decimal("10.00"),
        )

        def racing_save(*args, **kwargs):
            raise _integrity_error(SYNTHETIC_LINK_CONSTRAINT)

        with (
            patch(
                "plaid_integration.account_import._find_existing_link",
                side_effect=[None, existing_link],
            ),
            patch(
                "plaid_integration.account_import.PlaidAccountLink.save",
                side_effect=racing_save,
            ),
        ):
            result = self.import_accounts(
                FakeProviderAccount(
                    account_id="plaid-account-race-1",
                    current=99.99,
                )
            )

        self.assertEqual(result, AccountImportResult(0, 1, 0, ()))
        self.assertEqual(Account.objects.count(), 1)
        self.assertEqual(PlaidAccountLink.objects.count(), 1)
        existing_link.refresh_from_db()
        self.assertEqual(existing_link.provider_current_balance, Decimal("99.99"))
        self.assertEqual(existing_link.account, existing_account)

    def test_no_diagnostic_exact_duplicate_translates_to_reuse_without_orphan(self):
        existing_account = Account.objects.create(
            user=self.user,
            name="Existing Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        existing_link = PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=existing_account,
            plaid_account_id="plaid-account-race-2",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
            provider_current_balance=Decimal("10.00"),
        )

        def racing_save(*args, **kwargs):
            raise _integrity_error(None)

        with (
            patch(
                "plaid_integration.account_import._find_existing_link",
                side_effect=[None, existing_link],
            ),
            patch(
                "plaid_integration.account_import.PlaidAccountLink.save",
                side_effect=racing_save,
            ),
        ):
            result = self.import_accounts(
                FakeProviderAccount(
                    account_id="plaid-account-race-2",
                    current=99.99,
                )
            )

        self.assertEqual(result, AccountImportResult(0, 1, 0, ()))
        self.assertEqual(Account.objects.count(), 1)
        self.assertEqual(PlaidAccountLink.objects.count(), 1)
        existing_link.refresh_from_db()
        self.assertEqual(existing_link.provider_current_balance, Decimal("99.99"))
        self.assertEqual(existing_link.account, existing_account)

    def test_no_diagnostic_unrelated_integrity_error_propagates_without_orphan(self):
        def unrelated_save(*args, **kwargs):
            raise _integrity_error(None)

        with (
            patch(
                "plaid_integration.account_import._find_existing_link",
                return_value=None,
            ),
            patch(
                "plaid_integration.account_import.PlaidAccountLink.save",
                side_effect=unrelated_save,
            ),
            self.assertRaises(IntegrityError),
        ):
            self.import_accounts(FakeProviderAccount())

        self.assertEqual(Account.objects.count(), 0)
        self.assertEqual(PlaidAccountLink.objects.count(), 0)

    def test_result_never_exposes_provider_values(self):
        result = self.import_accounts(
            FakeProviderAccount(
                account_id="secret-result-id",
                name="Secret Result Name",
                mask="9876",
                current=123.45,
                available=67.89,
            )
        )
        text = repr(result) + str(result)
        for forbidden in (
            "secret-result-id",
            "Secret Result Name",
            "9876",
            "123.45",
            "67.89",
        ):
            self.assertNotIn(forbidden, text)

    def test_import_logs_nothing(self):
        with self.assertNoLogs(
            "plaid_integration.account_import", level=logging.WARNING
        ):
            self.import_accounts(
                FakeProviderAccount(account_id="plaid-account-quiet-1"),
                FakeProviderAccount(account_type="loan", subtype="auto"),
            )
