"""Tests for the bounded Plaid item-removal retry driver.

Covers issue #39 slice D3 ``process_plaid_item_removals``: due pending rows
are claimed with one conditional update before any network call, removed on
success, rescheduled with exponential backoff on provider failure, failed
after ``ITEM_REMOVAL_MAX_ATTEMPTS``, failed immediately when undecryptable,
bounded by batch size, always through the row's own moved ciphertext, and
returning counts only. Also covers the ``process_plaid_removals`` management
command boundary. Only synthetic credentials are used; no network.
"""

import logging
from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from cryptography.fernet import Fernet
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from plaid_integration.gateway import PLAID_UNAVAILABLE_DETAIL, PlaidGatewayError
from plaid_integration.management.commands.process_plaid_removals import Command
from plaid_integration.models import PlaidConnection, PlaidItemRemovalRequest
from plaid_integration.services import (
    ITEM_REMOVAL_BACKOFF_BASE,
    ITEM_REMOVAL_BACKOFF_CAP,
    ITEM_REMOVAL_FAILED_DETAIL,
    ITEM_REMOVAL_MAX_ATTEMPTS,
    process_plaid_item_removals,
)
from plaid_integration.token_encryption import TokenKeyRing

from .tests_connection_disconnect import (
    SYNTHETIC_ACCESS_TOKEN,
    FakeRemovalApi,
    gateway_for,
)

_TEST_KEY = Fernet.generate_key().decode()
SYNTHETIC_RING = TokenKeyRing([("key-a", _TEST_KEY)])
_OTHER_KEY = Fernet.generate_key().decode()
_OTHER_RING = TokenKeyRing([("key-b", _OTHER_KEY)])

PLAID_API_SETTINGS = {
    "PLAID_ENABLED": True,
    "PLAID_ENV": "sandbox",
    "PLAID_CLIENT_ID": "client-id-test",
    "PLAID_SECRET": "secret-test",
    "PLAID_TOKEN_RING": SYNTHETIC_RING,
}


def _encrypt(token):
    package, _ = SYNTHETIC_RING.encrypt(token.encode())
    return package


