"""Tests for the bounded webhook inbox and poison quarantine (issue #39 slice C).

Covers the bounded global inbox cap enforced inside the same transaction that
inserts an event, the eviction priority (oldest processed rows first, then
oldest quarantine rows, never an unprocessed matched row), the fixed
repr-safe ``WebhookInboxFull`` fail-closed path, the minimized quarantine
shape for verified but malformed deliveries, duplicate poison handling, and
the endpoint's fixed 200 quarantine and 503 inbox-full responses. Small caps
and explicit timestamps keep every boundary deterministic; the verification
gateway is injected so no network call is ever made.
"""

import hashlib
import json
import logging
import time
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import IntegrityError
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APITestCase

from plaid_integration.models import PlaidConnection, PlaidWebhookEvent
from plaid_integration.services import (
    QUARANTINE_UNKNOWN_ITEM_ID,
    QUARANTINE_UNKNOWN_WEBHOOK_CODE,
    QUARANTINE_UNKNOWN_WEBHOOK_TYPE,
    WebhookDuplicateEvent,
    WebhookInboxFull,
    persist_verified_webhook,
    quarantine_verified_webhook,
)
from plaid_integration.tests_webhook_endpoint import (
    ITEM_ID,
    WEBHOOK_RECEIVED_RESPONSE,
    patched_gateway,
    signed_header,
    webhook_body,
)
from plaid_integration.tests_webhook_verification import SYNTHETIC_KID
from plaid_integration.views import WEBHOOK_INBOX_FULL_DETAIL
from plaid_integration.webhook_verification import (
    VerifiedWebhookClaims,
    reset_webhook_key_cache,
)

NOW = timezone.now()
BODY_MARKER = "QUARANTINE-BODY-MARKER"
HASH_MARKER = "a" * 64


def key_for(index):
    return f"{index:064d}"


class WebhookInboxBase(APITestCase):
    def setUp(self):
        cache.clear()
        reset_webhook_key_cache()
        self.user = get_user_model().objects.create_user(
            email="inbox-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.connection = PlaidConnection.objects.create(
            user=self.user,
            item_id=ITEM_ID,
            institution_name="Inbox Bank",
        )
        self.url = reverse("plaid-webhook-transactions")

    def tearDown(self):
        cache.clear()
        reset_webhook_key_cache()

    def claims(self, idempotency_key):
        return VerifiedWebhookClaims(
            kid=SYNTHETIC_KID,
            iat=int(time.time()),
            idempotency_key=idempotency_key,
        )

    def matched_event(self, idempotency_key, *, received_at, processed_at=None):
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

    def quarantine_event(self, idempotency_key, *, received_at, processed=False):
        return PlaidWebhookEvent.objects.create(
            connection=None,
            user=None,
            webhook_type=QUARANTINE_UNKNOWN_WEBHOOK_TYPE,
            webhook_code=QUARANTINE_UNKNOWN_WEBHOOK_CODE,
            item_id=QUARANTINE_UNKNOWN_ITEM_ID,
            idempotency_key=idempotency_key,
            received_at=received_at,
            processed_at=received_at if processed else None,
        )

    def persist(self, idempotency_key):
        return persist_verified_webhook(
            self.connection,
            self.claims(idempotency_key),
            webhook_type="TRANSACTIONS",
            webhook_code="SYNC_UPDATES_AVAILABLE",
            initial_update_complete=False,
            historical_update_complete=False,
        )

    def post_webhook(self, body, *, header=None):
        return self.client.post(
            self.url,
            data=body,
            content_type="application/json",
            HTTP_PLAID_VERIFICATION=header,
        )


