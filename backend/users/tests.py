from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APITestCase


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
