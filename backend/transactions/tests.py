from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models, transaction
from django.db.models.deletion import RestrictedError
from django.test import TestCase
from django.utils import timezone

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from transactions.models import Transaction, TransactionType

TRANSACTION_TYPE_CHOICES = [
    ("income", "Income"),
    ("expense", "Expense"),
]


class TransactionModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="transaction-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="transaction-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Everyday Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.category = Category.objects.create(
            user=cls.user,
            name="Salary",
            category_type=CategoryType.INCOME,
        )
        cls.expense_category = Category.objects.create(
            user=cls.user,
            name="Groceries",
            category_type=CategoryType.EXPENSE,
        )

    def create_transaction(self, **overrides):
        values = {
            "user": self.user,
            "account": self.account,
            "category": self.category,
            "transaction_type": TransactionType.INCOME,
            "amount": Decimal("25.50"),
            "date": date(2026, 9, 1),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def test_transaction_type_choices_are_exact(self):
        self.assertEqual(list(TransactionType.choices), TRANSACTION_TYPE_CHOICES)

    def test_transaction_belongs_to_user_through_related_name(self):
        transaction = self.create_transaction()

        self.assertEqual(transaction.user, self.user)
        self.assertEqual(list(self.user.transactions.all()), [transaction])
        self.assertFalse(self.other_user.transactions.exists())

    def test_account_and_category_expose_reverse_relations(self):
        transaction = self.create_transaction()

        self.assertEqual(list(self.account.transactions.all()), [transaction])
        self.assertEqual(list(self.category.transactions.all()), [transaction])
        self.assertFalse(self.expense_category.transactions.exists())

    def test_each_allowed_transaction_type_persists(self):
        for transaction_type, label in TRANSACTION_TYPE_CHOICES:
            with self.subTest(transaction_type=transaction_type):
                category = (
                    self.category
                    if transaction_type == TransactionType.INCOME
                    else self.expense_category
                )
                transaction = self.create_transaction(
                    transaction_type=transaction_type,
                    category=category,
                )
                transaction.refresh_from_db()

                self.assertEqual(transaction.transaction_type, transaction_type)
                self.assertEqual(transaction.get_transaction_type_display(), label)

    def test_amount_persists_exact_decimal(self):
        for amount in (
            Decimal("9999999999.99"),
            Decimal("25.50"),
            Decimal("0.01"),
        ):
            with self.subTest(amount=amount):
                transaction = self.create_transaction(amount=amount)
                transaction.refresh_from_db()

                self.assertIsInstance(transaction.amount, Decimal)
                self.assertEqual(transaction.amount, amount)

    def test_date_persists(self):
        transaction = self.create_transaction(date=date(2026, 9, 15))
        transaction.refresh_from_db()

        self.assertEqual(transaction.date, date(2026, 9, 15))

    def test_note_defaults_to_empty_string_and_accepts_text(self):
        default = self.create_transaction()
        with_note = self.create_transaction(
            note="Paid off the credit card bill early.",
        )

        self.assertEqual(default.note, "")
        self.assertEqual(
            with_note.note,
            "Paid off the credit card bill early.",
        )

    def test_timestamps_track_creation_and_updates(self):
        transaction = self.create_transaction()
        created_at = transaction.created_at

        self.assertIsNotNone(created_at)
        self.assertIsNotNone(transaction.updated_at)
        self.assertGreaterEqual(transaction.updated_at, created_at)

        transaction.note = "Edited note"
        transaction.save()
        transaction.refresh_from_db()

        self.assertEqual(transaction.created_at, created_at)
        self.assertGreater(transaction.updated_at, created_at)

    def test_default_ordering_is_date_desc_created_at_desc_id_desc(self):
        self.assertEqual(
            Transaction._meta.ordering,
            ("-date", "-created_at", "-id"),
        )

    def test_transactions_are_ordered_newest_first(self):
        older = self.create_transaction(date=date(2026, 8, 1))
        newer = self.create_transaction(date=date(2026, 9, 1))

        self.assertEqual(list(Transaction.objects.all()), [newer, older])

    def test_same_date_ties_break_by_created_at_descending(self):
        first = self.create_transaction(date=date(2026, 9, 1))
        second = self.create_transaction(date=date(2026, 9, 1))
        Transaction.objects.update(created_at=timezone.now() - timedelta(days=1))
        second.created_at = timezone.now()
        second.save(update_fields=["created_at"])

        self.assertEqual(list(Transaction.objects.all()), [second, first])

    def test_same_date_and_created_at_ties_break_by_id_descending(self):
        first = self.create_transaction(date=date(2026, 9, 1))
        second = self.create_transaction(date=date(2026, 9, 1))
        Transaction.objects.update(created_at=timezone.now())

        self.assertEqual(list(Transaction.objects.all()), [second, first])

    def test_str_returns_deterministic_representation_without_user_details(self):
        transaction = self.create_transaction(
            amount=Decimal("25.50"),
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
        )

        self.assertEqual(str(transaction), "2026-09-01 expense 25.50")
        self.assertNotIn(self.user.email, str(transaction))

    def test_database_constraint_rejects_zero_amount(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_transaction(amount=Decimal("0.00"))

        self.assertFalse(Transaction.objects.exists())

    def test_database_constraint_rejects_negative_amount(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_transaction(amount=Decimal("-1.00"))

        self.assertFalse(Transaction.objects.exists())

    def test_database_constraint_rejects_invalid_transaction_type(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_transaction(transaction_type="transfer")

        self.assertFalse(Transaction.objects.exists())

    def test_check_constraints_have_stable_names(self):
        constraint_names = {
            constraint.name for constraint in Transaction._meta.constraints
        }

        self.assertIn("transactions_transaction_type_valid", constraint_names)
        self.assertIn("transactions_amount_positive", constraint_names)
        self.assertTrue(
            all(
                isinstance(constraint, models.CheckConstraint)
                for constraint in Transaction._meta.constraints
            )
        )

    def test_user_date_index_has_stable_name(self):
        self.assertEqual(
            [(index.fields, index.name) for index in Transaction._meta.indexes],
            [(["user", "date"], "transactions_user_date_idx")],
        )

    def test_full_clean_accepts_valid_transaction(self):
        transaction = self.create_transaction()

        transaction.full_clean()

    def test_full_clean_accepts_archived_account_and_category(self):
        archived_account = Account.objects.create(
            user=self.user,
            name="Old Card",
            account_type=AccountType.CREDIT_CARD,
            opening_balance=Decimal("0.00"),
            is_archived=True,
        )
        archived_category = Category.objects.create(
            user=self.user,
            name="Old Rent",
            category_type=CategoryType.EXPENSE,
            is_archived=True,
        )
        transaction = Transaction(
            user=self.user,
            account=archived_account,
            category=archived_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("10.00"),
            date=date(2026, 9, 1),
        )

        transaction.full_clean()

    def test_full_clean_rejects_amount_beyond_precision(self):
        invalid_amounts = (
            Decimal("10.123"),
            Decimal("12345678901.00"),
        )

        for amount in invalid_amounts:
            with self.subTest(amount=amount):
                transaction = Transaction(
                    user=self.user,
                    account=self.account,
                    category=self.category,
                    transaction_type=TransactionType.INCOME,
                    amount=amount,
                    date=date(2026, 9, 1),
                )

                with self.assertRaises(ValidationError) as context:
                    transaction.full_clean()

                self.assertIn("amount", context.exception.message_dict)

    def test_full_clean_rejects_account_owned_by_another_user(self):
        other_account = Account.objects.create(
            user=self.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        transaction = Transaction(
            user=self.user,
            account=other_account,
            category=self.category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("10.00"),
            date=date(2026, 9, 1),
        )

        with self.assertRaises(ValidationError) as context:
            transaction.full_clean()

        self.assertIn("account", context.exception.message_dict)

    def test_full_clean_rejects_category_owned_by_another_user(self):
        other_category = Category.objects.create(
            user=self.other_user,
            name="Their Salary",
            category_type=CategoryType.INCOME,
        )
        transaction = Transaction(
            user=self.user,
            account=self.account,
            category=other_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("10.00"),
            date=date(2026, 9, 1),
        )

        with self.assertRaises(ValidationError) as context:
            transaction.full_clean()

        self.assertIn("category", context.exception.message_dict)

    def test_full_clean_rejects_category_type_mismatch(self):
        transaction = Transaction(
            user=self.user,
            account=self.account,
            category=self.expense_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("10.00"),
            date=date(2026, 9, 1),
        )

        with self.assertRaises(ValidationError) as context:
            transaction.full_clean()

        self.assertIn("category", context.exception.message_dict)

    def test_deleting_account_is_restricted_while_referenced(self):
        transaction = self.create_transaction()

        with self.assertRaises(RestrictedError):
            self.account.delete()

        self.assertTrue(Account.objects.filter(pk=self.account.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=transaction.pk).exists())

    def test_deleting_category_is_restricted_while_referenced(self):
        transaction = self.create_transaction()

        with self.assertRaises(RestrictedError):
            self.category.delete()

        self.assertTrue(Category.objects.filter(pk=self.category.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=transaction.pk).exists())

    def test_deleting_user_cascades_through_transactions_accounts_and_categories(self):
        transaction = self.create_transaction()

        self.user.delete()

        self.assertFalse(Transaction.objects.filter(pk=transaction.pk).exists())
        self.assertFalse(Account.objects.filter(pk=self.account.pk).exists())
        self.assertFalse(Category.objects.filter(pk=self.category.pk).exists())