class WebhookInboxCapTests(WebhookInboxBase):
    @override_settings(PLAID_WEBHOOK_INBOX_CAP=2)
    def test_exact_cap_boundary_insert_fits_without_eviction(self):
        existing = self.matched_event(
            key_for(1),
            received_at=NOW - timedelta(hours=2),
            processed_at=NOW - timedelta(hours=1),
        )

        self.persist(key_for(2))

        self.assertEqual(PlaidWebhookEvent.objects.count(), 2)
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=existing.pk).exists())

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=2)
    def test_insert_above_cap_evicts_oldest_processed_row_only(self):
        oldest = self.matched_event(
            key_for(1),
            received_at=NOW - timedelta(hours=3),
            processed_at=NOW - timedelta(hours=3),
        )
        newer = self.matched_event(
            key_for(2),
            received_at=NOW - timedelta(hours=2),
            processed_at=NOW - timedelta(hours=2),
        )

        self.persist(key_for(3))

        self.assertEqual(PlaidWebhookEvent.objects.count(), 2)
        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=oldest.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=newer.pk).exists())
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(3)).exists()
        )

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=3)
    def test_eviction_priority_processed_then_quarantine_never_unprocessed_matched(
        self,
    ):
        unprocessed_matched = self.matched_event(
            key_for(1),
            received_at=NOW - timedelta(hours=4),
        )
        processed = self.matched_event(
            key_for(2),
            received_at=NOW - timedelta(hours=3),
            processed_at=NOW - timedelta(hours=3),
        )
        unprocessed_quarantine = self.quarantine_event(
            key_for(3),
            received_at=NOW - timedelta(hours=2),
        )

        self.persist(key_for(4))

        self.assertEqual(PlaidWebhookEvent.objects.count(), 3)
        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=processed.pk).exists())
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(pk=unprocessed_matched.pk).exists()
        )
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(pk=unprocessed_quarantine.pk).exists()
        )

        self.persist(key_for(5))

        self.assertEqual(PlaidWebhookEvent.objects.count(), 3)
        # The accepted insert is itself processed, so it is the legal eviction
        # target before any legacy unprocessed matched or quarantine row.
        self.assertFalse(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(4)).exists()
        )
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(5)).exists()
        )
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(pk=unprocessed_matched.pk).exists()
        )
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(pk=unprocessed_quarantine.pk).exists()
        )

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=2)
    def test_full_cap_of_unprocessed_matched_raises_and_rolls_back_everything(self):
        first = self.matched_event(key_for(1), received_at=NOW - timedelta(hours=2))
        second = self.matched_event(key_for(2), received_at=NOW - timedelta(hours=1))

        with self.assertRaises(WebhookInboxFull) as caught:
            self.persist(key_for(3))

        self.assertEqual(PlaidWebhookEvent.objects.count(), 2)
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=first.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=second.pk).exists())
        self.assertFalse(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(3)).exists()
        )
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)
        self.assertIsNone(self.connection.transactions_update_status)
        self.assertEqual(self.connection.last_sync_error, "")
        self.assertIsNone(caught.exception.__cause__)
        self.assertNotIn(ITEM_ID, repr(caught.exception))
        self.assertNotIn(key_for(3), repr(caught.exception))
        self.assertNotIn("item", repr(caught.exception))

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=3)
    def test_cap_never_exceeded_after_successful_service_return(self):
        for index in range(3):
            for offset in range(3):
                self.matched_event(
                    key_for(index * 10 + offset),
                    received_at=timezone.now() - timedelta(hours=1),
                    processed_at=timezone.now() - timedelta(hours=1),
                )
            self.persist(key_for(100 + index))
            self.assertLessEqual(PlaidWebhookEvent.objects.count(), 3)
            self.assertTrue(
                PlaidWebhookEvent.objects.filter(
                    idempotency_key=key_for(100 + index)
                ).exists()
            )

        # A full cap of accepted (processed) events never blocks a later one:
        # the newest insert evicts the oldest processed row instead of 503.
        self.persist(key_for(103))
        self.assertEqual(PlaidWebhookEvent.objects.count(), 3)
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(103)).exists()
        )

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=1)
    def test_recognized_insert_is_never_self_evicted(self):
        oldest = self.matched_event(
            key_for(1),
            received_at=NOW - timedelta(hours=2),
            processed_at=NOW - timedelta(hours=2),
        )

        self.persist(key_for(2))

        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=oldest.pk).exists())
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.idempotency_key, key_for(2))
        self.assertEqual(event.processed_at, event.received_at)

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=2)
    def test_later_accepted_event_evicts_oldest_accepted_instead_of_503(self):
        self.persist(key_for(1))
        self.persist(key_for(2))

        self.persist(key_for(3))

        self.assertEqual(PlaidWebhookEvent.objects.count(), 2)
        self.assertFalse(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(1)).exists()
        )
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(2)).exists()
        )
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(3)).exists()
        )

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=2)
    def test_duplicate_at_cap_evicts_nothing_and_mutates_nothing(self):
        duplicate = self.matched_event(
            key_for(1),
            received_at=NOW - timedelta(hours=2),
        )
        processed = self.matched_event(
            key_for(2),
            received_at=NOW - timedelta(hours=1),
            processed_at=NOW - timedelta(hours=1),
        )

        with self.assertRaises(WebhookDuplicateEvent):
            self.persist(key_for(1))

        self.assertEqual(PlaidWebhookEvent.objects.count(), 2)
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=duplicate.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=processed.pk).exists())
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)
        self.assertIsNone(self.connection.transactions_update_status)


