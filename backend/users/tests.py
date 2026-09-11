from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
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
