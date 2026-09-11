from django.contrib.auth import get_user_model
from django.test import TestCase


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
