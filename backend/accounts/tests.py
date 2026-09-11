from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models, transaction
from django.test import TestCase
from django.utils import timezone

from accounts.models import Account, AccountType

ACCOUNT_TYPE_CHOICES = [
    ("checking", "Checking"),
    ("savings", "Savings"),
    ("cash", "Cash"),
    ("credit_card", "Credit card"),
]


class AccountModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="account-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="other-owner@example.com",
            password="TestOnlyPassword123!",
        )

    def create_account(self, **overrides):
        values = {
            "user": self.user,
            "name": "Everyday Checking",
            "account_type": AccountType.CHECKING,
            "opening_balance": Decimal("100.00"),
        }
        values.update(overrides)
        return Account.objects.create(**values)

    def test_account_type_choices_are_exact(self):
        self.assertEqual(list(AccountType.choices), ACCOUNT_TYPE_CHOICES)

    def test_account_belongs_to_user_through_related_name(self):
        account = self.create_account()

        self.assertEqual(account.user, self.user)
        self.assertEqual(list(self.user.accounts.all()), [account])
        self.assertFalse(self.other_user.accounts.exists())

    def test_deleting_user_cascades_to_owned_accounts(self):
        account = self.create_account()
        other_account = self.create_account(
            user=self.other_user,
            name="Other Cash",
            account_type=AccountType.CASH,
        )

        self.user.delete()

        self.assertFalse(Account.objects.filter(pk=account.pk).exists())
        self.assertTrue(Account.objects.filter(pk=other_account.pk).exists())

    def test_each_allowed_account_type_persists(self):
        for account_type, label in ACCOUNT_TYPE_CHOICES:
            with self.subTest(account_type=account_type):
                account = self.create_account(account_type=account_type)
                account.refresh_from_db()

                self.assertEqual(account.account_type, account_type)
                self.assertEqual(account.get_account_type_display(), label)

    def test_opening_balance_persists_exact_decimal_including_negative(self):
        for opening_balance in (
            Decimal("123456789.12"),
            Decimal("0.00"),
            Decimal("-250.75"),
        ):
            with self.subTest(opening_balance=opening_balance):
                account = self.create_account(opening_balance=opening_balance)
                account.refresh_from_db()

                self.assertIsInstance(account.opening_balance, Decimal)
                self.assertEqual(account.opening_balance, opening_balance)

    def test_is_archived_defaults_to_false(self):
        account = self.create_account()

        self.assertFalse(account.is_archived)

    def test_timestamps_track_creation_and_updates(self):
        account = self.create_account()
        created_at = account.created_at

        self.assertIsNotNone(created_at)
        self.assertIsNotNone(account.updated_at)
        self.assertGreaterEqual(account.updated_at, created_at)

        account.name = "Renamed Checking"
        account.save()
        account.refresh_from_db()

        self.assertEqual(account.created_at, created_at)
        self.assertGreater(account.updated_at, created_at)

    def test_full_clean_requires_opening_balance(self):
        account = Account(
            user=self.user,
            name="Missing Balance",
            account_type=AccountType.CASH,
        )

        with self.assertRaises(ValidationError) as context:
            account.full_clean()

        self.assertIn("opening_balance", context.exception.message_dict)

    def test_full_clean_rejects_opening_balance_beyond_precision(self):
        invalid_balances = (
            Decimal("10.123"),
            Decimal("12345678901.00"),
        )

        for opening_balance in invalid_balances:
            with self.subTest(opening_balance=opening_balance):
                account = Account(
                    user=self.user,
                    name="Out of Range",
                    account_type=AccountType.CASH,
                    opening_balance=opening_balance,
                )

                with self.assertRaises(ValidationError) as context:
                    account.full_clean()

                self.assertIn("opening_balance", context.exception.message_dict)

    def test_database_constraint_rejects_invalid_account_type(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_account(account_type="crypto")

        self.assertFalse(Account.objects.exists())

    def test_account_type_check_constraint_has_stable_name(self):
        constraint_names = {constraint.name for constraint in Account._meta.constraints}

        self.assertIn("accounts_account_type_valid", constraint_names)
        self.assertTrue(
            any(
                isinstance(constraint, models.CheckConstraint)
                for constraint in Account._meta.constraints
            )
        )

    def test_default_ordering_is_created_at_then_id(self):
        self.assertEqual(Account._meta.ordering, ("created_at", "id"))

    def test_accounts_are_ordered_by_creation_time(self):
        first = self.create_account(name="First")
        second = self.create_account(name="Second")
        Account.objects.update(created_at=timezone.now() - timedelta(days=1))
        second.created_at = timezone.now()
        second.save(update_fields=["created_at"])

        self.assertEqual(list(Account.objects.all()), [first, second])

    def test_str_returns_name_without_exposing_user_details(self):
        account = self.create_account(name="Travel Rewards")

        self.assertEqual(str(account), "Travel Rewards")
        self.assertNotIn(self.user.email, str(account))
