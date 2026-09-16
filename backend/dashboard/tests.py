import itertools
from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import (
    APIClient,
    APIRequestFactory,
    APITestCase,
    force_authenticate,
)

from accounts.models import Account, AccountType
from budgets.models import MonthlyBudget
from categories.models import Category, CategoryType
from dashboard.views import DashboardSummaryView
from plaid_integration.models import PlaidAccountLink, PlaidConnection
from transactions.models import Transaction, TransactionType

SUMMARY_URL_NAME = "dashboard-summary"


class DashboardSummaryRouteAuthTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="dashboard-owner@example.com",
            password="TestOnlyPassword123!",
        )

    def test_route_maps_to_api_dashboard_summary(self):
        self.assertEqual(reverse(SUMMARY_URL_NAME), "/api/dashboard/summary/")

    def test_get_returns_exact_empty_response_shape_and_types(self):
        self.client.force_login(self.user)

        response = self.client.get(reverse(SUMMARY_URL_NAME))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            list(response.data.keys()),
            [
                "total_balance",
                "current_month_income",
                "current_month_expenses",
                "total_budgeted",
                "remaining_budget",
                "recent_transactions",
            ],
        )
        self.assertEqual(
            response.data,
            {
                "total_balance": "0.00",
                "current_month_income": "0.00",
                "current_month_expenses": "0.00",
                "total_budgeted": "0.00",
                "remaining_budget": "0.00",
                "recent_transactions": [],
            },
        )
        for field in (
            "total_balance",
            "current_month_income",
            "current_month_expenses",
            "total_budgeted",
            "remaining_budget",
        ):
            self.assertIsInstance(response.data[field], str)

    def test_get_requires_authentication(self):
        response = self.client.get(reverse(SUMMARY_URL_NAME))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_head_and_options_are_supported(self):
        self.client.force_login(self.user)

        response = self.client.head(reverse(SUMMARY_URL_NAME))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self.client.options(reverse(SUMMARY_URL_NAME))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_unsupported_methods_return_405(self):
        self.client.force_login(self.user)

        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    reverse(SUMMARY_URL_NAME),
                    {},
                    format="json",
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

    def test_authenticated_post_without_csrf_token_returns_generic_403(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.post(reverse(SUMMARY_URL_NAME), {}, format="json")

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertFalse(Account.objects.exists())
        self.assertFalse(Category.objects.exists())
        self.assertFalse(MonthlyBudget.objects.exists())
        self.assertFalse(Transaction.objects.exists())

    def test_authenticated_post_with_csrf_token_reaches_dispatch_and_returns_405(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_response = csrf_client.get(reverse("auth-csrf"))
        csrf_token = csrf_response.cookies["csrftoken"].value

        response = csrf_client.post(
            reverse(SUMMARY_URL_NAME),
            {},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": 'Method "POST" not allowed.'})
        self.assertFalse(Account.objects.exists())
        self.assertFalse(Category.objects.exists())
        self.assertFalse(MonthlyBudget.objects.exists())
        self.assertFalse(Transaction.objects.exists())

    def test_anonymous_requests_return_401_before_method_disclosure(self):
        for method in ("get", "head", "options", "post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    reverse(SUMMARY_URL_NAME),
                    {},
                    format="json",
                )
                self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
                self.assertEqual(
                    response.data,
                    {"detail": "Authentication credentials were not provided."},
                )

    def test_get_leaves_existing_rows_unchanged(self):
        income_category = Category.objects.create(
            user=self.user,
            name="Salary",
            category_type=CategoryType.INCOME,
        )
        expense_category = Category.objects.create(
            user=self.user,
            name="Groceries",
            category_type=CategoryType.EXPENSE,
        )
        account = Account.objects.create(
            user=self.user,
            name="Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        MonthlyBudget.objects.create(
            user=self.user,
            category=expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("500.00"),
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("25.50"),
            date=date(2026, 9, 1),
        )
        self.client.force_login(self.user)

        response = self.client.get(reverse(SUMMARY_URL_NAME))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(Category.objects.count(), 2)
        self.assertEqual(Account.objects.count(), 1)
        self.assertEqual(MonthlyBudget.objects.count(), 1)
        self.assertEqual(Transaction.objects.count(), 1)


class DashboardTotalBalanceTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="dashboard-balance-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="dashboard-balance-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.checking = Account.objects.create(
            user=cls.user,
            name="Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.savings = Account.objects.create(
            user=cls.user,
            name="Savings",
            account_type=AccountType.SAVINGS,
            opening_balance=Decimal("250.50"),
        )
        cls.archived_account = Account.objects.create(
            user=cls.user,
            name="Old Card",
            account_type=AccountType.CREDIT_CARD,
            opening_balance=Decimal("999.99"),
            is_archived=True,
        )
        cls.other_account = Account.objects.create(
            user=cls.other_user,
            name="Their Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("5000.00"),
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
        cls.other_income_category = Category.objects.create(
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
            "account": self.checking,
            "category": self.income_category,
            "transaction_type": TransactionType.INCOME,
            "amount": Decimal("25.50"),
            "date": date(2026, 9, 1),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def fetch_summary(self):
        self.client.force_login(self.user)
        response = self.client.get(reverse(SUMMARY_URL_NAME))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_total_balance_sums_active_accounts_without_transactions(self):
        self.assertEqual(self.fetch_summary()["total_balance"], "350.50")

    def test_total_balance_includes_mixed_income_and_expense(self):
        self.create_transaction(amount=Decimal("50.00"), date=date(2026, 8, 20))
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("10.00"),
            date=date(2026, 9, 2),
        )
        self.create_transaction(
            account=self.savings,
            amount=Decimal("20.00"),
            date=date(2025, 12, 1),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "410.50")

    def test_total_balance_excludes_archived_account_balance_entirely(self):
        self.create_transaction(
            account=self.archived_account,
            amount=Decimal("100.00"),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "350.50")

    def test_total_balance_ignores_other_users_accounts(self):
        Transaction.objects.create(
            user=self.other_user,
            account=self.other_account,
            category=self.other_income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("999.99"),
            date=date(2026, 9, 1),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "350.50")

    def test_total_balance_defensively_excludes_malformed_cross_user_transaction(self):
        self.create_transaction(amount=Decimal("50.00"))
        Transaction.objects.create(
            user=self.other_user,
            account=self.checking,
            category=self.other_income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("999.99"),
            date=date(2026, 9, 1),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "400.50")

    def test_total_balance_can_be_negative(self):
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("400.00"),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "-49.50")

    def test_total_balance_exceeds_twelve_digits_and_serializes_exactly(self):
        self.create_transaction(amount=Decimal("9999999999.99"))
        self.create_transaction(amount=Decimal("9999999999.99"))

        summary = self.fetch_summary()

        self.assertEqual(summary["total_balance"], "20000000350.48")
        self.assertIsInstance(summary["total_balance"], str)


class DashboardCurrentMonthTotalsTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="dashboard-month-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="dashboard-month-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Checking",
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
        cls.other_income_category = Category.objects.create(
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
            "category": self.income_category,
            "transaction_type": TransactionType.INCOME,
            "amount": Decimal("25.50"),
            "date": date(2026, 9, 15),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def fetch_summary(self, today):
        self.client.force_login(self.user)
        with mock.patch("django.utils.timezone.localdate", return_value=today):
            response = self.client.get(reverse(SUMMARY_URL_NAME))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_current_month_totals_include_exact_month_boundaries(self):
        self.create_transaction(amount=Decimal("25.50"), date=date(2026, 9, 1))
        self.create_transaction(amount=Decimal("10.00"), date=date(2026, 9, 30))
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("5.00"),
            date=date(2026, 9, 1),
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("3.00"),
            date=date(2026, 9, 30),
        )

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["current_month_income"], "35.50")
        self.assertEqual(summary["current_month_expenses"], "8.00")

    def test_current_month_excludes_previous_and_next_month_transactions(self):
        self.create_transaction(amount=Decimal("50.00"), date=date(2026, 8, 31))
        self.create_transaction(amount=Decimal("60.00"), date=date(2026, 10, 1))

        summary = self.fetch_summary(date(2026, 9, 1))

        self.assertEqual(summary["current_month_income"], "0.00")
        self.assertEqual(summary["current_month_expenses"], "0.00")

    def test_current_month_excludes_same_month_number_in_different_year(self):
        self.create_transaction(amount=Decimal("100.00"), date=date(2027, 9, 15))
        self.create_transaction(amount=Decimal("25.00"), date=date(2026, 9, 15))

        summary = self.fetch_summary(date(2026, 9, 30))

        self.assertEqual(summary["current_month_income"], "25.00")

    def test_december_to_january_rollover_uses_exclusive_next_boundary(self):
        self.create_transaction(amount=Decimal("100.00"), date=date(2026, 12, 31))
        self.create_transaction(amount=Decimal("50.00"), date=date(2027, 1, 1))
        self.create_transaction(amount=Decimal("25.00"), date=date(2025, 12, 1))
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("10.00"),
            date=date(2026, 12, 1),
        )

        summary = self.fetch_summary(date(2026, 12, 15))

        self.assertEqual(summary["current_month_income"], "100.00")
        self.assertEqual(summary["current_month_expenses"], "10.00")

    def test_current_month_includes_transactions_with_archived_links(self):
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("10.00"),
        )
        Account.objects.filter(pk=self.account.pk).update(is_archived=True)
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["current_month_income"], "0.00")
        self.assertEqual(summary["current_month_expenses"], "10.00")

    def test_current_month_ignores_other_users_transactions(self):
        Transaction.objects.create(
            user=self.other_user,
            account=self.other_account,
            category=self.other_income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("999.99"),
            date=date(2026, 9, 15),
        )
        Transaction.objects.create(
            user=self.other_user,
            account=self.other_account,
            category=self.other_expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("777.77"),
            date=date(2026, 9, 15),
        )
        self.create_transaction(amount=Decimal("5.00"))

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["current_month_income"], "5.00")
        self.assertEqual(summary["current_month_expenses"], "0.00")

    def test_current_month_totals_are_large_and_exact_strings(self):
        self.create_transaction(amount=Decimal("9999999999.99"))
        self.create_transaction(amount=Decimal("9999999999.99"))
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("123456.78"),
        )

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["current_month_income"], "19999999999.98")
        self.assertEqual(summary["current_month_expenses"], "123456.78")
        self.assertIsInstance(summary["current_month_income"], str)
        self.assertIsInstance(summary["current_month_expenses"], str)

    def test_current_month_totals_are_zero_without_transactions(self):
        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["current_month_income"], "0.00")
        self.assertEqual(summary["current_month_expenses"], "0.00")


class DashboardBudgetTotalsTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="dashboard-budget-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="dashboard-budget-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
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
        cls.income_category = Category.objects.create(
            user=cls.user,
            name="Salary",
            category_type=CategoryType.INCOME,
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

    def fetch_summary(self, today):
        self.client.force_login(self.user)
        with mock.patch("django.utils.timezone.localdate", return_value=today):
            response = self.client.get(reverse(SUMMARY_URL_NAME))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_budget_totals_sum_current_month_budgets_without_spending(self):
        self.create_budget(amount=Decimal("500.00"))
        self.create_budget(
            category=self.second_expense_category,
            amount=Decimal("250.50"),
        )

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["total_budgeted"], "750.50")
        self.assertEqual(summary["remaining_budget"], "750.50")

    def test_budget_totals_exclude_previous_and_future_months(self):
        self.create_budget(month=date(2026, 8, 1), amount=Decimal("300.00"))
        self.create_budget(month=date(2026, 10, 1), amount=Decimal("400.00"))
        self.create_budget(month=date(2026, 9, 1), amount=Decimal("500.00"))

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["total_budgeted"], "500.00")
        self.assertEqual(summary["remaining_budget"], "500.00")

    def test_budget_totals_respect_december_to_january_boundary(self):
        self.create_budget(month=date(2026, 12, 1), amount=Decimal("500.00"))
        self.create_budget(month=date(2027, 1, 1), amount=Decimal("600.00"))

        summary = self.fetch_summary(date(2026, 12, 20))

        self.assertEqual(summary["total_budgeted"], "500.00")
        self.assertEqual(summary["remaining_budget"], "500.00")

    def test_budget_totals_include_budgets_with_archived_categories(self):
        self.create_budget(amount=Decimal("500.00"))
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["total_budgeted"], "500.00")
        self.assertEqual(summary["remaining_budget"], "500.00")

    def test_remaining_subtracts_only_spending_in_budgeted_categories(self):
        self.create_budget(amount=Decimal("500.00"))
        self.create_transaction(amount=Decimal("75.25"))
        self.create_transaction(
            category=self.second_expense_category,
            amount=Decimal("100.00"),
        )
        self.create_transaction(
            transaction_type=TransactionType.INCOME,
            category=self.income_category,
            amount=Decimal("50.00"),
        )

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["total_budgeted"], "500.00")
        self.assertEqual(summary["remaining_budget"], "424.75")

    def test_remaining_allows_negative_overspending(self):
        self.create_budget(amount=Decimal("50.00"))
        self.create_transaction(amount=Decimal("75.50"))

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["total_budgeted"], "50.00")
        self.assertEqual(summary["remaining_budget"], "-25.50")

    def test_budget_totals_ignore_other_users_budgets(self):
        self.create_budget(amount=Decimal("500.00"))
        MonthlyBudget.objects.create(
            user=self.other_user,
            category=self.other_expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("999.99"),
        )

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["total_budgeted"], "500.00")
        self.assertEqual(summary["remaining_budget"], "500.00")

    def test_budget_totals_are_large_and_exact_strings(self):
        self.create_budget(amount=Decimal("9999999999.99"))
        self.create_budget(
            category=self.second_expense_category,
            amount=Decimal("9999999999.99"),
        )
        self.create_transaction(amount=Decimal("123456.78"))

        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["total_budgeted"], "19999999999.98")
        self.assertEqual(summary["remaining_budget"], "19999876543.20")
        self.assertIsInstance(summary["total_budgeted"], str)
        self.assertIsInstance(summary["remaining_budget"], str)

    def test_remaining_recalculates_after_transaction_create_move_and_delete(self):
        self.create_budget(amount=Decimal("500.00"))
        transaction_obj = self.create_transaction(
            amount=Decimal("25.50"),
            date=date(2026, 9, 10),
        )

        summary = self.fetch_summary(date(2026, 9, 15))
        self.assertEqual(summary["remaining_budget"], "474.50")

        Transaction.objects.filter(pk=transaction_obj.pk).update(date=date(2026, 8, 10))
        summary = self.fetch_summary(date(2026, 9, 15))
        self.assertEqual(summary["remaining_budget"], "500.00")

        Transaction.objects.filter(pk=transaction_obj.pk).update(
            amount=Decimal("75.25"),
            date=date(2026, 9, 10),
        )
        summary = self.fetch_summary(date(2026, 9, 15))
        self.assertEqual(summary["remaining_budget"], "424.75")

        transaction_obj.delete()
        summary = self.fetch_summary(date(2026, 9, 15))
        self.assertEqual(summary["remaining_budget"], "500.00")

    def test_budget_totals_are_zero_without_budgets(self):
        summary = self.fetch_summary(date(2026, 9, 15))

        self.assertEqual(summary["total_budgeted"], "0.00")
        self.assertEqual(summary["remaining_budget"], "0.00")