@override_settings(**PLAID_API_SETTINGS)
class ItemRemovalRetryTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="removal-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-removal-00001",
            institution_name="Removal Bank",
            access_token_encrypted=None,
            encryption_key_id=None,
        )
        self.now = timezone.now().replace(microsecond=0)

    def make_row(self, token=SYNTHETIC_ACCESS_TOKEN, ring=SYNTHETIC_RING, **overrides):
        if token is None:
            package = "key-a:not-a-fernet-token"
            key_id = "key-a"
        else:
            package, key_id = ring.encrypt(token.encode())
        values = {
            "connection": self.connection,
            "access_token_encrypted": package,
            "encryption_key_id": key_id,
            "status": "pending",
            "attempts": 0,
            "next_retry_at": self.now - timedelta(minutes=1),
        }
        values.update(overrides)
        return PlaidItemRemovalRequest.objects.create(**values)

    def patched(self, fake_api):
        return patch(
            "plaid_integration.services.PlaidGateway.from_settings",
            return_value=gateway_for(fake_api),
        )

    def test_due_pending_row_removed_on_success_row_deleted(self):
        row = self.make_row()
        fake_api = FakeRemovalApi()

        with self.patched(fake_api):
            result = process_plaid_item_removals(10, now=self.now)

        self.assertEqual(
            (result.removed, result.retried, result.failed, result.skipped),
            (1, 0, 0, 0),
        )
        self.assertEqual(len(fake_api.calls), 1)
        request, _ = fake_api.calls[0]
        self.assertEqual(request.access_token, SYNTHETIC_ACCESS_TOKEN)
        self.assertFalse(PlaidItemRemovalRequest.objects.filter(pk=row.pk).exists())

    def test_not_yet_due_row_is_skipped_untouched(self):
        row = self.make_row(next_retry_at=self.now + timedelta(hours=2))
        fake_api = FakeRemovalApi()

        with self.patched(fake_api):
            result = process_plaid_item_removals(10, now=self.now)

        self.assertEqual(fake_api.calls, [])
        row.refresh_from_db()
        self.assertEqual(row.status, "pending")
        self.assertEqual(row.attempts, 0)
        self.assertEqual((result.removed, result.retried, result.failed), (0, 0, 0))

    def test_lost_claim_race_counts_skipped_and_touches_nothing(self):
        row = self.make_row()
        fake_api = FakeRemovalApi()

        def losing_claim(*args, **kwargs):
            # Simulate the concurrent winner: the conditional claim UPDATE
            # matched zero rows (the row was already claimed or failed by
            # another process), so this driver must count skipped only.
            return 0

        with (
            patch("django.db.models.query.QuerySet.update", side_effect=losing_claim),
            patch.object(
                SYNTHETIC_RING, "decrypt", wraps=SYNTHETIC_RING.decrypt
            ) as decrypt_spy,
            self.patched(fake_api),
        ):
            result = process_plaid_item_removals(10, now=self.now)

        self.assertEqual(
            (result.removed, result.retried, result.failed, result.skipped),
            (0, 0, 0, 1),
        )
        decrypt_spy.assert_not_called()
        self.assertEqual(fake_api.calls, [])
        row.refresh_from_db()
        self.assertEqual(row.status, "pending")
        self.assertEqual(row.attempts, 0)
        self.assertIsNone(row.last_attempt_at)
        self.assertEqual(row.last_error, "")
        self.assertEqual(row.next_retry_at, self.now - timedelta(minutes=1))

    def test_failure_schedules_exponential_backoff_and_increments(self):
        row = self.make_row()
        fake_api = FakeRemovalApi(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))

        with self.patched(fake_api):
            result = process_plaid_item_removals(10, now=self.now)

        self.assertEqual((result.removed, result.retried, result.failed), (0, 1, 0))
        row.refresh_from_db()
        self.assertEqual(row.status, "pending")
        self.assertEqual(row.attempts, 1)
        self.assertEqual(row.last_error, ITEM_REMOVAL_FAILED_DETAIL)
        expected = self.now + min(
            ITEM_REMOVAL_BACKOFF_BASE * (2**0), ITEM_REMOVAL_BACKOFF_CAP
        )
        self.assertEqual(row.next_retry_at, expected)
        self.assertIsNotNone(row.last_attempt_at)

    def test_backoff_grows_and_caps(self):
        row = self.make_row(attempts=3)
        fake_api = FakeRemovalApi(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))
        with self.patched(fake_api):
            process_plaid_item_removals(10, now=self.now)
        row.refresh_from_db()
        expected = self.now + min(
            ITEM_REMOVAL_BACKOFF_BASE * (2**3), ITEM_REMOVAL_BACKOFF_CAP
        )
        self.assertEqual(row.next_retry_at, expected)
        # Cap: attempts large enough that base * 2**attempts exceeds cap.
        row.attempts = 10
        row.next_retry_at = self.now - timedelta(minutes=1)
        row.status = "pending"
        row.save(update_fields=["attempts", "next_retry_at", "status"])
        with self.patched(
            FakeRemovalApi(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))
        ):
            process_plaid_item_removals(10, now=self.now)
        row.refresh_from_db()
        self.assertLessEqual(row.next_retry_at, self.now + ITEM_REMOVAL_BACKOFF_CAP)

    def test_reaching_max_attempts_sets_failed_and_stops(self):
        row = self.make_row(attempts=ITEM_REMOVAL_MAX_ATTEMPTS - 1)
        fake_api = FakeRemovalApi(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))

        with self.patched(fake_api):
            result = process_plaid_item_removals(10, now=self.now)

        self.assertEqual((result.removed, result.retried, result.failed), (0, 0, 1))
        row.refresh_from_db()
        self.assertEqual(row.status, "failed")
        self.assertEqual(row.attempts, ITEM_REMOVAL_MAX_ATTEMPTS)
        self.assertEqual(row.last_error, ITEM_REMOVAL_FAILED_DETAIL)
        # A failed row is never retried again.
        fake_api2 = FakeRemovalApi()
        with self.patched(fake_api2):
            result2 = process_plaid_item_removals(10, now=self.now + timedelta(days=2))
        self.assertEqual(fake_api2.calls, [])
        self.assertEqual((result2.removed, result2.retried, result2.failed), (0, 0, 0))

    def test_batch_size_bounds_the_work(self):
        for index in range(3):
            connection = PlaidConnection.objects.create(
                user=self.user,
                item_id=f"item-sandbox-removal-batch-{index}",
                institution_name="Batch Bank",
            )
            package, key_id = SYNTHETIC_RING.encrypt(SYNTHETIC_ACCESS_TOKEN.encode())
            PlaidItemRemovalRequest.objects.create(
                connection=connection,
                access_token_encrypted=package,
                encryption_key_id=key_id,
                status="pending",
                next_retry_at=self.now - timedelta(minutes=1),
            )
        fake_api = FakeRemovalApi()

        with self.patched(fake_api):
            result = process_plaid_item_removals(2, now=self.now)

        self.assertEqual(result.removed, 2)
        self.assertEqual(len(fake_api.calls), 2)
        self.assertEqual(PlaidItemRemovalRequest.objects.count(), 1)

    def test_undecryptable_package_fails_immediately(self):
        row = self.make_row(token=None)
        fake_api = FakeRemovalApi()

        with self.patched(fake_api):
            result = process_plaid_item_removals(10, now=self.now)

        self.assertEqual((result.removed, result.retried, result.failed), (0, 0, 1))
        self.assertEqual(fake_api.calls, [])
        row.refresh_from_db()
        self.assertEqual(row.status, "failed")
        self.assertEqual(row.last_error, ITEM_REMOVAL_FAILED_DETAIL)

    def test_driver_never_removes_fresh_token_only_moved_ciphertext(self):
        moved_token = "access-sandbox-moved-0000000000000001"
        fresh_token = "access-sandbox-fresh-0000000000000002"
        moved_package, moved_key = SYNTHETIC_RING.encrypt(moved_token.encode())
        fresh_package, fresh_key = SYNTHETIC_RING.encrypt(fresh_token.encode())
        self.connection.access_token_encrypted = fresh_package
        self.connection.encryption_key_id = fresh_key
        self.connection.save(
            update_fields=["access_token_encrypted", "encryption_key_id"]
        )
        PlaidItemRemovalRequest.objects.create(
            connection=self.connection,
            access_token_encrypted=moved_package,
            encryption_key_id=moved_key,
            status="pending",
            next_retry_at=self.now - timedelta(minutes=1),
        )
        fake_api = FakeRemovalApi()

        with self.patched(fake_api):
            result = process_plaid_item_removals(10, now=self.now)

        self.assertEqual(result.removed, 1)
        self.assertEqual(len(fake_api.calls), 1)
        request, _ = fake_api.calls[0]
        self.assertEqual(request.access_token, moved_token)
        self.assertNotEqual(request.access_token, fresh_token)
        # The fresh token on the connection is untouched.
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.access_token_encrypted, fresh_package)

    def test_one_bad_row_never_aborts_batch(self):
        bad = self.make_row(token=None)
        connection2 = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-removal-good-00001",
            institution_name="Good Bank",
        )
        package, key_id = SYNTHETIC_RING.encrypt(SYNTHETIC_ACCESS_TOKEN.encode())
        good = PlaidItemRemovalRequest.objects.create(
            connection=connection2,
            access_token_encrypted=package,
            encryption_key_id=key_id,
            status="pending",
            next_retry_at=self.now - timedelta(minutes=1),
        )
        fake_api = FakeRemovalApi()

        with self.patched(fake_api):
            result = process_plaid_item_removals(10, now=self.now)

        self.assertEqual((result.removed, result.failed), (1, 1))
        self.assertFalse(PlaidItemRemovalRequest.objects.filter(pk=good.pk).exists())
        bad.refresh_from_db()
        self.assertEqual(bad.status, "failed")

    def test_counts_only_result_and_no_token_in_logs(self):
        self.make_row()
        fake_api = FakeRemovalApi()
        with self.patched(fake_api):
            with self.assertNoLogs("plaid_integration.services", level=logging.INFO):
                result = process_plaid_item_removals(10, now=self.now)
        self.assertEqual(
            set(vars(result).keys()), {"removed", "retried", "failed", "skipped"}
        )
        self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, repr(result))

    def test_max_attempts_constant_is_five(self):
        self.assertEqual(ITEM_REMOVAL_MAX_ATTEMPTS, 5)
        self.assertEqual(ITEM_REMOVAL_BACKOFF_BASE, timedelta(hours=1))
        self.assertEqual(ITEM_REMOVAL_BACKOFF_CAP, timedelta(hours=24))


