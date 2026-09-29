from datetime import date, timedelta
from decimal import Decimal

from axes.models import AccessAttempt, AccessAttemptExpiration
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from accounts.models import Account, AccountType
from budgets.models import MonthlyBudget
from categories.models import Category, CategoryType
from plaid_integration.models import PlaidConnection
from transactions.models import Transaction, TransactionSource, TransactionType


class UserManagerTests(TestCase):
    def test_create_user_creates_regular_user_with_hashed_password(self):
        user = get_user_model().objects.create_user(
            email="Person@EXAMPLE.COM",
            password="test-password",
        )

        self.assertEqual(user.email, "Person@example.com")
        self.assertTrue(user.check_password("test-password"))
        self.assertNotEqual(user.password, "test-password")
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)

    def test_create_user_rejects_missing_email(self):
        with self.assertRaisesMessage(ValueError, "Users must have an email address"):
            get_user_model().objects.create_user(
                email="",
                password="test-password",
            )

    def test_create_superuser_sets_admin_flags(self):
        user = get_user_model().objects.create_superuser(
            email="admin@example.com",
            password="test-password",
        )

        self.assertTrue(user.is_staff)
        self.assertTrue(user.is_superuser)
        self.assertTrue(user.check_password("test-password"))

    def test_create_superuser_rejects_non_staff_user(self):
        with self.assertRaisesMessage(ValueError, "Superuser must have is_staff=True."):
            get_user_model().objects.create_superuser(
                email="admin@example.com",
                password="test-password",
                is_staff=False,
            )

    def test_create_superuser_rejects_non_superuser(self):
        with self.assertRaisesMessage(
            ValueError, "Superuser must have is_superuser=True."
        ):
            get_user_model().objects.create_superuser(
                email="admin@example.com",
                password="test-password",
                is_superuser=False,
            )


