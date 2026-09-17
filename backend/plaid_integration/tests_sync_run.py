"""Tests for the bounded sync orchestration and the opening-balance anchor.

Covers the ``docs/plaid.md`` section 5 anchor and section 7 sync-loop contract
for issue #38 slice E: ``perform_sync`` drives one bounded sync of ONE
``PlaidConnection`` through an injected fake gateway (no network, no real
credentials), imports supported accounts before rows are mapped, applies each
page through ``apply_sync_page`` so rows and the cursor commit together,
applies the opening-balance anchor exactly once per link when the drained
final page of the window reports ``HISTORICAL_UPDATE_COMPLETE``, restarts
the pagination sequence from the
update-start cursor on mutation-during-pagination, fails closed on outage,
token, and anchor conditions without advancing the cursor, heals the
``error`` status back to ``active`` on a later successful run, and never
touches another user's rows. Every database-visible behavior is asserted
against the real PostgreSQL-backed test database.
"""

import logging
from datetime import date
from decimal import Decimal

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from plaid_integration.account_import import normalize_provider_account
from plaid_integration.gateway import PLAID_UNAVAILABLE_DETAIL, PlaidGatewayError
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    TransactionsUpdateStatus,
)
from plaid_integration.services import (
    ANCHOR_MISSING_BALANCE_DETAIL,
    BLOCKED_CURSOR_DETAIL,
    MUTATION_RESTARTS_EXHAUSTED_DETAIL,
    SYNC_ERROR_TAG,
    TOKEN_UNAVAILABLE_DETAIL,
    SyncRunResult,
    perform_sync,
)
from plaid_integration.tests_account_import import FakeProviderAccount
from plaid_integration.tests_sync_page import added_tx, removed_tx
from plaid_integration.token_encryption import TokenKeyRing
from plaid_integration.transaction_sync import (
    NormalizedSyncPage,
    PlaidSyncMutationError,
)
from transactions.models import Transaction, TransactionType

SYNTHETIC_ACCESS_TOKEN = "access-sandbox-sync-run-00000000000000"
CURSOR_A = "cursor-opaque-a"
CURSOR_B = "cursor-opaque-b"
CURSOR_C = "cursor-opaque-c"

CHECKING_ACCOUNT_ID = "plaid-account-checking-0001"
CREDIT_ACCOUNT_ID = "plaid-account-credit-0001"

_TEST_KEY = Fernet.generate_key().decode()
SYNTHETIC_RING = TokenKeyRing([("key-a", _TEST_KEY)])

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


def make_page(
    *,
    added=(),
    modified=(),
    removed=(),
    quarantines=(),
    account_outcomes=(),
    next_cursor=CURSOR_A,
    status="INITIAL_UPDATE_COMPLETE",
    has_more=False,
):
    return NormalizedSyncPage(
        added=tuple(added),
        modified=tuple(modified),
        removed=tuple(removed),
        account_outcomes=tuple(account_outcomes),
        quarantines=tuple(quarantines),
        next_cursor=next_cursor,
        has_more=has_more,
        transactions_update_status=status,
        quarantined=len(quarantines),
    )


def checking_outcome(current="100.00"):
    return normalize_provider_account(
        FakeProviderAccount(
            account_id=CHECKING_ACCOUNT_ID,
            name="Everyday Checking",
            current=current,
        )
    )


def credit_card_outcome(current="400.00"):
    return normalize_provider_account(
        FakeProviderAccount(
            account_id=CREDIT_ACCOUNT_ID,
            name="Travel Rewards Card",
            account_type="credit",
            subtype="credit card",
            current=current,
            available=1600.00,
        )
    )


class FakeSyncGateway:
    """Scripted provider gateway: pre-built pages returned in order.

    A scripted exception instance is raised when one is scheduled, so tests
    can inject ``PlaidGatewayError`` and ``PlaidSyncMutationError`` exactly
    where a real provider would raise. Every call's token and cursor are
    recorded for exact assertion; the network boundary is never exercised.
    """

    def __init__(self, script, on_call=None):
        self._script = list(script)
        self._on_call = on_call
        self.calls = []

    def sync_transactions(self, access_token, cursor=None):
        self.calls.append((access_token, cursor))
        if self._on_call is not None:
            self._on_call(access_token, cursor, len(self.calls))
        step = self._script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