@override_settings(**PLAID_API_SETTINGS)
class ProcessRemovalsCommandTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="removal-cmd-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-sandbox-removal-cmd-00001",
            institution_name="Cmd Bank",
            access_token_encrypted=None,
            encryption_key_id=None,
        )

    def run_command(self, *args):
        out = StringIO()
        call_command("process_plaid_removals", *args, stdout=out)
        return out.getvalue()

    def test_default_batch_size_is_500_with_upper_bound_5000(self):
        parser = Command().create_parser("manage.py", "process_plaid_removals")
        options = parser.parse_args([])
        self.assertEqual(options.batch_size, 500)
        options = parser.parse_args(["--batch-size", "5000"])
        self.assertEqual(options.batch_size, 5000)

    def test_invalid_batch_sizes_raise_before_mutation(self):
        for value in ("0", "-1", "5001", "abc"):
            with self.subTest(value=value):
                with self.assertRaises(CommandError):
                    call_command("process_plaid_removals", "--batch-size", value)

    def test_output_is_counts_only(self):
        package, key_id = SYNTHETIC_RING.encrypt(SYNTHETIC_ACCESS_TOKEN.encode())
        PlaidItemRemovalRequest.objects.create(
            connection=self.connection,
            access_token_encrypted=package,
            encryption_key_id=key_id,
            status="pending",
            next_retry_at=timezone.now() - timedelta(minutes=1),
        )
        output = self.run_command("--batch-size", "500")
        self.assertNotIn(SYNTHETIC_ACCESS_TOKEN, output)
        self.assertNotIn(package, output)
        self.assertIn("Removed", output)