class RegistrationAPITests(APITestCase):
    def test_register_creates_user_and_returns_public_profile(self):
        password = "StrongTestPassword123!"

        response = self.client.post(
            reverse("auth-register"),
            {
                "email": "new-user@example.com",
                "password": password,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        self.assertEqual(
            response.data,
            {
                "id": response.data["id"],
                "email": "new-user@example.com",
            },
        )
        user = get_user_model().objects.get(email="new-user@example.com")
        self.assertTrue(user.check_password(password))
        self.assertNotEqual(user.password, password)

    def test_register_rejects_weak_password_without_creating_user(self):
        response = self.client.post(
            reverse("auth-register"),
            {
                "email": "new-user@example.com",
                "password": "password",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("password", response.data)
        self.assertFalse(get_user_model().objects.exists())

    def test_register_rejects_invalid_email_without_creating_user(self):
        response = self.client.post(
            reverse("auth-register"),
            {
                "email": "not-an-email",
                "password": "StrongTestPassword123!",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("email", response.data)
        self.assertFalse(get_user_model().objects.exists())

    def test_register_rejects_duplicate_email(self):
        get_user_model().objects.create_user(
            email="existing@example.com",
            password="ExistingTestPassword123!",
        )

        response = self.client.post(
            reverse("auth-register"),
            {
                "email": "existing@example.com",
                "password": "AnotherStrongPassword123!",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("email", response.data)
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_register_rejects_missing_required_fields(self):
        for payload, missing_field in (
            ({"password": "StrongTestPassword123!"}, "email"),
            ({"email": "new-user@example.com"}, "password"),
        ):
            with self.subTest(missing_field=missing_field):
                response = self.client.post(
                    reverse("auth-register"),
                    payload,
                    format="json",
                )

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(missing_field, response.data)

        self.assertFalse(get_user_model().objects.exists())

    def test_register_does_not_allow_admin_privilege_escalation(self):
        response = self.client.post(
            reverse("auth-register"),
            {
                "email": "new-user@example.com",
                "password": "StrongTestPassword123!",
                "is_staff": True,
                "is_superuser": True,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        user = get_user_model().objects.get(email="new-user@example.com")
        self.assertFalse(user.is_staff)
        self.assertFalse(user.is_superuser)
        self.assertNotIn("is_staff", response.data)
        self.assertNotIn("is_superuser", response.data)

    def test_register_rejects_unsupported_method(self):
        response = self.client.get(reverse("auth-register"))

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertFalse(get_user_model().objects.exists())

    def test_register_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)

        response = csrf_client.post(
            reverse("auth-register"),
            {
                "email": "new-user@example.com",
                "password": "StrongTestPassword123!",
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertFalse(get_user_model().objects.exists())
        self.assertNotIn("_auth_user_id", csrf_client.session)

    def test_csrf_cookie_allows_registration_without_creating_session(self):
        csrf_client = APIClient(enforce_csrf_checks=True)

        csrf_response = csrf_client.get(reverse("auth-csrf"))

        self.assertEqual(csrf_response.status_code, status.HTTP_200_OK)
        csrf_token = csrf_response.cookies["csrftoken"].value

        response = csrf_client.post(
            reverse("auth-register"),
            {
                "email": "new-user@example.com",
                "password": "StrongTestPassword123!",
            },
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        user = get_user_model().objects.get(email="new-user@example.com")
        self.assertTrue(user.check_password("StrongTestPassword123!"))
        self.assertNotIn("_auth_user_id", csrf_client.session)


class CsrfCookieAPITests(APITestCase):
    def test_csrf_cookie_rejects_unsupported_method(self):
        response = self.client.post(reverse("auth-csrf"))

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)


class LoginAPITests(APITestCase):
    def setUp(self):
        self.password = "StrongTestPassword123!"
        self.user = get_user_model().objects.create_user(
            email="user@example.com",
            password=self.password,
        )

    def test_login_creates_session_and_returns_public_profile(self):
        response = self.client.post(
            reverse("auth-login"),
            {
                "email": self.user.email,
                "password": self.password,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data,
            {
                "id": self.user.id,
                "email": self.user.email,
            },
        )
        self.assertEqual(
            int(self.client.session["_auth_user_id"]),
            self.user.id,
        )
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_login_rejects_invalid_credentials_without_revealing_which_failed(self):
        invalid_credentials = (
            {
                "email": "missing@example.com",
                "password": self.password,
            },
            {
                "email": self.user.email,
                "password": "WrongTestPassword123!",
            },
        )

        for payload in invalid_credentials:
            with self.subTest(email=payload["email"]):
                response = self.client.post(
                    reverse("auth-login"),
                    payload,
                    format="json",
                )

                self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
                self.assertEqual(
                    response.data,
                    {"detail": "Invalid email or password."},
                )
                self.assertNotIn("_auth_user_id", self.client.session)

    def test_login_rejects_invalid_or_missing_fields(self):
        invalid_payloads = (
            ({"email": "not-an-email", "password": self.password}, "email"),
            ({"password": self.password}, "email"),
            ({"email": self.user.email}, "password"),
        )

        for payload, field in invalid_payloads:
            with self.subTest(field=field, payload=payload):
                response = self.client.post(
                    reverse("auth-login"),
                    payload,
                    format="json",
                )

                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
                self.assertIn(field, response.data)
                self.assertNotIn("_auth_user_id", self.client.session)

    def test_login_rejects_inactive_user(self):
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])

        response = self.client.post(
            reverse("auth-login"),
            {
                "email": self.user.email,
                "password": self.password,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(response.data, {"detail": "Invalid email or password."})
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_login_rejects_unsupported_method(self):
        response = self.client.get(reverse("auth-login"))

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_login_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)

        response = csrf_client.post(
            reverse("auth-login"),
            {
                "email": self.user.email,
                "password": self.password,
            },
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertNotIn("_auth_user_id", csrf_client.session)

    def test_csrf_cookie_allows_login(self):
        csrf_client = APIClient(enforce_csrf_checks=True)

        csrf_response = csrf_client.get(reverse("auth-csrf"))

        self.assertEqual(csrf_response.status_code, status.HTTP_200_OK)
        csrf_token = csrf_response.cookies["csrftoken"].value

        login_response = csrf_client.post(
            reverse("auth-login"),
            {
                "email": self.user.email,
                "password": self.password,
            },
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(login_response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            int(csrf_client.session["_auth_user_id"]),
            self.user.id,
        )


class LoginLockoutAPITests(APITestCase):
    lockout_detail = "Too many failed login attempts. Try again later."

    def setUp(self):
        self.password = "StrongTestPassword123!"
        self.lockout_url = reverse("auth-login")
        self.user = get_user_model().objects.create_user(
            email="user@example.com",
            password=self.password,
        )

    def _login(self, email, password, ip=None):
        extra = {}
        if ip is not None:
            extra["HTTP_CF_CONNECTING_IP"] = ip
        return self.client.post(
            self.lockout_url,
            {"email": email, "password": password},
            format="json",
            **extra,
        )

    def _fail_login(self, email, times=5, ip=None):
        response = None
        for _ in range(times):
            response = self._login(email, "WrongTestPassword123!", ip=ip)
        return response

    def test_login_locks_out_username_and_ip_after_five_failures(self):
        cases = (
            (self.user.email, self.password),
            ("missing@example.com", self.password),
        )

        for email, correct_password in cases:
            with self.subTest(email=email):
                for _ in range(5):
                    failed = self._login(email, "WrongTestPassword123!")
                self.assertEqual(
                    failed.status_code,
                    status.HTTP_429_TOO_MANY_REQUESTS,
                )

                locked = self._login(email, correct_password)
                self.assertEqual(
                    locked.status_code,
                    status.HTTP_429_TOO_MANY_REQUESTS,
                )
                self.assertEqual(locked.json(), {"detail": self.lockout_detail})
                self.assertNotIn("_auth_user_id", self.client.session)

    def test_other_username_from_same_ip_is_not_locked(self):
        other = get_user_model().objects.create_user(
            email="other@example.com",
            password="OtherStrongPassword123!",
        )
        self._fail_login(self.user.email)

        response = self._login(other.email, "OtherStrongPassword123!")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(int(self.client.session["_auth_user_id"]), other.id)

    def test_same_username_from_other_ip_is_not_locked(self):
        self._fail_login(self.user.email, ip="203.0.113.10")

        response = self._login(self.user.email, self.password, ip="198.51.100.20")

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.user.id)

    def test_untrusted_forwarded_for_does_not_change_client_ip(self):
        self.client.post(
            self.lockout_url,
            {"email": self.user.email, "password": "WrongTestPassword123!"},
            format="json",
            HTTP_X_FORWARDED_FOR="203.0.113.10",
        )

        attempt = AccessAttempt.objects.get(username=self.user.email)
        self.assertEqual(attempt.ip_address, "127.0.0.1")

    def test_success_before_threshold_resets_failures(self):
        self._fail_login(self.user.email, times=4)

        success = self._login(self.user.email, self.password)
        self.assertEqual(success.status_code, status.HTTP_200_OK)

        after_reset = self._login(self.user.email, "WrongTestPassword123!")
        self.assertEqual(after_reset.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_lockout_expires_after_cooldown(self):
        self._fail_login(self.user.email)
        locked = self._login(self.user.email, self.password)
        self.assertEqual(locked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)

        aged = timezone.now() - timedelta(minutes=16)
        AccessAttempt.objects.update(attempt_time=aged)
        AccessAttemptExpiration.objects.update(expires_at=aged)

        recovered = self._login(self.user.email, self.password)
        self.assertEqual(recovered.status_code, status.HTTP_200_OK)
        self.assertEqual(int(self.client.session["_auth_user_id"]), self.user.id)

    def test_lockout_does_not_bypass_csrf(self):
        self._fail_login(self.user.email)
        csrf_client = APIClient(enforce_csrf_checks=True)

        response = csrf_client.post(
            self.lockout_url,
            {"email": self.user.email, "password": self.password},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})

    def test_admin_login_is_locked_out_too(self):
        self.user.is_staff = True
        self.user.is_superuser = True
        self.user.save(update_fields=["is_staff", "is_superuser"])
        admin_url = reverse("admin:login")

        response = self.client.post(
            admin_url,
            {"username": self.user.email, "password": "WrongTestPassword123!"},
        )
        for _ in range(4):
            response = self.client.post(
                admin_url,
                {"username": self.user.email, "password": "WrongTestPassword123!"},
            )
        self.assertEqual(response.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        attempt = AccessAttempt.objects.get(username=self.user.email)
        self.assertNotIn("WrongTestPassword123!", attempt.post_data)

        locked = self.client.post(
            admin_url,
            {"username": self.user.email, "password": self.password},
        )
        self.assertEqual(locked.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_admin_and_api_share_failed_attempts(self):
        self.user.is_staff = True
        self.user.save(update_fields=["is_staff"])
        self._fail_login(self.user.email, times=4)

        response = self.client.post(
            reverse("admin:login"),
            {"username": self.user.email, "password": "WrongTestPassword123!"},
        )

        self.assertEqual(response.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
        self.assertEqual(
            self._login(self.user.email, self.password).status_code,
            status.HTTP_429_TOO_MANY_REQUESTS,
        )

    def test_failed_login_does_not_store_password(self):
        self._fail_login(self.user.email)

        attempts = list(AccessAttempt.objects.all())
        self.assertTrue(attempts)
        for attempt in attempts:
            self.assertNotIn("WrongTestPassword123!", attempt.post_data)
            self.assertNotIn(self.password, attempt.post_data)
            self.assertNotIn(self.password, attempt.get_data)


class LogoutAPITests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="user@example.com",
            password="StrongTestPassword123!",
        )

    def test_logout_ends_session(self):
        self.client.force_login(self.user)
        self.assertEqual(
            int(self.client.session["_auth_user_id"]),
            self.user.id,
        )

        response = self.client.post(reverse("auth-logout"))

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(response.content, b"")
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_logout_rejects_unauthenticated_request(self):
        response = self.client.post(reverse("auth-logout"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_logout_requires_csrf_token(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        response = csrf_client.post(reverse("auth-logout"))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        self.assertEqual(
            int(csrf_client.session["_auth_user_id"]),
            self.user.id,
        )

    def test_csrf_token_allows_logout(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        csrf_response = csrf_client.get(reverse("auth-csrf"))
        csrf_token = csrf_response.cookies["csrftoken"].value

        response = csrf_client.post(
            reverse("auth-logout"),
            HTTP_X_CSRFTOKEN=csrf_token,
        )

        self.assertEqual(response.status_code, status.HTTP_204_NO_CONTENT)
        self.assertEqual(response.content, b"")
        self.assertNotIn("_auth_user_id", csrf_client.session)

    def test_logout_rejects_unsupported_method(self):
        self.client.force_login(self.user)

        response = self.client.get(reverse("auth-logout"))

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)


class CurrentUserAPITests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="current@example.com",
            password="StrongTestPassword123!",
        )
        self.other_user = get_user_model().objects.create_user(
            email="other@example.com",
            password="AnotherStrongPassword123!",
        )

    def test_me_returns_authenticated_users_public_profile(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        user_count = get_user_model().objects.count()

        response = csrf_client.get(reverse("auth-me"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            response.data,
            {
                "id": self.user.id,
                "email": self.user.email,
            },
        )
        self.assertNotIn("password", response.data)
        self.assertNotIn("is_staff", response.data)
        self.assertNotIn("is_superuser", response.data)
        self.assertNotIn(self.other_user.email, response.data.values())
        self.assertEqual(get_user_model().objects.count(), user_count)

    def test_me_rejects_unauthenticated_request(self):
        response = self.client.get(reverse("auth-me"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_me_rejects_inactive_user(self):
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self.client.force_login(self.user)

        response = self.client.get(reverse("auth-me"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )

    def test_me_rejects_unsupported_method(self):
        self.client.force_login(self.user)
        user_count = get_user_model().objects.count()

        response = self.client.post(reverse("auth-me"))

        self.assertEqual(response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED)
        self.assertEqual(get_user_model().objects.count(), user_count)


class DataExportAPITests(APITestCase):
    """Contract for the read-only owner-data download at ``/api/auth/export/``."""

    PASSWORD = "TestOnlyPassword123!"

    TOP_LEVEL_KEYS = {
        "schema_version",
        "accounts",
        "categories",
        "transactions",
        "monthly_budgets",
    }
    ACCOUNT_KEYS = {
        "id",
        "name",
        "account_type",
        "opening_balance",
        "is_archived",
        "created_at",
        "updated_at",
    }
    CATEGORY_KEYS = {
        "id",
        "name",
        "category_type",
        "is_archived",
        "created_at",
        "updated_at",
    }
    TRANSACTION_KEYS = {
        "id",
        "account_id",
        "category_id",
        "transaction_type",
        "amount",
        "date",
        "note",
        "source",
        "is_pending",
        "is_provider_removed",
        "is_superseded",
        "superseded_by_id",
        "category_customized",
        "note_customized",
        "is_transfer",
        "created_at",
        "updated_at",
    }
    BUDGET_KEYS = {
        "id",
        "category_id",
        "month",
        "amount",
        "created_at",
        "updated_at",
    }
    FORBIDDEN_KEYS = {
        "user",
        "user_id",
        "connection",
        "connection_id",
        "item_id",
        "plaid_transaction_id",
        "plaid_pending_transaction_id",
        "provider_name",
        "password",
        "access_token_encrypted",
        "encryption_key_id",
        "session",
    }

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="export-owner@example.com",
            password=self.PASSWORD,
        )
        self.other_user = get_user_model().objects.create_user(
            email="export-other@example.com",
            password=self.PASSWORD,
        )
        self.other_account = Account.objects.create(
            user=self.other_user,
            name="Their Private Account",
            account_type=AccountType.CHECKING,
            opening_balance=Decimal("42.42"),
        )
        self.other_category = Category.objects.create(
            user=self.other_user,
            name="Their Private Category",
            category_type=CategoryType.EXPENSE,
        )
        self.other_transaction = Transaction.objects.create(
            user=self.other_user,
            account=self.other_account,
            category=self.other_category,
            transaction_type=TransactionType.EXPENSE,
            amount=Decimal("13.13"),
            date=date(2026, 9, 2),
            note="their private note",
        )
        self.other_budget = MonthlyBudget.objects.create(
            user=self.other_user,
            category=self.other_category,
            month=date(2026, 9, 1),
            amount=Decimal("900.00"),
        )
        self.url = reverse("auth-export")
        self.client.force_login(self.user)

    def create_account(self, **overrides):
        values = {
            "user": self.user,
            "name": "Everyday Checking",
            "account_type": AccountType.CHECKING,
            "opening_balance": Decimal("100.00"),
        }
        values.update(overrides)
        return Account.objects.create(**values)

    def create_category(self, **overrides):
        values = {
            "user": self.user,
            "name": "Groceries",
            "category_type": CategoryType.EXPENSE,
        }
        values.update(overrides)
        return Category.objects.create(**values)

    def create_transaction(self, **overrides):
        values = {
            "user": self.user,
            "transaction_type": TransactionType.EXPENSE,
            "amount": Decimal("25.50"),
            "date": date(2026, 9, 1),
        }
        values.update(overrides)
        return Transaction.objects.create(**values)

    def create_connection(self, **overrides):
        values = {
            "user": self.user,
            "item_id": "item-sandbox-export-00001",
            "institution_name": "Export Bank",
        }
        values.update(overrides)
        return PlaidConnection.objects.create(**values)

    def fetch_export(self):
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        return response, response.json()

    def assert_only_allowlisted_keys(self, item, allowed_keys):
        self.assertEqual(set(item.keys()), allowed_keys)
        self.assertFalse(self.FORBIDDEN_KEYS & set(item.keys()))

    def test_export_for_user_without_records_returns_empty_collections(self):
        response, body = self.fetch_export()

        self.assertEqual(set(body.keys()), self.TOP_LEVEL_KEYS)
        self.assertEqual(body["schema_version"], 1)
        self.assertEqual(body["accounts"], [])
        self.assertEqual(body["categories"], [])
        self.assertEqual(body["transactions"], [])
        self.assertEqual(body["monthly_budgets"], [])
        self.assertEqual(response["Content-Type"], "application/json")

    def test_export_returns_exact_allowlisted_owned_payload(self):
        account = self.create_account()
        category = self.create_category()
        transaction = self.create_transaction(
            account=account,
            category=category,
            amount=Decimal("19.99"),
            date=date(2026, 9, 15),
            note="weekly shop",
        )
        budget = MonthlyBudget.objects.create(
            user=self.user,
            category=category,
            month=date(2026, 9, 1),
            amount=Decimal("300.00"),
        )

        _, body = self.fetch_export()

        self.assertEqual(
            body["accounts"],
            [
                {
                    "id": account.id,
                    "name": "Everyday Checking",
                    "account_type": "checking",
                    "opening_balance": "100.00",
                    "is_archived": False,
                    "created_at": account.created_at.isoformat(),
                    "updated_at": account.updated_at.isoformat(),
                }
            ],
        )
        self.assertEqual(
            body["categories"],
            [
                {
                    "id": category.id,
                    "name": "Groceries",
                    "category_type": "expense",
                    "is_archived": False,
                    "created_at": category.created_at.isoformat(),
                    "updated_at": category.updated_at.isoformat(),
                }
            ],
        )
        self.assertEqual(
            body["transactions"],
            [
                {
                    "id": transaction.id,
                    "account_id": account.id,
                    "category_id": category.id,
                    "transaction_type": "expense",
                    "amount": "19.99",
                    "date": "2026-09-15",
                    "note": "weekly shop",
                    "source": "manual",
                    "is_pending": False,
                    "is_provider_removed": False,
                    "is_superseded": False,
                    "superseded_by_id": None,
                    "category_customized": False,
                    "note_customized": False,
                    "is_transfer": False,
                    "created_at": transaction.created_at.isoformat(),
                    "updated_at": transaction.updated_at.isoformat(),
                }
            ],
        )
        self.assertEqual(
            body["monthly_budgets"],
            [
                {
                    "id": budget.id,
                    "category_id": category.id,
                    "month": "2026-09-01",
                    "amount": "300.00",
                    "created_at": budget.created_at.isoformat(),
                    "updated_at": budget.updated_at.isoformat(),
                }
            ],
        )
        self.assert_only_allowlisted_keys(body["accounts"][0], self.ACCOUNT_KEYS)
        self.assert_only_allowlisted_keys(body["categories"][0], self.CATEGORY_KEYS)
        self.assert_only_allowlisted_keys(
            body["transactions"][0], self.TRANSACTION_KEYS
        )
        self.assert_only_allowlisted_keys(body["monthly_budgets"][0], self.BUDGET_KEYS)

    def test_export_never_includes_another_users_rows(self):
        account = self.create_account()
        category = self.create_category()

        _, body = self.fetch_export()

        self.assertEqual([item["id"] for item in body["accounts"]], [account.id])
        self.assertEqual([item["id"] for item in body["categories"]], [category.id])
        self.assertEqual(body["transactions"], [])
        self.assertEqual(body["monthly_budgets"], [])
        exported_text = self.client.get(self.url).content.decode()
        for leaked in (
            self.other_account.name,
            self.other_category.name,
            self.other_transaction.note,
            self.other_user.email,
        ):
            self.assertNotIn(leaked, exported_text)

    def test_export_includes_archived_and_audit_state_rows(self):
        archived_account = self.create_account(
            name="Closed Savings",
            account_type=AccountType.SAVINGS,
            is_archived=True,
        )
        archived_category = self.create_category(
            name="Old Hobby",
            is_archived=True,
        )
        connection = self.create_connection()
        target = self.create_transaction(
            account=archived_account,
            category=archived_category,
            source=TransactionSource.PLAID,
            connection=connection,
            plaid_transaction_id="plaid-export-target",
            provider_name="Provider Target",
        )
        superseded = self.create_transaction(
            account=archived_account,
            category=archived_category,
            source=TransactionSource.PLAID,
            connection=connection,
            plaid_transaction_id="plaid-export-superseded",
            is_superseded=True,
            superseded_by=target,
        )
        pending = self.create_transaction(
            account=archived_account,
            category=archived_category,
            source=TransactionSource.PLAID,
            connection=connection,
            plaid_transaction_id="plaid-export-pending",
            is_pending=True,
            is_provider_removed=True,
            category_customized=True,
            note_customized=True,
        )

        _, body = self.fetch_export()

        accounts = {item["id"]: item for item in body["accounts"]}
        categories = {item["id"]: item for item in body["categories"]}
        transactions = {item["id"]: item for item in body["transactions"]}
        self.assertTrue(accounts[archived_account.id]["is_archived"])
        self.assertTrue(categories[archived_category.id]["is_archived"])
        self.assertIn(target.id, transactions)
        self.assertIn(superseded.id, transactions)
        self.assertEqual(transactions[superseded.id]["superseded_by_id"], target.id)
        self.assertTrue(transactions[pending.id]["is_pending"])
        self.assertTrue(transactions[pending.id]["is_provider_removed"])
        self.assertTrue(transactions[pending.id]["category_customized"])
        self.assertTrue(transactions[pending.id]["note_customized"])

    def test_export_sanitizes_malformed_cross_user_relations(self):
        own_account = self.create_account()
        own_category = self.create_category()
        foreign_account_transaction = self.create_transaction(
            account=self.other_account,
            category=own_category,
            amount=Decimal("5.00"),
            date=date(2026, 9, 3),
        )
        foreign_category_transaction = self.create_transaction(
            account=own_account,
            category=self.other_category,
            amount=Decimal("6.00"),
            date=date(2026, 9, 4),
        )
        foreign_budget = MonthlyBudget.objects.create(
            user=self.user,
            category=self.other_category,
            month=date(2026, 9, 1),
            amount=Decimal("400.00"),
        )

        response, body = self.fetch_export()

        transactions = {item["id"]: item for item in body["transactions"]}
        self.assertIsNone(transactions[foreign_account_transaction.id]["account_id"])
        self.assertEqual(
            transactions[foreign_account_transaction.id]["category_id"],
            own_category.id,
        )
        self.assertEqual(
            transactions[foreign_category_transaction.id]["account_id"],
            own_account.id,
        )
        self.assertIsNone(transactions[foreign_category_transaction.id]["category_id"])
        self.assertIsNone(body["monthly_budgets"][0]["category_id"])
        self.assertEqual(body["monthly_budgets"][0]["id"], foreign_budget.id)

        exported_relationship_ids = (
            {item["account_id"] for item in body["transactions"]}
            | {item["category_id"] for item in body["transactions"]}
            | {item["category_id"] for item in body["monthly_budgets"]}
        )
        exported_relationship_ids.discard(None)
        self.assertNotIn(self.other_account.id, exported_relationship_ids)
        self.assertNotIn(self.other_category.id, exported_relationship_ids)
        exported_text = response.content.decode()
        self.assertNotIn(self.other_account.name, exported_text)
        self.assertNotIn(self.other_category.name, exported_text)

    def test_export_sanitizes_cross_user_superseded_by_relation(self):
        superseding = self.create_transaction(
            account=self.create_account(),
            category=self.create_category(
                name="Salary",
                category_type=CategoryType.INCOME,
            ),
            transaction_type=TransactionType.INCOME,
            source=TransactionSource.PLAID,
            connection=self.create_connection(),
            plaid_transaction_id="plaid-export-cross-user-superseded",
            is_superseded=True,
            superseded_by=self.other_transaction,
        )

        response, body = self.fetch_export()

        transactions = {item["id"]: item for item in body["transactions"]}
        self.assertIn(superseding.id, transactions)
        self.assertIsNone(transactions[superseding.id]["superseded_by_id"])
        self.assertNotIn(
            self.other_transaction.id,
            [item["id"] for item in body["transactions"]],
        )
        self.assertNotIn(
            self.other_transaction.id,
            {item["superseded_by_id"] for item in body["transactions"]},
        )
        self.assertNotIn(self.other_transaction.note, response.content.decode())

    def test_export_exposes_no_provider_or_authentication_material(self):
        connection = self.create_connection(
            item_id="item-sandbox-secret-sentinel",
            access_token_encrypted="sentinel-access-token-ciphertext",
            encryption_key_id="sentinel-key-id",
        )
        self.create_transaction(
            account=self.create_account(),
            category=self.create_category(
                name="Salary",
                category_type=CategoryType.INCOME,
            ),
            transaction_type=TransactionType.INCOME,
            amount=Decimal("1.00"),
            date=date(2026, 9, 5),
            source=TransactionSource.PLAID,
            connection=connection,
            plaid_transaction_id="sentinel-plaid-transaction-id",
            plaid_pending_transaction_id="sentinel-plaid-pending-id",
            provider_name="Sentinel Merchant",
            is_pending=True,
        )

        response, body = self.fetch_export()

        exported_text = response.content.decode()
        for secret in (
            "sentinel-access-token-ciphertext",
            "sentinel-key-id",
            "sentinel-plaid-transaction-id",
            "sentinel-plaid-pending-id",
            "Sentinel Merchant",
            "item-sandbox-secret-sentinel",
            "export-owner@example.com",
            self.PASSWORD,
            self.user.password,
        ):
            self.assertNotIn(secret, exported_text)
        for collection in (
            body["accounts"],
            body["categories"],
            body["transactions"],
            body["monthly_budgets"],
        ):
            for item in collection:
                self.assertFalse(self.FORBIDDEN_KEYS & set(item.keys()))

    def test_export_orders_collections_stably_by_id(self):
        first_account = self.create_account(name="First Account")
        second_account = self.create_account(name="Second Account")
        first_category = self.create_category(name="First Category")
        second_category = self.create_category(name="Second Category")
        first_transaction = self.create_transaction(
            account=second_account,
            category=second_category,
            date=date(2026, 9, 20),
        )
        second_transaction = self.create_transaction(
            account=first_account,
            category=first_category,
            date=date(2026, 9, 10),
        )
        first_budget = MonthlyBudget.objects.create(
            user=self.user,
            category=first_category,
            month=date(2026, 11, 1),
            amount=Decimal("100.00"),
        )
        second_budget = MonthlyBudget.objects.create(
            user=self.user,
            category=second_category,
            month=date(2026, 10, 1),
            amount=Decimal("200.00"),
        )

        _, body = self.fetch_export()

        self.assertEqual(
            [item["id"] for item in body["accounts"]],
            [first_account.id, second_account.id],
        )
        self.assertEqual(
            [item["id"] for item in body["categories"]],
            [first_category.id, second_category.id],
        )
        self.assertEqual(
            [item["id"] for item in body["transactions"]],
            [first_transaction.id, second_transaction.id],
        )
        self.assertEqual(
            [item["id"] for item in body["monthly_budgets"]],
            [first_budget.id, second_budget.id],
        )

    def test_export_sets_download_headers_and_no_store(self):
        response, _ = self.fetch_export()

        self.assertTrue(response["Content-Disposition"].startswith("attachment;"))
        self.assertIn("filename=", response["Content-Disposition"])
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_export_rejects_unauthenticated_request(self):
        self.client.logout()
        counts_before = (
            Account.objects.count(),
            Category.objects.count(),
            Transaction.objects.count(),
            MonthlyBudget.objects.count(),
        )

        response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        self.assertEqual(
            (
                Account.objects.count(),
                Category.objects.count(),
                Transaction.objects.count(),
                MonthlyBudget.objects.count(),
            ),
            counts_before,
        )

    def test_export_rejects_unsupported_methods(self):
        counts_before = (
            Account.objects.count(),
            Category.objects.count(),
            Transaction.objects.count(),
            MonthlyBudget.objects.count(),
        )

        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(self.url)
                self.assertEqual(
                    response.status_code,
                    status.HTTP_405_METHOD_NOT_ALLOWED,
                )

        self.assertEqual(
            (
                Account.objects.count(),
                Category.objects.count(),
                Transaction.objects.count(),
                MonthlyBudget.objects.count(),
            ),
            counts_before,
        )

    def test_export_performs_no_database_writes(self):
        account = self.create_account()
        category = self.create_category()
        self.create_transaction(account=account, category=category)
        MonthlyBudget.objects.create(
            user=self.user,
            category=category,
            month=date(2026, 9, 1),
            amount=Decimal("100.00"),
        )
        counts_before = (
            Account.objects.count(),
            Category.objects.count(),
            Transaction.objects.count(),
            MonthlyBudget.objects.count(),
        )

        with CaptureQueriesContext(connection) as captured:
            response = self.client.get(self.url)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        write_prefixes = {"INSERT", "UPDATE", "DELETE"}
        writes = [
            query["sql"]
            for query in captured.captured_queries
            if query["sql"].strip()
            and query["sql"].lstrip().split(None, 1)[0].upper() in write_prefixes
        ]
        self.assertEqual(writes, [])
        self.assertEqual(
            (
                Account.objects.count(),
                Category.objects.count(),
                Transaction.objects.count(),
                MonthlyBudget.objects.count(),
            ),
            counts_before,
        )
