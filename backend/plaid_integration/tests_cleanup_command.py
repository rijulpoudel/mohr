"""Tests for the ``cleanup_plaid_state`` management command (issue #39 slice C).

Covers the bounded per-kind batch limits, the retention boundary, expired or
consumed exchange-handle purging, the above-cap processed-row eviction, the
never-delete guarantees for unprocessed matched rows and active handles,
CommandError batch validation before any mutation, and the counts-only
redacted output.
"""

from datetime import timedelta
from io import StringIO
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from plaid_integration.management.commands.cleanup_plaid_state import Command
from plaid_integration.models import (
    PlaidConnection,
    PlaidExchangeHandle,
    PlaidWebhookEvent,
)
from plaid_integration.services import persist_verified_webhook
from plaid_integration.webhook_verification import VerifiedWebhookClaims

RETENTION_DAYS = 30


def key_for(index):
    return f"{index:064d}"


class CleanupCommandBase(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="cleanup-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.connection = PlaidConnection.objects.create(
            user=self.user,
            item_id="item-cleanup-00001",
            institution_name="Cleanup Bank",
        )
        self.frozen = timezone.now().replace(microsecond=0)

    def webhook(self, idempotency_key, *, received_at, processed_at=None):
        return PlaidWebhookEvent.objects.create(
            connection=self.connection,
            user=self.user,
            webhook_type="TRANSACTIONS",
            webhook_code="SYNC_UPDATES_AVAILABLE",
            item_id=self.connection.item_id,
            idempotency_key=idempotency_key,
            received_at=received_at,
            processed_at=processed_at,
        )

    def quarantine_webhook(self, idempotency_key, *, received_at, processed_at):
        return PlaidWebhookEvent.objects.create(
            connection=None,
            user=None,
            webhook_type="UNKNOWN",
            webhook_code="UNKNOWN",
            item_id="UNKNOWN",
            idempotency_key=idempotency_key,
            received_at=received_at,
            processed_at=processed_at,
        )

    def handle(self, digest, *, expires_at, consumed_at=None):
        return PlaidExchangeHandle.objects.create(
            user=self.user,
            digest=digest,
            expires_at=expires_at,
            consumed_at=consumed_at,
        )

    def run_cleanup(self, *args):
        out = StringIO()
        with patch("django.utils.timezone.now", return_value=self.frozen):
            call_command("cleanup_plaid_state", *args, stdout=out)
        return out.getvalue()


class CleanupRetentionTests(CleanupCommandBase):
    def test_deletes_at_most_batch_size_oldest_processed_rows_older_than_retention(
        self,
    ):
        oldest = self.webhook(
            key_for(1),
            received_at=self.frozen - timedelta(days=40),
            processed_at=self.frozen - timedelta(days=40),
        )
        middle = self.webhook(
            key_for(2),
            received_at=self.frozen - timedelta(days=39),
            processed_at=self.frozen - timedelta(days=39),
        )
        third = self.webhook(
            key_for(3),
            received_at=self.frozen - timedelta(days=38),
            processed_at=self.frozen - timedelta(days=38),
        )
        recent = self.webhook(
            key_for(4),
            received_at=self.frozen - timedelta(days=1),
            processed_at=self.frozen - timedelta(days=1),
        )

        output = self.run_cleanup("--batch-size", "2")

        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=oldest.pk).exists())
        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=middle.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=third.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=recent.pk).exists())
        self.assertEqual(
            output.strip(), "Deleted 2 webhook event(s) and 0 exchange handle(s)."
        )

    def test_retention_boundary_row_at_cutoff_is_retained(self):
        boundary = self.webhook(
            key_for(1),
            received_at=self.frozen - timedelta(days=RETENTION_DAYS),
            processed_at=self.frozen - timedelta(days=RETENTION_DAYS),
        )
        older = self.webhook(
            key_for(2),
            received_at=self.frozen - timedelta(days=RETENTION_DAYS, seconds=1),
            processed_at=self.frozen - timedelta(days=RETENTION_DAYS, seconds=1),
        )

        self.run_cleanup("--batch-size", "500")

        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=boundary.pk).exists())
        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=older.pk).exists())

    def test_quarantine_rows_follow_the_same_retention_rule(self):
        old = self.quarantine_webhook(
            key_for(1),
            received_at=self.frozen - timedelta(days=31),
            processed_at=self.frozen - timedelta(days=31),
        )
        fresh = self.quarantine_webhook(
            key_for(2),
            received_at=self.frozen - timedelta(days=1),
            processed_at=self.frozen - timedelta(days=1),
        )

        self.run_cleanup("--batch-size", "500")

        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=old.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=fresh.pk).exists())

    def test_unprocessed_matched_rows_are_never_deleted_by_retention(self):
        unprocessed = self.webhook(
            key_for(1),
            received_at=self.frozen - timedelta(days=60),
        )

        self.run_cleanup("--batch-size", "500")

        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=unprocessed.pk).exists())

    def test_accepted_matched_event_is_deleted_after_retention_expires(self):
        claims = VerifiedWebhookClaims(
            kid="synthetic-kid",
            iat=1,
            idempotency_key=key_for(2),
        )
        with patch(
            "django.utils.timezone.now",
            return_value=self.frozen - timedelta(days=40),
        ):
            persist_verified_webhook(
                self.connection,
                claims,
                webhook_type="TRANSACTIONS",
                webhook_code="SYNC_UPDATES_AVAILABLE",
                initial_update_complete=False,
                historical_update_complete=False,
            )
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.processed_at, event.received_at)
        self.assertIsNotNone(event.processed_at)

        self.run_cleanup("--batch-size", "500")

        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=event.pk).exists())


