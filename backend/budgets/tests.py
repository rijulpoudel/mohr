from datetime import date, timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import IntegrityError, models, transaction
from django.db.models.deletion import RestrictedError
from django.test import TestCase
from django.utils import timezone

from budgets.models import MonthlyBudget
from categories.models import Category, CategoryType


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
