"""Tests for idempotent per-page application of a normalized sync page.

Covers the ``docs/plaid.md`` section 7 sync-loop contract for issue #38
slice D: one ``transaction.atomic()`` block writes the applied rows and the
next cursor together, per-Item ``select_for_update()`` serialization, the
duplicate-safe ``added``/``modified``/``removed`` handling with override
preservation, pending-to-posted supersession with exactly-once ledger
counting via the slice A aggregate predicate, unmappable-account row
skipping, cross-user and cross-connection isolation, bounded redacted
quarantine summaries, the archived-``Uncategorized`` fail-closed case,
cursor-correctness (never backward, never on failure, never advanced past
an unrelated page, and the cursor-equality replay/no-progress contract),
and the atomic rollback of a mid-page failure on a later row. Every
database-visible behavior is asserted against the real PostgreSQL-backed
test database; no network or provider calls are ever made.
"""

import threading
from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.test import TestCase, TransactionTestCase
from django.utils import timezone

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    TransactionsUpdateStatus,
)
from plaid_integration.services import (
    ARCHIVED_CATEGORY_DETAIL,
    BLOCKED_CURSOR_DETAIL,
    SYNC_ERROR_TAG,
    SyncPageResult,
    apply_sync_page,
)
from plaid_integration.transaction_sync import (
    NormalizedProviderTransaction,
    NormalizedSyncPage,
    RemovedProviderTransaction,
    TransactionQuarantineOutcome,
)
from transactions.models import Transaction, TransactionType
from transactions.selectors import ledger_transactions_q

SYNTHETIC_ACCOUNT_ID = "plaid-account-sync-page-0001"
SYNTHETIC_ITEM_ID = "item-sandbox-sync-page-00001"
CURSOR_A = "cursor-opaque-a"
CURSOR_B = "cursor-opaque-b"
CURSOR_C = "cursor-opaque-c"


def make_page(
    *,
    added=(),
    modified=(),
    removed=(),
    quarantines=(),
    next_cursor=CURSOR_A,
    status="INITIAL_UPDATE_COMPLETE",
    has_more=False,
):
    return NormalizedSyncPage(
        added=tuple(added),
        modified=tuple(modified),
        removed=tuple(removed),
        account_outcomes=(),
        quarantines=tuple(quarantines),
        next_cursor=next_cursor,
        has_more=has_more,
        transactions_update_status=status,
        quarantined=len(quarantines),
    )


def added_tx(
    *,
    transaction_id="tx-1",
    account_id=SYNTHETIC_ACCOUNT_ID,
    pending_transaction_id=None,
    amount="12.34",
    transaction_type="expense",
    transaction_date=date(2024, 1, 15),
    name="Synthetic Store",
    is_pending=False,
):
    return NormalizedProviderTransaction(
        transaction_id=transaction_id,
        account_id=account_id,
        pending_transaction_id=pending_transaction_id,
        amount=Decimal(amount),
        transaction_type=transaction_type,
        date=transaction_date,
        name=name,
        is_pending=is_pending,
    )


def modified_tx(*args, **kwargs):
    return added_tx(*args, **kwargs)


def removed_tx(transaction_id):
    return RemovedProviderTransaction(transaction_id=transaction_id)


def quarantine(operation, reason):
    return TransactionQuarantineOutcome(operation=operation, reason=reason)


class SyncPageApplicationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="sync-page-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="sync-page-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id=SYNTHETIC_ITEM_ID,
            institution_name="Sync Page Bank",
        )
        cls.other_connection = PlaidConnection.objects.create(
            user=cls.other_user,
            item_id="item-sandbox-sync-page-other-00001",
            institution_name="Other Sync Bank",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Linked Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.account,
            plaid_account_id=SYNTHETIC_ACCOUNT_ID,
            plaid_type="depository",
            plaid_subtype="checking",
            mask="4321",
        )
        PlaidAccountLink.objects.create(
            connection=cls.other_connection,
            user=cls.other_user,
            account=cls.other_account,
            plaid_account_id="plaid-account-other-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )

    def apply(self, page, request_cursor=None):
        return apply_sync_page(self.connection, page, request_cursor=request_cursor)

    def ledger_count(self):
        return (
            Transaction.objects.filter(user=self.user)
            .filter(ledger_transactions_q())
            .count()
        )

    def test_first_page_applies_rows_and_commits_cursor(self):
        result = self.apply(
            make_page(
                added=(
                    added_tx(transaction_id="tx-1", amount="12.34"),
                    added_tx(
                        transaction_id="tx-2",
                        amount="45.00",
                        transaction_type="income",
                    ),
                ),
                next_cursor=CURSOR_A,
            )
        )

        self.assertEqual(
            result,
            SyncPageResult(
                applied=True,
                added=2,
                modified=0,
                removed=0,
                superseded=0,
                skipped=0,
                quarantined=0,
            ),
        )
        expense = Transaction.objects.get(plaid_transaction_id="tx-1")
        self.assertEqual(expense.user, self.user)
        self.assertEqual(expense.connection, self.connection)
        self.assertEqual(expense.account, self.account)
        self.assertEqual(expense.source, "plaid")
        self.assertEqual(expense.transaction_type, TransactionType.EXPENSE)
        self.assertEqual(expense.amount, Decimal("12.34"))
        self.assertEqual(expense.date, date(2024, 1, 15))
        self.assertEqual(expense.provider_name, "Synthetic Store")
        self.assertFalse(expense.is_pending)
        self.assertEqual(expense.plaid_transaction_id, "tx-1")
        self.assertIsNone(expense.plaid_pending_transaction_id)
        self.assertFalse(expense.is_provider_removed)
        self.assertFalse(expense.is_superseded)
        self.assertIsNone(expense.superseded_by)
        self.assertFalse(expense.category_customized)
        self.assertFalse(expense.note_customized)
        self.assertEqual(expense.category.name, "Uncategorized")
        self.assertEqual(expense.category.category_type, CategoryType.EXPENSE)
        income = Transaction.objects.get(plaid_transaction_id="tx-2")
        self.assertEqual(income.transaction_type, TransactionType.INCOME)
        self.assertEqual(income.amount, Decimal("45.00"))
        self.assertEqual(income.category.category_type, CategoryType.INCOME)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )
        self.assertIsNotNone(self.connection.last_synced_at)
        self.assertEqual(self.connection.last_sync_error, "")

    def test_incremental_page_uses_exact_stored_cursor_and_advances(self):
        self.connection.sync_cursor = CURSOR_A
        self.connection.save(update_fields=["sync_cursor"])

        result = self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-3"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertTrue(result.applied)
        self.assertEqual(result.added, 1)
        self.assertEqual(Transaction.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )

    def test_replay_of_same_page_is_idempotent(self):
        page = make_page(
            added=(added_tx(transaction_id="tx-1", amount="12.34"),),
            next_cursor=CURSOR_A,
        )
        first = self.apply(page)
        second = self.apply(page)

        self.assertTrue(first.applied)
        self.assertTrue(second.applied)
        self.assertEqual(second.added, 0)
        self.assertEqual(Transaction.objects.count(), 1)
        row = Transaction.objects.get()
        self.assertEqual(row.amount, Decimal("12.34"))
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)

        third = self.apply(page, request_cursor=CURSOR_A)
        self.assertTrue(third.applied)
        self.assertEqual(Transaction.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)

    def test_next_cursor_equality_never_advances_cursor_or_duplicates_rows(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_A,
            )
        )
        page_b = make_page(
            added=(added_tx(transaction_id="tx-2"),),
            next_cursor=CURSOR_B,
        )
        self.apply(page_b, request_cursor=CURSOR_A)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)

        # next_cursor equals the stored cursor: a replay of the page that
        # already committed tx-2 is re-applied idempotently and the cursor
        # does not move.
        replay = self.apply(page_b, request_cursor=CURSOR_A)
        self.assertTrue(replay.applied)
        self.assertEqual(replay.added, 0)
        self.assertEqual(Transaction.objects.count(), 2)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)

        # next_cursor equals the request_cursor: the provider made no forward
        # progress, so the page applies idempotently without duplicating the
        # already-stored row and leaves the cursor where it was.
        no_progress = self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_B,
        )
        self.assertTrue(no_progress.applied)
        self.assertEqual(no_progress.added, 0)
        self.assertEqual(Transaction.objects.count(), 2)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)

    def test_replay_never_duplicates_provider_categories(self):
        page = make_page(
            added=(added_tx(transaction_id="tx-1"),),
            next_cursor=CURSOR_A,
        )
        self.apply(page)
        self.apply(page)

        self.assertEqual(Category.objects.filter(user=self.user).count(), 2)

    def test_duplicate_added_for_existing_plaid_transaction_id_is_safe(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_A,
            )
        )

        result = self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.added, 0)
        self.assertEqual(
            Transaction.objects.filter(plaid_transaction_id="tx-1").count(),
            1,
        )

    def test_modified_preserves_customized_category_and_note(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1", amount="10.00"),),
                next_cursor=CURSOR_A,
            )
        )
        row = Transaction.objects.get()
        custom = Category.objects.create(
            user=self.user,
            name="Custom Food",
            category_type=CategoryType.EXPENSE,
        )
        row.category = custom
        row.category_customized = True
        row.note = "my note"
        row.note_customized = True
        row.save()

        result = self.apply(
            make_page(
                modified=(
                    modified_tx(
                        transaction_id="tx-1",
                        amount="25.00",
                        transaction_date=date(2024, 2, 1),
                        name="New Name",
                        is_pending=True,
                        pending_transaction_id="pend-1",
                    ),
                ),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.modified, 1)
        row.refresh_from_db()
        self.assertEqual(row.amount, Decimal("25.00"))
        self.assertEqual(row.provider_name, "New Name")
        self.assertEqual(row.date, date(2024, 2, 1))
        self.assertTrue(row.is_pending)
        self.assertEqual(row.plaid_pending_transaction_id, "pend-1")
        self.assertEqual(row.category, custom)
        self.assertEqual(row.note, "my note")
        self.assertTrue(row.category_customized)
        self.assertTrue(row.note_customized)

    def test_modified_updates_provider_fields_when_not_customized(self):
        self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-1",
                        amount="10.00",
                        is_pending=True,
                        pending_transaction_id="pend-1",
                    ),
                ),
                next_cursor=CURSOR_A,
            )
        )

        self.apply(
            make_page(
                modified=(
                    modified_tx(
                        transaction_id="tx-1",
                        amount="25.00",
                        name="New Name",
                        is_pending=False,
                    ),
                ),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        row = Transaction.objects.get()
        self.assertEqual(row.amount, Decimal("25.00"))
        self.assertEqual(row.provider_name, "New Name")
        self.assertFalse(row.is_pending)
        self.assertIsNone(row.plaid_pending_transaction_id)
        self.assertEqual(row.category.name, "Uncategorized")
        self.assertEqual(row.category.category_type, CategoryType.EXPENSE)
        self.assertFalse(row.category_customized)
        self.assertEqual(row.note, "")

    def test_modified_never_overwrites_note_even_when_not_customized(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_A,
            )
        )
        row = Transaction.objects.get()
        row.note = "kept"
        row.save(update_fields=["note"])

        self.apply(
            make_page(
                modified=(modified_tx(transaction_id="tx-1", amount="20.00"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        row.refresh_from_db()
        self.assertEqual(row.note, "kept")
        self.assertFalse(row.note_customized)
        self.assertEqual(row.amount, Decimal("20.00"))

    def test_removed_sets_provider_removed_and_preserves_history(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_A,
            )
        )

        result = self.apply(
            make_page(removed=(removed_tx("tx-1"),), next_cursor=CURSOR_B),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.removed, 1)
        self.assertEqual(Transaction.objects.count(), 1)
        row = Transaction.objects.get()
        self.assertTrue(row.is_provider_removed)
        self.assertFalse(row.is_superseded)
        self.assertIsNone(row.superseded_by)

        replay = self.apply(
            make_page(removed=(removed_tx("tx-1"),), next_cursor=CURSOR_B),
            request_cursor=CURSOR_B,
        )
        self.assertEqual(replay.removed, 0)
        row.refresh_from_db()
        self.assertTrue(row.is_provider_removed)
        self.assertEqual(Transaction.objects.count(), 1)

    def test_pending_to_posted_supersession_counts_exactly_once(self):
        # The slice A aggregate predicate also excludes rows whose account
        # link is not yet anchored; the anchor slice is out of scope here, so
        # the link is anchored directly to exercise exactly-once counting.
        PlaidAccountLink.objects.filter(connection=self.connection).update(
            anchor_applied_at=timezone.now()
        )
        self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="pend-1",
                        amount="30.00",
                        is_pending=True,
                    ),
                ),
                next_cursor=CURSOR_A,
            )
        )
        pending = Transaction.objects.get(plaid_transaction_id="pend-1")
        self.assertTrue(pending.is_pending)
        self.assertEqual(self.ledger_count(), 0)

        result = self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-posted-1",
                        amount="30.00",
                        pending_transaction_id="pend-1",
                    ),
                ),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.added, 1)
        self.assertEqual(result.superseded, 1)
        posted = Transaction.objects.get(plaid_transaction_id="tx-posted-1")
        self.assertFalse(posted.is_pending)
        pending.refresh_from_db()
        self.assertTrue(pending.is_superseded)
        self.assertIsNotNone(pending.superseded_by)
        self.assertEqual(pending.superseded_by, posted)
        self.assertFalse(pending.is_provider_removed)
        self.assertEqual(self.ledger_count(), 1)

        replay = self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-posted-1",
                        amount="30.00",
                        pending_transaction_id="pend-1",
                    ),
                ),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_B,
        )
        self.assertEqual(replay.added, 0)
        self.assertEqual(replay.superseded, 0)
        self.assertEqual(Transaction.objects.count(), 2)
        self.assertEqual(self.ledger_count(), 1)
        posted.refresh_from_db()
        pending.refresh_from_db()
        self.assertTrue(pending.is_superseded)
        self.assertEqual(pending.superseded_by, posted)

    def test_removed_then_superseded_converges(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="pend-1", is_pending=True),),
                next_cursor=CURSOR_A,
            )
        )
        self.apply(
            make_page(removed=(removed_tx("pend-1"),), next_cursor=CURSOR_B),
            request_cursor=CURSOR_A,
        )
        pending = Transaction.objects.get(plaid_transaction_id="pend-1")
        self.assertTrue(pending.is_provider_removed)
        self.assertFalse(pending.is_superseded)

        self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="posted-1",
                        pending_transaction_id="pend-1",
                    ),
                ),
                next_cursor=CURSOR_C,
            ),
            request_cursor=CURSOR_B,
        )

        pending.refresh_from_db()
        self.assertTrue(pending.is_provider_removed)
        self.assertTrue(pending.is_superseded)
        self.assertIsNotNone(pending.superseded_by)
        self.assertEqual(pending.superseded_by.plaid_transaction_id, "posted-1")

    def test_superseded_then_removed_converges(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="pend-1", is_pending=True),),
                next_cursor=CURSOR_A,
            )
        )
        self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="posted-1",
                        pending_transaction_id="pend-1",
                    ),
                ),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )
        pending = Transaction.objects.get(plaid_transaction_id="pend-1")
        self.assertTrue(pending.is_superseded)
        self.assertIsNotNone(pending.superseded_by)

        self.apply(
            make_page(removed=(removed_tx("pend-1"),), next_cursor=CURSOR_C),
            request_cursor=CURSOR_B,
        )

        pending.refresh_from_db()
        self.assertTrue(pending.is_superseded)
        self.assertTrue(pending.is_provider_removed)
        self.assertIsNotNone(pending.superseded_by)

    def test_unmapped_provider_account_rows_are_skipped(self):
        result = self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-unknown",
                        account_id="plaid-account-missing-1",
                    ),
                    added_tx(transaction_id="tx-ok"),
                ),
                modified=(
                    modified_tx(
                        transaction_id="tx-unknown",
                        account_id="plaid-account-missing-1",
                    ),
                ),
                next_cursor=CURSOR_A,
            )
        )

        self.assertEqual(result.added, 1)
        self.assertEqual(result.skipped, 2)
        self.assertEqual(Transaction.objects.count(), 1)
        self.assertTrue(
            Transaction.objects.filter(plaid_transaction_id="tx-ok").exists()
        )
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertIn("skipped 2 unlinked row(s)", self.connection.last_sync_error)

    def test_rows_for_foreign_linked_account_are_skipped_without_touching_other_user(
        self,
    ):
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=self.other_account,
            plaid_account_id="plaid-account-foreign-1",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="7777",
        )
        other_category = Category.objects.create(
            user=self.other_user,
            name="Their Category",
            category_type=CategoryType.EXPENSE,
        )
        other_tx = Transaction.objects.create(
            user=self.other_user,
            account=self.other_account,
            category=other_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("9.99"),
            date=date(2024, 1, 1),
            source="plaid",
            connection=self.other_connection,
            plaid_transaction_id="tx-theirs",
        )

        result = self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-new",
                        account_id="plaid-account-foreign-1",
                    ),
                ),
                next_cursor=CURSOR_A,
            )
        )

        self.assertEqual(result.skipped, 1)
        self.assertFalse(Transaction.objects.filter(user=self.user).exists())
        other_tx.refresh_from_db()
        self.assertEqual(other_tx.user, self.other_user)
        self.assertEqual(other_tx.account, self.other_account)
        self.assertEqual(other_tx.amount, Decimal("9.99"))
        self.assertFalse(other_tx.is_provider_removed)
        self.assertEqual(
            Transaction.objects.filter(plaid_transaction_id="tx-theirs").count(),
            1,
        )

    def test_cross_user_rows_are_never_read_or_mutated(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-owner"),),
                next_cursor=CURSOR_A,
            )
        )
        other_category = Category.objects.create(
            user=self.other_user,
            name="Their Expense",
            category_type=CategoryType.EXPENSE,
        )
        other_tx = Transaction.objects.create(
            user=self.other_user,
            account=self.other_account,
            category=other_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("9.99"),
            date=date(2024, 1, 1),
            source="plaid",
            connection=self.other_connection,
            plaid_transaction_id="tx-theirs",
        )

        result = self.apply(
            make_page(
                modified=(modified_tx(transaction_id="tx-theirs", amount="77.00"),),
                removed=(removed_tx("tx-theirs"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.modified, 0)
        self.assertEqual(result.removed, 0)
        other_tx.refresh_from_db()
        self.assertEqual(other_tx.amount, Decimal("9.99"))
        self.assertFalse(other_tx.is_provider_removed)
        self.other_connection.refresh_from_db()
        self.assertIsNone(self.other_connection.sync_cursor)
        self.assertIsNone(self.other_connection.transactions_update_status)
        self.assertEqual(self.other_connection.last_sync_error, "")

    def store_row_on_second_connection(self, transaction_id="tx-second"):
        """Create a second connection of the same user holding one plaid row.

        Uses the real sync path so the stored row, provider categories, and
        cursor exactly match what a second synced Item of this user owns.
        """
        connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-sync-page-second-00001",
            institution_name="Second Sync Bank",
        )
        account = Account.objects.create(
            user=self.user,
            name="Second Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=connection,
            user=self.user,
            account=account,
            plaid_account_id="plaid-account-sync-page-second-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="2222",
        )
        result = apply_sync_page(
            connection,
            make_page(
                added=(
                    added_tx(
                        transaction_id=transaction_id,
                        account_id="plaid-account-sync-page-second-0001",
                        amount="9.99",
                        transaction_date=date(2024, 2, 20),
                        name="Second Store",
                    ),
                ),
                next_cursor=CURSOR_A,
            ),
        )
        self.assertTrue(result.applied)
        return connection, account

    def test_modified_row_does_not_mutate_same_user_row_on_other_connection(
        self,
    ):
        self.apply(make_page(next_cursor=CURSOR_A))
        second_connection, _ = self.store_row_on_second_connection()
        row = Transaction.objects.get(plaid_transaction_id="tx-second")
        self.assertEqual(row.connection, second_connection)
        self.assertEqual(row.amount, Decimal("9.99"))
        self.assertEqual(row.provider_name, "Second Store")
        self.assertEqual(row.date, date(2024, 2, 20))

        result = self.apply(
            make_page(
                modified=(
                    modified_tx(
                        transaction_id="tx-second",
                        account_id=SYNTHETIC_ACCOUNT_ID,
                        amount="77.00",
                        transaction_date=date(2024, 3, 1),
                        name="Should Not Apply",
                    ),
                ),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.modified, 0)
        row.refresh_from_db()
        self.assertEqual(row.amount, Decimal("9.99"))
        self.assertEqual(row.provider_name, "Second Store")
        self.assertEqual(row.date, date(2024, 2, 20))
        self.assertFalse(row.is_pending)
        self.assertFalse(row.category_customized)
        self.assertEqual(row.connection, second_connection)

    def test_removed_row_does_not_flag_same_user_row_on_other_connection(self):
        self.apply(make_page(next_cursor=CURSOR_A))
        second_connection, _ = self.store_row_on_second_connection()
        row = Transaction.objects.get(plaid_transaction_id="tx-second")
        self.assertFalse(row.is_provider_removed)

        result = self.apply(
            make_page(
                removed=(removed_tx("tx-second"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.removed, 0)
        row.refresh_from_db()
        self.assertFalse(row.is_provider_removed)
        self.assertFalse(row.is_superseded)
        self.assertEqual(row.connection, second_connection)

    def test_added_row_for_same_user_account_on_other_connection_is_skipped(
        self,
    ):
        self.apply(make_page(next_cursor=CURSOR_A))
        second_connection, _ = self.store_row_on_second_connection()

        result = self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-under-second-account",
                        account_id="plaid-account-sync-page-second-0001",
                    ),
                ),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.skipped, 1)
        self.assertEqual(result.added, 0)
        self.assertFalse(
            Transaction.objects.filter(
                user=self.user,
                plaid_transaction_id="tx-under-second-account",
            ).exists()
        )
        self.assertEqual(
            Transaction.objects.filter(plaid_transaction_id="tx-second").count(),
            1,
        )
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_B)
        self.assertIn("skipped 1 unlinked row(s)", self.connection.last_sync_error)

    def test_duplicate_added_across_connections_is_refused_without_duplicating(self):
        self.apply(make_page(next_cursor=CURSOR_A))
        second_connection, _ = self.store_row_on_second_connection(
            transaction_id="dup-tx"
        )
        existing = Transaction.objects.get(plaid_transaction_id="dup-tx")
        self.assertEqual(existing.connection, second_connection)

        result = self.apply(
            make_page(
                added=(added_tx(transaction_id="dup-tx", amount="55.00"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.added, 0)
        self.assertEqual(
            Transaction.objects.filter(plaid_transaction_id="dup-tx").count(), 1
        )
        existing.refresh_from_db()
        self.assertEqual(existing.connection, second_connection)
        self.assertEqual(existing.amount, Decimal("9.99"))
        self.assertNotEqual(existing.connection, self.connection)

    def test_posted_row_does_not_supersede_same_user_pending_row_on_other_connection(
        self,
    ):
        self.apply(make_page(next_cursor=CURSOR_A))
        second_connection, _ = self.store_row_on_second_connection(
            transaction_id="pend-second"
        )
        Transaction.objects.filter(plaid_transaction_id="pend-second").update(
            is_pending=True
        )
        pending = Transaction.objects.get(plaid_transaction_id="pend-second")
        self.assertTrue(pending.is_pending)
        self.assertFalse(pending.is_superseded)

        result = self.apply(
            make_page(
                added=(
                    added_tx(
                        transaction_id="tx-posted-first",
                        pending_transaction_id="pend-second",
                    ),
                ),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertEqual(result.added, 1)
        self.assertEqual(result.superseded, 0)
        pending.refresh_from_db()
        self.assertFalse(pending.is_superseded)
        self.assertIsNone(pending.superseded_by)
        self.assertEqual(pending.connection, second_connection)

    def test_quarantined_rows_record_bounded_error_and_cursor_advances(self):
        result = self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-good-1"),),
                quarantines=(
                    quarantine("added", "zero amount"),
                    quarantine("added", "invalid date"),
                    quarantine("added", "zero amount"),
                ),
                next_cursor=CURSOR_A,
            )
        )

        self.assertEqual(result.quarantined, 3)
        self.assertEqual(result.added, 1)
        self.assertEqual(Transaction.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        error = self.connection.last_sync_error
        self.assertTrue(error.startswith(SYNC_ERROR_TAG))
        self.assertIn("quarantined 3 row(s)", error)
        self.assertIn("zero amount", error)
        self.assertIn("invalid date", error)
        for forbidden in ("tx-good-1", "12.34", CURSOR_A, SYNTHETIC_ITEM_ID):
            self.assertNotIn(forbidden, error)

        self.apply(make_page(next_cursor=CURSOR_B), request_cursor=CURSOR_A)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.last_sync_error, "")

    def test_quarantine_error_preserves_unrelated_error(self):
        self.connection.last_sync_error = "cursor lost after provider outage"
        self.connection.save(update_fields=["last_sync_error"])

        self.apply(
            make_page(
                quarantines=(quarantine("added", "zero amount"),),
                next_cursor=CURSOR_A,
            )
        )
        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.last_sync_error,
            "cursor lost after provider outage",
        )

        self.apply(make_page(next_cursor=CURSOR_B), request_cursor=CURSOR_A)
        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.last_sync_error,
            "cursor lost after provider outage",
        )

    def test_archived_uncategorized_fails_closed_leaving_nothing_applied(self):
        Category.objects.create(
            user=self.user,
            name="Uncategorized",
            category_type=CategoryType.INCOME,
            is_archived=True,
        )
        Category.objects.create(
            user=self.user,
            name="Uncategorized",
            category_type=CategoryType.EXPENSE,
            is_archived=True,
        )

        result = self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_A,
            )
        )

        self.assertFalse(result.applied)
        self.assertEqual(Transaction.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertIsNone(self.connection.transactions_update_status)
        self.assertIsNone(self.connection.last_synced_at)
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {ARCHIVED_CATEGORY_DETAIL}",
        )
        self.assertEqual(Category.objects.filter(user=self.user).count(), 2)
        archived_income = Category.objects.get(
            user=self.user, category_type=CategoryType.INCOME
        )
        self.assertTrue(archived_income.is_archived)

        result = self.apply(make_page(next_cursor=CURSOR_B), request_cursor=None)
        self.assertFalse(result.applied)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {ARCHIVED_CATEGORY_DETAIL}",
        )

    def test_atomic_failure_rolls_back_rows_cursor_and_status(self):
        self.connection.sync_cursor = CURSOR_A
        self.connection.transactions_update_status = (
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE
        )
        self.connection.last_synced_at = timezone.now()
        self.connection.last_sync_error = "stale unrelated import error"
        self.connection.save(
            update_fields=[
                "sync_cursor",
                "transactions_update_status",
                "last_synced_at",
                "last_sync_error",
            ]
        )
        status_before = self.connection.transactions_update_status
        synced_at_before = self.connection.last_synced_at
        error_before = self.connection.last_sync_error

        # The failure is deliberately on the second row, not the first: the
        # first row must already be applied (and saved) inside the page's
        # atomic block, so a regression that commits each row outside the
        # shared transaction would leave that row behind when the later row
        # fails. The negative amount violates the
        # transactions_amount_positive check constraint at INSERT time, so
        # the failure is a genuine database error.
        with self.assertRaises(IntegrityError):
            self.apply(
                make_page(
                    added=(
                        added_tx(transaction_id="tx-1", amount="12.34"),
                        added_tx(transaction_id="tx-2", amount="-5.00"),
                    ),
                    next_cursor=CURSOR_B,
                ),
                request_cursor=CURSOR_A,
            )

        self.assertFalse(
            Transaction.objects.filter(plaid_transaction_id="tx-1").exists()
        )
        self.assertEqual(Transaction.objects.count(), 0)
        self.assertEqual(Category.objects.filter(user=self.user).count(), 0)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertEqual(self.connection.transactions_update_status, status_before)
        self.assertEqual(self.connection.last_synced_at, synced_at_before)
        self.assertEqual(self.connection.last_sync_error, error_before)

    def test_already_advanced_page_cannot_double_apply(self):
        page = make_page(
            added=(added_tx(transaction_id="tx-1"),),
            next_cursor=CURSOR_A,
        )
        self.apply(page)

        second = self.apply(page)
        self.assertEqual(second.added, 0)
        self.assertEqual(Transaction.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)

    def test_inconsistent_cursor_blocks_page_without_mutation(self):
        self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_A,
            )
        )
        self.connection.refresh_from_db()
        last_synced_at = self.connection.last_synced_at

        result = self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-2"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor="cursor-from-another-context",
        )

        self.assertFalse(result.applied)
        self.assertEqual(Transaction.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )
        self.assertEqual(self.connection.last_synced_at, last_synced_at)
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {BLOCKED_CURSOR_DETAIL}",
        )
        self.assertNotIn("cursor-from-another-context", self.connection.last_sync_error)

    def test_lost_cursor_blocks_incremental_page(self):
        result = self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_B,
            ),
            request_cursor=CURSOR_A,
        )

        self.assertFalse(result.applied)
        self.assertEqual(Transaction.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertIsNone(self.connection.transactions_update_status)
        self.assertIsNone(self.connection.last_synced_at)
        self.assertEqual(
            self.connection.last_sync_error,
            f"{SYNC_ERROR_TAG} {BLOCKED_CURSOR_DETAIL}",
        )

    def test_status_maps_each_provider_value(self):
        cases = (
            ("NOT_READY", TransactionsUpdateStatus.NOT_READY),
            (
                "INITIAL_UPDATE_COMPLETE",
                TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
            ),
            (
                "HISTORICAL_UPDATE_COMPLETE",
                TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
            ),
        )
        for provider_status, model_status in cases:
            with self.subTest(status=provider_status):
                self.connection.sync_cursor = None
                self.connection.transactions_update_status = None
                self.connection.save(
                    update_fields=["sync_cursor", "transactions_update_status"]
                )
                self.apply(
                    make_page(
                        next_cursor=f"cursor-{provider_status}",
                        status=provider_status,
                    ),
                    request_cursor=None,
                )
                self.connection.refresh_from_db()
                self.assertEqual(
                    self.connection.transactions_update_status,
                    model_status,
                )

    def test_uncategorized_reuses_existing_user_rows(self):
        existing = Category.objects.create(
            user=self.user,
            name="Uncategorized",
            category_type=CategoryType.EXPENSE,
        )

        self.apply(
            make_page(
                added=(added_tx(transaction_id="tx-1"),),
                next_cursor=CURSOR_A,
            )
        )

        self.assertEqual(
            Category.objects.filter(
                user=self.user, category_type=CategoryType.EXPENSE
            ).count(),
            1,
        )
        self.assertEqual(
            Category.objects.filter(
                user=self.user, category_type=CategoryType.INCOME
            ).count(),
            1,
        )
        row = Transaction.objects.get()
        self.assertEqual(row.category, existing)

    def test_modified_and_removed_for_unknown_rows_are_noops(self):
        result = self.apply(
            make_page(
                modified=(modified_tx(transaction_id="never-existed"),),
                removed=(removed_tx("never-existed-2"),),
                next_cursor=CURSOR_A,
            )
        )

        self.assertEqual(result.modified, 0)
        self.assertEqual(result.removed, 0)
        self.assertEqual(Transaction.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
        self.assertEqual(self.connection.last_sync_error, "")


class SyncPageConcurrencyTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="sync-page-lock@example.com",
            password="TestOnlyPassword123!",
        )
        self.connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-sync-page-lock-00001",
            institution_name="Lock Test Bank",
        )
        self.account = Account.objects.create(
            user=self.user,
            name="Lock Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=self.account,
            plaid_account_id="plaid-account-lock-0001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )

    def test_select_for_update_serializes_concurrent_applies(self):
        lock_acquired = threading.Event()
        release_lock = threading.Event()
        errors = []

        def holder():
            from django.db import connections

            try:
                with transaction.atomic():
                    PlaidConnection.objects.select_for_update().get(
                        pk=self.connection.pk
                    )
                    lock_acquired.set()
                    if not release_lock.wait(30):
                        raise RuntimeError("lock holder timed out")
            except Exception as exc:  # pragma: no cover - failure path
                errors.append(exc)
            finally:
                connections.close_all()

        holder_thread = threading.Thread(target=holder)
        holder_thread.start()
        self.assertTrue(lock_acquired.wait(10))

        results = []
        page = make_page(
            added=(
                added_tx(transaction_id="tx-1", account_id="plaid-account-lock-0001"),
            ),
            next_cursor=CURSOR_A,
        )

        def applier():
            from django.db import connections

            try:
                results.append(apply_sync_page(self.connection, page))
            except Exception as exc:  # pragma: no cover - failure path
                errors.append(exc)
            finally:
                connections.close_all()

        applier_thread = threading.Thread(target=applier)
        applier_thread.start()
        applier_thread.join(timeout=1.0)
        self.assertTrue(
            applier_thread.is_alive(),
            "a concurrent page application must block on the Item row lock",
        )

        release_lock.set()
        applier_thread.join(timeout=30)
        holder_thread.join(timeout=30)

        self.assertFalse(errors)
        self.assertEqual(len(results), 1)
        self.assertTrue(results[0].applied)
        self.assertEqual(Transaction.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.sync_cursor, CURSOR_A)