def format_datetime(value):
    return value.isoformat().replace("+00:00", "Z")


class DashboardRecentTransactionsTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="dashboard-recent-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="dashboard-recent-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Checking",
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
        cls.other_income_category = Category.objects.create(
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
            "category": self.income_category,
            "transaction_type": TransactionType.INCOME,
            "amount": Decimal("25.50"),
            "date": date(2026, 9, 15),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def fetch_summary(self, today=date(2026, 9, 15)):
        self.client.force_login(self.user)
        with mock.patch("django.utils.timezone.localdate", return_value=today):
            response = self.client.get(reverse(SUMMARY_URL_NAME))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_recent_transactions_returns_at_most_five_newest_in_exact_shape(self):
        for index in range(7):
            self.create_transaction(
                amount=Decimal(f"{index + 1}.00"),
                date=date(2026, 9, 20) - timedelta(days=index),
            )
        transactions = list(Transaction.objects.order_by("-date", "-id"))
        expected = transactions[:5]

        summary = self.fetch_summary()

        self.assertEqual(len(summary["recent_transactions"]), 5)
        self.assertEqual(
            [item["id"] for item in summary["recent_transactions"]],
            [item.id for item in expected],
        )
        self.assertEqual(
            summary["recent_transactions"][0],
            {
                "id": expected[0].id,
                "account": self.account.id,
                "category": self.income_category.id,
                "transaction_type": "income",
                "amount": "1.00",
                "date": "2026-09-20",
                "note": "",
                "source": "manual",
                "provider_name": "",
                "is_pending": False,
                "is_pending_initial_import": False,
                "created_at": format_datetime(expected[0].created_at),
                "updated_at": format_datetime(expected[0].updated_at),
            },
        )
        self.assertEqual(
            list(summary["recent_transactions"][0].keys()),
            [
                "id",
                "account",
                "category",
                "transaction_type",
                "amount",
                "date",
                "note",
                "source",
                "provider_name",
                "is_pending",
                "is_pending_initial_import",
                "created_at",
                "updated_at",
            ],
        )

    def test_recent_transactions_returns_fewer_than_five(self):
        first = self.create_transaction(amount=Decimal("10.00"), date=date(2026, 9, 2))
        second = self.create_transaction(
            amount=Decimal("20.00"),
            date=date(2026, 9, 10),
        )

        summary = self.fetch_summary()

        self.assertEqual(
            [item["id"] for item in summary["recent_transactions"]],
            [second.id, first.id],
        )

    def test_recent_transactions_is_empty_without_transactions(self):
        summary = self.fetch_summary()

        self.assertEqual(summary["recent_transactions"], [])

    def test_recent_transactions_breaks_ties_by_newest_id(self):
        self.create_transaction(amount=Decimal("10.00"), date=date(2026, 9, 1))
        self.create_transaction(amount=Decimal("20.00"), date=date(2026, 9, 1))
        self.create_transaction(amount=Decimal("30.00"), date=date(2026, 9, 1))
        Transaction.objects.update(created_at=timezone.now())

        summary = self.fetch_summary()

        self.assertEqual(
            [item["amount"] for item in summary["recent_transactions"]],
            ["30.00", "20.00", "10.00"],
        )

    def test_recent_transactions_ignores_other_users_transactions(self):
        self.create_transaction(amount=Decimal("10.00"), date=date(2026, 9, 2))
        Transaction.objects.create(
            user=self.other_user,
            account=self.other_account,
            category=self.other_income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("999.99"),
            date=date(2026, 12, 31),
        )

        summary = self.fetch_summary()

        self.assertEqual(len(summary["recent_transactions"]), 1)
        self.assertEqual(summary["recent_transactions"][0]["amount"], "10.00")

    def test_recent_transactions_includes_archived_links_and_other_months(self):
        transaction = self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("10.00"),
            date=date(2025, 6, 5),
        )
        Account.objects.filter(pk=self.account.pk).update(is_archived=True)
        Category.objects.filter(pk=self.expense_category.pk).update(is_archived=True)

        summary = self.fetch_summary()

        self.assertEqual(len(summary["recent_transactions"]), 1)
        self.assertEqual(summary["recent_transactions"][0]["id"], transaction.id)

    def test_recent_transactions_never_exposes_owner(self):
        self.create_transaction()

        summary = self.fetch_summary()

        self.assertNotIn("user", summary["recent_transactions"][0])


class DashboardQueryCountTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="dashboard-query-owner@example.com",
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

    def fetch_summary_queries(self):
        factory = APIRequestFactory()
        request = factory.get(reverse(SUMMARY_URL_NAME))
        force_authenticate(request, user=self.user)
        with mock.patch(
            "django.utils.timezone.localdate", return_value=date(2026, 9, 15)
        ):
            with CaptureQueriesContext(connection) as captured:
                response = DashboardSummaryView.as_view()(request)
        return response, captured

    def test_empty_dataset_uses_exactly_four_finance_queries(self):
        response, captured = self.fetch_summary_queries()

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(captured.captured_queries), 4)
        self.assertEqual(
            response.data,
            {
                "total_balance": "0.00",
                "current_month_income": "0.00",
                "current_month_expenses": "0.00",
                "total_budgeted": "0.00",
                "remaining_budget": "0.00",
                "recent_transactions": [],
            },
        )

    def test_small_dataset_uses_exactly_four_finance_queries(self):
        account = Account.objects.create(
            user=self.user,
            name="Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("50.00"),
            date=date(2026, 9, 1),
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("10.00"),
            date=date(2026, 9, 2),
        )
        MonthlyBudget.objects.create(
            user=self.user,
            category=self.expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("500.00"),
        )

        response, captured = self.fetch_summary_queries()

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(captured.captured_queries), 4)
        self.assertEqual(response.data["total_balance"], "140.00")
        self.assertEqual(response.data["current_month_income"], "50.00")
        self.assertEqual(response.data["current_month_expenses"], "10.00")
        self.assertEqual(response.data["total_budgeted"], "500.00")
        self.assertEqual(response.data["remaining_budget"], "490.00")
        self.assertEqual(len(response.data["recent_transactions"]), 2)

    def test_linked_account_rows_keep_query_count_constant(self):
        linked_account = Account.objects.create(
            user=self.user,
            name="Linked Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-dashboard-query-00001",
            institution_name="Query Bank",
        )
        link = PlaidAccountLink.objects.create(
            connection=connection,
            user=self.user,
            account=linked_account,
            plaid_account_id="plaid-account-dashboard-query-00001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )
        for index in range(3):
            Transaction.objects.create(
                user=self.user,
                account=linked_account,
                category=self.income_category,
                transaction_type=TransactionType.INCOME,
                amount=Decimal("10.00"),
                date=date(2026, 9, 1) + timedelta(days=index),
                source="plaid",
                connection=connection,
                plaid_transaction_id=f"plaid-transaction-dashboard-query-{index + 1}",
            )
            Transaction.objects.create(
                user=self.user,
                account=linked_account,
                category=self.income_category,
                transaction_type=TransactionType.INCOME,
                amount=Decimal("1.00"),
                date=date(2026, 9, 1) + timedelta(days=index),
                source="plaid",
                connection=connection,
                plaid_transaction_id=(
                    f"plaid-transaction-dashboard-query-pending-{index + 1}"
                ),
                is_pending=True,
            )
        PlaidAccountLink.objects.filter(pk=link.pk).update(
            anchor_applied_at=timezone.now()
        )

        response, captured = self.fetch_summary_queries()

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(captured.captured_queries), 4)
        self.assertEqual(response.data["total_balance"], "30.00")
        self.assertEqual(len(response.data["recent_transactions"]), 3)
        self.assertFalse(
            response.data["recent_transactions"][0]["is_pending_initial_import"]
        )

    def test_query_count_stays_constant_as_data_grows(self):
        account = Account.objects.create(
            user=self.user,
            name="Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("50.00"),
            date=date(2026, 9, 1),
        )
        small_response, small_captured = self.fetch_summary_queries()

        for index in range(8):
            Account.objects.create(
                user=self.user,
                name=f"Account {index}",
                account_type=AccountType.CHECKING,
                opening_balance=Decimal("25.00"),
            )
            Category.objects.create(
                user=self.user,
                name=f"Category {index}",
                category_type=CategoryType.EXPENSE,
            )
        for index in range(6):
            MonthlyBudget.objects.create(
                user=self.user,
                category=Category.objects.get(user=self.user, name=f"Category {index}"),
                month=date(2026, 9, 1),
                amount=Decimal(f"{index + 1}00.00"),
            )
        for index in range(15):
            Transaction.objects.create(
                user=self.user,
                account=Account.objects.get(
                    user=self.user, name=f"Account {index % 8}"
                ),
                category=Category.objects.get(
                    user=self.user, name=f"Category {index % 6}"
                ),
                transaction_type=TransactionType.EXPENSE,
                amount=Decimal(f"{index + 1}.00"),
                date=date(2026, 9, 10) - timedelta(days=index),
            )

        large_response, large_captured = self.fetch_summary_queries()

        self.assertEqual(large_response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(small_captured.captured_queries), 4)
        self.assertEqual(len(large_captured.captured_queries), 4)
        self.assertEqual(
            len(large_captured.captured_queries),
            len(small_captured.captured_queries),
        )
        self.assertEqual(small_response.data["total_balance"], "150.00")
        self.assertEqual(large_response.data["total_balance"], "230.00")
        self.assertEqual(large_response.data["current_month_expenses"], "55.00")
        self.assertEqual(len(large_response.data["recent_transactions"]), 5)


