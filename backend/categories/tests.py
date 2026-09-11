from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import IntegrityError, models, transaction
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from categories.models import Category, CategoryType

CATEGORY_TYPE_CHOICES = [
    ("income", "Income"),
    ("expense", "Expense"),
]


class CategoryModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="category-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="category-other@example.com",
            password="TestOnlyPassword123!",
        )

    def create_category(self, **overrides):
        values = {
            "user": self.user,
            "name": "Salary",
            "category_type": CategoryType.INCOME,
        }
        values.update(overrides)
        return Category.objects.create(**values)

    def test_category_type_choices_are_exact(self):
        self.assertEqual(list(CategoryType.choices), CATEGORY_TYPE_CHOICES)

    def test_category_belongs_to_user_through_related_name(self):
        category = self.create_category()

        self.assertEqual(category.user, self.user)
        self.assertEqual(list(self.user.categories.all()), [category])
        self.assertFalse(self.other_user.categories.exists())

    def test_each_allowed_category_type_persists(self):
        for category_type, label in CATEGORY_TYPE_CHOICES:
            with self.subTest(category_type=category_type):
                category = self.create_category(category_type=category_type)
                category.refresh_from_db()

                self.assertEqual(category.category_type, category_type)
                self.assertEqual(category.get_category_type_display(), label)

    def test_is_archived_defaults_to_false(self):
        category = self.create_category()

        self.assertFalse(category.is_archived)

    def test_timestamps_track_creation_and_updates(self):
        category = self.create_category()
        created_at = category.created_at

        self.assertIsNotNone(created_at)
        self.assertIsNotNone(category.updated_at)
        self.assertGreaterEqual(category.updated_at, created_at)

        category.name = "Renamed Salary"
        category.save()
        category.refresh_from_db()

        self.assertEqual(category.created_at, created_at)
        self.assertGreater(category.updated_at, created_at)

    def test_default_ordering_is_created_at_then_id(self):
        self.assertEqual(Category._meta.ordering, ("created_at", "id"))

    def test_categories_are_ordered_by_creation_time(self):
        first = self.create_category(name="First")
        second = self.create_category(
            name="Second",
            category_type=CategoryType.EXPENSE,
        )
        Category.objects.update(created_at=timezone.now() - timedelta(days=1))
        second.created_at = timezone.now()
        second.save(update_fields=["created_at"])

        self.assertEqual(list(Category.objects.all()), [first, second])

    def test_unique_constraint_rejects_duplicate_name_per_user_and_type(self):
        self.create_category()

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_category()

        self.assertEqual(Category.objects.count(), 1)

    def test_unique_constraint_rejects_case_and_whitespace_variant(self):
        self.create_category(name="Food", category_type=CategoryType.INCOME)

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_category(name="  FOOD  ", category_type=CategoryType.INCOME)

        self.assertEqual(Category.objects.count(), 1)

    def test_same_name_is_allowed_for_a_different_type(self):
        income = self.create_category(name="Bonus", category_type=CategoryType.INCOME)
        expense = self.create_category(
            name="Bonus",
            category_type=CategoryType.EXPENSE,
        )

        self.assertEqual(
            set(Category.objects.values_list("pk", flat=True)),
            {income.pk, expense.pk},
        )

    def test_same_name_is_allowed_for_a_different_user(self):
        mine = self.create_category(name="Salary")
        theirs = self.create_category(user=self.other_user, name="Salary")

        self.assertEqual(
            set(Category.objects.values_list("pk", flat=True)),
            {mine.pk, theirs.pk},
        )

    def test_database_constraint_rejects_invalid_category_type(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self.create_category(category_type="transfer")

        self.assertFalse(Category.objects.exists())

    def test_category_type_check_constraint_has_stable_name(self):
        constraint_names = {
            constraint.name for constraint in Category._meta.constraints
        }

        self.assertIn("categories_category_type_valid", constraint_names)
        self.assertTrue(
            any(
                isinstance(constraint, models.CheckConstraint)
                for constraint in Category._meta.constraints
            )
        )

    def test_unique_constraint_has_stable_name(self):
        unique_constraints = [
            constraint
            for constraint in Category._meta.constraints
            if isinstance(constraint, models.UniqueConstraint)
        ]

        self.assertEqual(len(unique_constraints), 1)
        self.assertEqual(
            unique_constraints[0].name,
            "categories_user_name_type_unique",
        )
        self.assertEqual(len(unique_constraints[0].expressions), 3)

    def test_deleting_user_cascades_to_owned_categories(self):
        category = self.create_category()
        other_category = self.create_category(
            user=self.other_user,
            name="Their Expense",
            category_type=CategoryType.EXPENSE,
        )

        self.user.delete()

        self.assertFalse(Category.objects.filter(pk=category.pk).exists())
        self.assertTrue(Category.objects.filter(pk=other_category.pk).exists())

    def test_str_returns_name_without_exposing_user_details(self):
        category = self.create_category(name="Freelance")

        self.assertEqual(str(category), "Freelance")
        self.assertNotIn(self.user.email, str(category))


def format_datetime(value):
    return value.isoformat().replace("+00:00", "Z")


class CategoryCollectionAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="category-api-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="category-api-other@example.com",
            password="TestOnlyPassword123!",
        )

    def create_category(self, **overrides):
        values = {
            "user": self.user,
            "name": "Salary",
            "category_type": CategoryType.INCOME,
        }
        values.update(overrides)
        return Category.objects.create(**values)

    def post_category(self, **overrides):
        payload = {
            "name": "Salary",
            "category_type": "income",
        }
        payload.update(overrides)
        return self.client.post(
            reverse("category-list"),
            payload,
            format="json",
        )

    def test_list_returns_owned_categories_in_model_order(self):
        first = self.create_category(name="Salary")
        second = self.create_category(
            name="Rent",
            category_type=CategoryType.EXPENSE,
        )
        self.create_category(user=self.other_user, name="Not Mine")
        self.client.force_login(self.user)

        response = self.client.get(reverse("category-list"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual([item["id"] for item in response.data], [first.id, second.id])

    def test_list_returns_exact_output_shape_and_values(self):
        category = self.create_category()
        self.client.force_login(self.user)

        response = self.client.get(reverse("category-list"))

        self.assertEqual(
            response.data,
            [
                {
                    "id": category.id,
                    "name": "Salary",
                    "category_type": "income",
                    "is_archived": False,
                    "created_at": format_datetime(category.created_at),
                    "updated_at": format_datetime(category.updated_at),
                }
            ],
        )

    def test_list_includes_archived_owned_categories(self):
        archived = self.create_category(name="Old Side Hustle", is_archived=True)
        active = self.create_category(name="Active Salary")
        self.client.force_login(self.user)

        response = self.client.get(reverse("category-list"))

        self.assertEqual(
            {item["id"] for item in response.data},
            {archived.id, active.id},
        )

    def test_list_never_returns_another_users_categories(self):
        self.create_category(name="Mine")
        self.create_category(user=self.other_user, name="Theirs")
        self.client.force_login(self.user)

        response = self.client.get(reverse("category-list"))

        self.assertEqual([item["name"] for item in response.data], ["Mine"])

    def test_list_requires_authentication(self):
        response = self.client.get(reverse("category-list"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_create_returns_201_and_persists_row_owned_by_request_user(self):
        self.client.force_login(self.user)

        response = self.post_category(name="  Freelance  ", category_type="income")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        category = Category.objects.get()
        self.assertEqual(category.user, self.user)
        self.assertEqual(category.name, "Freelance")
        self.assertEqual(category.category_type, "income")
        self.assertEqual(
            response.data,
            {
                "id": category.id,
                "name": "Freelance",
                "category_type": "income",
                "is_archived": False,
                "created_at": format_datetime(category.created_at),
                "updated_at": format_datetime(category.updated_at),
            },
        )

    def test_create_ownership_and_server_controlled_fields_ignore_client_input(self):
        self.client.force_login(self.user)

        response = self.post_category(
            user=self.other_user.id,
            id=999,
            is_archived=True,
            created_at="2000-01-01T00:00:00Z",
            updated_at="2000-01-01T00:00:00Z",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        category = Category.objects.get()
        self.assertEqual(Category.objects.count(), 1)
        self.assertEqual(category.user, self.user)
        self.assertNotEqual(category.id, 999)
        self.assertFalse(category.is_archived)
        self.assertNotEqual(category.created_at.year, 2000)
        self.assertNotEqual(category.updated_at.year, 2000)
        self.assertNotIn("user", response.data)
        self.assertEqual(response.data["id"], category.id)
        self.assertFalse(response.data["is_archived"])
        self.assertEqual(
            response.data["created_at"],
            format_datetime(category.created_at),
        )
        self.assertEqual(
            response.data["updated_at"],
            format_datetime(category.updated_at),
        )

    def test_create_rejects_blank_or_whitespace_only_name(self):
        self.client.force_login(self.user)

        for name in ("", "   "):
            with self.subTest(name=name):
                response = self.post_category(name=name)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("name", response.data)
                self.assertFalse(Category.objects.exists())

    def test_create_rejects_null_name(self):
        self.client.force_login(self.user)

        response = self.post_category(name=None)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", response.data)
        self.assertFalse(Category.objects.exists())

    def test_create_rejects_name_longer_than_100_characters(self):
        self.client.force_login(self.user)

        response = self.post_category(name="x" * 101)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", response.data)
        self.assertFalse(Category.objects.exists())

    def test_create_requires_name_and_category_type(self):
        self.client.force_login(self.user)

        for field in ("name", "category_type"):
            with self.subTest(field=field):
                payload = {"name": "Salary", "category_type": "income"}
                payload.pop(field)

                response = self.client.post(
                    reverse("category-list"),
                    payload,
                    format="json",
                )

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)
                self.assertFalse(Category.objects.exists())

    def test_create_rejects_any_category_type_other_than_income_or_expense(self):
        self.client.force_login(self.user)

        for category_type in ("transfer", "INCOME", "Income", "", None):
            with self.subTest(category_type=category_type):
                response = self.post_category(category_type=category_type)

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("category_type", response.data)
                self.assertFalse(Category.objects.exists())

    def test_create_rejects_case_and_whitespace_variant_of_existing_name(self):
        self.create_category(name="Food", category_type=CategoryType.INCOME)
        self.client.force_login(self.user)

        for name in ("food", " FOOD ", "  Food  "):
            with self.subTest(name=name):
                response = self.post_category(name=name, category_type="income")

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("name", response.data)

        self.assertEqual(Category.objects.count(), 1)

    def test_archived_category_still_reserves_its_normalized_name(self):
        self.create_category(name="Food", is_archived=True)
        self.client.force_login(self.user)

        for name in ("FOOD", "  food  "):
            with self.subTest(name=name):
                response = self.post_category(name=name, category_type="income")

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("name", response.data)

        self.assertEqual(Category.objects.count(), 1)

    def test_create_rejects_duplicate_trimmed_name_for_same_user_and_type(self):
        self.create_category(name="Salary", category_type=CategoryType.INCOME)
        self.client.force_login(self.user)

        response = self.post_category(name="  Salary  ", category_type="income")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", response.data)
        self.assertEqual(Category.objects.count(), 1)

    def test_create_allows_same_name_for_a_different_type(self):
        self.create_category(name="Bonus", category_type=CategoryType.INCOME)
        self.client.force_login(self.user)

        response = self.post_category(name="Bonus", category_type="expense")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Category.objects.count(), 2)

    def test_create_allows_same_name_for_another_user(self):
        self.create_category(
            user=self.other_user,
            name="Salary",
            category_type=CategoryType.INCOME,
        )
        self.client.force_login(self.user)

        response = self.post_category(name="Salary", category_type="income")

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Category.objects.count(), 2)
        self.assertEqual(Category.objects.get(user=self.user).name, "Salary")

    def test_create_requires_authentication(self):
        response = self.post_category()

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        self.assertFalse(Category.objects.exists())

    def test_create_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.post(
            reverse("category-list"),
            {"name": "CSRF Blocked", "category_type": "income"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertFalse(Category.objects.exists())

    def test_csrf_token_allows_create(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_response = csrf_client.get(reverse("auth-csrf"))
        csrf_token = csrf_response.cookies["csrftoken"].value

        response = csrf_client.post(
            reverse("category-list"),
            {"name": "CSRF Allowed", "category_type": "expense"},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(Category.objects.count(), 1)
        self.assertEqual(Category.objects.get().name, "CSRF Allowed")

    def test_collection_rejects_unsupported_methods(self):
        self.create_category(name="Untouched")
        self.client.force_login(self.user)

        for method in ("patch", "put"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    reverse("category-list"),
                    {"name": "Ignored"},
                    format="json",
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        response = self.client.delete(reverse("category-list"))
        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)

        self.assertEqual(Category.objects.count(), 1)
        self.assertEqual(Category.objects.get().name, "Untouched")

    def test_options_and_head_are_supported(self):
        self.client.force_login(self.user)

        response = self.client.options(reverse("category-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        response = self.client.head(reverse("category-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)


class CategoryDetailAPITests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="category-detail-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="category-detail-other@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_category = Category.objects.create(
            user=cls.other_user,
            name="Their Rent",
            category_type=CategoryType.EXPENSE,
        )

    def create_category(self, **overrides):
        values = {
            "user": self.user,
            "name": "Salary",
            "category_type": CategoryType.INCOME,
        }
        values.update(overrides)
        return Category.objects.create(**values)

    def detail_url(self, category):
        return reverse("category-detail", args=[category.pk])

    def test_detail_returns_exact_category_shape(self):
        category = self.create_category()
        self.client.force_login(self.user)

        response = self.client.get(self.detail_url(category))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data,
            {
                "id": category.id,
                "name": "Salary",
                "category_type": "income",
                "is_archived": False,
                "created_at": format_datetime(category.created_at),
                "updated_at": format_datetime(category.updated_at),
            },
        )

    def test_detail_returns_archived_owned_category(self):
        category = self.create_category(is_archived=True)
        self.client.force_login(self.user)

        response = self.client.get(self.detail_url(category))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["id"], category.id)
        self.assertTrue(response.data["is_archived"])

    def test_patch_partially_updates_name_only(self):
        category = self.create_category()
        self.client.force_login(self.user)

        response = self.client.patch(
            self.detail_url(category),
            {"name": "  Renamed  "},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        category.refresh_from_db()
        self.assertEqual(category.name, "Renamed")
        self.assertEqual(category.category_type, "income")
        self.assertFalse(category.is_archived)
        self.assertEqual(
            response.data,
            {
                "id": category.id,
                "name": "Renamed",
                "category_type": "income",
                "is_archived": False,
                "created_at": format_datetime(category.created_at),
                "updated_at": format_datetime(category.updated_at),
            },
        )

    def test_patch_cannot_change_category_type(self):
        category = self.create_category(category_type=CategoryType.INCOME)
        self.client.force_login(self.user)

        response = self.client.patch(
            self.detail_url(category),
            {"category_type": "expense"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        category.refresh_from_db()
        self.assertEqual(category.category_type, "income")
        self.assertEqual(response.data["category_type"], "income")

    def test_patch_cannot_change_read_only_or_ownership_fields(self):
        category = self.create_category()
        category_id = category.id
        created_at = category.created_at
        self.client.force_login(self.user)

        response = self.client.patch(
            self.detail_url(category),
            {
                "id": category_id + 1,
                "user": self.other_user.id,
                "is_archived": True,
                "created_at": "2000-01-01T00:00:00Z",
                "updated_at": "2000-01-01T00:00:00Z",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        category.refresh_from_db()
        self.assertEqual(category.id, category_id)
        self.assertEqual(category.user, self.user)
        self.assertFalse(category.is_archived)
        self.assertEqual(category.created_at, created_at)
        self.assertNotEqual(category.updated_at.year, 2000)
        self.assertEqual(response.data["id"], category_id)
        self.assertFalse(response.data["is_archived"])

    def test_patch_rejects_blank_or_too_long_name_without_mutation(self):
        category = self.create_category()
        self.client.force_login(self.user)
        url = self.detail_url(category)

        for name in ("", "   ", "x" * 101):
            with self.subTest(name=name):
                response = self.client.patch(url, {"name": name}, format="json")

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn("name", response.data)

        category.refresh_from_db()
        self.assertEqual(category.name, "Salary")
        self.assertEqual(category.category_type, "income")
        self.assertFalse(category.is_archived)

    def test_patch_rejects_duplicate_trimmed_name_for_same_user_and_type(self):
        self.create_category(name="Salary", category_type=CategoryType.INCOME)
        target = self.create_category(name="Rent", category_type=CategoryType.INCOME)
        self.client.force_login(self.user)

        response = self.client.patch(
            self.detail_url(target),
            {"name": "  Salary  "},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", response.data)
        target.refresh_from_db()
        self.assertEqual(target.name, "Rent")
        self.assertEqual(Category.objects.filter(user=self.user).count(), 2)

    def test_patch_allows_name_that_is_unique_for_its_type(self):
        self.create_category(name="Bonus", category_type=CategoryType.EXPENSE)
        target = self.create_category(
            name="Freelance", category_type=CategoryType.INCOME
        )
        self.client.force_login(self.user)

        response = self.client.patch(
            self.detail_url(target),
            {"name": "Bonus"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        target.refresh_from_db()
        self.assertEqual(target.name, "Bonus")
        self.assertEqual(target.category_type, "income")

    def test_patch_rejects_case_and_whitespace_variant_of_owned_name(self):
        self.create_category(name="Food", category_type=CategoryType.INCOME)
        target = self.create_category(name="Rent", category_type=CategoryType.INCOME)
        self.client.force_login(self.user)

        response = self.client.patch(
            self.detail_url(target),
            {"name": "  FOOD  "},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("name", response.data)
        target.refresh_from_db()
        self.assertEqual(target.name, "Rent")
        self.assertEqual(Category.objects.filter(user=self.user).count(), 2)

    def test_detail_returns_404_for_another_users_category_without_side_effects(self):
        self.client.force_login(self.user)
        url = self.detail_url(self.other_category)

        for method in ("get", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    url,
                    {"name": "Spoofed"},
                    format="json",
                )
                self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

        self.other_category.refresh_from_db()
        self.assertEqual(self.other_category.name, "Their Rent")
        self.assertEqual(self.other_category.category_type, "expense")
        self.assertFalse(self.other_category.is_archived)

    def test_cross_user_and_missing_ids_are_indistinguishable(self):
        self.client.force_login(self.user)

        cross_user = self.client.get(self.detail_url(self.other_category))
        missing = self.client.get(reverse("category-detail", args=[999999]))

        self.assertEqual(cross_user.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(missing.status_code, status.HTTP_404_NOT_FOUND)
        self.assertEqual(cross_user.json(), missing.json())

    def test_detail_returns_404_for_missing_id_without_side_effects(self):
        self.client.force_login(self.user)
        url = reverse("category-detail", args=[999999])

        for method in ("get", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    url,
                    {"name": "Spoofed"},
                    format="json",
                )
                self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

        self.assertEqual(Category.objects.count(), 1)

    def test_detail_requires_authentication(self):
        category = self.create_category()
        url = self.detail_url(category)

        for method in ("get", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(url, {}, format="json")

                self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
                self.assertEqual(
                    response.data,
                    {"detail": "Authentication credentials were not provided."},
                )

        category.refresh_from_db()
        self.assertEqual(category.name, "Salary")
        self.assertFalse(category.is_archived)

    def test_delete_archives_row_and_returns_204_empty(self):
        category = self.create_category()
        created_at = category.created_at
        updated_at = category.updated_at
        self.client.force_login(self.user)

        response = self.client.delete(self.detail_url(category))

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(response.content, b"")
        category.refresh_from_db()
        self.assertTrue(category.is_archived)
        self.assertEqual(Category.objects.filter(pk=category.pk).count(), 1)
        self.assertEqual(category.user, self.user)
        self.assertEqual(category.name, "Salary")
        self.assertEqual(category.category_type, "income")
        self.assertEqual(category.created_at, created_at)
        self.assertGreater(category.updated_at, updated_at)

    def test_delete_is_idempotent(self):
        category = self.create_category()
        self.client.force_login(self.user)

        first = self.client.delete(self.detail_url(category))
        second = self.client.delete(self.detail_url(category))

        self.assertEqual(first.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(second.status_code, status.HTTP_204_NO_CONTENT)
        category.refresh_from_db()
        self.assertTrue(category.is_archived)
        self.assertEqual(Category.objects.filter(pk=category.pk).count(), 1)

    def test_delete_requires_csrf_token(self):
        category = self.create_category()
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.delete(self.detail_url(category))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        category.refresh_from_db()
        self.assertFalse(category.is_archived)

    def test_csrf_token_allows_delete(self):
        category = self.create_category()
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_token = csrf_client.get(reverse("auth-csrf")).cookies["csrftoken"].value

        response = csrf_client.delete(
            self.detail_url(category),
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        category.refresh_from_db()
        self.assertTrue(category.is_archived)

    def test_patch_requires_csrf_token(self):
        category = self.create_category()
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.patch(
            self.detail_url(category),
            {"name": "Blocked"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        category.refresh_from_db()
        self.assertEqual(category.name, "Salary")

    def test_csrf_token_allows_patch(self):
        category = self.create_category()
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_token = csrf_client.get(reverse("auth-csrf")).cookies["csrftoken"].value

        response = csrf_client.patch(
            self.detail_url(category),
            {"name": "Allowed"},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        category.refresh_from_db()
        self.assertEqual(category.name, "Allowed")

    def test_detail_rejects_post_and_put(self):
        category = self.create_category()
        self.client.force_login(self.user)
        url = self.detail_url(category)

        for method in ("post", "put"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(
                    url,
                    {"name": "Ignored"},
                    format="json",
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        category.refresh_from_db()
        self.assertEqual(category.name, "Salary")
        self.assertFalse(category.is_archived)

    def test_detail_supports_options_and_head(self):
        category = self.create_category()
        self.client.force_login(self.user)
        url = self.detail_url(category)

        self.assertEqual(self.client.options(url).status_code, status.HTTP_200_OK)
        self.assertEqual(self.client.head(url).status_code, status.HTTP_200_OK)
