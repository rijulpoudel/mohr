from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, models, transaction
from django.db.models.deletion import RestrictedError
from django.db.models.query import QuerySet
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import Account, AccountType
from budgets.models import MonthlyBudget
from budgets.serializers import DUPLICATE_BUDGET_MESSAGE
from budgets.views import BudgetViewSet
from categories.models import Category, CategoryType
from transactions.models import Transaction, TransactionType


class BudgetModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="budget-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="budget-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.income_category = Category.objects.create(
            user=cls.user,
            name="Salary",
            category_type=CategoryType.INCOME,
        )
        cls.expense_category = Category.objects.create(
            user=cls.user,
            name="Groceries",
            category_type=CategoryType.EXPENSE,
        )
        cls.second_expense_category = Category.objects.create(
            user=cls.user,
            name="Dining Out",
            category_type=CategoryType.EXPENSE,
        )
        cls.other_expense_category = Category.objects.create(
            user=cls.other_user,
            name="Their Groceries",
            category_type=CategoryType.EXPENSE,
        )

    def create_budget(self, **overrides):
        values = {
            "user": self.user,
            "category": self.expense_category,
            "month": date(2026, 9, 1),
            "amount": Decimal("500.00"),
        }
        values.update(overrides)
        return MonthlyBudget.objects.create(**values)

    def test_budget_belongs_to_user_through_related_name(self):
        budget = self.create_budget()

        self.assertEqual(budget.user, self.user)
        self.assertEqual(list(self.user.monthly_budgets.all()), [budget])
        self.assertFalse(self.other_user.monthly_budgets.exists())

    def test_category_exposes_reverse_relation(self):
        budget = self.create_budget()

        self.assertEqual(budget.category, self.expense_category)
        self.assertEqual(
            list(self.expense_category.monthly_budgets.all()),
            [budget],
        )
        self.assertFalse(self.second_expense_category.monthly_budgets.exists())

    def test_amount_persists_exact_decimal(self):
        for amount, month in (
            (Decimal("9999999999.99"), date(2026, 9, 1)),
            (Decimal("500.00"), date(2026, 10, 1)),
            (Decimal("0.01"), date(2026, 11, 1)),
        ):
            with self.subTest(amount=amount):
                budget = self.create_budget(amount=amount, month=month)
                budget.refresh_from_db()

                self.assertIsInstance(budget.amount, Decimal)
                self.assertEqual(budget.amount, amount)

    def test_month_persists(self):
        budget = self.create_budget(month=date(2026, 9, 1))
        budget.refresh_from_db()

        self.assertEqual(budget.month, date(2026, 9, 1))

    def test_timestamps_track_creation_and_updates(self):
        budget = self.create_budget()
        created_at = budget.created_at

        self.assertIsNotNone(created_at)
        self.assertIsNotNone(budget.updated_at)
        self.assertGreaterEqual(budget.updated_at, created_at)

        budget.amount = Decimal("650.00")
        budget.save()
        budget.refresh_from_db()

        self.assertEqual(budget.created_at, created_at)
        self.assertGreater(budget.updated_at, created_at)

    def test_database_constraint_rejects_zero_amount(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_budget(amount=Decimal("0.00"))

        self.assertFalse(MonthlyBudget.objects.exists())

    def test_database_constraint_rejects_negative_amount(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_budget(amount=Decimal("-1.00"))

        self.assertFalse(MonthlyBudget.objects.exists())

    def test_database_constraint_rejects_non_first_day_month(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_budget(month=date(2026, 9, 15))

        self.assertFalse(MonthlyBudget.objects.exists())

    def test_database_constraint_rejects_duplicate_user_category_month(self):
        self.create_budget()

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_budget()

        self.assertEqual(MonthlyBudget.objects.count(), 1)

    def test_same_category_different_month_allowed(self):
        first = self.create_budget(month=date(2026, 9, 1))
        second = self.create_budget(month=date(2026, 10, 1))

        self.assertEqual(MonthlyBudget.objects.count(), 2)
        self.assertEqual(
            {first.id, second.id},
            set(MonthlyBudget.objects.values_list("id", flat=True)),
        )

    def test_same_user_and_month_different_category_allowed(self):
        first = self.create_budget()
        second = self.create_budget(category=self.second_expense_category)

        self.assertEqual(MonthlyBudget.objects.count(), 2)
        self.assertEqual(
            {first.id, second.id},
            set(MonthlyBudget.objects.values_list("id", flat=True)),
        )

    def test_another_user_with_own_category_and_month_allowed(self):
        first = self.create_budget()
        second = self.create_budget(
            user=self.other_user,
            category=self.other_expense_category,
        )

        self.assertEqual(MonthlyBudget.objects.count(), 2)
        self.assertEqual(
            {first.id, second.id},
            set(MonthlyBudget.objects.values_list("id", flat=True)),
        )

    def test_default_ordering_is_month_desc_created_at_asc_id_asc(self):
        self.assertEqual(
            MonthlyBudget._meta.ordering,
            ("-month", "created_at", "id"),
        )

    def test_budgets_are_ordered_newest_month_first(self):
        older = self.create_budget(month=date(2026, 8, 1))
        newer = self.create_budget(month=date(2026, 9, 1))

        self.assertEqual(list(MonthlyBudget.objects.all()), [newer, older])

    def test_same_month_ties_break_by_created_at_ascending(self):
        first = self.create_budget()
        second = self.create_budget(category=self.second_expense_category)
        MonthlyBudget.objects.update(created_at=timezone.now())
        first.created_at = timezone.now() - timedelta(days=1)
        first.save(update_fields=["created_at"])

        self.assertEqual(list(MonthlyBudget.objects.all()), [first, second])

    def test_same_month_and_created_at_ties_break_by_id_ascending(self):
        first = self.create_budget()
        second = self.create_budget(category=self.second_expense_category)
        MonthlyBudget.objects.update(created_at=timezone.now())

        self.assertEqual(list(MonthlyBudget.objects.all()), [first, second])

    def test_check_constraints_have_stable_names(self):
        constraint_names = {
            constraint.name for constraint in MonthlyBudget._meta.constraints
        }

        self.assertEqual(
            constraint_names,
            {
                "budgets_amount_positive",
                "budgets_month_first_day",
                "budgets_user_category_month_unique",
            },
        )
        self.assertTrue(
            all(
                isinstance(constraint, models.CheckConstraint)
                or isinstance(constraint, models.UniqueConstraint)
                for constraint in MonthlyBudget._meta.constraints
            )
        )

    def test_user_month_index_has_stable_name(self):
        self.assertEqual(
            [(index.fields, index.name) for index in MonthlyBudget._meta.indexes],
            [(["user", "month"], "budgets_user_month_idx")],
        )

    def test_full_clean_accepts_valid_budget(self):
        budget = self.create_budget()

        budget.full_clean()

    def test_full_clean_rejects_amount_beyond_precision(self):
        for amount in (Decimal("10.123"), Decimal("12345678901.00")):
            with self.subTest(amount=amount):
                budget = MonthlyBudget(
                    user=self.user,
                    category=self.expense_category,
                    month=date(2026, 9, 1),
                    amount=amount,
                )

                with self.assertRaises(ValidationError) as context:
                    budget.full_clean()

                self.assertIn("amount", context.exception.message_dict)

    def test_full_clean_rejects_non_first_day_month(self):
        budget = MonthlyBudget(
            user=self.user,
            category=self.expense_category,
            month=date(2026, 9, 15),
            amount=Decimal("500.00"),
        )

        with self.assertRaises(ValidationError) as context:
            budget.full_clean()

        self.assertIn("month", context.exception.message_dict)

    def test_full_clean_rejects_category_owned_by_another_user(self):
        budget = MonthlyBudget(
            user=self.user,
            category=self.other_expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("500.00"),
        )

        with self.assertRaises(ValidationError) as context:
            budget.full_clean()

        self.assertIn("category", context.exception.message_dict)

    def test_full_clean_rejects_income_category(self):
        budget = MonthlyBudget(
            user=self.user,
            category=self.income_category,
            month=date(2026, 9, 1),
            amount=Decimal("500.00"),
        )

        with self.assertRaises(ValidationError) as context:
            budget.full_clean()

        self.assertIn("category", context.exception.message_dict)

    def test_full_clean_accepts_archived_expense_category(self):
        archived = Category.objects.create(
            user=self.user,
            name="Old Rent",
            category_type=CategoryType.EXPENSE,
            is_archived=True,
        )
        budget = MonthlyBudget(
            user=self.user,
            category=archived,
            month=date(2026, 9, 1),
            amount=Decimal("500.00"),
        )

        budget.full_clean()

    def test_str_returns_deterministic_representation_without_user_details(self):
        budget = self.create_budget(amount=Decimal("500.00"))

        self.assertEqual(str(budget), "2026-09-01 500.00")
        self.assertNotIn(self.user.email, str(budget))
        self.assertNotIn(self.expense_category.name, str(budget))

    def test_deleting_category_is_restricted_while_referenced(self):
        budget = self.create_budget()

        with self.assertRaises(RestrictedError):
            self.expense_category.delete()

        self.assertTrue(Category.objects.filter(pk=self.expense_category.pk).exists())
        self.assertTrue(MonthlyBudget.objects.filter(pk=budget.pk).exists())

    def test_deleting_user_cascades_through_budgets_and_categories(self):
        budget = self.create_budget()

        self.user.delete()

        self.assertFalse(MonthlyBudget.objects.filter(pk=budget.pk).exists())
        self.assertFalse(Category.objects.filter(pk=self.expense_category.pk).exists())

    def test_deleting_budget_leaves_category_and_user_intact(self):
        budget = self.create_budget()

        budget.delete()

        self.assertFalse(MonthlyBudget.objects.filter(pk=budget.pk).exists())
        self.assertTrue(Category.objects.filter(pk=self.expense_category.pk).exists())
        self.assertTrue(get_user_model().objects.filter(pk=self.user.pk).exists())


def format_datetime(value):
    return value.isoformat().replace("+00:00", "Z")


class BudgetCollectionAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="budget-api-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="budget-api-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.income_category = Category.objects.create(
            user=cls.user,
            name="Salary",
            category_type=CategoryType.INCOME,
        )
        cls.expense_category = Category.objects.create(
            user=cls.user,
            name="Groceries",
            category_type=CategoryType.EXPENSE,
        )
        cls.second_expense_category = Category.objects.create(
            user=cls.user,
            name="Dining Out",
            category_type=CategoryType.EXPENSE,
        )
        cls.other_expense_category = Category.objects.create(
            user=cls.other_user,
            name="Their Groceries",
            category_type=CategoryType.EXPENSE,
        )

    def create_budget(self, **overrides):
        values = {
            "user": self.user,
            "category": self.expense_category,
            "month": date(2026, 9, 1),
            "amount": Decimal("500.00"),
        }
        values.update(overrides)
        return MonthlyBudget.objects.create(**values)

    def post_budget(self, **overrides):
        payload = {
            "category": self.expense_category.id,
            "month": "2026-09-01",
            "budgeted": "500.00",
        }
        payload.update(overrides)
        return self.client.post(
            reverse("budget-list"),
            payload,
            format="json",
        )

    def test_budget_list_route_maps_to_api_budgets(self):
        self.assertEqual(reverse("budget-list"), "/api/budgets/")

    def test_list_returns_empty_array_for_new_user(self):
        self.client.force_login(self.user)

        response = self.client.get(reverse("budget-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, [])

    def test_list_requires_authentication(self):
        response = self.client.get(reverse("budget-list"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_list_returns_exact_shape_and_order(self):
        older = self.create_budget(month=date(2026, 8, 1), amount=Decimal("250.00"))
        newer = self.create_budget(month=date(2026, 9, 1), amount=Decimal("500.00"))
        self.client.force_login(self.user)

        response = self.client.get(reverse("budget-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [newer.id, older.id])
        self.assertEqual(
            list(response.data[0].keys()),
            [
                "id",
                "category",
                "month",
                "budgeted",
                "spent",
                "remaining",
                "created_at",
                "updated_at",
            ],
        )
        self.assertEqual(
            response.data,
            [
                {
                    "id": newer.id,
                    "category": self.expense_category.id,
                    "month": "2026-09-01",
                    "budgeted": "500.00",
                    "spent": "0.00",
                    "remaining": "500.00",
                    "created_at": format_datetime(newer.created_at),
                    "updated_at": format_datetime(newer.updated_at),
                },
                {
                    "id": older.id,
                    "category": self.expense_category.id,
                    "month": "2026-08-01",
                    "budgeted": "250.00",
                    "spent": "0.00",
                    "remaining": "250.00",
                    "created_at": format_datetime(older.created_at),
                    "updated_at": format_datetime(older.updated_at),
                },
            ],
        )

    def test_list_never_returns_another_users_budgets(self):
        mine = self.create_budget()
        self.create_budget(
            user=self.other_user,
            category=self.other_expense_category,
        )
        self.client.force_login(self.user)

        response = self.client.get(reverse("budget-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [mine.id])
        self.assertEqual(MonthlyBudget.objects.count(), 2)

    def test_list_includes_historical_budget_after_category_archived(self):
        budget = self.create_budget()
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)
        self.client.force_login(self.user)

        response = self.client.get(reverse("budget-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [budget.id])

    def test_create_returns_201_and_exact_response(self):
        self.client.force_login(self.user)

        response = self.post_budget()

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        budget = MonthlyBudget.objects.get()
        self.assertEqual(MonthlyBudget.objects.count(), 1)
        self.assertEqual(budget.user, self.user)
        self.assertEqual(budget.category, self.expense_category)
        self.assertEqual(budget.month, date(2026, 9, 1))
        self.assertEqual(budget.amount, Decimal("500.00"))
        self.assertEqual(
            response.data,
            {
                "id": budget.id,
                "category": self.expense_category.id,
                "month": "2026-09-01",
                "budgeted": "500.00",
                "spent": "0.00",
                "remaining": "500.00",
                "created_at": format_datetime(budget.created_at),
                "updated_at": format_datetime(budget.updated_at),
            },
        )

    def test_create_derives_user_from_session_and_ignores_spoofed_fields(self):
        self.client.force_login(self.user)

        response = self.post_budget(
            user=self.other_user.id,
            id=999,
            amount="999.00",
            spent="999.99",
            remaining="999.99",
            created_at="2000-01-01T00:00:00Z",
            updated_at="2000-01-01T00:00:00Z",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        budget = MonthlyBudget.objects.get()
        self.assertEqual(MonthlyBudget.objects.count(), 1)
        self.assertEqual(budget.user, self.user)
        self.assertEqual(budget.amount, Decimal("500.00"))
        self.assertNotEqual(budget.id, 999)
        self.assertNotEqual(budget.created_at.year, 2000)
        self.assertNotEqual(budget.updated_at.year, 2000)
        self.assertNotIn("user", response.data)
        self.assertNotIn("amount", response.data)
        self.assertEqual(response.data["id"], budget.id)
        self.assertEqual(response.data["spent"], "0.00")
        self.assertEqual(response.data["remaining"], "500.00")

    def test_create_requires_authentication(self):
        response = self.post_budget()

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.post(
            reverse("budget-list"),
            {
                "category": self.expense_category.id,
                "month": "2026-09-01",
                "budgeted": "500.00",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_requires_each_field(self):
        self.client.force_login(self.user)

        for field in ("category", "month", "budgeted"):
            with self.subTest(field=field):
                payload = {
                    "category": self.expense_category.id,
                    "month": "2026-09-01",
                    "budgeted": "500.00",
                }
                payload.pop(field)

                response = self.client.post(
                    reverse("budget-list"),
                    payload,
                    format="json",
                )

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)
                self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_null_fields(self):
        self.client.force_login(self.user)

        for field in ("category", "month", "budgeted"):
            with self.subTest(field=field):
                response = self.post_budget(**{field: None})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)
                self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_blank_fields(self):
        self.client.force_login(self.user)

        for field in ("category", "month", "budgeted"):
            with self.subTest(field=field):
                response = self.post_budget(**{field: ""})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)
                self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_malformed_month(self):
        self.client.force_login(self.user)

        for value in ("2026-13-01", "not-a-date", "2026/09/01"):
            with self.subTest(month=value):
                response = self.post_budget(month=value)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("month", response.data)
                self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_accepts_first_day_of_month(self):
        self.client.force_login(self.user)

        response = self.post_budget(month="2026-12-01")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(MonthlyBudget.objects.get().month, date(2026, 12, 1))

    def test_create_rejects_non_first_day_month(self):
        self.client.force_login(self.user)

        response = self.post_budget(month="2026-09-15")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("month", response.data)
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_zero_and_negative_budgeted(self):
        self.client.force_login(self.user)

        for value in ("0.00", "-1.00"):
            with self.subTest(budgeted=value):
                response = self.post_budget(budgeted=value)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("budgeted", response.data)
                self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_budgeted_beyond_precision(self):
        self.client.force_login(self.user)

        for value in ("10.123", "12345678901.00"):
            with self.subTest(budgeted=value):
                response = self.post_budget(budgeted=value)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("budgeted", response.data)
                self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_nonnumeric_budgeted(self):
        self.client.force_login(self.user)

        response = self.post_budget(budgeted="not-a-number")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("budgeted", response.data)
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_cross_user_and_missing_category_ids_are_indistinguishable(self):
        self.client.force_login(self.user)

        cross_user = self.post_budget(category=self.other_expense_category.id)
        missing = self.post_budget(category=999999)

        self.assertEqual(cross_user.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(missing.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(cross_user.json(), missing.json())
        self.assertIn("category", cross_user.json())
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_income_category(self):
        self.client.force_login(self.user)

        response = self.post_budget(category=self.income_category.id)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_archived_category(self):
        archived = Category.objects.create(
            user=self.user,
            name="Old Rent",
            category_type=CategoryType.EXPENSE,
            is_archived=True,
        )
        self.client.force_login(self.user)

        response = self.post_budget(category=archived.id)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_rejects_duplicate_without_mutation(self):
        self.create_budget()
        self.client.force_login(self.user)

        response = self.post_budget()

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("non_field_errors", response.data)
        self.assertEqual(MonthlyBudget.objects.count(), 1)
        self.assertEqual(MonthlyBudget.objects.get().amount, Decimal("500.00"))

    def test_create_duplicate_race_reaches_constraint_and_returns_controlled_400(
        self,
    ):
        self.create_budget()
        self.client.force_login(self.user)

        # Stub only the serializer's exists() pre-check so the duplicate
        # slips past validation, forcing the insert to hit the named
        # database constraint like a real check-then-insert race would.
        with mock.patch.object(QuerySet, "exists", return_value=False):
            response = self.post_budget()

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.data,
            {"non_field_errors": [DUPLICATE_BUDGET_MESSAGE]},
        )
        self.assertEqual(MonthlyBudget.objects.count(), 1)
        self.assertEqual(MonthlyBudget.objects.get().amount, Decimal("500.00"))

    def test_create_reraises_unidentifiable_integrity_error(self):
        self.client.force_login(self.user)

        with mock.patch.object(
            BudgetViewSet,
            "perform_create",
            side_effect=IntegrityError("simulated unrelated integrity failure"),
        ):
            with self.assertRaises(IntegrityError):
                self.post_budget()

        self.assertFalse(MonthlyBudget.objects.exists())

    def test_create_response_includes_correct_spent_and_remaining(self):
        Transaction.objects.create(
            user=self.user,
            account=Account.objects.create(
                user=self.user,
                name="Everyday Checking",
                account_type=AccountType.CHECKING,
                opening_balance=Decimal("100.00"),
            ),
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("25.50"),
            date=date(2026, 9, 10),
        )
        self.client.force_login(self.user)

        response = self.post_budget()

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(response.data["spent"], "25.50")
        self.assertEqual(response.data["remaining"], "474.50")

    def test_collection_rejects_unsupported_methods(self):
        self.client.force_login(self.user)

        for method in ("patch", "put", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    reverse("budget-list"),
                    {"budgeted": "99.99"},
                    format="json",
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        self.assertFalse(MonthlyBudget.objects.exists())

    def test_options_and_head_are_supported(self):
        self.client.force_login(self.user)

        response = self.client.options(reverse("budget-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self.client.head(reverse("budget-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)


class BudgetCalculationTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="budget-calc-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="budget-calc-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Everyday Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.income_category = Category.objects.create(
            user=cls.user,
            name="Salary",
            category_type=CategoryType.INCOME,
        )
        cls.expense_category = Category.objects.create(
            user=cls.user,
            name="Groceries",
            category_type=CategoryType.EXPENSE,
        )
        cls.second_expense_category = Category.objects.create(
            user=cls.user,
            name="Dining Out",
            category_type=CategoryType.EXPENSE,
        )
        cls.other_expense_category = Category.objects.create(
            user=cls.other_user,
            name="Their Groceries",
            category_type=CategoryType.EXPENSE,
        )

    def create_budget(self, **overrides):
        values = {
            "user": self.user,
            "category": self.expense_category,
            "month": date(2026, 9, 1),
            "amount": Decimal("500.00"),
        }
        values.update(overrides)
        return MonthlyBudget.objects.create(**values)

    def create_transaction(self, **overrides):
        values = {
            "user": self.user,
            "account": self.account,
            "category": self.expense_category,
            "transaction_type": TransactionType.EXPENSE,
            "amount": Decimal("10.00"),
            "date": date(2026, 9, 15),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def fetch_budget(self, budget):
        self.client.force_login(self.user)
        response = self.client.get(reverse("budget-list"))
        return next(item for item in response.data if item["id"] == budget.id)

    def test_spent_is_zero_with_no_transactions(self):
        budget = self.create_budget()

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "0.00")
        self.assertEqual(item["remaining"], "500.00")

    def test_spent_sums_in_month_expenses_with_exact_decimals(self):
        budget = self.create_budget()
        self.create_transaction(amount=Decimal("25.50"), date=date(2026, 9, 3))
        self.create_transaction(amount=Decimal("10.00"), date=date(2026, 9, 20))
        self.create_transaction(amount=Decimal("1.01"), date=date(2026, 9, 1))

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "36.51")
        self.assertEqual(item["remaining"], "463.49")

    def test_spent_excludes_transactions_in_other_categories(self):
        budget = self.create_budget()
        self.create_transaction(
            category=self.second_expense_category,
            amount=Decimal("100.00"),
        )

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "0.00")

    def test_spent_respects_prior_and_next_month_boundaries(self):
        budget = self.create_budget()
        self.create_transaction(amount=Decimal("50.00"), date=date(2026, 8, 31))
        self.create_transaction(amount=Decimal("60.00"), date=date(2026, 10, 1))
        self.create_transaction(amount=Decimal("20.00"), date=date(2026, 9, 1))
        self.create_transaction(amount=Decimal("5.00"), date=date(2026, 9, 30))

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "25.00")

    def test_spent_excludes_income_transactions_on_the_same_category(self):
        budget = self.create_budget()
        self.create_transaction(
            transaction_type=TransactionType.INCOME,
            amount=Decimal("300.00"),
        )

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "0.00")

    def test_spent_defensively_excludes_foreign_user_transactions_on_same_category(
        self,
    ):
        budget = self.create_budget()
        self.create_transaction(
            user=self.other_user,
            account=self.other_account,
            amount=Decimal("200.00"),
        )

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "0.00")

    def test_archived_category_budget_still_calculates(self):
        budget = self.create_budget()
        self.create_transaction(amount=Decimal("75.25"))
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "75.25")
        self.assertEqual(item["remaining"], "424.75")

    def test_remaining_allows_negative_overspent(self):
        budget = self.create_budget(amount=Decimal("50.00"))
        self.create_transaction(amount=Decimal("75.50"))

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "75.50")
        self.assertEqual(item["remaining"], "-25.50")

    def test_spent_and_remaining_serialize_beyond_twelve_digits(self):
        budget = self.create_budget(amount=Decimal("500.00"))
        self.create_transaction(amount=Decimal("9999999999.99"), date=date(2026, 9, 2))
        self.create_transaction(amount=Decimal("9999999999.99"), date=date(2026, 9, 5))
        self.create_transaction(amount=Decimal("9999999999.99"), date=date(2026, 9, 20))

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "29999999999.97")
        self.assertEqual(item["remaining"], "-29999999499.97")
        self.assertIsInstance(item["spent"], str)
        self.assertIsInstance(item["remaining"], str)

    def test_spent_excludes_same_month_number_in_different_year(self):
        budget = self.create_budget()
        self.create_transaction(amount=Decimal("100.00"), date=date(2027, 9, 15))
        self.create_transaction(amount=Decimal("25.00"), date=date(2026, 9, 15))

        item = self.fetch_budget(budget)

        self.assertEqual(item["spent"], "25.00")

    def test_calculation_tracks_transaction_create_update_move_and_delete(self):
        budget = self.create_budget()

        transaction_obj = self.create_transaction(
            amount=Decimal("25.50"),
            date=date(2026, 9, 10),
        )
        self.assertEqual(self.fetch_budget(budget)["spent"], "25.50")

        Transaction.objects.filter(pk=transaction_obj.pk).update(date=date(2026, 8, 10))
        self.assertEqual(self.fetch_budget(budget)["spent"], "0.00")

        Transaction.objects.filter(pk=transaction_obj.pk).update(
            amount=Decimal("75.25"),
            date=date(2026, 9, 10),
        )
        self.assertEqual(self.fetch_budget(budget)["spent"], "75.25")

        transaction_obj.delete()
        self.assertEqual(self.fetch_budget(budget)["spent"], "0.00")

    def test_list_query_count_is_constant_as_budget_count_grows(self):
        self.client.force_login(self.user)
        self.create_budget(month=date(2026, 9, 1))
        with CaptureQueriesContext(connection) as few:
            self.client.get(reverse("budget-list"))

        for month in (date(2026, 8, 1), date(2026, 7, 1), date(2026, 6, 1)):
            self.create_budget(month=month)

        with CaptureQueriesContext(connection) as many:
            response = self.client.get(reverse("budget-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(many.captured_queries), len(few.captured_queries))


class BudgetDetailAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="budget-detail-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="budget-detail-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Everyday Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.income_category = Category.objects.create(
            user=cls.user,
            name="Salary",
            category_type=CategoryType.INCOME,
        )
        cls.expense_category = Category.objects.create(
            user=cls.user,
            name="Groceries",
            category_type=CategoryType.EXPENSE,
        )
        cls.second_expense_category = Category.objects.create(
            user=cls.user,
            name="Dining Out",
            category_type=CategoryType.EXPENSE,
        )
        cls.other_expense_category = Category.objects.create(
            user=cls.other_user,
            name="Their Groceries",
            category_type=CategoryType.EXPENSE,
        )
        cls.budget = MonthlyBudget.objects.create(
            user=cls.user,
            category=cls.expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("500.00"),
        )

    def create_budget(self, **overrides):
        values = {
            "user": self.user,
            "category": self.expense_category,
            "month": date(2026, 10, 1),
            "amount": Decimal("300.00"),
        }
        values.update(overrides)
        return MonthlyBudget.objects.create(**values)

    def create_transaction(self, **overrides):
        values = {
            "user": self.user,
            "account": self.account,
            "category": self.expense_category,
            "transaction_type": TransactionType.EXPENSE,
            "amount": Decimal("10.00"),
            "date": date(2026, 9, 15),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def detail_url(self, budget):
        return reverse("budget-detail", args=[budget.pk])

    def patch_budget(self, budget, payload):
        return self.client.patch(
            self.detail_url(budget),
            payload,
            format="json",
        )

    def snapshot(self, budget):
        return {
            "id": budget.id,
            "user": budget.user,
            "category": budget.category,
            "month": budget.month,
            "amount": budget.amount,
            "created_at": budget.created_at,
            "updated_at": budget.updated_at,
        }

    def test_budget_detail_route_maps_to_api_budgets_pk(self):
        self.assertEqual(
            reverse("budget-detail", args=[self.budget.pk]),
            f"/api/budgets/{self.budget.pk}/",
        )

    def test_detail_returns_exact_representation(self):
        self.client.force_login(self.user)

        response = self.client.get(self.detail_url(self.budget))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            list(response.data.keys()),
            [
                "id",
                "category",
                "month",
                "budgeted",
                "spent",
                "remaining",
                "created_at",
                "updated_at",
            ],
        )
        self.assertEqual(
            response.data,
            {
                "id": self.budget.id,
                "category": self.expense_category.id,
                "month": "2026-09-01",
                "budgeted": "500.00",
                "spent": "0.00",
                "remaining": "500.00",
                "created_at": format_datetime(self.budget.created_at),
                "updated_at": format_datetime(self.budget.updated_at),
            },
        )

    def test_detail_calculates_live_spent_and_remaining(self):
        self.create_transaction(amount=Decimal("25.50"), date=date(2026, 9, 10))
        self.client.force_login(self.user)

        response = self.client.get(self.detail_url(self.budget))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["spent"], "25.50")
        self.assertEqual(response.data["remaining"], "474.50")

    def test_detail_returns_archived_historical_budget(self):
        self.create_transaction(amount=Decimal("75.25"))
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)
        self.client.force_login(self.user)

        response = self.client.get(self.detail_url(self.budget))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["id"], self.budget.id)
        self.assertEqual(response.data["spent"], "75.25")

    def test_detail_foreign_and_missing_ids_are_indistinguishable(self):
        other_budget = MonthlyBudget.objects.create(
            user=self.other_user,
            category=self.other_expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("100.00"),
        )
        self.client.force_login(self.user)

        foreign = self.client.get(self.detail_url(other_budget))
        missing = self.client.get(self.detail_url(MonthlyBudget(pk=999999)))

        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(foreign.json(), missing.json())
        self.assertTrue(MonthlyBudget.objects.filter(pk=other_budget.pk).exists())

    def test_detail_requires_authentication(self):
        response = self.client.get(self.detail_url(self.budget))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_patch_updates_budgeted_alone(self):
        before = self.snapshot(self.budget)
        self.client.force_login(self.user)

        response = self.patch_budget(self.budget, {"budgeted": "750.00"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.amount, Decimal("750.00"))
        self.assertEqual(self.budget.category, self.expense_category)
        self.assertEqual(self.budget.month, date(2026, 9, 1))
        self.assertEqual(self.budget.user, self.user)
        self.assertEqual(self.budget.created_at, before["created_at"])
        self.assertGreater(self.budget.updated_at, before["updated_at"])
        self.assertEqual(response.data["budgeted"], "750.00")
        self.assertEqual(response.data["spent"], "0.00")
        self.assertEqual(response.data["remaining"], "750.00")

    def test_patch_updates_month_alone(self):
        self.client.force_login(self.user)

        response = self.patch_budget(self.budget, {"month": "2026-10-01"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.month, date(2026, 10, 1))
        self.assertEqual(self.budget.amount, Decimal("500.00"))
        self.assertEqual(response.data["month"], "2026-10-01")

    def test_patch_updates_category_alone(self):
        self.client.force_login(self.user)

        response = self.patch_budget(
            self.budget,
            {"category": self.second_expense_category.id},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.category, self.second_expense_category)
        self.assertEqual(response.data["category"], self.second_expense_category.id)

    def test_patch_updates_all_writable_fields_combined(self):
        self.client.force_login(self.user)

        response = self.patch_budget(
            self.budget,
            {
                "category": self.second_expense_category.id,
                "month": "2026-11-01",
                "budgeted": "100.00",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.category, self.second_expense_category)
        self.assertEqual(self.budget.month, date(2026, 11, 1))
        self.assertEqual(self.budget.amount, Decimal("100.00"))
        self.assertEqual(response.data["category"], self.second_expense_category.id)
        self.assertEqual(response.data["month"], "2026-11-01")
        self.assertEqual(response.data["budgeted"], "100.00")

    def test_patch_recalculates_after_budgeted_category_and_month_changes(self):
        self.create_transaction(
            amount=Decimal("25.50"),
            date=date(2026, 9, 10),
        )
        self.create_transaction(
            category=self.second_expense_category,
            amount=Decimal("10.00"),
            date=date(2026, 10, 5),
        )
        self.client.force_login(self.user)

        baseline = self.client.get(self.detail_url(self.budget))
        self.assertEqual(baseline.data["spent"], "25.50")

        moved = self.patch_budget(self.budget, {"month": "2026-10-01"})
        self.assertEqual(moved.status_code, status.HTTP_200_OK)
        self.assertEqual(moved.data["spent"], "0.00")
        self.assertEqual(moved.data["remaining"], "500.00")

        recategorized = self.patch_budget(
            self.budget,
            {"category": self.second_expense_category.id},
        )
        self.assertEqual(recategorized.status_code, status.HTTP_200_OK)
        self.assertEqual(recategorized.data["spent"], "10.00")
        self.assertEqual(recategorized.data["remaining"], "490.00")

        rebudgeted = self.patch_budget(self.budget, {"budgeted": "100.00"})
        self.assertEqual(rebudgeted.status_code, status.HTTP_200_OK)
        self.assertEqual(rebudgeted.data["spent"], "10.00")
        self.assertEqual(rebudgeted.data["remaining"], "90.00")

    def test_patch_omitted_fields_remain_unchanged(self):
        before = self.snapshot(self.budget)
        self.client.force_login(self.user)

        response = self.patch_budget(self.budget, {"budgeted": "600.00"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.amount, Decimal("600.00"))
        self.assertEqual(self.budget.category, before["category"])
        self.assertEqual(self.budget.month, before["month"])
        self.assertEqual(self.budget.user, before["user"])
        self.assertEqual(self.budget.created_at, before["created_at"])

    def test_patch_rejects_archived_category_resubmission(self):
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)
        self.client.force_login(self.user)

        response = self.patch_budget(
            self.budget,
            {"category": self.expense_category.id},
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.category, self.expense_category)

    def test_patch_other_fields_work_when_category_archived(self):
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)
        self.client.force_login(self.user)

        budgeted = self.patch_budget(self.budget, {"budgeted": "600.00"})
        self.assertEqual(budgeted.status_code, status.HTTP_200_OK)

        month = self.patch_budget(self.budget, {"month": "2026-10-01"})
        self.assertEqual(month.status_code, status.HTTP_200_OK)

        self.budget.refresh_from_db()
        self.assertEqual(self.budget.amount, Decimal("600.00"))
        self.assertEqual(self.budget.month, date(2026, 10, 1))

    def test_patch_rejects_foreign_and_missing_category_ids_indistinguishable(self):
        self.client.force_login(self.user)

        foreign = self.patch_budget(
            self.budget,
            {"category": self.other_expense_category.id},
        )
        missing = self.patch_budget(self.budget, {"category": 999999})

        self.assertEqual(foreign.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(missing.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(foreign.json(), missing.json())
        self.assertIn("category", foreign.json())
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.category, self.expense_category)

    def test_patch_rejects_income_category(self):
        self.client.force_login(self.user)

        response = self.patch_budget(
            self.budget,
            {"category": self.income_category.id},
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("category", response.data)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.category, self.expense_category)

    def test_patch_rejects_malformed_null_and_blank_category_without_mutation(self):
        before = self.snapshot(self.budget)
        self.client.force_login(self.user)

        for value in (None, "", "not-a-number", 0, -1):
            with self.subTest(category=value):
                response = self.patch_budget(self.budget, {"category": value})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("category", response.data)

        self.budget.refresh_from_db()
        self.assertEqual(self.budget.category, before["category"])
        self.assertEqual(self.budget.month, before["month"])
        self.assertEqual(self.budget.amount, before["amount"])
        self.assertEqual(self.budget.user, before["user"])
        self.assertEqual(self.budget.created_at, before["created_at"])
        self.assertEqual(self.budget.updated_at, before["updated_at"])

    def test_patch_rejects_malformed_null_and_blank_month(self):
        self.client.force_login(self.user)

        for value in ("2026-13-01", "not-a-date", None, ""):
            with self.subTest(month=value):
                response = self.patch_budget(self.budget, {"month": value})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("month", response.data)

        self.budget.refresh_from_db()
        self.assertEqual(self.budget.month, date(2026, 9, 1))

    def test_patch_rejects_non_first_day_month(self):
        self.client.force_login(self.user)

        response = self.patch_budget(self.budget, {"month": "2026-09-15"})

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("month", response.data)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.month, date(2026, 9, 1))

    def test_patch_rejects_invalid_budgeted_values(self):
        self.client.force_login(self.user)

        for value in (
            "0.00",
            "-1.00",
            "10.123",
            "12345678901.00",
            "not-a-number",
            "",
            None,
        ):
            with self.subTest(budgeted=value):
                response = self.patch_budget(self.budget, {"budgeted": value})

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("budgeted", response.data)

        self.budget.refresh_from_db()
        self.assertEqual(self.budget.amount, Decimal("500.00"))

    def test_patch_duplicate_checks_use_effective_final_combination(self):
        self.create_budget(
            category=self.second_expense_category,
            month=date(2026, 9, 1),
        )
        self.create_budget(month=date(2026, 11, 1))
        self.create_budget(
            category=self.second_expense_category,
            month=date(2026, 10, 1),
        )
        self.client.force_login(self.user)

        category_only = self.patch_budget(
            self.budget,
            {"category": self.second_expense_category.id},
        )
        self.assertEqual(category_only.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("non_field_errors", category_only.data)

        month_only = self.patch_budget(self.budget, {"month": "2026-11-01"})
        self.assertEqual(month_only.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("non_field_errors", month_only.data)

        # Month 2026-10 alone is free; only the combined final state
        # (category B + 2026-10) collides with an existing budget.
        free_month = self.patch_budget(self.budget, {"month": "2026-10-01"})
        self.assertEqual(free_month.status_code, status.HTTP_200_OK)

        combined = self.patch_budget(
            self.budget,
            {
                "category": self.second_expense_category.id,
                "month": "2026-10-01",
            },
        )
        self.assertEqual(combined.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("non_field_errors", combined.data)

        noop = self.patch_budget(self.budget, {"month": "2026-09-01"})
        self.assertEqual(noop.status_code, status.HTTP_200_OK)

        self.budget.refresh_from_db()
        self.assertEqual(self.budget.category, self.expense_category)
        self.assertEqual(self.budget.month, date(2026, 9, 1))
        self.assertEqual(self.budget.amount, Decimal("500.00"))

    def test_patch_duplicate_race_hits_constraint(self):
        self.create_budget(
            category=self.second_expense_category,
            month=date(2026, 9, 1),
        )
        self.client.force_login(self.user)

        with mock.patch.object(QuerySet, "exists", return_value=False):
            response = self.patch_budget(
                self.budget,
                {"category": self.second_expense_category.id},
            )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.data,
            {"non_field_errors": [DUPLICATE_BUDGET_MESSAGE]},
        )
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.category, self.expense_category)

    def test_patch_reraises_unidentifiable_integrity_error(self):
        self.client.force_login(self.user)

        with mock.patch.object(
            BudgetViewSet,
            "perform_update",
            side_effect=IntegrityError("simulated unrelated integrity failure"),
        ):
            with self.assertRaises(IntegrityError):
                self.patch_budget(self.budget, {"budgeted": "600.00"})

        self.budget.refresh_from_db()
        self.assertEqual(self.budget.amount, Decimal("500.00"))

    def test_patch_ignores_spoofed_system_and_calculation_fields(self):
        before = self.snapshot(self.budget)
        self.client.force_login(self.user)

        response = self.patch_budget(
            self.budget,
            {
                "user": self.other_user.id,
                "id": 999,
                "amount": "999.00",
                "spent": "999.99",
                "remaining": "999.99",
                "created_at": "2000-01-01T00:00:00Z",
                "updated_at": "2000-01-01T00:00:00Z",
                "budgeted": "600.00",
            },
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.id, before["id"])
        self.assertEqual(self.budget.user, before["user"])
        self.assertEqual(self.budget.amount, Decimal("600.00"))
        self.assertEqual(self.budget.created_at, before["created_at"])
        self.assertNotEqual(self.budget.updated_at.year, 2000)
        self.assertNotIn("user", response.data)
        self.assertNotIn("amount", response.data)
        self.assertEqual(response.data["spent"], "0.00")
        self.assertEqual(response.data["remaining"], "600.00")

    def test_patch_requires_authentication(self):
        response = self.patch_budget(self.budget, {"budgeted": "600.00"})

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.amount, Decimal("500.00"))

    def test_patch_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.patch(
            self.detail_url(self.budget),
            {"budgeted": "600.00"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.amount, Decimal("500.00"))

    def test_patch_foreign_and_missing_ids_404_without_side_effects(self):
        other_budget = MonthlyBudget.objects.create(
            user=self.other_user,
            category=self.other_expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("100.00"),
        )
        before = self.snapshot(other_budget)
        self.client.force_login(self.user)

        foreign = self.patch_budget(other_budget, {"budgeted": "999.00"})
        missing = self.patch_budget(MonthlyBudget(pk=999999), {"budgeted": "999.00"})

        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(foreign.json(), missing.json())
        other_budget.refresh_from_db()
        self.assertEqual(self.snapshot(other_budget), before)

    def test_delete_returns_204_and_removes_only_budget(self):
        transaction_obj = self.create_transaction(amount=Decimal("25.50"))
        self.client.force_login(self.user)

        response = self.client.delete(self.detail_url(self.budget))

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(response.content, b"")
        self.assertFalse(MonthlyBudget.objects.filter(pk=self.budget.pk).exists())
        self.assertTrue(Category.objects.filter(pk=self.expense_category.pk).exists())
        self.assertTrue(get_user_model().objects.filter(pk=self.user.pk).exists())
        self.assertTrue(Transaction.objects.filter(pk=transaction_obj.pk).exists())

    def test_delete_repeated_returns_404(self):
        self.client.force_login(self.user)

        first = self.client.delete(self.detail_url(self.budget))
        second = self.client.delete(self.detail_url(self.budget))

        self.assertEqual(first.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(second.status_code, status.HTTP_404_NOT_FOUND)

    def test_delete_foreign_and_missing_ids_404_no_mutation(self):
        other_budget = MonthlyBudget.objects.create(
            user=self.other_user,
            category=self.other_expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("100.00"),
        )
        self.client.force_login(self.user)

        foreign = self.client.delete(self.detail_url(other_budget))
        missing = self.client.delete(self.detail_url(MonthlyBudget(pk=999999)))

        self.assertEqual(foreign.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(foreign.json(), missing.json())
        self.assertTrue(MonthlyBudget.objects.filter(pk=other_budget.pk).exists())

    def test_delete_requires_authentication(self):
        response = self.client.delete(self.detail_url(self.budget))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        self.assertTrue(MonthlyBudget.objects.filter(pk=self.budget.pk).exists())

    def test_delete_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.delete(self.detail_url(self.budget))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertTrue(MonthlyBudget.objects.filter(pk=self.budget.pk).exists())

    def test_detail_rejects_put_and_post(self):
        self.client.force_login(self.user)

        put = self.client.put(
            self.detail_url(self.budget),
            {
                "category": self.expense_category.id,
                "month": "2026-09-01",
                "budgeted": "600.00",
            },
            format="json",
        )
        post = self.client.post(
            self.detail_url(self.budget),
            {"budgeted": "600.00"},
            format="json",
        )

        self.assertEqual(put.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertEqual(post.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.budget.refresh_from_db()
        self.assertEqual(self.budget.amount, Decimal("500.00"))

    def test_detail_supports_head_and_options(self):
        self.client.force_login(self.user)

        response = self.client.options(self.detail_url(self.budget))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self.client.head(self.detail_url(self.budget))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_detail_query_parameters_do_not_alter_lookup_or_calculation(self):
        self.create_transaction(amount=Decimal("25.50"), date=date(2026, 9, 10))
        self.client.force_login(self.user)

        plain = self.client.get(self.detail_url(self.budget))
        with_params = self.client.get(
            self.detail_url(self.budget) + "?foo=bar&month=2026-01-01&category=999"
        )

        self.assertEqual(plain.status_code, status.HTTP_200_OK)
        self.assertEqual(with_params.status_code, status.HTTP_200_OK)
        self.assertEqual(plain.data, with_params.data)
        self.assertEqual(with_params.data["spent"], "25.50")