class SyncRunResultTests(SimpleTestCase):
    def test_result_repr_never_exposes_provider_values(self):
        result = SyncRunResult(
            blocked=False,
            pages_applied=2,
            added=3,
            modified=1,
            removed=1,
            superseded=1,
            skipped=1,
            quarantined=1,
            history_complete=True,
            anchors_applied=1,
        )
        text = repr(result) + str(result)
        for forbidden in (
            "cursor-opaque-a",
            SYNTHETIC_ACCESS_TOKEN,
            CHECKING_ACCOUNT_ID,
            "12.34",
            "Synthetic Store",
        ):
            self.assertNotIn(forbidden, text)


@override_settings(**PLAID_API_SETTINGS)
class SyncRunPaginationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="sync-run-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-sync-run-00001",
            institution_name="Sync Run Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )

    def test_first_sync_spans_two_pages_imports_accounts_and_completes(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="12.34",
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-2",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="45.00",
                            transaction_type="income",
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertEqual(
            result,
            SyncRunResult(
                blocked=False,
                pages_applied=2,
                added=2,
                modified=0,
                removed=0,
                superseded=0,
                skipped=0,
                quarantined=0,
                history_complete=True,
                anchors_applied=1,
            ),
        )
        self.assertEqual(
            [cursor for _, cursor in gateway.calls],
            [None, CURSOR_A],
        )
        self.assertEqual(
            gateway.calls[0][0],
            SYNTHETIC_ACCESS_TOKEN,
            "the gateway must receive the decrypted plaintext token",
        )
        self.assertEqual(Account.objects.count(), 1)
        account = Account.objects.get()
        self.assertEqual(account.user, self.user)
        self.assertEqual(account.account_type, AccountType.CHECKING)
        self.assertEqual(account.opening_balance, Decimal("67.34"))
        self.assertEqual(PlaidAccountLink.objects.count(), 1)
        link = PlaidAccountLink.objects.get()
        self.assertEqual(link.user, self.user)
        self.assertEqual(link.connection, self.connection)
        self.assertEqual(link.account, account)
        self.assertEqual(link.anchor_provider_current_balance, Decimal("100.00"))
        self.assertIsNotNone(link.anchor_applied_at)
        self.assertEqual(Transaction.objects.count(), 2)
        first = Transaction.objects.get(plaid_transaction_id="tx-1")
        self.assertEqual(first.account, account)
        self.assertEqual(first.amount, Decimal("12.34"))
        self.assertEqual(first.transaction_type, TransactionType.EXPENSE)
        second = Transaction.objects.get(plaid_transaction_id="tx-2")
        self.assertEqual(second.account, account)
        self.assertEqual(second.transaction_type, TransactionType.INCOME)
        self.assertEqual(second.amount, Decimal("45.00"))
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        self.assertEqual(self.connection.last_sync_error, "")

    def test_page_cap_stops_run_with_committed_cursor_reported_not_complete(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(transaction_id="tx-1", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                make_page(
                    added=(
                        added_tx(transaction_id="tx-2", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=1)

        self.assertFalse(result.blocked)
        self.assertEqual(result.pages_applied, 1)
        self.assertEqual(result.added, 1)
        self.assertFalse(result.history_complete)
        self.assertEqual(result.anchors_applied, 0)
        self.assertEqual(len(gateway.calls), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )

    def test_resumed_run_continues_from_committed_cursor_without_duplicates(self):
        first = perform_sync(
            self.connection,
            gateway=FakeSyncGateway(
                [
                    make_page(
                        added=(
                            added_tx(
                                transaction_id="tx-1",
                                account_id=CHECKING_ACCOUNT_ID,
                            ),
                        ),
                        account_outcomes=(checking_outcome(),),
                        next_cursor=CURSOR_A,
                        has_more=True,
                    ),
                ]
            ),
            page_cap=1,
        )
        self.assertEqual(first.pages_applied, 1)
        self.assertEqual(first.added, 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)

        resumed_gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-2",
                            account_id=CHECKING_ACCOUNT_ID,
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )
        resumed = perform_sync(
            self.connection,
            gateway=resumed_gateway,
            page_cap=10,
        )

        self.assertFalse(resumed.blocked)
        self.assertEqual(resumed.pages_applied, 1)
        self.assertEqual(resumed.added, 1)
        self.assertTrue(resumed.history_complete)
        self.assertEqual(resumed.anchors_applied, 1)
        self.assertEqual([cursor for _, cursor in resumed_gateway.calls], [CURSOR_A])
        self.assertEqual(Transaction.objects.count(), 2)
        self.assertEqual(
            Transaction.objects.filter(plaid_transaction_id="tx-1").count(),
            1,
        )
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)

    def test_unsupported_account_siblings_are_skipped_while_supported_import(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-ok",
                            account_id=CHECKING_ACCOUNT_ID,
                        ),
                        added_tx(
                            transaction_id="tx-loan",
                            account_id="plaid-account-loan-0001",
                        ),
                    ),
                    account_outcomes=(
                        checking_outcome(),
                        normalize_provider_account(
                            FakeProviderAccount(
                                account_id="plaid-account-loan-0001",
                                name="Auto Loan",
                                account_type="loan",
                                subtype="auto",
                            )
                        ),
                    ),
                    next_cursor=CURSOR_A,
                    has_more=False,
                    status="INITIAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertFalse(result.blocked)
        self.assertEqual(result.added, 1)
        self.assertEqual(result.skipped, 1)
        self.assertEqual(Account.objects.count(), 1)
        self.assertEqual(
            Transaction.objects.filter(plaid_transaction_id="tx-ok").count(),
            1,
        )
        self.assertFalse(
            Transaction.objects.filter(plaid_transaction_id="tx-loan").exists()
        )

    def test_mutation_during_pagination_restarts_from_update_start_cursor(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="12.34",
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                PlaidSyncMutationError(),
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="12.34",
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-2",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="5.00",
                        ),
                    ),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertFalse(result.blocked)
        # The re-served tx-1 page behind the committed cursor advanced nothing,
        # so the run reports exactly the 2 distinct pages whose rows changed.
        self.assertEqual(result.pages_applied, 2)
        self.assertEqual(result.added, 2)
        self.assertEqual(result.anchors_applied, 1)
        self.assertEqual(
            [cursor for _, cursor in gateway.calls],
            [None, CURSOR_A, None, CURSOR_A],
        )
        self.assertEqual(Transaction.objects.count(), 2)
        self.assertEqual(
            Transaction.objects.filter(plaid_transaction_id="tx-1").count(),
            1,
        )
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        account = Account.objects.get()
        self.assertEqual(account.opening_balance, Decimal("117.34"))
        self.assertEqual(account.current_balance, Decimal("100.00"))

    def test_mutation_restarts_exhausted_block_with_fixed_redacted_error(self):
        mutation = PlaidSyncMutationError()
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(transaction_id="tx-1", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                make_page(
                    added=(
                        added_tx(transaction_id="tx-2", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    next_cursor=CURSOR_B,
                    has_more=True,
                ),
                mutation,
                make_page(
                    added=(
                        added_tx(transaction_id="tx-1", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                make_page(
                    added=(
                        added_tx(transaction_id="tx-2", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    next_cursor=CURSOR_B,
                    has_more=True,
                ),
                mutation,
                make_page(
                    added=(
                        added_tx(transaction_id="tx-1", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                make_page(
                    added=(
                        added_tx(transaction_id="tx-2", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    next_cursor=CURSOR_B,
                    has_more=True,
                ),
                mutation,
            ]
        )

        result = perform_sync(
            self.connection,
            gateway=gateway,
            page_cap=10,
            max_mutation_restarts=2,
        )

        self.assertTrue(result.blocked)
        self.assertEqual(result.added, 2)
        self.assertEqual(Transaction.objects.count(), 2)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        error = self.connection.last_sync_error
        self.assertEqual(
            error,
            f"{SYNC_ERROR_TAG} {MUTATION_RESTARTS_EXHAUSTED_DETAIL}",
        )
        for forbidden in (
            SYNTHETIC_ACCESS_TOKEN,
            CURSOR_A,
            CURSOR_B,
            CHECKING_ACCOUNT_ID,
            "tx-1",
        ):
            self.assertNotIn(forbidden, error)

    def test_inconsistent_page_blocks_the_run_without_mutation(self):
        def spoil(_token, _cursor, call_index):
            if call_index == 2:
                self.connection.sync_cursor = "cursor-from-another-context"
                self.connection.save(update_fields=["sync_cursor"])

        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(transaction_id="tx-1", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                make_page(
                    added=(
                        added_tx(transaction_id="tx-2", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    next_cursor=CURSOR_B,
                    has_more=False,
                ),
            ],
            on_call=spoil,
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertTrue(result.blocked)
        self.assertEqual(result.pages_applied, 1)
        self.assertEqual(result.added, 1)
        self.assertEqual(Transaction.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, "cursor-from-another-context")
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {BLOCKED_CURSOR_DETAIL}",
        )


@override_settings(**PLAID_API_SETTINGS)
class SyncRunAnchorTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="sync-run-anchor@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-sync-run-anchor-00001",
            institution_name="Anchor Run Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )

    def test_credit_card_anchor_worked_example(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-cc-1",
                            account_id=CREDIT_ACCOUNT_ID,
                            amount="300.00",
                        ),
                        added_tx(
                            transaction_id="tx-cc-2",
                            account_id=CREDIT_ACCOUNT_ID,
                            amount="50.00",
                            transaction_type="income",
                        ),
                    ),
                    account_outcomes=(credit_card_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertFalse(result.blocked)
        self.assertTrue(result.history_complete)
        self.assertEqual(result.anchors_applied, 1)
        card = Account.objects.get()
        self.assertEqual(card.account_type, AccountType.CREDIT_CARD)
        self.assertEqual(card.opening_balance, Decimal("-150.00"))
        self.assertEqual(card.current_balance, Decimal("-400.00"))
        link = PlaidAccountLink.objects.get()
        self.assertIsNotNone(link.anchor_applied_at)
        self.assertEqual(link.anchor_provider_current_balance, Decimal("400.00"))

        later = perform_sync(
            self.connection,
            gateway=FakeSyncGateway(
                [
                    make_page(
                        added=(
                            added_tx(
                                transaction_id="tx-cc-3",
                                account_id=CREDIT_ACCOUNT_ID,
                                amount="25.00",
                            ),
                        ),
                        account_outcomes=(credit_card_outcome(current="425.00"),),
                        next_cursor=CURSOR_B,
                        has_more=False,
                        status="INITIAL_UPDATE_COMPLETE",
                    ),
                ]
            ),
            page_cap=10,
        )

        self.assertFalse(later.blocked)
        self.assertEqual(later.anchors_applied, 0)
        card.refresh_from_db()
        self.assertEqual(card.opening_balance, Decimal("-150.00"))
        self.assertEqual(card.current_balance, Decimal("-425.00"))
        link.refresh_from_db()
        self.assertIsNotNone(link.anchor_applied_at)
        self.assertEqual(link.anchor_provider_current_balance, Decimal("400.00"))
        self.assertEqual(link.provider_current_balance, Decimal("425.00"))

    def test_checking_anchor_derives_to_provider_balance(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-check-1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="200.00",
                        ),
                        added_tx(
                            transaction_id="tx-check-2",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="150.00",
                            transaction_type="income",
                        ),
                    ),
                    account_outcomes=(checking_outcome(current="1000.00"),),
                    next_cursor=CURSOR_A,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertEqual(result.anchors_applied, 1)
        checking = Account.objects.get()
        self.assertEqual(checking.opening_balance, Decimal("1050.00"))
        self.assertEqual(checking.current_balance, Decimal("1000.00"))

    def test_anchor_waits_for_the_drained_final_page_of_the_window(self):
        # Completion is reported on a page that still has pages pending; the
        # anchor must not pin against this partial history. Rows arriving on
        # the later page of the same window must be inside the anchored
        # window, so the derived balance equals the provider snapshot.
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-d1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="10.00",
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-d2",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="5.00",
                        ),
                    ),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertFalse(result.blocked)
        self.assertTrue(result.history_complete)
        self.assertEqual(result.pages_applied, 2)
        self.assertEqual(result.added, 2)
        self.assertEqual(result.anchors_applied, 1)
        account = Account.objects.get()
        self.assertEqual(account.opening_balance, Decimal("115.00"))
        self.assertEqual(account.current_balance, Decimal("100.00"))
        derived = account.opening_balance - Decimal("15.00")
        self.assertEqual(derived, Decimal("100.00"))
        self.assertEqual(derived, account.current_balance)

    def test_anchor_not_applied_while_status_is_initial_or_not_ready(self):
        for status in ("INITIAL_UPDATE_COMPLETE", "NOT_READY"):
            with self.subTest(status=status):
                conn = PlaidConnection.objects.create(
                    user=self.user,
                    item_id=f"item-sandbox-sync-run-{status}-00001",
                    institution_name="Anchor Run Bank",
                    access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
                    encryption_key_id="key-a",
                )
                account_id = f"plaid-account-{status}-0001"
                gateway = FakeSyncGateway(
                    [
                        make_page(
                            added=(
                                added_tx(
                                    transaction_id=f"tx-{status}",
                                    account_id=account_id,
                                    amount="12.34",
                                ),
                            ),
                            account_outcomes=(
                                normalize_provider_account(
                                    FakeProviderAccount(
                                        account_id=account_id,
                                        name="Everyday Checking",
                                        current=100.00,
                                    )
                                ),
                            ),
                            next_cursor=CURSOR_A,
                            has_more=False,
                            status=status,
                        ),
                    ]
                )

                result = perform_sync(conn, gateway=gateway, page_cap=10)

                self.assertFalse(result.blocked)
                self.assertFalse(result.history_complete)
                self.assertEqual(result.anchors_applied, 0)
                account = Account.objects.get(plaid_account_links__connection=conn)
                self.assertEqual(account.opening_balance, Decimal("0.00"))
                link = PlaidAccountLink.objects.get(connection=conn)
                self.assertIsNone(link.anchor_applied_at)
                self.assertEqual(
                    link.anchor_provider_current_balance, Decimal("100.00")
                )
                conn.refresh_from_db()
                self.assertEqual(conn.sync_cursor, CURSOR_A)

    def test_anchor_excludes_pending_removed_and_superseded_rows(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-e1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="200.00",
                        ),
                        added_tx(
                            transaction_id="tx-p1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="50.00",
                            is_pending=True,
                        ),
                    ),
                    account_outcomes=(checking_outcome(current="1000.00"),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                    status="INITIAL_UPDATE_COMPLETE",
                ),
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-e2",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="50.00",
                            pending_transaction_id="tx-p1",
                        ),
                    ),
                    removed=(removed_tx("tx-e1"),),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertEqual(result.anchors_applied, 1)
        checking = Account.objects.get()
        self.assertEqual(checking.opening_balance, Decimal("1050.00"))
        self.assertEqual(checking.current_balance, Decimal("1000.00"))

    def test_anchor_applies_at_most_once_when_completion_page_is_replayed(self):
        # The completion page carries pending pages, and the drained final
        # page carries a posted row, so an anchor pinned to the early
        # completion page would diverge from the provider snapshot and be
        # caught by the opening_balance and derived-balance assertions.
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="12.34",
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
                PlaidSyncMutationError(),
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="12.34",
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-2",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="5.00",
                        ),
                    ),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertFalse(result.blocked)
        self.assertEqual(result.anchors_applied, 1)
        self.assertEqual(Transaction.objects.count(), 2)
        checking = Account.objects.get()
        # anchor 100.00 minus net income of -17.34 (two posted expenses), so
        # the derived balance lands exactly on the provider snapshot.
        self.assertEqual(checking.opening_balance, Decimal("117.34"))
        self.assertEqual(checking.current_balance, Decimal("100.00"))
        self.assertEqual(
            checking.opening_balance - Decimal("17.34"),
            checking.current_balance,
        )
        link = PlaidAccountLink.objects.get()
        self.assertIsNotNone(link.anchor_applied_at)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)

    def test_anchor_fails_closed_without_captured_balance_and_recovers(self):
        account = Account.objects.create(
            user=self.user,
            name="Legacy Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        link = PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=account,
            plaid_account_id=CHECKING_ACCOUNT_ID,
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )
        self.assertIsNone(link.anchor_provider_current_balance)

        blocked = perform_sync(
            self.connection,
            gateway=FakeSyncGateway(
                [
                    make_page(
                        added=(
                            added_tx(
                                transaction_id="tx-1",
                                account_id=CHECKING_ACCOUNT_ID,
                                amount="12.34",
                            ),
                        ),
                        next_cursor=CURSOR_A,
                        has_more=False,
                        status="HISTORICAL_UPDATE_COMPLETE",
                    ),
                ]
            ),
            page_cap=10,
        )

        self.assertTrue(blocked.blocked)
        self.assertEqual(blocked.pages_applied, 0)
        self.assertEqual(blocked.added, 0)
        self.assertEqual(Transaction.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertIsNone(self.connection.transactions_update_status)
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {ANCHOR_MISSING_BALANCE_DETAIL}",
        )
        account.refresh_from_db()
        self.assertEqual(account.opening_balance, Decimal("0.00"))
        link.refresh_from_db()
        self.assertIsNone(link.anchor_applied_at)

        recovered = perform_sync(
            self.connection,
            gateway=FakeSyncGateway(
                [
                    make_page(
                        added=(
                            added_tx(
                                transaction_id="tx-1",
                                account_id=CHECKING_ACCOUNT_ID,
                                amount="12.34",
                            ),
                        ),
                        account_outcomes=(checking_outcome(current="100.00"),),
                        next_cursor=CURSOR_A,
                        has_more=False,
                        status="HISTORICAL_UPDATE_COMPLETE",
                    ),
                ]
            ),
            page_cap=10,
        )

        self.assertFalse(recovered.blocked)
        self.assertEqual(recovered.anchors_applied, 1)
        link.refresh_from_db()
        self.assertEqual(link.anchor_provider_current_balance, Decimal("100.00"))
        self.assertIsNotNone(link.anchor_applied_at)
        account.refresh_from_db()
        self.assertEqual(account.opening_balance, Decimal("112.34"))
        self.assertEqual(account.current_balance, Decimal("100.00"))
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertEqual(self.connection.last_sync_error, "")

    def test_anchor_fail_closed_surfaces_the_anchor_reason_over_account_import_error(
        self,
    ):
        # A skipped unsupported sibling writes an account-import-tagged
        # summary before the page applies; the anchor fail-closed reason is
        # what actually blocked the window and must be what the connection
        # reports, never masked by the earlier tag.
        other = Account.objects.create(
            user=self.user,
            name="Legacy Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=other,
            plaid_account_id="plaid-account-legacy-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="3333",
        )
        self.assertIsNone(
            other.plaid_account_links.get().anchor_provider_current_balance
        )

        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="12.34",
                        ),
                    ),
                    account_outcomes=(
                        checking_outcome(),
                        normalize_provider_account(
                            FakeProviderAccount(
                                account_id="plaid-account-loan-0001",
                                name="Auto Loan",
                                account_type="loan",
                                subtype="auto",
                            )
                        ),
                    ),
                    next_cursor=CURSOR_A,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertTrue(result.blocked)
        self.assertEqual(result.pages_applied, 0)
        self.assertEqual(result.added, 0)
        self.assertEqual(Transaction.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {ANCHOR_MISSING_BALANCE_DETAIL}",
        )
        other.refresh_from_db()
        self.assertEqual(other.opening_balance, Decimal("0.00"))


@override_settings(**PLAID_API_SETTINGS)
class SyncRunGuardTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="sync-run-guard@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="sync-run-guard-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-sync-run-guard-00001",
            institution_name="Guard Run Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-sync-run-guard-other-00001",
            institution_name="Other Guard Run Bank",
            access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
            encryption_key_id="key-a",
        )

    def test_disconnected_revoked_and_updating_connections_are_blocked_without_any_write(
        self,
    ):
        for status in (
            PlaidConnectionStatus.DISCONNECTED,
            PlaidConnectionStatus.REVOKED,
            PlaidConnectionStatus.UPDATING,
        ):
            with self.subTest(status=status):
                conn = PlaidConnection.objects.create(
                    user=self.user,
                    item_id=f"item-sandbox-sync-run-guard-{status}-00001",
                    institution_name="Guard Run Bank",
                    access_token_encrypted=_encrypt(SYNTHETIC_ACCESS_TOKEN),
                    encryption_key_id="key-a",
                    status=status,
                    sync_cursor=CURSOR_A,
                    last_sync_error="unrelated kept error",
                )
                gateway = FakeSyncGateway(
                    [
                        make_page(
                            next_cursor=CURSOR_B,
                            has_more=False,
                        ),
                    ]
                )

                result = perform_sync(conn, gateway=gateway, page_cap=10)

                self.assertTrue(result.blocked)
                self.assertEqual(gateway.calls, [])
                self.assertEqual(Transaction.objects.count(), 0)
                conn.refresh_from_db()
                self.assertEqual(conn.sync_cursor, CURSOR_A)
                self.assertEqual(conn.last_sync_error, "unrelated kept error")
                self.assertEqual(conn.status, status)

    def test_missing_stored_token_blocks_without_ledger_writes(self):
        conn = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-sync-run-guard-no-token-00001",
            institution_name="Guard Run Bank",
            access_token_encrypted="",
            encryption_key_id="key-a",
            sync_cursor=CURSOR_A,
        )
        gateway = FakeSyncGateway(
            [
                make_page(
                    next_cursor=CURSOR_B,
                    has_more=False,
                ),
            ]
        )

        result = perform_sync(conn, gateway=gateway, page_cap=10)

        self.assertTrue(result.blocked)
        self.assertEqual(gateway.calls, [])
        self.assertEqual(Transaction.objects.count(), 0)
        conn.refresh_from_db()
        self.assertEqual(conn.sync_cursor, CURSOR_A)
        self.assertEqual(conn.status, PlaidConnectionStatus.ACTIVE)
        self.assertEqual(
            conn.last_sync_error,
            f"{SYNC_ERROR_TAG} {TOKEN_UNAVAILABLE_DETAIL}",
        )

    def test_undecryptable_token_blocks_without_ledger_writes(self):
        conn = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-sync-run-guard-bad-token-00001",
            institution_name="Guard Run Bank",
            access_token_encrypted="not-a-fernet-package",
            encryption_key_id="key-a",
            sync_cursor=CURSOR_A,
        )
        gateway = FakeSyncGateway(
            [
                make_page(
                    next_cursor=CURSOR_B,
                    has_more=False,
                ),
            ]
        )

        result = perform_sync(conn, gateway=gateway, page_cap=10)

        self.assertTrue(result.blocked)
        self.assertEqual(gateway.calls, [])
        self.assertEqual(Transaction.objects.count(), 0)
        conn.refresh_from_db()
        self.assertEqual(conn.sync_cursor, CURSOR_A)
        self.assertEqual(conn.status, PlaidConnectionStatus.ACTIVE)
        self.assertEqual(
            conn.last_sync_error,
            f"{SYNC_ERROR_TAG} {TOKEN_UNAVAILABLE_DETAIL}",
        )

    def test_missing_key_ring_blocks_without_ledger_writes(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    next_cursor=CURSOR_B,
                    has_more=False,
                ),
            ]
        )

        with override_settings(PLAID_TOKEN_RING=None):
            result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertTrue(result.blocked)
        self.assertEqual(gateway.calls, [])
        self.assertEqual(Transaction.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {TOKEN_UNAVAILABLE_DETAIL}",
        )

    def test_provider_outage_sets_error_status_with_cursor_unmoved_and_retry_succeeds(
        self,
    ):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=True,
                ),
                PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertTrue(result.blocked)
        self.assertEqual(result.pages_applied, 1)
        self.assertEqual(result.added, 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ERROR)
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {PLAID_UNAVAILABLE_DETAIL}",
        )

        retry_gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-2",
                            account_id=CHECKING_ACCOUNT_ID,
                        ),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_B,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )
        retry = perform_sync(
            self.connection,
            gateway=retry_gateway,
            page_cap=10,
        )

        self.assertFalse(retry.blocked)
        self.assertEqual(retry.added, 1)
        self.assertEqual(retry.anchors_applied, 1)
        self.assertEqual([cursor for _, cursor in retry_gateway.calls], [CURSOR_A])
        self.assertEqual(Transaction.objects.count(), 2)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        self.assertEqual(self.connection.last_sync_error, "")

    def test_cross_user_rows_connections_and_accounts_are_never_touched(self):
        other_account = Account.objects.create(
            user=self.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.other_connection,
            user=self.other_user,
            account=other_account,
            plaid_account_id="plaid-account-theirs-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="7777",
            anchor_provider_current_balance=Decimal("500.00"),
        )
        other_category = Category.objects.create(
            user=self.other_user,
            name="Their Expense",
            category_type=CategoryType.EXPENSE,
        )
        other_tx = Transaction.objects.create(
            user=self.other_user,
            account=other_account,
            category=other_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("9.99"),
            date=date(2024, 1, 1),
            source="plaid",
            connection=self.other_connection,
            plaid_transaction_id="tx-theirs",
        )

        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(
                            transaction_id="tx-1",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="12.34",
                        ),
                    ),
                    modified=(
                        added_tx(
                            transaction_id="tx-theirs",
                            account_id=CHECKING_ACCOUNT_ID,
                            amount="77.00",
                        ),
                    ),
                    removed=(removed_tx("tx-theirs"),),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=False,
                    status="HISTORICAL_UPDATE_COMPLETE",
                ),
            ]
        )

        result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertFalse(result.blocked)
        self.assertEqual(result.anchors_applied, 1)
        self.assertEqual(Transaction.objects.filter(user=self.user).count(), 1)
        other_tx.refresh_from_db()
        self.assertEqual(other_tx.amount, Decimal("9.99"))
        self.assertFalse(other_tx.is_provider_removed)
        self.assertEqual(other_tx.connection, self.other_connection)
        other_account.refresh_from_db()
        self.assertEqual(other_account.opening_balance, Decimal("0.00"))
        other_link = PlaidAccountLink.objects.get(connection=self.other_connection)
        self.assertIsNone(other_link.anchor_applied_at)
        self.assertEqual(other_link.anchor_provider_current_balance, Decimal("500.00"))
        self.other_connection.refresh_from_db()
        self.assertIsNone(self.other_connection.sync_cursor)
        self.assertIsNone(self.other_connection.transactions_update_status)
        self.assertEqual(self.other_connection.last_sync_error, "")
        self.assertEqual(self.other_connection.status, PlaidConnectionStatus.ACTIVE)
        mine = Account.objects.get(user=self.user)
        self.assertEqual(mine.opening_balance, Decimal("112.34"))
        self.assertEqual(mine.current_balance, Decimal("100.00"))

    def test_sync_run_logs_nothing(self):
        gateway = FakeSyncGateway(
            [
                make_page(
                    added=(
                        added_tx(transaction_id="tx-1", account_id=CHECKING_ACCOUNT_ID),
                    ),
                    account_outcomes=(checking_outcome(),),
                    next_cursor=CURSOR_A,
                    has_more=False,
                    status="INITIAL_UPDATE_COMPLETE",
                ),
            ]
        )

        with self.assertNoLogs("plaid_integration.services", level=logging.WARNING):
            result = perform_sync(self.connection, gateway=gateway, page_cap=10)

        self.assertFalse(result.blocked)