class WebhookQuarantineServiceTests(WebhookInboxBase):
    def test_quarantine_persists_only_minimized_safe_fields(self):
        stored = quarantine_verified_webhook(
            self.claims(key_for(1)),
            webhook_type=QUARANTINE_UNKNOWN_WEBHOOK_TYPE,
            webhook_code=QUARANTINE_UNKNOWN_WEBHOOK_CODE,
            item_id=QUARANTINE_UNKNOWN_ITEM_ID,
        )

        self.assertTrue(stored)
        event = PlaidWebhookEvent.objects.get()
        self.assertIsNone(event.connection_id)
        self.assertIsNone(event.user_id)
        self.assertEqual(event.webhook_type, QUARANTINE_UNKNOWN_WEBHOOK_TYPE)
        self.assertEqual(event.webhook_code, QUARANTINE_UNKNOWN_WEBHOOK_CODE)
        self.assertEqual(event.item_id, QUARANTINE_UNKNOWN_ITEM_ID)
        self.assertEqual(event.idempotency_key, key_for(1))
        self.assertEqual(event.processed_at, event.received_at)
        self.assertIsNotNone(event.received_at)
        self.assertFalse(event.initial_update_complete)
        self.assertFalse(event.historical_update_complete)
        self.assertFalse(hasattr(event, "raw_body"))
        self.assertFalse(hasattr(event, "body"))

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=2)
    def test_duplicate_quarantine_is_translated_and_evicts_nothing(self):
        processed = self.matched_event(
            key_for(1),
            received_at=NOW - timedelta(hours=2),
            processed_at=NOW - timedelta(hours=2),
        )
        stored = quarantine_verified_webhook(
            self.claims(key_for(2)),
            webhook_type=QUARANTINE_UNKNOWN_WEBHOOK_TYPE,
            webhook_code=QUARANTINE_UNKNOWN_WEBHOOK_CODE,
            item_id=QUARANTINE_UNKNOWN_ITEM_ID,
        )
        self.assertTrue(stored)

        with self.assertRaises(WebhookDuplicateEvent):
            quarantine_verified_webhook(
                self.claims(key_for(2)),
                webhook_type=QUARANTINE_UNKNOWN_WEBHOOK_TYPE,
                webhook_code=QUARANTINE_UNKNOWN_WEBHOOK_CODE,
                item_id=QUARANTINE_UNKNOWN_ITEM_ID,
            )

        self.assertEqual(PlaidWebhookEvent.objects.count(), 2)
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=processed.pk).exists())
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(2)).exists()
        )

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=2)
    def test_quarantine_dropped_when_cap_is_only_unprocessed_matched(self):
        first = self.matched_event(key_for(1), received_at=NOW - timedelta(hours=2))
        second = self.matched_event(key_for(2), received_at=NOW - timedelta(hours=1))

        stored = quarantine_verified_webhook(
            self.claims(key_for(3)),
            webhook_type=QUARANTINE_UNKNOWN_WEBHOOK_TYPE,
            webhook_code=QUARANTINE_UNKNOWN_WEBHOOK_CODE,
            item_id=QUARANTINE_UNKNOWN_ITEM_ID,
        )

        self.assertFalse(stored)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 2)
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=first.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=second.pk).exists())
        self.assertFalse(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(3)).exists()
        )

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=2)
    def test_quarantine_evicts_oldest_processed_row_but_never_itself(self):
        oldest = self.matched_event(
            key_for(1),
            received_at=NOW - timedelta(hours=2),
            processed_at=NOW - timedelta(hours=2),
        )
        newer = self.matched_event(
            key_for(2),
            received_at=NOW - timedelta(hours=1),
            processed_at=NOW - timedelta(hours=1),
        )

        stored = quarantine_verified_webhook(
            self.claims(key_for(3)),
            webhook_type=QUARANTINE_UNKNOWN_WEBHOOK_TYPE,
            webhook_code=QUARANTINE_UNKNOWN_WEBHOOK_CODE,
            item_id=QUARANTINE_UNKNOWN_ITEM_ID,
        )

        self.assertTrue(stored)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 2)
        self.assertFalse(PlaidWebhookEvent.objects.filter(pk=oldest.pk).exists())
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=newer.pk).exists())
        self.assertTrue(
            PlaidWebhookEvent.objects.filter(idempotency_key=key_for(3)).exists()
        )

    def test_unrelated_integrity_error_propagates(self):
        def unrelated_save(*args, **kwargs):
            class Diag:
                constraint_name = "plaid_webhook_event_connection_user_null_pair"

            cause = IntegrityError("synthetic provider cause")
            cause.diag = Diag()
            raise IntegrityError("unrelated constraint") from cause

        with patch.object(
            PlaidWebhookEvent.objects, "create", side_effect=unrelated_save
        ):
            with self.assertRaises(IntegrityError):
                quarantine_verified_webhook(
                    self.claims(key_for(1)),
                    webhook_type=QUARANTINE_UNKNOWN_WEBHOOK_TYPE,
                    webhook_code=QUARANTINE_UNKNOWN_WEBHOOK_CODE,
                    item_id=QUARANTINE_UNKNOWN_ITEM_ID,
                )

        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)


