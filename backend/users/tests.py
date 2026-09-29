from datetime import timedelta

from axes.models import AccessAttempt, AccessAttemptExpiration
from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase


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
