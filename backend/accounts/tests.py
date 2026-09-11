from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models, transaction
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

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


class AccountCollectionAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="account-api-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="account-api-other@example.com",
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

    @staticmethod
    def format_datetime(value):
        return value.isoformat().replace("+00:00", "Z")

    def test_list_returns_owned_accounts_in_model_order(self):
        first = self.create_account(name="First")
        second = self.create_account(
            name="Second",
            account_type=AccountType.SAVINGS,
            opening_balance=Decimal("0.00"),
        )
        self.create_account(user=self.other_user, name="Not Mine")
        self.client.force_login(self.user)

        response = self.client.get(reverse("account-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [first.id, second.id])

    def test_list_returns_exact_output_shape_and_values(self):
        account = self.create_account()
        self.client.force_login(self.user)

        response = self.client.get(reverse("account-list"))

        self.assertEqual(
            response.data,
            [
                {
                    "id": account.id,
                    "name": "Everyday Checking",
                    "account_type": "checking",
                    "opening_balance": "100.00",
                    "is_archived": False,
                    "created_at": self.format_datetime(account.created_at),
                    "updated_at": self.format_datetime(account.updated_at),
                }
            ],
        )

    def test_list_includes_archived_owned_accounts(self):
        archived = self.create_account(name="Old Card", is_archived=True)
        active = self.create_account(name="Active")
        self.client.force_login(self.user)

        response = self.client.get(reverse("account-list"))

        self.assertEqual(
            {item["id"] for item in response.data},
            {archived.id, active.id},
        )

    def test_list_never_returns_another_users_accounts(self):
        self.create_account(name="Mine")
        self.create_account(user=self.other_user, name="Theirs")
        self.client.force_login(self.user)

        response = self.client.get(reverse("account-list"))

        self.assertEqual([item["name"] for item in response.data], ["Mine"])

    def test_list_requires_authentication(self):
        response = self.client.get(reverse("account-list"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def post_account(self, **overrides):
        payload = {
            "name": "New Account",
            "account_type": "checking",
            "opening_balance": "50.00",
        }
        payload.update(overrides)
        return self.client.post(
            reverse("account-list"),
            payload,
            format="json",
        )

    def test_create_returns_201_and_persists_exact_decimal(self):
        self.client.force_login(self.user)

        response = self.post_account(
            name="  Travel Rewards  ",
            account_type="credit_card",
            opening_balance="-123.45",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        account = Account.objects.get()
        self.assertEqual(account.user, self.user)
        self.assertEqual(account.name, "Travel Rewards")
        self.assertEqual(account.account_type, "credit_card")
        self.assertEqual(account.opening_balance, Decimal("-123.45"))
        self.assertEqual(
            response.data,
            {
                "id": account.id,
                "name": "Travel Rewards",
                "account_type": "credit_card",
                "opening_balance": "-123.45",
                "is_archived": False,
                "created_at": self.format_datetime(account.created_at),
                "updated_at": self.format_datetime(account.updated_at),
            },
        )

    def test_create_ownership_comes_only_from_session(self):
        self.client.force_login(self.user)

        response = self.post_account(user=self.other_user.id)

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        account = Account.objects.get()
        self.assertEqual(account.user, self.user)
        self.assertNotIn("user", response.data)

    def test_create_rejects_blank_or_whitespace_only_name(self):
        self.client.force_login(self.user)

        for name in ("", "   "):
            with self.subTest(name=name):
                response = self.post_account(name=name)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("name", response.data)
                self.assertFalse(Account.objects.exists())

    def test_create_rejects_name_longer_than_100_characters(self):
        self.client.force_login(self.user)

        response = self.post_account(name="x" * 101)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", response.data)
        self.assertFalse(Account.objects.exists())

    def test_create_rejects_null_name(self):
        self.client.force_login(self.user)

        response = self.post_account(name=None)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", response.data)
        self.assertFalse(Account.objects.exists())

    def test_create_rejects_null_opening_balance(self):
        self.client.force_login(self.user)

        response = self.post_account(opening_balance=None)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("opening_balance", response.data)
        self.assertFalse(Account.objects.exists())

    def test_create_requires_each_writable_field(self):
        self.client.force_login(self.user)

        for field in ("name", "account_type", "opening_balance"):
            with self.subTest(field=field):
                payload = {
                    "name": "New Account",
                    "account_type": "checking",
                    "opening_balance": "50.00",
                }
                payload.pop(field)

                response = self.client.post(
                    reverse("account-list"),
                    payload,
                    format="json",
                )

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)
                self.assertFalse(Account.objects.exists())

    def test_create_rejects_nonnumeric_opening_balance(self):
        self.client.force_login(self.user)

        response = self.post_account(opening_balance="not-a-number")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("opening_balance", response.data)
        self.assertFalse(Account.objects.exists())

    def test_create_rejects_opening_balance_beyond_precision(self):
        self.client.force_login(self.user)

        for opening_balance in ("10.123", "12345678901.00"):
            with self.subTest(opening_balance=opening_balance):
                response = self.post_account(opening_balance=opening_balance)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("opening_balance", response.data)
                self.assertFalse(Account.objects.exists())

    def test_create_rejects_invalid_account_type(self):
        self.client.force_login(self.user)

        response = self.post_account(account_type="crypto")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("account_type", response.data)
        self.assertFalse(Account.objects.exists())

    def test_create_requires_authentication(self):
        response = self.post_account()

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        self.assertFalse(Account.objects.exists())

    def test_create_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.post(
            reverse("account-list"),
            {
                "name": "CSRF Blocked",
                "account_type": "cash",
                "opening_balance": "5.00",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertFalse(Account.objects.exists())

    def test_csrf_token_allows_create(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_response = csrf_client.get(reverse("auth-csrf"))
        csrf_token = csrf_response.cookies["csrftoken"].value

        response = csrf_client.post(
            reverse("account-list"),
            {
                "name": "CSRF Allowed",
                "account_type": "cash",
                "opening_balance": "5.00",
            },
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Account.objects.count(), 1)
        self.assertEqual(Account.objects.get().name, "CSRF Allowed")

    def test_collection_rejects_unsupported_methods(self):
        self.client.force_login(self.user)

        for method in ("patch", "put"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    reverse("account-list"),
                    {"name": "Ignored"},
                    format="json",
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        response = self.client.delete(reverse("account-list"))
        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertFalse(Account.objects.exists())

    def test_options_and_head_are_supported(self):
        self.client.force_login(self.user)

        response = self.client.options(reverse("account-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self.client.head(reverse("account-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