class WebhookEndpointQuarantineTests(WebhookInboxBase):
    def test_malformed_json_is_quarantined_with_fixed_200(self):
        body = b"{not json"
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        event = PlaidWebhookEvent.objects.get()
        self.assertIsNone(event.connection_id)
        self.assertIsNone(event.user_id)
        self.assertEqual(event.webhook_type, QUARANTINE_UNKNOWN_WEBHOOK_TYPE)
        self.assertEqual(event.webhook_code, QUARANTINE_UNKNOWN_WEBHOOK_CODE)
        self.assertEqual(event.item_id, QUARANTINE_UNKNOWN_ITEM_ID)
        self.assertEqual(event.idempotency_key, hashlib.sha256(body).hexdigest())
        self.assertEqual(event.processed_at, event.received_at)
        self.assertFalse(event.initial_update_complete)
        self.assertFalse(event.historical_update_complete)

    def test_non_utf8_body_is_quarantined(self):
        body = b"\xff\xfe\x00 not utf-8"
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.item_id, QUARANTINE_UNKNOWN_ITEM_ID)
        self.assertEqual(event.idempotency_key, hashlib.sha256(body).hexdigest())

    def test_json_scalars_and_arrays_are_quarantined(self):
        for value in ([1, 2], "text", 42, True, None):
            with self.subTest(value=value):
                PlaidWebhookEvent.objects.all().delete()
                body = json.dumps(value).encode()
                header = signed_header(body)

                with patched_gateway():
                    response = self.post_webhook(body, header=header)

                self.assertEqual(response.status_code, status.HTTP_200_OK)
                event = PlaidWebhookEvent.objects.get()
                self.assertEqual(event.webhook_type, QUARANTINE_UNKNOWN_WEBHOOK_TYPE)
                self.assertEqual(event.webhook_code, QUARANTINE_UNKNOWN_WEBHOOK_CODE)
                self.assertEqual(event.item_id, QUARANTINE_UNKNOWN_ITEM_ID)

    def test_valid_fields_are_kept_and_missing_or_invalid_use_sentinels(self):
        body = json.dumps(
            {
                "webhook_type": "TRANSACTIONS",
                "webhook_code": 123,
                "item_id": ITEM_ID,
            }
        ).encode()
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.webhook_type, "TRANSACTIONS")
        self.assertEqual(event.webhook_code, QUARANTINE_UNKNOWN_WEBHOOK_CODE)
        self.assertEqual(event.item_id, ITEM_ID)
        self.assertIsNone(event.connection_id)
        self.assertIsNone(event.user_id)

    def test_quarantine_response_and_logs_leak_no_body_or_digest(self):
        body = json.dumps(
            {
                "webhook_type": [BODY_MARKER],
                "webhook_code": "SYNC_UPDATES_AVAILABLE",
                "item_id": ITEM_ID,
            }
        ).encode()
        header = signed_header(body)

        with patched_gateway():
            with self.assertLogs(
                "plaid_integration", level=logging.WARNING
            ) as captured:
                response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        raw = response.content.decode()
        self.assertNotIn(BODY_MARKER, raw)
        self.assertNotIn(ITEM_ID, raw)
        log_text = "\n".join(captured.output)
        self.assertNotIn(BODY_MARKER, log_text)
        self.assertNotIn(ITEM_ID, log_text)
        self.assertNotIn(hashlib.sha256(body).hexdigest(), log_text)

    def test_duplicate_poison_returns_200_with_single_row_and_no_eviction(self):
        body = b"{not json"
        header = signed_header(body)

        with patched_gateway():
            first = self.post_webhook(body, header=header)
            second = self.post_webhook(body, header=header)

        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=1)
    def test_quarantine_drop_at_full_cap_still_returns_200(self):
        existing = self.matched_event(key_for(1), received_at=NOW - timedelta(hours=1))
        body = b"{not json"
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=existing.pk).exists())

    @override_settings(PLAID_WEBHOOK_INBOX_CAP=1)
    def test_full_cap_of_unprocessed_matched_returns_fixed_503_without_mutation(self):
        existing = self.matched_event(key_for(1), received_at=NOW - timedelta(hours=1))
        body = webhook_body()
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": WEBHOOK_INBOX_FULL_DETAIL})
        raw = response.content.decode()
        self.assertNotIn(ITEM_ID, raw)
        self.assertNotIn(hashlib.sha256(body).hexdigest(), raw)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=existing.pk).exists())
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)
        self.assertIsNone(self.connection.transactions_update_status)

    def test_endpoint_never_calls_perform_sync(self):
        body = webhook_body()
        header = signed_header(body)

        with (
            patched_gateway(),
            patch(
                "plaid_integration.views.perform_sync",
                side_effect=AssertionError("webhook endpoint must not sync"),
            ),
        ):
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
