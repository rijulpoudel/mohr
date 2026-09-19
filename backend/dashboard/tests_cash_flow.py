import itertools
from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import Account, AccountType
from categories.models import Category, CategoryType
from plaid_integration.models import PlaidAccountLink, PlaidConnection
from transactions.models import Transaction, TransactionType

CASH_FLOW_URL_NAME = "cash-flow-summary"

TOP_LEVEL_KEYS = [
    "month",
    "income",
    "expenses",
    "net",
    "transaction_count",
    "income_categories",
    "expense_categories",
]

CATEGORY_ITEM_KEYS = [
    "category_id",
    "category_name",
    "amount",
    "transaction_count",
]


class CashFlowRouteAndAuthTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="cash-flow-owner@example.com",
            password="TestOnlyPassword123!",
        )

    def test_route_maps_to_api_cash_flow_summary(self):
        self.assertEqual(reverse(CASH_FLOW_URL_NAME), "/api/cash-flow/summary/")

    def test_get_returns_exact_empty_response_shape_and_types(self):
        self.client.force_login(self.user)

        response = self.client.get(reverse(CASH_FLOW_URL_NAME), {"month": "2026-09"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(list(response.data.keys()), TOP_LEVEL_KEYS)
        self.assertEqual(
            response.data,
            {
                "month": "2026-09",
                "income": "0.00",
                "expenses": "0.00",
                "net": "0.00",
                "transaction_count": 0,
                "income_categories": [],
                "expense_categories": [],
            },
        )
        for field in ("month", "income", "expenses", "net"):
            self.assertIsInstance(response.data[field], str)
        self.assertIsInstance(response.data["transaction_count"], int)
        self.assertIsInstance(response.data["income_categories"], list)
        self.assertIsInstance(response.data["expense_categories"], list)

    def test_get_returns_exact_populated_contract(self):
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
            opening_balance=Decimal("0.00"),
        )
        Transaction.objects.create(
            user=self.user,
            account=account,
            category=income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("1000.00"),
            date=date(2026, 9, 5),
        )
        for amount in (Decimal("150.00"), Decimal("150.00")):
            Transaction.objects.create(
                user=self.user,
                account=account,
                category=expense_category,
                transaction_type=TransactionType.EXPENSE,
                amount=amount,
                date=date(2026, 9, 10),
            )
        self.client.force_login(self.user)

        response = self.client.get(reverse(CASH_FLOW_URL_NAME), {"month": "2026-09"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data,
            {
                "month": "2026-09",
                "income": "1000.00",
                "expenses": "300.00",
                "net": "700.00",
                "transaction_count": 3,
                "income_categories": [
                    {
                        "category_id": income_category.id,
                        "category_name": "Salary",
                        "amount": "1000.00",
                        "transaction_count": 1,
                    }
                ],
                "expense_categories": [
                    {
                        "category_id": expense_category.id,
                        "category_name": "Groceries",
                        "amount": "300.00",
                        "transaction_count": 2,
                    }
                ],
            },
        )
        self.assertEqual(
            list(response.data["income_categories"][0].keys()),
            CATEGORY_ITEM_KEYS,
        )
        self.assertEqual(
            list(response.data["expense_categories"][0].keys()),
            CATEGORY_ITEM_KEYS,
        )

    def test_get_requires_authentication(self):
        response = self.client.get(reverse(CASH_FLOW_URL_NAME), {"month": "2026-09"})

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_head_with_valid_month_returns_200(self):
        self.client.force_login(self.user)

        response = self.client.head(
            reverse(CASH_FLOW_URL_NAME),
            {"month": "2026-09"},
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_options_available_without_month_parameter(self):
        self.client.force_login(self.user)

        response = self.client.options(reverse(CASH_FLOW_URL_NAME))

        self.assertEqual(response.status_code, status.HTTP_200_OK)

    def test_unsupported_methods_return_405(self):
        self.client.force_login(self.user)

        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    reverse(CASH_FLOW_URL_NAME),
                    {"month": "2026-09"},
                    format="json",
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

    def test_authenticated_post_with_csrf_token_reaches_dispatch_and_returns_405(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_response = csrf_client.get(reverse("auth-csrf"))
        csrf_token = csrf_response.cookies["csrftoken"].value

        response = csrf_client.post(
            reverse(CASH_FLOW_URL_NAME),
            {"month": "2026-09"},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertEqual(response.json(), {"detail": 'Method "POST" not allowed.'})

    def test_anonymous_requests_return_401_before_method_disclosure(self):
        for method in ("get", "head", "options", "post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    reverse(CASH_FLOW_URL_NAME),
                    {"month": "2026-09"},
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
        account = Account.objects.create(
            user=self.user,
            name="Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
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

        response = self.client.get(reverse(CASH_FLOW_URL_NAME), {"month": "2026-09"})

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(Category.objects.count(), 1)
        self.assertEqual(Account.objects.count(), 1)
        self.assertEqual(Transaction.objects.count(), 1)


class CashFlowTotalsTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="cash-flow-totals-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="cash-flow-totals-other@example.com",
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

    def fetch_summary(self, month):
        self.client.force_login(self.user)
        response = self.client.get(reverse(CASH_FLOW_URL_NAME), {"month": month})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_includes_exact_month_boundaries(self):
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

        summary = self.fetch_summary("2026-09")

        self.assertEqual(summary["income"], "35.50")
        self.assertEqual(summary["expenses"], "8.00")
        self.assertEqual(summary["net"], "27.50")
        self.assertEqual(summary["transaction_count"], 4)

    def test_excludes_previous_and_next_month_transactions(self):
        self.create_transaction(amount=Decimal("50.00"), date=date(2026, 8, 31))
        self.create_transaction(amount=Decimal("60.00"), date=date(2026, 10, 1))
        self.create_transaction(amount=Decimal("25.00"), date=date(2026, 9, 15))

        summary = self.fetch_summary("2026-09")

        self.assertEqual(summary["income"], "25.00")
        self.assertEqual(summary["expenses"], "0.00")
        self.assertEqual(summary["transaction_count"], 1)

    def test_excludes_same_month_number_in_different_year(self):
        self.create_transaction(amount=Decimal("100.00"), date=date(2027, 9, 15))
        self.create_transaction(amount=Decimal("25.00"), date=date(2026, 9, 15))

        summary = self.fetch_summary("2026-09")

        self.assertEqual(summary["income"], "25.00")
        self.assertEqual(summary["transaction_count"], 1)

    def test_december_rollover_uses_exclusive_next_boundary(self):
        self.create_transaction(amount=Decimal("100.00"), date=date(2026, 12, 31))
        self.create_transaction(amount=Decimal("50.00"), date=date(2027, 1, 1))
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("10.00"),
            date=date(2026, 12, 1),
        )

        summary = self.fetch_summary("2026-12")

        self.assertEqual(summary["income"], "100.00")
        self.assertEqual(summary["expenses"], "10.00")
        self.assertEqual(summary["transaction_count"], 2)

    def test_accepts_extreme_valid_years(self):
        self.create_transaction(amount=Decimal("5.00"), date=date(1, 1, 1))
        self.create_transaction(amount=Decimal("7.00"), date=date(9999, 12, 31))
        self.create_transaction(amount=Decimal("9.00"), date=date(9999, 11, 30))

        summary = self.fetch_summary("0001-01")

        self.assertEqual(summary["income"], "5.00")
        self.assertEqual(summary["transaction_count"], 1)

        summary = self.fetch_summary("9999-12")

        self.assertEqual(summary["income"], "7.00")
        self.assertEqual(summary["expenses"], "0.00")
        self.assertEqual(summary["transaction_count"], 1)

    def test_mixed_income_expense_exact_totals_and_negative_net(self):
        self.create_transaction(amount=Decimal("50.00"))
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("75.25"),
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("24.75"),
        )

        summary = self.fetch_summary("2026-09")

        self.assertEqual(summary["income"], "50.00")
        self.assertEqual(summary["expenses"], "100.00")
        self.assertEqual(summary["net"], "-50.00")

    def test_totals_are_large_and_exact_strings(self):
        self.create_transaction(amount=Decimal("9999999999.99"))
        self.create_transaction(amount=Decimal("9999999999.99"))
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.expense_category,
            amount=Decimal("123456.78"),
        )

        summary = self.fetch_summary("2026-09")

        self.assertEqual(summary["income"], "19999999999.98")
        self.assertEqual(summary["expenses"], "123456.78")
        self.assertEqual(summary["net"], "19999876543.20")
        self.assertEqual(summary["transaction_count"], 3)
        self.assertIsInstance(summary["income"], str)
        self.assertIsInstance(summary["expenses"], str)
        self.assertIsInstance(summary["net"], str)

    def test_other_users_transactions_do_not_affect_totals(self):
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

        summary = self.fetch_summary("2026-09")

        self.assertEqual(summary["income"], "5.00")
        self.assertEqual(summary["expenses"], "0.00")
        self.assertEqual(summary["transaction_count"], 1)


class CashFlowCategoryBreakdownTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="cash-flow-breakdown-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.account = Account.objects.create(
            user=cls.user,
            name="Checking",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("100.00"),
        )
        cls.income_category = Category.objects.create(
            user=cls.user,
            name="Salary",
            category_type=CategoryType.INCOME,
        )
        cls.bonus_category = Category.objects.create(
            user=cls.user,
            name="Bonus",
            category_type=CategoryType.INCOME,
        )
        cls.groceries_category = Category.objects.create(
            user=cls.user,
            name="Groceries",
            category_type=CategoryType.EXPENSE,
        )
        cls.rent_category = Category.objects.create(
            user=cls.user,
            name="Rent",
            category_type=CategoryType.EXPENSE,
        )
        cls.dining_category = Category.objects.create(
            user=cls.user,
            name="Dining Out",
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

    def fetch_summary(self, month="2026-09"):
        self.client.force_login(self.user)
        response = self.client.get(reverse(CASH_FLOW_URL_NAME), {"month": month})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_categories_group_amounts_and_counts_by_category(self):
        self.create_transaction(
            category=self.bonus_category,
            amount=Decimal("500.00"),
        )
        self.create_transaction(amount=Decimal("1000.00"))
        self.create_transaction(amount=Decimal("200.00"))
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.groceries_category,
            amount=Decimal("40.00"),
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.groceries_category,
            amount=Decimal("60.00"),
        )

        summary = self.fetch_summary()

        self.assertEqual(
            summary["income_categories"],
            [
                {
                    "category_id": self.income_category.id,
                    "category_name": "Salary",
                    "amount": "1200.00",
                    "transaction_count": 2,
                },
                {
                    "category_id": self.bonus_category.id,
                    "category_name": "Bonus",
                    "amount": "500.00",
                    "transaction_count": 1,
                },
            ],
        )
        self.assertEqual(
            summary["expense_categories"],
            [
                {
                    "category_id": self.groceries_category.id,
                    "category_name": "Groceries",
                    "amount": "100.00",
                    "transaction_count": 2,
                }
            ],
        )

    def test_categories_sort_amount_desc_then_name_asc(self):
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.rent_category,
            amount=Decimal("300.00"),
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.groceries_category,
            amount=Decimal("300.00"),
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.dining_category,
            amount=Decimal("500.00"),
        )

        summary = self.fetch_summary()

        self.assertEqual(
            [item["category_name"] for item in summary["expense_categories"]],
            ["Dining Out", "Groceries", "Rent"],
        )

    def test_archived_categories_keep_current_names(self):
        archived = Category.objects.create(
            user=self.user,
            name="Old Subscriptions",
            category_type=CategoryType.EXPENSE,
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=archived,
            amount=Decimal("25.00"),
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=archived,
            amount=Decimal("25.00"),
        )
        Category.objects.filter(pk=archived.pk).update(is_archived=True)

        summary = self.fetch_summary()

        self.assertEqual(
            summary["expense_categories"],
            [
                {
                    "category_id": archived.id,
                    "category_name": "Old Subscriptions",
                    "amount": "50.00",
                    "transaction_count": 2,
                }
            ],
        )

    def test_income_and_expense_lists_are_separate(self):
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.groceries_category,
            amount=Decimal("999.99"),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["income_categories"], [])
        self.assertEqual(
            summary["expense_categories"],
            [
                {
                    "category_id": self.groceries_category.id,
                    "category_name": "Groceries",
                    "amount": "999.99",
                    "transaction_count": 1,
                }
            ],
        )

    def test_transaction_count_equals_sum_of_category_counts(self):
        self.create_transaction(amount=Decimal("1000.00"))
        self.create_transaction(
            category=self.bonus_category,
            amount=Decimal("500.00"),
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.groceries_category,
            amount=Decimal("40.00"),
        )
        self.create_transaction(
            transaction_type=TransactionType.EXPENSE,
            category=self.rent_category,
            amount=Decimal("900.00"),
        )

        summary = self.fetch_summary()

        counted = sum(
            item["transaction_count"]
            for item in summary["income_categories"] + summary["expense_categories"]
        )
        self.assertEqual(counted, summary["transaction_count"])
        self.assertEqual(summary["transaction_count"], 4)

    def test_categories_do_not_leak_other_users_categories(self):
        other_user = get_user_model().objects.create_user(
            email="cash-flow-breakdown-other@example.com",
            password="TestOnlyPassword123!",
        )
        other_category = Category.objects.create(
            user=other_user,
            name="Their Salary",
            category_type=CategoryType.INCOME,
        )
        self.create_transaction(amount=Decimal("10.00"))

        summary = self.fetch_summary()

        self.assertEqual(len(summary["income_categories"]), 1)
        self.assertEqual(summary["income_categories"][0]["category_name"], "Salary")
        self.assertNotIn("Their Salary", summary["income_categories"])
        self.assertEqual(
            summary["income_categories"][0]["category_id"], self.income_category.id
        )
        self.assertNotEqual(
            summary["income_categories"][0]["category_id"],
            other_category.id,
        )


class CashFlowLedgerPredicateTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="cash-flow-ledger-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="cash-flow-ledger-other@example.com",
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
        cls.other_income_category = Category.objects.create(
            user=cls.other_user,
            name="Their Salary",
            category_type=CategoryType.INCOME,
        )
        cls.connection = PlaidConnection.objects.create(
            user=cls.user,
            item_id="item-sandbox-cash-flow-00001",
            institution_name="Cash Flow Bank",
        )
        cls.link = PlaidAccountLink.objects.create(
            connection=cls.connection,
            user=cls.user,
            account=cls.linked_account,
            plaid_account_id="plaid-account-cash-flow-00001",
            plaid_type="depository",
            plaid_subtype="checking",
            mask="1111",
        )
        cls._plaid_seq = itertools.count(1)

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
                f"plaid-transaction-cash-flow-{next(self._plaid_seq)}"
            ),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def fetch_summary(self):
        self.client.force_login(self.user)
        response = self.client.get(reverse(CASH_FLOW_URL_NAME), {"month": "2026-09"})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_not_yet_anchored_linked_rows_are_excluded(self):
        self.create_plaid(amount=Decimal("25.50"))
        self.create_plaid(
            category=self.expense_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("5.00"),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["income"], "0.00")
        self.assertEqual(summary["expenses"], "0.00")
        self.assertEqual(summary["transaction_count"], 0)
        self.assertEqual(summary["income_categories"], [])
        self.assertEqual(summary["expense_categories"], [])

    def test_pending_removed_superseded_rows_are_excluded_when_anchored(self):
        posted = self.create_plaid(amount=Decimal("25.50"))
        self.create_plaid(
            amount=Decimal("10.00"),
            is_pending=True,
            plaid_transaction_id="plaid-transaction-cash-flow-pending",
        )
        self.create_plaid(
            amount=Decimal("7.00"),
            is_provider_removed=True,
            plaid_transaction_id="plaid-transaction-cash-flow-removed",
        )
        self.create_plaid(
            amount=Decimal("3.00"),
            is_superseded=True,
            superseded_by=posted,
            plaid_transaction_id="plaid-transaction-cash-flow-superseded",
        )
        PlaidAccountLink.objects.filter(pk=self.link.pk).update(
            anchor_applied_at=timezone.now()
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["income"], "25.50")
        self.assertEqual(summary["expenses"], "0.00")
        self.assertEqual(summary["transaction_count"], 1)

    def test_anchored_posted_rows_are_included(self):
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

        self.assertEqual(summary["income"], "25.50")
        self.assertEqual(summary["expenses"], "5.00")
        self.assertEqual(summary["transaction_count"], 2)

    def test_manual_rows_always_count_even_with_unanchored_link_elsewhere(self):
        Transaction.objects.create(
            user=self.user,
            account=self.manual_account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("1.00"),
            date=date(2026, 9, 20),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["income"], "1.00")
        self.assertEqual(summary["transaction_count"], 1)


class CashFlowMalformedIsolationTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="cash-flow-malformed-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="cash-flow-malformed-other@example.com",
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

    def fetch_summary(self):
        self.client.force_login(self.user)
        response = self.client.get(reverse(CASH_FLOW_URL_NAME), {"month": "2026-09"})
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response.data

    def test_other_user_transaction_using_our_account_is_excluded(self):
        Transaction.objects.create(
            user=self.other_user,
            account=self.account,
            category=self.other_income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("999.99"),
            date=date(2026, 9, 15),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["income"], "0.00")
        self.assertEqual(summary["transaction_count"], 0)
        self.assertEqual(summary["income_categories"], [])

    def test_other_user_transaction_using_our_category_is_excluded(self):
        # Malformed row owned by another user but pointing at OUR category.
        # This is the only direction that isolates the transaction-level
        # `user=` scoping: `category__user` alone would let it through.
        Transaction.objects.create(
            user=self.other_user,
            account=self.other_account,
            category=self.income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("999.99"),
            date=date(2026, 9, 15),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["income"], "0.00")
        self.assertEqual(summary["expenses"], "0.00")
        self.assertEqual(summary["transaction_count"], 0)
        self.assertEqual(summary["income_categories"], [])
        self.assertEqual(summary["expense_categories"], [])

    def test_our_transaction_with_foreign_category_leaks_no_name_or_amount(self):
        Transaction.objects.create(
            user=self.user,
            account=self.account,
            category=self.other_income_category,
            transaction_type=TransactionType.INCOME,
            amount=Decimal("999.99"),
            date=date(2026, 9, 15),
        )

        summary = self.fetch_summary()

        self.assertEqual(summary["income"], "0.00")
        self.assertEqual(summary["expenses"], "0.00")
        self.assertEqual(summary["transaction_count"], 0)
        self.assertEqual(summary["income_categories"], [])
        self.assertEqual(summary["expense_categories"], [])


class CashFlowQueryValidationTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="cash-flow-validation-owner@example.com",
            password="TestOnlyPassword123!",
        )

    def fetch(self, **query):
        self.client.force_login(self.user)
        return self.client.get(reverse(CASH_FLOW_URL_NAME), query)

    def test_missing_month_returns_400(self):
        response = self.fetch()

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data, {"month": ["This field is required."]})

    def test_blank_month_returns_400(self):
        response = self.fetch(month="")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(response.data, {"month": ["This field may not be blank."]})

    def test_malformed_months_return_400(self):
        for value in (
            "2026-9",
            "202609",
            "2026/09",
            "2026-00",
            "2026-13",
            "0000-01",
            "10000-01",
            "26-09",
            "2026-09-01",
            "abc",
            "2026-09 01",
        ):
            with self.subTest(value=value):
                response = self.fetch(month=value)
                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertEqual(
                    response.data,
                    {"month": ["Enter a valid month in YYYY-MM format."]},
                )

    def test_duplicate_month_returns_400(self):
        response = self.fetch(month=["2026-09", "2026-10"])

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.data,
            {"month": ["Exactly one month value is required."]},
        )

    def test_unknown_query_parameter_returns_400(self):
        response = self.fetch(month="2026-09", foo="bar")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.data,
            {"non_field_errors": ["Unknown query parameters are not allowed."]},
        )

    def test_unknown_parameter_alone_returns_400(self):
        response = self.fetch(foo="bar")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.data,
            {"non_field_errors": ["Unknown query parameters are not allowed."]},
        )

    def test_validation_errors_never_expose_internal_details(self):
        response = self.fetch(month="not-a-month")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.data,
            {"month": ["Enter a valid month in YYYY-MM format."]},
        )