class CleanupHandleTests(CleanupCommandBase):
    def test_deletes_only_expired_or_consumed_handles_and_keeps_active(self):
        active = self.handle(
            key_for(1),
            expires_at=self.frozen + timedelta(days=1),
        )
        expired = self.handle(
            key_for(2),
            expires_at=self.frozen - timedelta(minutes=1),
        )
        expired_boundary = self.handle(
            key_for(3),
            expires_at=self.frozen,
        )
        consumed = self.handle(
            key_for(4),
            expires_at=self.frozen + timedelta(days=1),
            consumed_at=self.frozen - timedelta(minutes=1),
        )

        self.run_cleanup("--batch-size", "500")

        self.assertTrue(PlaidExchangeHandle.objects.filter(pk=active.pk).exists())
        self.assertFalse(PlaidExchangeHandle.objects.filter(pk=expired.pk).exists())
        self.assertFalse(
            PlaidExchangeHandle.objects.filter(pk=expired_boundary.pk).exists()
        )
        self.assertFalse(PlaidExchangeHandle.objects.filter(pk=consumed.pk).exists())


class CleanupBatchTests(CleanupCommandBase):
    def test_per_kind_batch_limit_is_independent(self):
        events = [
            self.webhook(
                key_for(index),
                received_at=self.frozen - timedelta(days=40, minutes=index),
                processed_at=self.frozen - timedelta(days=40, minutes=index),
            )
            for index in range(3)
        ]
        handles = [
            self.handle(
                key_for(10 + index),
                expires_at=self.frozen - timedelta(minutes=1, seconds=index),
            )
            for index in range(3)
        ]

        output = self.run_cleanup("--batch-size", "2")

        remaining_events = [
            row
            for row in events
            if PlaidWebhookEvent.objects.filter(pk=row.pk).exists()
        ]
        remaining_handles = [
            row
            for row in handles
            if PlaidExchangeHandle.objects.filter(pk=row.pk).exists()
        ]
        self.assertEqual(len(remaining_events), 1)
        self.assertEqual(len(remaining_handles), 1)
        self.assertEqual(
            output.strip(), "Deleted 2 webhook event(s) and 2 exchange handle(s)."
        )

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=3)
    def test_above_cap_eviction_deletes_oldest_processed_rows_only(self):
        first = self.webhook(
            key_for(1),
            received_at=self.frozen - timedelta(days=1, minutes=3),
            processed_at=self.frozen - timedelta(days=1, minutes=3),
        )
        second = self.webhook(
            key_for(2),
            received_at=self.frozen - timedelta(days=1, minutes=2),
            processed_at=self.frozen - timedelta(days=1, minutes=2),
        )
        third = self.webhook(
            key_for(3),
            received_at=self.frozen - timedelta(days=1, minutes=1),
            processed_at=self.frozen - timedelta(days=1, minutes=1),
        )
        fourth = self.webhook(
            key_for(4),
            received_at=self.frozen - timedelta(days=1),
            processed_at=self.frozen - timedelta(days=1),
        )
        unprocessed = self.webhook(
            key_for(5),
            received_at=self.frozen - timedelta(days=1),
        )

        output = self.run_cleanup("--batch-size", "2")

        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=first.pk).exists())
        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=second.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=third.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=fourth.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=unprocessed.pk).exists())
        self.assertEqual(PlaidWebhookEvent.objects.count(), 3)
        self.assertEqual(
            output.strip(), "Deleted 2 webhook event(s) and 0 exchange handle(s)."
        )

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=1)
    def test_above_cap_eviction_never_deletes_unprocessed_rows(self):
        first = self.webhook(key_for(1), received_at=self.frozen - timedelta(days=1))
        second = self.webhook(key_for(2), received_at=self.frozen - timedelta(days=1))
        unprocessed_quarantine = PlaidWebhookEvent.objects.create(
            connection=None,
            user=None,
            webhook_type="UNKNOWN",
            webhook_code="UNKNOWN",
            item_id="UNKNOWN",
            idempotency_key=key_for(3),
            received_at=self.frozen - timedelta(days=1),
        )

        self.run_cleanup("--batch-size", "2")

        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=first.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=second.pk).exists())
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(pk=unprocessed_quarantine.pk).exists()
        )
        self.assertEqual(PlaidWebhookEvent.objects.count(), 3)

    def test_invalid_and_out_of_range_batch_sizes_raise_before_mutation(self):
        deletable_event = self.webhook(
            key_for(1),
            received_at=self.frozen - timedelta(days=40),
            processed_at=self.frozen - timedelta(days=40),
        )
        deletable_handle = self.handle(
            key_for(2),
            expires_at=self.frozen - timedelta(minutes=1),
        )

        for value in ("0", "-1", "5001", "abc"):
            with self.subTest(value=value):
                with self.assertRaises(CommandError):
                    call_command("cleanup_plaid_state", "--batch-size", value)

        self.assertTrue(
            PlaidWebhookEvent.objects.filter(pk=deletable_event.pk).exists()
        )
        self.assertTrue(
            PlaidExchangeHandle.objects.filter(pk=deletable_handle.pk).exists()
        )

    def test_default_batch_size_is_500_with_upper_bound_5000(self):
        parser = Command().create_parser("manage.py", "cleanup_plaid_state")
        options = parser.parse_args([])
        self.assertEqual(options.batch_size, 500)
        options = parser.parse_args(["--batch-size", "5000"])
        self.assertEqual(options.batch_size, 5000)