class DashboardProviderVisibilityTests(APITestCase):
    """Slice A dashboard gate: unanchored linked accounts and provider
    lifecycle rows contribute nothing to any aggregate, and recent rows use
    the same ledger predicate."""

    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="dashboard-provider-visibility-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="dashboard-provider-visibility-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.manual_account = Account.objects.create(
            user=cls.user,
            name="Manual Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.linked_account = Account.objects.create(
            user=cls.user,
            name="Linked Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
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
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-dashboard-gate-00001",
            institution_name="Dashboard Gate Bank",
        )
        cls.link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.linked_account,
            plaid_account_id="plaid-account-dashboard-gate-00001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )
        cls._plaid_seq = itertools.count(1)
        cls.unlinked_anchored_account = Account.objects.create(
            user=cls.user,
            name="Second Linked Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("0.00"),
        )
        PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.unlinked_anchored_account,
            plaid_account_id="plaid-account-dashboard-gate-00002",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="2222",
        )
        cls.budget = MonthlyBudget.objects.create(
            user=cls.user,
            category=cls.expense_category,
            month=date(2026, 9, 1),
            amount=Decimal("500.00"),
        )

    def create_plaid(self, **overrides):
        values = {
            "user": self.user,
            "account": self.linked_account,
            "category": self.income_category,
            "transaction_type": TransactionType.INCOME,
            "amount": Decimal("25.50"),
            "date": date(2026, 9, 15),
            "source": "plaid",
            "connection": self.connection,
            "plaid_transaction_id": (
                f"plaid-transaction-dashboard-gate-{next(self._plaid_seq)}"
            ),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def create_plaid_on_second_account(self, **overrides):
        values = {
            "user": self.user,
            "account": self.unlinked_anchored_account,
            "category": self.income_category,
            "transaction_type": TransactionType.INCOME,
            "amount": Decimal("25.50"),
            "date": date(2026, 9, 15),
            "source": "plaid",
            "connection": self.connection,
            "plaid_transaction_id": (
                f"plaid-transaction-dashboard-gate-{next(self._plaid_seq)}"
            ),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def fetch_summary(self, today=date(2026, 9, 15)):
        self.client.force_login(self.user)
        with mock.patch("django.utils.timezone.localdate", return_value=today):
            response = self.client.get(reverse(SUMMARY_URL_NAME))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_total_balance_ignores_unanchored_linked_account_entirely(self):
        self.create_plaid(amount=Decimal("50.00"))
        self.create_plaid(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("10.00"),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "100.00")

    def test_total_balance_ignores_unanchored_linked_nonzero_opening_account(self):
        account = Account.objects.create(
            user=self.user,
            name="Nonzero Unanchored",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("500.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=account,
            plaid_account_id="plaid-account-dashboard-gate-nonzero-00001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="3333",
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("50.00"),
            date=date(2026, 9, 15),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "100.00")

    def test_total_balance_counts_anchored_linked_nonzero_opening_account(self):
        account = Account.objects.create(
            user=self.user,
            name="Nonzero Anchored",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("500.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=account,
            plaid_account_id="plaid-account-dashboard-gate-nonzero-00002",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="3334",
            anchor_applied_at=timezone.now(),
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("50.00"),
            date=date(2026, 9, 15),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "650.00")

    def test_duplicate_cross_user_links_do_not_double_total_balance(self):
        account = Account.objects.create(
            user=self.user,
            name="Doubly Linked",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        PlaidAccountLink.objects.create(
            connection=self.connection,
            user=self.user,
            account=account,
            plaid_account_id="plaid-account-dashboard-gate-dup-00001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="4444",
            anchor_applied_at=timezone.now(),
        )
        PlaidAccountLink.objects.create(
            connection=PlaidConnection.objects.create(
                user=self.other_user,
                item_id="item-sandbox-dashboard-gate-dup-00001",
                institution_name="Their Dup Bank",
            ),
            user=self.other_user,
            account=account,
            plaid_account_id="plaid-account-dashboard-gate-dup-foreign-00001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="5555",
            anchor_applied_at=timezone.now(),
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("50.00"),
            date=date(2026, 9, 15),
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "250.00")

    def test_malformed_foreign_user_link_does_not_hide_owner_month_totals(self):
        account = Account.objects.create(
            user=self.user,
            name="Foreign Link Only",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        PlaidAccountLink.objects.create(
            connection=PlaidConnection.objects.create(
                user=self.other_user,
                item_id="item-sandbox-dashboard-gate-foreign-00001",
                institution_name="Their Foreign Bank",
            ),
            user=self.other_user,
            account=account,
            plaid_account_id="plaid-account-dashboard-gate-foreign-00001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="6666",
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("25.50"),
            date=date(2026, 9, 15),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["current_month_income"], "25.50")
        self.assertEqual(summary["total_balance"], "225.50")

    def test_total_balance_counts_anchored_linked_accounts(self):
        self.create_plaid(amount=Decimal("50.00"))
        self.create_plaid(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("10.00"),
        )
        PlaidAccountLink.objects.filter(pk=self.link.pk).update(
            anchor_applied_at=timezone.now()
        )

        self.assertEqual(self.fetch_summary()["total_balance"], "140.00")

    def test_current_month_totals_exclude_unanchored_rows(self):
        self.create_plaid(amount=Decimal("25.50"))
        self.create_plaid(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("5.00"),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["current_month_income"], "0.00")
        self.assertEqual(summary["current_month_expenses"], "0.00")

    def test_current_month_totals_count_anchored_posted_rows(self):
        self.create_plaid(amount=Decimal("25.50"))
        self.create_plaid(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("5.00"),
        )
        PlaidAccountLink.objects.filter(pk=self.link.pk).update(
            anchor_applied_at=timezone.now()
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["current_month_income"], "25.50")
        self.assertEqual(summary["current_month_expenses"], "5.00")

    def test_current_month_totals_exclude_pending_removed_superseded_when_anchored(
        self,
    ):
        posted = self.create_plaid(amount=Decimal("25.50"))
        self.create_plaid(amount=Decimal("10.00"), is_pending=True)
        self.create_plaid(amount=Decimal("7.00"), is_provider_removed=True)
        self.create_plaid(
            amount=Decimal("3.00"),
            is_superseded=True,
            superseded_by=posted,
        )
        PlaidAccountLink.objects.filter(pk=self.link.pk).update(
            anchor_applied_at=timezone.now()
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["current_month_income"], "25.50")
        self.assertEqual(summary["current_month_expenses"], "0.00")

    def test_recent_transactions_exclude_rows_not_yet_countable(self):
        manual = Transaction.objects.create(
            user=self.user,
            account=self.manual_account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("1.00"),
            date=date(2026, 9, 20),
        )
        posted = self.create_plaid(
            amount=Decimal("2.00"),
            date=date(2026, 9, 19),
        )
        self.create_plaid(
            amount=Decimal("3.00"),
            is_pending=True,
            date=date(2026, 9, 21),
        )
        self.create_plaid(
            amount=Decimal("4.00"),
            is_provider_removed=True,
            date=date(2026, 9, 22),
        )
        self.create_plaid(
            amount=Decimal("5.00"),
            is_superseded=True,
            superseded_by=posted,
            date=date(2026, 9, 23),
        )
        self.create_plaid_on_second_account(
            amount=Decimal("6.00"),
            date=date(2026, 9, 24),
        )
        PlaidAccountLink.objects.filter(pk=self.link.pk).update(
            anchor_applied_at=timezone.now()
        )

        summary = self.fetch_summary()

        self.assertEqual(
            [item["id"] for item in summary["recent_transactions"]],
            [manual.id, posted.id],
        )

    def test_recent_transactions_never_include_unanchored_rows(self):
        self.create_plaid(amount=Decimal("6.00"), date=date(2026, 9, 24))

        summary = self.fetch_summary()

        self.assertEqual(summary["recent_transactions"], [])

    def test_remaining_budget_excludes_unanchored_linked_rows(self):
        self.create_plaid(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("100.00"),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["total_budgeted"], "500.00")
        self.assertEqual(summary["remaining_budget"], "500.00")
