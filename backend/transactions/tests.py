from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models, transaction
from django.db.models.deletion import RestrictedError
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

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


def format_datetime(value):
    return value.isoformat().replace("+00:00", "Z")


class TransactionCollectionAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="transaction-api-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="transaction-api-other@example.com",
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
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.other_category = Category.objects.create(
            user=cls.other_user,
            name="Their Salary",
            category_type=CategoryType.INCOME,
        )
        cls.other_expense_category = Category.objects.create(
            user=cls.other_user,
            name="Their Groceries",
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

    def post_transaction(self, **overrides):
        payload = {
            "account": self.account.id,
            "category": self.category.id,
            "transaction_type": "income",
            "amount": "25.50",
            "date": "2026-09-01",
        }
        payload.update(overrides)
        return self.client.post(
            reverse("transaction-list"),
            payload,
            format="json",
        )

    def test_list_returns_exact_shape_and_order_newest_first(self):
        first = self.create_transaction(amount=Decimal("50.00"), date=date(2026, 8, 1))
        second = self.create_transaction(amount=Decimal("25.50"), date=date(2026, 9, 1))
        self.client.force_login(self.user)

        response = self.client.get(reverse("transaction-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data,
            [
                {
                    "id": second.id,
                    "account": self.account.id,
                    "category": self.category.id,
                    "transaction_type": "income",
                    "amount": "25.50",
                    "date": "2026-09-01",
                    "note": "",
                    "created_at": format_datetime(second.created_at),
                    "updated_at": format_datetime(second.updated_at),
                },
                {
                    "id": first.id,
                    "account": self.account.id,
                    "category": self.category.id,
                    "transaction_type": "income",
                    "amount": "50.00",
                    "date": "2026-08-01",
                    "note": "",
                    "created_at": format_datetime(first.created_at),
                    "updated_at": format_datetime(first.updated_at),
                },
            ],
        )

    def test_list_never_returns_another_users_transactions(self):
        mine = self.create_transaction()
        self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
        )
        self.client.force_login(self.user)

        response = self.client.get(reverse("transaction-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [mine.id])
        self.assertEqual(Transaction.objects.count(), 2)

    def test_list_includes_historical_transaction_after_account_and_category_archived(
        self,
    ):
        transaction = self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("10.00"),
        )
        Account.objects.filter(pk=self.account.pk).update(is_archived=True)
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)
        self.client.force_login(self.user)

        response = self.client.get(reverse("transaction-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [transaction.id])

    def test_list_requires_authentication(self):
        response = self.client.get(reverse("transaction-list"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_create_income_returns_201_and_exact_response(self):
        self.client.force_login(self.user)

        response = self.post_transaction()

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        transaction = Transaction.objects.get()
        self.assertEqual(Transaction.objects.count(), 1)
        self.assertEqual(transaction.user, self.user)
        self.assertEqual(transaction.account, self.account)
        self.assertEqual(transaction.category, self.category)
        self.assertEqual(transaction.transaction_type, "income")
        self.assertEqual(transaction.amount, Decimal("25.50"))
        self.assertEqual(transaction.date, date(2026, 9, 1))
        self.assertEqual(transaction.note, "")
        self.assertEqual(
            response.data,
            {
                "id": transaction.id,
                "account": self.account.id,
                "category": self.category.id,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
                "note": "",
                "created_at": format_datetime(transaction.created_at),
                "updated_at": format_datetime(transaction.updated_at),
            },
        )

    def test_create_expense_returns_201_and_exact_response(self):
        self.client.force_login(self.user)

        response = self.post_transaction(
            account=self.account.id,
            category=self.expense_category.id,
            transaction_type="expense",
            amount="10.00",
            date="2026-09-02",
            note="  Weekly groceries  ",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        transaction = Transaction.objects.get()
        self.assertEqual(transaction.user, self.user)
        self.assertEqual(transaction.transaction_type, "expense")
        self.assertEqual(transaction.amount, Decimal("10.00"))
        self.assertEqual(transaction.date, date(2026, 9, 2))
        self.assertEqual(transaction.note, "Weekly groceries")
        self.assertEqual(
            response.data,
            {
                "id": transaction.id,
                "account": self.account.id,
                "category": self.expense_category.id,
                "transaction_type": "expense",
                "amount": "10.00",
                "date": "2026-09-02",
                "note": "Weekly groceries",
                "created_at": format_datetime(transaction.created_at),
                "updated_at": format_datetime(transaction.updated_at),
            },
        )

    def test_create_ownership_and_server_fields_ignore_spoofed_input(self):
        self.client.force_login(self.user)

        response = self.post_transaction(
            user=self.other_user.id,
            id=999,
            is_archived=True,
            created_at="2000-01-01T00:00:00Z",
            updated_at="2000-01-01T00:00:00Z",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        transaction = Transaction.objects.get()
        self.assertEqual(Transaction.objects.count(), 1)
        self.assertEqual(transaction.user, self.user)
        self.assertNotEqual(transaction.id, 999)
        self.assertNotEqual(transaction.created_at.year, 2000)
        self.assertNotEqual(transaction.updated_at.year, 2000)
        self.assertNotIn("user", response.data)
        self.assertNotIn("is_archived", response.data)
        self.assertEqual(response.data["id"], transaction.id)

    def test_create_requires_authentication(self):
        response = self.post_transaction()

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_zero_amount(self):
        self.client.force_login(self.user)

        response = self.post_transaction(amount="0.00")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("amount", response.data)
        self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_negative_amount(self):
        self.client.force_login(self.user)

        response = self.post_transaction(amount="-1.00")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("amount", response.data)
        self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_nonnumeric_amount(self):
        self.client.force_login(self.user)

        response = self.post_transaction(amount="not-a-number")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("amount", response.data)
        self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_amount_beyond_precision(self):
        self.client.force_login(self.user)

        for amount in ("10.123", "12345678901.00"):
            with self.subTest(amount=amount):
                response = self.post_transaction(amount=amount)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("amount", response.data)
                self.assertFalse(Transaction.objects.exists())

    def test_create_accepts_maximum_valid_amount(self):
        self.client.force_login(self.user)

        response = self.post_transaction(amount="9999999999.99")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        transaction = Transaction.objects.get()
        self.assertEqual(transaction.amount, Decimal("9999999999.99"))
        self.assertEqual(response.data["amount"], "9999999999.99")

    def test_create_rejects_category_type_mismatch(self):
        self.client.force_login(self.user)

        response = self.post_transaction(
            category=self.expense_category.id,
            transaction_type="income",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_archived_account(self):
        archived = Account.objects.create(
            user=self.user,
            name="Old Card",
            account_type=AccountType.CREDIT_CARD,
            opening_balance=Decimal("0.00"),
            is_archived=True,
        )
        self.client.force_login(self.user)

        response = self.post_transaction(account=archived.id)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("account", response.data)
        self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_archived_category(self):
        archived = Category.objects.create(
            user=self.user,
            name="Old Rent",
            category_type=CategoryType.EXPENSE,
            is_archived=True,
        )
        self.client.force_login(self.user)

        response = self.post_transaction(
            category=archived.id,
            transaction_type="expense",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        self.assertFalse(Transaction.objects.exists())

    def test_create_requires_each_writable_field(self):
        self.client.force_login(self.user)

        for field in ("account", "category", "transaction_type", "amount", "date"):
            with self.subTest(field=field):
                payload = {
                    "account": self.account.id,
                    "category": self.category.id,
                    "transaction_type": "income",
                    "amount": "25.50",
                    "date": "2026-09-01",
                }
                payload.pop(field)

                response = self.client.post(
                    reverse("transaction-list"),
                    payload,
                    format="json",
                )

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)
                self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_null_writable_fields(self):
        self.client.force_login(self.user)

        for field in ("account", "category", "transaction_type", "amount", "date"):
            with self.subTest(field=field):
                response = self.post_transaction(**{field: None})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)
                self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_invalid_transaction_type(self):
        self.client.force_login(self.user)

        for transaction_type in ("transfer", "INCOME", ""):
            with self.subTest(transaction_type=transaction_type):
                response = self.post_transaction(transaction_type=transaction_type)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("transaction_type", response.data)
                self.assertFalse(Transaction.objects.exists())

    def test_create_rejects_invalid_date(self):
        self.client.force_login(self.user)

        for value in ("2026-13-01", "not-a-date"):
            with self.subTest(date=value):
                response = self.post_transaction(date=value)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("date", response.data)
                self.assertFalse(Transaction.objects.exists())

    def test_create_note_defaults_to_empty_string_when_omitted(self):
        self.client.force_login(self.user)

        response = self.post_transaction()

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["note"], "")
        self.assertEqual(Transaction.objects.get().note, "")

    def test_create_note_trims_whitespace_and_blank_becomes_empty(self):
        self.client.force_login(self.user)

        trimmed = self.post_transaction(note="  Paid early  ")
        blank = self.post_transaction(note="   ")

        self.assertEqual(trimmed.status_code, status.HTTP_201_CREATED)
        self.assertEqual(trimmed.data["note"], "Paid early")
        self.assertEqual(blank.status_code, status.HTTP_201_CREATED)
        self.assertEqual(blank.data["note"], "")
        self.assertEqual(Transaction.objects.count(), 2)

    def test_create_rejects_null_note(self):
        self.client.force_login(self.user)

        response = self.post_transaction(note=None)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("note", response.data)
        self.assertFalse(Transaction.objects.exists())

    def test_cross_user_and_missing_account_ids_are_indistinguishable(self):
        self.client.force_login(self.user)

        cross_user = self.client.post(
            reverse("transaction-list"),
            {
                "account": self.other_account.id,
                "category": self.category.id,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
            },
            format="json",
        )
        missing = self.client.post(
            reverse("transaction-list"),
            {
                "account": 999999,
                "category": self.category.id,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
            },
            format="json",
        )

        self.assertEqual(cross_user.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(missing.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(cross_user.json(), missing.json())
        self.assertIn("account", cross_user.json())
        self.assertFalse(Transaction.objects.exists())

    def test_cross_user_and_missing_category_ids_are_indistinguishable(self):
        self.client.force_login(self.user)

        cross_user = self.client.post(
            reverse("transaction-list"),
            {
                "account": self.account.id,
                "category": self.other_category.id,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
            },
            format="json",
        )
        missing = self.client.post(
            reverse("transaction-list"),
            {
                "account": self.account.id,
                "category": 999999,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
            },
            format="json",
        )

        self.assertEqual(cross_user.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(missing.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(cross_user.json(), missing.json())
        self.assertIn("category", cross_user.json())
        self.assertFalse(Transaction.objects.exists())

    def test_create_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.post(
            reverse("transaction-list"),
            {
                "account": self.account.id,
                "category": self.category.id,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertFalse(Transaction.objects.exists())

    def test_csrf_token_allows_create(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_token = csrf_client.get(reverse("auth-csrf")).cookies["csrftoken"].value

        response = csrf_client.post(
            reverse("transaction-list"),
            {
                "account": self.account.id,
                "category": self.category.id,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
            },
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Transaction.objects.count(), 1)
        self.assertEqual(Transaction.objects.get().user, self.user)

    def test_collection_rejects_unsupported_methods(self):
        self.client.force_login(self.user)

        for method in ("patch", "put", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    reverse("transaction-list"),
                    {"amount": "99.99"},
                    format="json",
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        self.assertFalse(Transaction.objects.exists())

    def test_options_and_head_are_supported(self):
        self.client.force_login(self.user)

        response = self.client.options(reverse("transaction-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self.client.head(reverse("transaction-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)


class TransactionDetailAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="transaction-detail-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="transaction-detail-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Everyday Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.second_account = Account.objects.create(
            user=cls.user,
            name="Travel Savings",
            account_type=AccountType.SAVINGS,
            opening_balance=Decimal("500.00"),
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
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.other_category = Category.objects.create(
            user=cls.other_user,
            name="Their Salary",
            category_type=CategoryType.INCOME,
        )
        cls.other_expense_category = Category.objects.create(
            user=cls.other_user,
            name="Their Groceries",
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

    def detail_url(self, transaction):
        return reverse("transaction-detail", args=[transaction.pk])

    @staticmethod
    def snapshot(transaction):
        return {
            "id": transaction.id,
            "user": transaction.user,
            "account": transaction.account,
            "category": transaction.category,
            "transaction_type": transaction.transaction_type,
            "amount": transaction.amount,
            "date": transaction.date,
            "note": transaction.note,
            "created_at": transaction.created_at,
            "updated_at": transaction.updated_at,
        }

    def test_detail_returns_exact_transaction_shape(self):
        transaction = self.create_transaction()
        self.client.force_login(self.user)

        response = self.client.get(self.detail_url(transaction))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data,
            {
                "id": transaction.id,
                "account": self.account.id,
                "category": self.category.id,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
                "note": "",
                "created_at": format_datetime(transaction.created_at),
                "updated_at": format_datetime(transaction.updated_at),
            },
        )

    def test_detail_returns_historical_transaction_after_relations_archived(self):
        transaction = self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("10.00"),
        )
        Account.objects.filter(pk=self.account.pk).update(is_archived=True)
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)
        self.client.force_login(self.user)

        response = self.client.get(self.detail_url(transaction))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["id"], transaction.id)

    def test_detail_returns_404_for_another_users_transaction(self):
        other_transaction = self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
        )
        self.client.force_login(self.user)

        response = self.client.get(self.detail_url(other_transaction))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertTrue(Transaction.objects.filter(pk=other_transaction.pk).exists())

    def test_detail_returns_404_for_missing_id(self):
        self.client.force_login(self.user)

        response = self.client.get(reverse("transaction-detail", args=[999999]))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

    def test_cross_user_and_missing_ids_are_indistinguishable(self):
        other_transaction = self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
        )
        self.client.force_login(self.user)

        cross_user = self.client.get(self.detail_url(other_transaction))
        missing = self.client.get(reverse("transaction-detail", args=[999999]))

        self.assertEqual(cross_user.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(cross_user.json(), missing.json())

    def test_detail_requires_authentication(self):
        transaction = self.create_transaction()

        response = self.client.get(self.detail_url(transaction))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def patch_transaction(self, transaction, payload):
        return self.client.patch(
            self.detail_url(transaction),
            payload,
            format="json",
        )

    def test_patch_partially_updates_note_only_and_keeps_other_fields(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        response = self.patch_transaction(transaction, {"note": "  Updated note  "})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        transaction.refresh_from_db()
        self.assertEqual(transaction.note, "Updated note")
        after = self.snapshot(transaction)
        for field in (
            "id",
            "user",
            "account",
            "category",
            "transaction_type",
            "amount",
            "date",
            "created_at",
        ):
            self.assertEqual(after[field], before[field])
        self.assertEqual(
            response.data,
            {
                "id": transaction.id,
                "account": self.account.id,
                "category": self.category.id,
                "transaction_type": "income",
                "amount": "25.50",
                "date": "2026-09-01",
                "note": "Updated note",
                "created_at": format_datetime(transaction.created_at),
                "updated_at": format_datetime(transaction.updated_at),
            },
        )

    def test_patch_updates_all_writable_fields_compatibly(self):
        transaction = self.create_transaction()
        self.client.force_login(self.user)

        response = self.patch_transaction(
            transaction,
            {
                "account": self.second_account.id,
                "category": self.expense_category.id,
                "transaction_type": "expense",
                "amount": "99.99",
                "date": "2026-10-01",
                "note": "Full rewrite",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        transaction.refresh_from_db()
        self.assertEqual(transaction.account, self.second_account)
        self.assertEqual(transaction.category, self.expense_category)
        self.assertEqual(transaction.transaction_type, "expense")
        self.assertEqual(transaction.amount, Decimal("99.99"))
        self.assertEqual(transaction.date, date(2026, 10, 1))
        self.assertEqual(transaction.note, "Full rewrite")
        self.assertEqual(transaction.user, self.user)
        self.assertEqual(response.data["account"], self.second_account.id)
        self.assertEqual(response.data["transaction_type"], "expense")
        self.assertEqual(response.data["amount"], "99.99")

    def test_patch_ignores_spoofed_owner_id_and_timestamps(self):
        transaction = self.create_transaction()
        transaction_id = transaction.id
        created_at = transaction.created_at
        self.client.force_login(self.user)

        response = self.patch_transaction(
            transaction,
            {
                "user": self.other_user.id,
                "id": transaction_id + 1,
                "created_at": "2000-01-01T00:00:00Z",
                "updated_at": "2000-01-01T00:00:00Z",
                "note": "Spoofed fields ignored",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        transaction.refresh_from_db()
        self.assertEqual(transaction.id, transaction_id)
        self.assertEqual(transaction.user, self.user)
        self.assertEqual(transaction.created_at, created_at)
        self.assertNotEqual(transaction.updated_at.year, 2000)
        self.assertEqual(transaction.note, "Spoofed fields ignored")
        self.assertNotIn("user", response.data)
        self.assertEqual(response.data["id"], transaction_id)

    def test_patch_returns_404_for_another_users_transaction_without_side_effects(self):
        other_transaction = self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
        )
        before = self.snapshot(other_transaction)
        self.client.force_login(self.user)

        response = self.patch_transaction(other_transaction, {"note": "Spoofed"})

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        other_transaction.refresh_from_db()
        self.assertEqual(self.snapshot(other_transaction), before)

    def test_patch_returns_404_for_missing_id_without_side_effects(self):
        self.client.force_login(self.user)

        response = self.client.patch(
            reverse("transaction-detail", args=[999999]),
            {"note": "Spoofed"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Transaction.objects.count(), 0)

    def test_patch_foreign_and_missing_ids_are_indistinguishable(self):
        other_transaction = self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
        )
        before = self.snapshot(other_transaction)
        self.client.force_login(self.user)

        foreign = self.patch_transaction(other_transaction, {"note": "Spoofed"})
        missing = self.client.patch(
            reverse("transaction-detail", args=[999999]),
            {"note": "Spoofed"},
            format="json",
        )

        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(foreign.json(), missing.json())
        other_transaction.refresh_from_db()
        self.assertEqual(self.snapshot(other_transaction), before)

    def test_patch_rejects_invalid_amount_without_mutation(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        for amount in (
            "0.00",
            "-1.00",
            "not-a-number",
            "10.123",
            "12345678901.00",
            "",
        ):
            with self.subTest(amount=amount):
                response = self.patch_transaction(transaction, {"amount": amount})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("amount", response.data)

        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_rejects_invalid_date_without_mutation(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        for value in ("2026-13-01", "not-a-date", ""):
            with self.subTest(date=value):
                response = self.patch_transaction(transaction, {"date": value})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("date", response.data)

        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_rejects_invalid_transaction_type_without_mutation(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        for value in ("transfer", "INCOME", ""):
            with self.subTest(transaction_type=value):
                response = self.patch_transaction(
                    transaction, {"transaction_type": value}
                )

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("transaction_type", response.data)

        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_rejects_null_and_blank_relation_ids_without_mutation(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        for field, value in (
            ("account", None),
            ("category", None),
            ("account", ""),
            ("category", ""),
        ):
            with self.subTest(field=field, value=value):
                response = self.patch_transaction(transaction, {field: value})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)

        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_rejects_null_note_without_mutation(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        response = self.patch_transaction(transaction, {"note": None})

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("note", response.data)
        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_rejects_null_amount_date_and_type_without_mutation(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        for field in ("amount", "date", "transaction_type"):
            with self.subTest(field=field):
                response = self.patch_transaction(transaction, {field: None})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)

        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_note_whitespace_only_becomes_empty(self):
        transaction = self.create_transaction(note="Original note")
        self.client.force_login(self.user)

        response = self.patch_transaction(transaction, {"note": "   "})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        transaction.refresh_from_db()
        self.assertEqual(transaction.note, "")
        self.assertEqual(response.data["note"], "")

    def test_patch_changing_only_transaction_type_to_mismatch_existing_category(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        response = self.patch_transaction(transaction, {"transaction_type": "expense"})

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_changing_only_category_to_mismatch_existing_type(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        response = self.patch_transaction(
            transaction, {"category": self.expense_category.id}
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_compatible_category_and_type_change_together_succeeds(self):
        transaction = self.create_transaction()
        self.client.force_login(self.user)

        response = self.patch_transaction(
            transaction,
            {
                "category": self.expense_category.id,
                "transaction_type": "expense",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        transaction.refresh_from_db()
        self.assertEqual(transaction.category, self.expense_category)
        self.assertEqual(transaction.transaction_type, "expense")

    def test_patch_rejects_explicit_archived_account_without_mutation(self):
        archived = Account.objects.create(
            user=self.user,
            name="Old Card",
            account_type=AccountType.CREDIT_CARD,
            opening_balance=Decimal("0.00"),
            is_archived=True,
        )
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        response = self.patch_transaction(transaction, {"account": archived.id})

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("account", response.data)
        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_rejects_explicit_archived_category_without_mutation(self):
        archived = Category.objects.create(
            user=self.user,
            name="Old Rent",
            category_type=CategoryType.EXPENSE,
            is_archived=True,
        )
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        response = self.patch_transaction(
            transaction,
            {"category": archived.id, "transaction_type": "expense"},
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_patch_allows_unrelated_update_on_historical_archived_relations(self):
        transaction = self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("10.00"),
        )
        Account.objects.filter(pk=self.account.pk).update(is_archived=True)
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)
        self.client.force_login(self.user)

        response = self.patch_transaction(
            transaction,
            {"note": "Still editable", "date": "2026-09-05", "amount": "15.00"},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        transaction.refresh_from_db()
        self.assertEqual(transaction.note, "Still editable")
        self.assertEqual(transaction.date, date(2026, 9, 5))
        self.assertEqual(transaction.amount, Decimal("15.00"))
        self.assertEqual(transaction.account, self.account)
        self.assertEqual(transaction.category, self.expense_category)

    def test_delete_returns_204_empty_and_removes_only_the_transaction_row(self):
        transaction = self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
        )
        account_id = self.account.id
        category_id = self.expense_category.id
        self.client.force_login(self.user)

        response = self.client.delete(self.detail_url(transaction))

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(response.content, b"")
        self.assertFalse(Transaction.objects.filter(pk=transaction.pk).exists())
        self.assertTrue(Account.objects.filter(pk=account_id).exists())
        self.assertTrue(Category.objects.filter(pk=category_id).exists())

    def test_delete_is_not_repeatable_second_delete_returns_404(self):
        transaction = self.create_transaction()
        self.client.force_login(self.user)

        first = self.client.delete(self.detail_url(transaction))
        second = self.client.delete(self.detail_url(transaction))

        self.assertEqual(first.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(second.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(
            second.json(), {"detail": "No Transaction matches the given query."}
        )
        self.assertFalse(Transaction.objects.exists())

    def test_delete_returns_404_for_another_users_transaction_without_side_effects(
        self,
    ):
        other_transaction = self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
        )
        before = self.snapshot(other_transaction)
        self.client.force_login(self.user)

        response = self.client.delete(self.detail_url(other_transaction))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        other_transaction.refresh_from_db()
        self.assertEqual(self.snapshot(other_transaction), before)

    def test_delete_returns_404_for_missing_id(self):
        self.client.force_login(self.user)

        response = self.client.delete(reverse("transaction-detail", args=[999999]))

        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(Transaction.objects.count(), 0)

    def test_delete_foreign_and_missing_ids_are_indistinguishable(self):
        other_transaction = self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
        )
        before = self.snapshot(other_transaction)
        self.client.force_login(self.user)

        foreign = self.client.delete(self.detail_url(other_transaction))
        missing = self.client.delete(reverse("transaction-detail", args=[999999]))

        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(foreign.json(), missing.json())
        other_transaction.refresh_from_db()
        self.assertEqual(self.snapshot(other_transaction), before)

    def test_detail_requires_authentication_for_get_patch_delete(self):
        transaction = self.create_transaction()
        url = self.detail_url(transaction)

        for method, payload in (
            ("get", None),
            ("patch", {"note": "Spoofed"}),
            ("delete", None),
        ):
            with self.subTest(method=method):
                kwargs = {"format": "json"} if payload is not None else {}
                response = getattr(self.client, method)(url, payload or {}, **kwargs)

                self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
                self.assertEqual(
                    response.data,
                    {"detail": "Authentication credentials were not provided."},
                )

        transaction.refresh_from_db()
        self.assertEqual(transaction.note, "")
        self.assertTrue(Transaction.objects.filter(pk=transaction.pk).exists())

    def test_patch_requires_csrf_token_without_mutation(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.patch(
            self.detail_url(transaction),
            {"note": "Blocked"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_csrf_token_allows_patch(self):
        transaction = self.create_transaction()
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_token = csrf_client.get(reverse("auth-csrf")).cookies["csrftoken"].value

        response = csrf_client.patch(
            self.detail_url(transaction),
            {"note": "Allowed"},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        transaction.refresh_from_db()
        self.assertEqual(transaction.note, "Allowed")

    def test_delete_requires_csrf_token_without_side_effects(self):
        transaction = self.create_transaction()
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.delete(self.detail_url(transaction))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertTrue(Transaction.objects.filter(pk=transaction.pk).exists())

    def test_csrf_token_allows_delete(self):
        transaction = self.create_transaction()
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_token = csrf_client.get(reverse("auth-csrf")).cookies["csrftoken"].value

        response = csrf_client.delete(
            self.detail_url(transaction),
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(Transaction.objects.filter(pk=transaction.pk).exists())

    def test_detail_rejects_post_and_put_without_mutation(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)
        url = self.detail_url(transaction)

        for method in ("post", "put"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    url,
                    {"note": "Ignored"},
                    format="json",
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)

    def test_detail_supports_options_and_head(self):
        transaction = self.create_transaction()
        self.client.force_login(self.user)
        url = self.detail_url(transaction)

        self.assertEqual(self.client.options(url).status_code, status.HTTP_200_OK)
        self.assertEqual(self.client.head(url).status_code, status.HTTP_200_OK)

    def test_patch_relation_ids_other_user_and_missing_are_indistinguishable(self):
        transaction = self.create_transaction()
        before = self.snapshot(transaction)
        self.client.force_login(self.user)

        cross_user = self.patch_transaction(
            transaction,
            {"account": self.other_account.id},
        )
        missing = self.patch_transaction(transaction, {"account": 999999})
        cross_user_category = self.patch_transaction(
            transaction,
            {"category": self.other_category.id},
        )
        missing_category = self.patch_transaction(transaction, {"category": 999999})

        for response in (cross_user, missing, cross_user_category, missing_category):
            self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(cross_user.json(), missing.json())
        self.assertEqual(cross_user_category.json(), missing_category.json())
        self.assertIn("account", cross_user.json())
        self.assertIn("category", cross_user_category.json())
        transaction.refresh_from_db()
        self.assertEqual(self.snapshot(transaction), before)


class TransactionFilterAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="transaction-filter-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="transaction-filter-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Everyday Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.second_account = Account.objects.create(
            user=cls.user,
            name="Travel Savings",
            account_type=AccountType.SAVINGS,
            opening_balance=Decimal("500.00"),
        )
        cls.archived_account = Account.objects.create(
            user=cls.user,
            name="Old Card",
            account_type=AccountType.CREDIT_CARD,
            opening_balance=Decimal("0.00"),
            is_archived=True,
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
        cls.freelance_category = Category.objects.create(
            user=cls.user,
            name="Freelance",
            category_type=CategoryType.INCOME,
        )
        cls.archived_category = Category.objects.create(
            user=cls.user,
            name="Old Rent",
            category_type=CategoryType.EXPENSE,
            is_archived=True,
        )
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.other_category = Category.objects.create(
            user=cls.other_user,
            name="Their Salary",
            category_type=CategoryType.INCOME,
        )
        cls.other_expense_category = Category.objects.create(
            user=cls.other_user,
            name="Their Groceries",
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

    def get_list(self, **params):
        return self.client.get(reverse("transaction-list"), params)

    def test_list_filters_by_account_and_never_exposes_other_users_rows(self):
        on_first = self.create_transaction(
            amount=Decimal("50.00"), date=date(2026, 9, 1)
        )
        on_second = self.create_transaction(
            account=self.second_account,
            amount=Decimal("25.50"),
            date=date(2026, 9, 10),
        )
        expense_on_first = self.create_transaction(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("10.00"),
            date=date(2026, 8, 1),
        )
        self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
            date=date(2026, 9, 15),
        )
        self.client.force_login(self.user)

        response = self.get_list(account=self.account.id)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item["id"] for item in response.data],
            [on_first.id, expense_on_first.id],
        )
        self.assertNotIn(on_second.id, [item["id"] for item in response.data])
        self.assertEqual(Transaction.objects.count(), 4)

    def test_list_account_filter_accepts_owned_archived_account(self):
        transaction = self.create_transaction(
            account=self.archived_account,
            date=date(2026, 9, 2),
        )
        self.client.force_login(self.user)

        response = self.get_list(account=self.archived_account.id)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [transaction.id])

    def test_list_account_filter_rejects_foreign_and_missing_identically(self):
        self.client.force_login(self.user)

        foreign = self.get_list(account=self.other_account.id)
        missing = self.get_list(account=999999)

        self.assertEqual(foreign.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(missing.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(foreign.json(), missing.json())
        self.assertEqual(foreign.json(), {"account": ["Invalid account."]})

    def test_list_account_filter_rejects_blank_noninteger_zero_negative(self):
        self.client.force_login(self.user)

        for value in ("", "abc", "0", "-5"):
            with self.subTest(account=value):
                response = self.get_list(account=value)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("account", response.data)

    def test_list_filters_by_category_and_never_exposes_other_users_rows(self):
        income = self.create_transaction(amount=Decimal("50.00"), date=date(2026, 9, 1))
        expense = self.create_transaction(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("10.00"),
            date=date(2026, 8, 1),
        )
        self.create_transaction(
            account=self.second_account,
            amount=Decimal("25.50"),
            date=date(2026, 9, 10),
        )
        self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_expense_category,
            transaction_type=TransactionType.EXPENSE,
            date=date(2026, 9, 15),
        )
        self.client.force_login(self.user)

        response = self.get_list(category=self.expense_category.id)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [expense.id])
        self.assertNotIn(income.id, [item["id"] for item in response.data])
        self.assertEqual(Transaction.objects.count(), 4)

    def test_list_category_filter_accepts_owned_archived_category(self):
        transaction = self.create_transaction(
            category=self.archived_category,
            transaction_type=TransactionType.EXPENSE,
            date=date(2026, 9, 2),
        )
        self.client.force_login(self.user)

        response = self.get_list(category=self.archived_category.id)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [transaction.id])

    def test_list_category_filter_rejects_foreign_and_missing_identically(self):
        self.client.force_login(self.user)

        foreign = self.get_list(category=self.other_category.id)
        missing = self.get_list(category=999999)

        self.assertEqual(foreign.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(missing.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(foreign.json(), missing.json())
        self.assertEqual(foreign.json(), {"category": ["Invalid category."]})

    def test_list_category_filter_rejects_blank_noninteger_zero_negative(self):
        self.client.force_login(self.user)

        for value in ("", "abc", "0", "-5"):
            with self.subTest(category=value):
                response = self.get_list(category=value)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("category", response.data)

    def test_list_filters_by_transaction_type_exactly(self):
        income = self.create_transaction(amount=Decimal("50.00"), date=date(2026, 9, 1))
        expense = self.create_transaction(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("10.00"),
            date=date(2026, 8, 1),
        )
        later_income = self.create_transaction(
            account=self.second_account,
            amount=Decimal("25.50"),
            date=date(2026, 9, 10),
        )
        self.client.force_login(self.user)

        income_response = self.get_list(transaction_type="income")
        expense_response = self.get_list(transaction_type="expense")

        self.assertEqual(income_response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item["id"] for item in income_response.data],
            [later_income.id, income.id],
        )
        self.assertEqual(expense_response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item["id"] for item in expense_response.data],
            [expense.id],
        )

    def test_list_transaction_type_filter_rejects_invalid_variants(self):
        self.client.force_login(self.user)

        for value in ("transfer", "INCOME", "Income", "", " income", "null"):
            with self.subTest(transaction_type=value):
                response = self.get_list(transaction_type=value)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("transaction_type", response.data)

    def test_list_filters_by_start_date_inclusive(self):
        before = self.create_transaction(amount=Decimal("50.00"), date=date(2026, 8, 1))
        on_boundary = self.create_transaction(
            account=self.second_account,
            amount=Decimal("25.50"),
            date=date(2026, 9, 1),
        )
        after = self.create_transaction(
            account=self.second_account,
            amount=Decimal("30.00"),
            date=date(2026, 9, 10),
        )
        self.client.force_login(self.user)

        response = self.get_list(start_date="2026-09-01")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item["id"] for item in response.data],
            [after.id, on_boundary.id],
        )
        self.assertNotIn(before.id, [item["id"] for item in response.data])

    def test_list_filters_by_end_date_inclusive(self):
        before = self.create_transaction(amount=Decimal("50.00"), date=date(2026, 8, 1))
        on_boundary = self.create_transaction(
            account=self.second_account,
            amount=Decimal("25.50"),
            date=date(2026, 8, 31),
        )
        after = self.create_transaction(
            account=self.second_account,
            amount=Decimal("30.00"),
            date=date(2026, 9, 10),
        )
        self.client.force_login(self.user)

        response = self.get_list(end_date="2026-08-31")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item["id"] for item in response.data],
            [on_boundary.id, before.id],
        )
        self.assertNotIn(after.id, [item["id"] for item in response.data])

    def test_list_equal_start_and_end_dates_return_that_single_day(self):
        matching = self.create_transaction(
            amount=Decimal("50.00"), date=date(2026, 9, 1)
        )
        self.create_transaction(
            account=self.second_account,
            amount=Decimal("25.50"),
            date=date(2026, 9, 2),
        )
        self.client.force_login(self.user)

        response = self.get_list(start_date="2026-09-01", end_date="2026-09-01")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [matching.id])

    def test_list_rejects_invalid_and_blank_dates(self):
        self.client.force_login(self.user)

        for field in ("start_date", "end_date"):
            for value in ("2026-13-01", "not-a-date", ""):
                with self.subTest(field=field, value=value):
                    response = self.get_list(**{field: value})

                    self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                    self.assertIn(field, response.data)

    def test_list_reversed_date_range_returns_400_under_end_date(self):
        self.client.force_login(self.user)

        response = self.get_list(start_date="2026-10-01", end_date="2026-09-01")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("end_date", response.data)

    def test_list_combines_filters_with_logical_and(self):
        self.create_transaction(amount=Decimal("50.00"), date=date(2026, 9, 1))
        outside_range = self.create_transaction(
            account=self.second_account,
            amount=Decimal("25.50"),
            date=date(2026, 9, 20),
        )
        same_type_decoy = self.create_transaction(
            account=self.second_account,
            category=self.freelance_category,
            amount=Decimal("21.00"),
            date=date(2026, 9, 10),
        )
        matching = self.create_transaction(
            account=self.second_account,
            category=self.category,
            amount=Decimal("30.00"),
            date=date(2026, 9, 10),
        )
        self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
            date=date(2026, 9, 10),
        )
        self.client.force_login(self.user)

        response = self.get_list(
            account=self.second_account.id,
            category=self.category.id,
            transaction_type="income",
            start_date="2026-09-01",
            end_date="2026-09-15",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [matching.id])
        self.assertNotIn(outside_range.id, [item["id"] for item in response.data])
        self.assertNotIn(same_type_decoy.id, [item["id"] for item in response.data])

    def test_list_valid_filter_with_no_matches_returns_empty_array(self):
        self.create_transaction(amount=Decimal("50.00"), date=date(2026, 9, 1))
        self.client.force_login(self.user)

        response = self.get_list(
            account=self.second_account.id,
            transaction_type="expense",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, [])

    def test_list_filtered_results_preserve_model_ordering(self):
        older = self.create_transaction(amount=Decimal("50.00"), date=date(2026, 8, 1))
        newer = self.create_transaction(
            account=self.second_account,
            amount=Decimal("25.50"),
            date=date(2026, 9, 10),
        )
        newest = self.create_transaction(
            account=self.second_account,
            amount=Decimal("30.00"),
            date=date(2026, 9, 15),
        )
        self.client.force_login(self.user)

        response = self.get_list(account=self.second_account.id)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            [item["id"] for item in response.data],
            [newest.id, newer.id],
        )
        self.assertNotIn(older.id, [item["id"] for item in response.data])

    def test_list_invalid_filters_do_not_mutate_rows(self):
        transaction = self.create_transaction(
            amount=Decimal("50.00"), date=date(2026, 9, 1)
        )
        before = (Transaction.objects.count(), transaction.note)
        self.client.force_login(self.user)

        self.get_list(account="abc")
        self.get_list(category=0)
        self.get_list(transaction_type="transfer")
        self.get_list(start_date="not-a-date")
        self.get_list(start_date="2026-10-01", end_date="2026-09-01")

        transaction.refresh_from_db()
        self.assertEqual((Transaction.objects.count(), transaction.note), before)

    def test_list_anonymous_malformed_filter_still_returns_401(self):
        response = self.get_list(account="abc", start_date="2026-13-01")

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_detail_actions_ignore_query_params(self):
        transaction = self.create_transaction()
        other_transaction = self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
        )
        self.client.force_login(self.user)
        owned_url = reverse("transaction-detail", args=[transaction.pk])
        foreign_url = reverse("transaction-detail", args=[other_transaction.pk])
        invalid_query = "?account=abc&start_date=not-a-date&transaction_type=transfer"

        get_response = self.client.get(f"{owned_url}{invalid_query}")
        patch_response = self.client.patch(
            f"{owned_url}{invalid_query}",
            {"note": "Filter ignored"},
            format="json",
        )
        delete_response = self.client.delete(f"{owned_url}{invalid_query}")
        foreign_response = self.client.get(f"{foreign_url}{invalid_query}")

        self.assertEqual(get_response.status_code, status.HTTP_200_OK)
        self.assertEqual(patch_response.status_code, status.HTTP_200_OK)
        self.assertEqual(delete_response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(foreign_response.status_code, status.HTTP_404_NOT_FOUND)
        self.assertFalse(Transaction.objects.filter(pk=transaction.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=other_transaction.pk).exists())

    def test_head_and_options_remain_successful_with_filter_params(self):
        self.create_transaction()
        self.client.force_login(self.user)

        head_response = self.client.head(
            reverse("transaction-list"),
            {"account": self.account.id, "transaction_type": "income"},
        )
        options_response = self.client.options(
            reverse("transaction-list"),
            {"start_date": "2026-09-01"},
        )

        self.assertEqual(head_response.status_code, status.HTTP_200_OK)
        self.assertEqual(options_response.status_code, status.HTTP_200_OK)