class CleanupOutputTests(CleanupCommandBase):
    def test_output_is_counts_only_and_redacts_all_identifiers(self):
        marker_item_id = "item-output-secret-00001"
        marker_digest = "e" * 64
        marker_connection = PlaidConnection.objects.create(
            user=self.user,
            item_id=marker_item_id,
            institution_name="Marker Bank",
        )
        PlaidWebhookEvent.objects.create(
            connection=marker_connection,
            user=self.user,
            webhook_type="TRANSACTIONS",
            webhook_code="SYNC_UPDATES_AVAILABLE",
            item_id=marker_item_id,
            idempotency_key=key_for(1),
            received_at=self.frozen - timedelta(days=40),
            processed_at=self.frozen - timedelta(days=40),
        )
        self.handle(marker_digest, expires_at=self.frozen - timedelta(minutes=1))

        output = self.run_cleanup("--batch-size", "500")

        self.assertNotIn(marker_item_id, output)
        self.assertNotIn(marker_digest, output)
        self.assertNotIn(key_for(1), output)
        self.assertNotIn(self.connection.item_id, output)
        self.assertEqual(
            output.strip(), "Deleted 1 webhook event(s) and 1 exchange handle(s)."
        )

    def test_empty_invocation_prints_zero_counts(self):
        output = self.run_cleanup("--batch-size", "500")

        self.assertEqual(
            output.strip(), "Deleted 0 webhook event(s) and 0 exchange handle(s)."
        )
