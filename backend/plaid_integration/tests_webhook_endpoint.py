"""Tests for the public verified webhook receiver (issue #39 slice B).

Covers the ``docs/plaid.md`` section 8 ``POST /api/plaid/webhooks/transactions/``
endpoint contract: verification-first ordering with zero queries on failure,
exact-raw-byte sensitivity, strict bounded payload validation, supported-code
persistence with the monotonic ``transactions_update_status`` advance,
idempotency-key duplicate translation, unknown/unmatched no-op deliveries, the
fixed safe responses that never reflect provider fields, method and
session/CSRF semantics, the per-source-IP rate limit, and the absence of any
ledger write or provider sync call. Real ES256 signatures are generated
in-process using the shared helpers from ``tests_webhook_verification``; the
verification gateway is injected so no network call is ever made.
"""

import hashlib
import json
import logging
import time
from unittest.mock import patch

from cryptography.hazmat.primitives.asymmetric import ec
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import IntegrityError
from django.test import override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from plaid_integration.gateway import PlaidGatewayError
from plaid_integration.models import (
    PlaidConnection,
    PlaidConnectionStatus,
    PlaidWebhookEvent,
    TransactionsUpdateStatus,
)
from plaid_integration.services import (
    WebhookDuplicateEvent,
    persist_verified_webhook,
)
from plaid_integration.tests_webhook_verification import (
    SYNTHETIC_KID,
    SYNTHETIC_PRIVATE_KEY,
    FakeKeyGateway,
    sign_webhook,
    webhook_key,
)
from plaid_integration.webhook_verification import (
    WEBHOOK_VERIFICATION_FAILED_DETAIL,
    VerifiedWebhookClaims,
    reset_webhook_key_cache,
)
from transactions.models import Transaction

ITEM_ID = "item-sandbox-webhook-endpoint-00001"
UNKNOWN_ITEM_ID = "item-sandbox-webhook-unknown-00001"
BODY_MARKER = "RAW-BODY-MARKER"
JWT_MARKER = "JWT-TOKEN-MARKER"

WEBHOOK_RECEIVED_RESPONSE = {"status": "ok"}


def webhook_body(**overrides):
    payload = {
        "webhook_type": "TRANSACTIONS",
        "webhook_code": "SYNC_UPDATES_AVAILABLE",
        "item_id": ITEM_ID,
    }
    payload.update(overrides)
    return json.dumps(payload).encode()


def signed_header(body, **kwargs):
    """Sign ``body`` with the synthetic key near the current time."""
    kwargs.setdefault("iat", int(time.time()))
    return sign_webhook(SYNTHETIC_PRIVATE_KEY, body, **kwargs)


def patched_gateway():
    return patch(
        "plaid_integration.views.PlaidGateway.from_settings",
        return_value=FakeKeyGateway(
            {SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)}
        ),
    )


def supported_event(connection, idempotency_key):
    return PlaidWebhookEvent.objects.create(
        connection=connection,
        user=connection.user,
        webhook_type="TRANSACTIONS",
        webhook_code="SYNC_UPDATES_AVAILABLE",
        item_id=connection.item_id,
        idempotency_key=idempotency_key,
        received_at=timezone.now(),
    )


class WebhookEndpointBase(APITestCase):
    def setUp(self):
        cache.clear()
        reset_webhook_key_cache()
        self.user = get_user_model().objects.create_user(
            email="webhook-endpoint-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.connection = PlaidConnection.objects.create(
            user=self.user,
            item_id=ITEM_ID,
            institution_name="Webhook Endpoint Bank",
        )
        self.url = reverse("plaid-webhook-transactions")

    def tearDown(self):
        cache.clear()
        reset_webhook_key_cache()

    def post_webhook(self, body, *, header=None, client=None, **extra):
        client = client if client is not None else self.client
        return client.post(
            self.url,
            data=body,
            content_type="application/json",
            HTTP_PLAID_VERIFICATION=header,
            **extra,
        )


class WebhookEndpointSuccessTests(WebhookEndpointBase):
    def test_supported_sync_updates_available_persists_event_and_flips_sync_due(
        self,
    ):
        body = webhook_body()
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.connection, self.connection)
        self.assertEqual(event.user, self.user)
        self.assertEqual(event.item_id, self.connection.item_id)
        self.assertEqual(event.webhook_type, "TRANSACTIONS")
        self.assertEqual(event.webhook_code, "SYNC_UPDATES_AVAILABLE")
        self.assertEqual(event.idempotency_key, hashlib.sha256(body).hexdigest())
        self.assertIsNotNone(event.received_at)
        self.assertIsNone(event.processed_at)
        self.assertFalse(event.initial_update_complete)
        self.assertFalse(event.historical_update_complete)
        self.connection.refresh_from_db()
        self.assertTrue(self.connection.sync_due)
        self.assertIsNone(self.connection.transactions_update_status)
        self.assertEqual(Transaction.objects.count(), 0)

    def test_supported_default_update_persists_event_and_flips_sync_due(self):
        body = webhook_body(webhook_code="DEFAULT_UPDATE")
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.webhook_code, "DEFAULT_UPDATE")
        self.connection.refresh_from_db()
        self.assertTrue(self.connection.sync_due)

    def test_initial_update_flag_advances_null_status_to_initial(self):
        body = webhook_body(initial_update_complete=True)
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        event = PlaidWebhookEvent.objects.get()
        self.assertTrue(event.initial_update_complete)
        self.assertFalse(event.historical_update_complete)
        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )

    def test_initial_update_flag_advances_not_ready_to_initial(self):
        self.connection.transactions_update_status = TransactionsUpdateStatus.NOT_READY
        self.connection.save(update_fields=["transactions_update_status"])
        body = webhook_body(initial_update_complete=True)
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )

    def test_historical_update_flag_advances_status_and_wins_over_initial(self):
        body = webhook_body(
            initial_update_complete=True,
            historical_update_complete=True,
        )
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        event = PlaidWebhookEvent.objects.get()
        self.assertTrue(event.initial_update_complete)
        self.assertTrue(event.historical_update_complete)
        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )

    def test_historical_status_never_regresses_on_later_initial_event(self):
        self.connection.transactions_update_status = (
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE
        )
        self.connection.save(update_fields=["transactions_update_status"])
        body = webhook_body(initial_update_complete=True)
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )

    def test_initial_status_does_not_regress_without_new_flags(self):
        self.connection.transactions_update_status = (
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE
        )
        self.connection.save(update_fields=["transactions_update_status"])
        body = webhook_body()
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )

    def test_accepted_webhook_writes_no_ledger_and_triggers_no_sync(self):
        body = webhook_body()
        header = signed_header(body)

        with patched_gateway() as gateway_class:
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(
            gateway_class.return_value.fetched_kids,
            [SYNTHETIC_KID],
        )
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertIsNone(self.connection.last_synced_at)
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertEqual(self.connection.last_sync_error, "")
        self.assertEqual(Transaction.objects.count(), 0)

    def test_accepted_response_and_event_reflect_no_parsed_or_body_data(self):
        body = webhook_body(ignored_provider_field=BODY_MARKER)
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        raw = response.content.decode()
        self.assertNotIn(BODY_MARKER, raw)
        self.assertNotIn(body.decode(), raw)
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.item_id, self.connection.item_id)
        self.assertFalse(hasattr(event, "raw_body"))
        self.assertFalse(hasattr(event, "body"))
        self.assertEqual(event.idempotency_key, hashlib.sha256(body).hexdigest())
        self.assertNotEqual(event.idempotency_key, body.decode())


class WebhookEndpointNoOpTests(WebhookEndpointBase):
    def test_unknown_webhook_type_returns_200_and_persists_nothing(self):
        body = webhook_body(webhook_type="INVESTMENTS")
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)

    def test_unknown_webhook_code_returns_200_and_persists_nothing(self):
        body = webhook_body(webhook_code="TRANSACTIONS_REMOVED")
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)

    def test_unknown_webhook_logs_only_bounded_type_and_code(self):
        body = webhook_body(
            webhook_type="INVESTMENTS",
            webhook_code="SOMETHING_ELSE",
            item_id=UNKNOWN_ITEM_ID,
        )
        header = signed_header(body)

        with patched_gateway():
            with self.assertLogs(
                "plaid_integration.views", level=logging.WARNING
            ) as captured:
                response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        log_text = "\n".join(captured.output)
        self.assertIn("INVESTMENTS", log_text)
        self.assertIn("SOMETHING_ELSE", log_text)
        self.assertNotIn(UNKNOWN_ITEM_ID, log_text)
        self.assertNotIn(body.decode(), log_text)

    def test_unmatched_item_returns_200_and_persists_nothing(self):
        body = webhook_body(item_id=UNKNOWN_ITEM_ID)
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.assertEqual(PlaidConnection.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)


class WebhookEndpointDuplicateTests(WebhookEndpointBase):
    def test_duplicate_exact_body_returns_200_single_row_and_connection_not_modified(
        self,
    ):
        body = webhook_body(historical_update_complete=True)
        header = signed_header(body)

        with patched_gateway():
            first = self.post_webhook(body, header=header)
            self.connection.refresh_from_db()
            updated_at_after_first = self.connection.updated_at
            second = self.post_webhook(body, header=header)

        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(second.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertTrue(self.connection.sync_due)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
        )
        self.assertEqual(self.connection.updated_at, updated_at_after_first)

    def test_duplicate_does_not_apply_incoming_flags_to_connection(self):
        body = webhook_body(historical_update_complete=True)
        header = signed_header(body)
        supported_event(self.connection, hashlib.sha256(body).hexdigest())

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)
        self.assertIsNone(self.connection.transactions_update_status)


class WebhookEndpointVerificationFailureTests(WebhookEndpointBase):
    def test_missing_header_returns_fixed_400_and_mutates_nothing(self):
        body = webhook_body()

        with patched_gateway():
            response = self.post_webhook(body)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.json(), {"detail": WEBHOOK_VERIFICATION_FAILED_DETAIL}
        )
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)

    def test_invalid_signature_returns_fixed_400_and_mutates_nothing(self):
        body = webhook_body()

        with patched_gateway():
            response = self.post_webhook(body, header="not-a-jwt")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.json(), {"detail": WEBHOOK_VERIFICATION_FAILED_DETAIL}
        )
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)

    def test_invalid_signature_performs_zero_database_queries(self):
        body = webhook_body()

        with patched_gateway():
            with self.assertNumQueries(0):
                response = self.post_webhook(body, header="not-a-jwt")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_tampered_raw_body_bytes_fail_verification_and_mutate_nothing(self):
        body = webhook_body()
        header = signed_header(body)
        tampered = body + b" "

        with patched_gateway():
            response = self.post_webhook(tampered, header=header)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.json(), {"detail": WEBHOOK_VERIFICATION_FAILED_DETAIL}
        )
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)

    def test_signature_failure_response_and_logs_leak_no_payload(self):
        other_key = ec.generate_private_key(ec.SECP256R1())
        body = f'{{"webhook_type":"{BODY_MARKER}"}}'.encode()
        header = sign_webhook(
            other_key,
            body,
            iat=int(time.time()),
            extra_claims={"marker": JWT_MARKER},
        )

        with patched_gateway():
            with self.assertLogs(
                "plaid_integration", level=logging.WARNING
            ) as captured:
                response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.json(), {"detail": WEBHOOK_VERIFICATION_FAILED_DETAIL}
        )
        raw = response.content.decode()
        self.assertNotIn(BODY_MARKER, raw)
        self.assertNotIn(JWT_MARKER, raw)
        self.assertNotIn(hashlib.sha256(body).hexdigest(), raw)
        log_text = "\n".join(captured.output)
        self.assertNotIn(BODY_MARKER, log_text)
        self.assertNotIn(JWT_MARKER, log_text)
        self.assertNotIn(hashlib.sha256(body).hexdigest(), log_text)

    def test_gateway_build_failure_returns_fixed_400_and_mutates_nothing(self):
        body = webhook_body()
        header = signed_header(body)

        with patch(
            "plaid_integration.views.PlaidGateway.from_settings",
            side_effect=PlaidGatewayError("synthetic provider failure"),
        ):
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(
            response.json(),
            {"detail": WEBHOOK_VERIFICATION_FAILED_DETAIL},
        )
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)


class WebhookEndpointPayloadValidationTests(WebhookEndpointBase):
    def assert_payload_quarantined(self, body):
        header = signed_header(body)
        with patched_gateway():
            response = self.post_webhook(body, header=header)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        event = PlaidWebhookEvent.objects.get()
        self.assertIsNone(event.connection)
        self.assertIsNone(event.user)
        self.assertEqual(event.idempotency_key, hashlib.sha256(body).hexdigest())
        self.assertEqual(event.processed_at, event.received_at)
        self.assertFalse(event.initial_update_complete)
        self.assertFalse(event.historical_update_complete)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)
        return response

    def test_malformed_json_bytes_are_quarantined(self):
        self.assert_payload_quarantined(b"{not json")

    def test_non_utf8_bytes_are_quarantined(self):
        self.assert_payload_quarantined(b"\xff\xfe\x00 not utf-8")

    def test_json_array_and_scalar_bodies_are_quarantined(self):
        for value in ([1, 2], "text", 42, True, None):
            with self.subTest(value=value):
                PlaidWebhookEvent.objects.all().delete()
                self.assert_payload_quarantined(json.dumps(value).encode())

    def test_missing_required_field_is_quarantined(self):
        for field in ("webhook_type", "webhook_code", "item_id"):
            with self.subTest(field=field):
                PlaidWebhookEvent.objects.all().delete()
                payload = json.loads(webhook_body())
                del payload[field]
                self.assert_payload_quarantined(json.dumps(payload).encode())

    def test_empty_required_field_is_quarantined(self):
        for field in ("webhook_type", "webhook_code", "item_id"):
            with self.subTest(field=field):
                PlaidWebhookEvent.objects.all().delete()
                self.assert_payload_quarantined(webhook_body(**{field: ""}))

    def test_non_string_required_field_is_quarantined(self):
        for field in ("webhook_type", "webhook_code", "item_id"):
            for bad in (123, None, [], {}):
                with self.subTest(field=field, bad=bad):
                    PlaidWebhookEvent.objects.all().delete()
                    self.assert_payload_quarantined(webhook_body(**{field: bad}))

    def test_oversized_required_field_is_quarantined(self):
        cases = [
            {"webhook_type": "T" * 51},
            {"webhook_code": "C" * 51},
            {"item_id": "i" * 101},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides):
                PlaidWebhookEvent.objects.all().delete()
                self.assert_payload_quarantined(webhook_body(**overrides))

    def test_max_length_required_field_is_accepted(self):
        max_item_id = "i" * 100
        PlaidConnection.objects.create(
            user=self.user,
            item_id=max_item_id,
            institution_name="Max Length Bank",
        )
        body = webhook_body(
            item_id=max_item_id,
        )
        header = signed_header(body)

        with patched_gateway():
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)

    def test_non_bool_flags_are_quarantined(self):
        for flag in ("initial_update_complete", "historical_update_complete"):
            for bad in ("true", 1, 0, None, [], {}):
                with self.subTest(flag=flag, bad=bad):
                    PlaidWebhookEvent.objects.all().delete()
                    self.assert_payload_quarantined(webhook_body(**{flag: bad}))

    def test_payload_quarantine_response_reflects_no_parsed_field_data(self):
        body = json.dumps(
            {
                "webhook_type": [BODY_MARKER],
                "webhook_code": "SYNC_UPDATES_AVAILABLE",
                "item_id": ITEM_ID,
            }
        ).encode()

        response = self.assert_payload_quarantined(body)

        raw = response.content.decode()
        self.assertNotIn(BODY_MARKER, raw)
        self.assertNotIn(ITEM_ID, raw)
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.webhook_type, "UNKNOWN")
        self.assertEqual(event.webhook_code, "SYNC_UPDATES_AVAILABLE")
        self.assertEqual(event.item_id, ITEM_ID)


class WebhookEndpointMethodTests(WebhookEndpointBase):
    def test_get_put_patch_delete_return_405(self):
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(self.url)
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )


class WebhookEndpointAuthCsrfTests(WebhookEndpointBase):
    def test_webhook_works_without_login_and_without_csrf_with_valid_signature(self):
        csrf_client = APIClient(enforce_csrf_checks=True)
        body = webhook_body()
        header = signed_header(body)

        with patched_gateway():
            response = csrf_client.post(
                self.url,
                data=body,
                content_type="application/json",
                HTTP_PLAID_VERIFICATION=header,
            )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)

    def test_webhook_exemption_does_not_weaken_authenticated_plaid_routes(self):
        anonymous = self.client.post(reverse("plaid-link-token"))
        self.assertEqual(anonymous.status_code, status.HTTP_401_UNAUTHORIZED)

        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)
        missing_csrf = csrf_client.post(reverse("plaid-link-token"))
        self.assertEqual(missing_csrf.status_code, status.HTTP_403_FORBIDDEN)

    @override_settings(PLAID_ENABLED=True, PLAID_ENV="production")
    def test_unverifiable_delivery_still_fails_closed_even_without_login(self):
        body = webhook_body()

        response = self.post_webhook(body, header="not-a-jwt")

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)


class WebhookEndpointRateLimitTests(WebhookEndpointBase):
    def test_61st_request_from_same_source_ip_is_throttled_without_mutation(self):
        with patch(
            "plaid_integration.views.PlaidGateway.from_settings"
        ) as gateway_class:
            for _ in range(60):
                response = self.post_webhook(b"{}")
                self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
            calls_after_60 = gateway_class.call_count
            response = self.post_webhook(b"{}")
            self.assertEqual(response.status_code, status.HTTP_429_TOO_MANY_REQUESTS)
            self.assertEqual(gateway_class.call_count, calls_after_60)

        self.assertEqual(PlaidConnection.objects.count(), 1)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)

    def test_rate_limit_is_scoped_only_to_the_webhook_endpoint(self):
        with patch("plaid_integration.views.PlaidGateway.from_settings"):
            for _ in range(60):
                self.post_webhook(b"{}")
            throttled = self.post_webhook(b"{}")
            self.assertEqual(throttled.status_code, status.HTTP_429_TOO_MANY_REQUESTS)

        self.client.force_login(self.user)
        with patch(
            "plaid_integration.views.PlaidWebhookRateThrottle.allow_request",
            side_effect=AssertionError("webhook throttle leaked to another route"),
        ) as webhook_throttle:
            unrelated = self.client.post(reverse("plaid-link-token"))

        self.assertEqual(unrelated.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        webhook_throttle.assert_not_called()


class WebhookEndpointOrderingTests(WebhookEndpointBase):
    def test_verification_precedes_json_parsing_and_item_matching(self):
        body = webhook_body()
        header = signed_header(body)
        events = []

        def recording_verify(raw_body, verification_header, *, gateway, now=None):
            events.append("verify")
            return VerifiedWebhookClaims(
                kid=SYNTHETIC_KID,
                iat=int(time.time()),
                idempotency_key=hashlib.sha256(raw_body).hexdigest(),
            )

        real_loads = json.loads

        def recording_loads(data, *args, **kwargs):
            events.append("parse")
            return real_loads(data, *args, **kwargs)

        real_filter = PlaidConnection.objects.filter

        def recording_filter(*args, **kwargs):
            events.append("match")
            return real_filter(*args, **kwargs)

        with (
            patch(
                "plaid_integration.views.verify_plaid_webhook",
                side_effect=recording_verify,
            ),
            patch("plaid_integration.views.json.loads", side_effect=recording_loads),
            patch.object(
                PlaidConnection.objects, "filter", side_effect=recording_filter
            ),
        ):
            response = self.post_webhook(body, header=header)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(events, ["verify", "parse", "match"])


class WebhookIngestServiceTests(WebhookEndpointBase):
    def setUp(self):
        super().setUp()
        self.claims = VerifiedWebhookClaims(
            kid=SYNTHETIC_KID,
            iat=int(time.time()),
            idempotency_key="a" * 64,
        )

    def test_persist_sets_sync_due_and_advances_status_monotonically(self):
        persist_verified_webhook(
            self.connection,
            self.claims,
            webhook_type="TRANSACTIONS",
            webhook_code="SYNC_UPDATES_AVAILABLE",
            initial_update_complete=True,
            historical_update_complete=False,
        )

        self.connection.refresh_from_db()
        self.assertTrue(self.connection.sync_due)
        self.assertEqual(
            self.connection.transactions_update_status,
            TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
        )
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.idempotency_key, self.claims.idempotency_key)
        self.assertTrue(event.initial_update_complete)
        self.assertFalse(event.historical_update_complete)

    def test_exact_duplicate_constraint_translates_to_duplicate_event(self):
        supported_event(self.connection, self.claims.idempotency_key)

        with self.assertRaises(WebhookDuplicateEvent):
            persist_verified_webhook(
                self.connection,
                self.claims,
                webhook_type="TRANSACTIONS",
                webhook_code="SYNC_UPDATES_AVAILABLE",
                initial_update_complete=True,
                historical_update_complete=False,
            )

        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertFalse(self.connection.sync_due)
        self.assertIsNone(self.connection.transactions_update_status)

    def test_duplicate_without_constraint_diagnostic_translates_exact_key(self):
        supported_event(self.connection, self.claims.idempotency_key)

        def no_diag_save(*args, **kwargs):
            raise IntegrityError("duplicate key")

        with patch.object(
            PlaidWebhookEvent.objects, "create", side_effect=no_diag_save
        ):
            with self.assertRaises(WebhookDuplicateEvent):
                persist_verified_webhook(
                    self.connection,
                    self.claims,
                    webhook_type="TRANSACTIONS",
                    webhook_code="SYNC_UPDATES_AVAILABLE",
                    initial_update_complete=True,
                    historical_update_complete=False,
                )

        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)

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
                persist_verified_webhook(
                    self.connection,
                    self.claims,
                    webhook_type="TRANSACTIONS",
                    webhook_code="SYNC_UPDATES_AVAILABLE",
                    initial_update_complete=True,
                    historical_update_complete=False,
                )

        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)


def item_body(
    webhook_code, *, item_id=ITEM_ID, error=None, include_error=False, **overrides
):
    payload = {
        "webhook_type": "ITEM",
        "webhook_code": webhook_code,
        "item_id": item_id,
    }
    if include_error:
        payload["error"] = error
    payload.update(overrides)
    return json.dumps(payload).encode()


def item_error_body(*, item_id=ITEM_ID, error_code="ITEM_LOGIN_REQUIRED", **overrides):
    return item_body(
        "ERROR",
        item_id=item_id,
        include_error=True,
        error={"error_code": error_code},
        **overrides,
    )


class WebhookItemLifecycleTests(WebhookEndpointBase):
    def post_item(self, body):
        header = signed_header(body)
        with patched_gateway():
            return self.post_webhook(body, header=header)

    def test_error_login_required_active_to_updating(self):
        body = item_error_body(error_code="ITEM_LOGIN_REQUIRED")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.UPDATING)
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.webhook_type, "ITEM")
        self.assertEqual(event.webhook_code, "ERROR")
        self.assertIsNotNone(event.processed_at)

    def test_error_login_required_error_to_updating(self):
        self.connection.status = PlaidConnectionStatus.ERROR
        self.connection.save(update_fields=["status"])
        body = item_error_body(error_code="ITEM_LOGIN_REQUIRED")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.UPDATING)
        self.assertIsNotNone(PlaidWebhookEvent.objects.get().processed_at)

    def test_login_repaired_updating_to_active_and_sync_due(self):
        self.connection.status = PlaidConnectionStatus.UPDATING
        self.connection.sync_due = False
        self.connection.save(update_fields=["status", "sync_due"])
        body = item_body("LOGIN_REPAIRED")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertTrue(self.connection.sync_due)
        self.assertIsNotNone(PlaidWebhookEvent.objects.get().processed_at)

    def test_login_repaired_error_to_active_and_sync_due(self):
        self.connection.status = PlaidConnectionStatus.ERROR
        self.connection.sync_due = False
        self.connection.save(update_fields=["status", "sync_due"])
        body = item_body("LOGIN_REPAIRED")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertTrue(self.connection.sync_due)

    def test_login_repaired_already_active_still_sets_sync_due(self):
        self.connection.sync_due = False
        self.connection.save(update_fields=["sync_due"])
        body = item_body("LOGIN_REPAIRED")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertTrue(self.connection.sync_due)

    def test_user_permission_revoked_active_to_revoked(self):
        body = item_body("USER_PERMISSION_REVOKED")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.REVOKED)

    def test_user_permission_revoked_updating_and_error_to_revoked(self):
        for start in (PlaidConnectionStatus.UPDATING, PlaidConnectionStatus.ERROR):
            with self.subTest(start=start):
                PlaidWebhookEvent.objects.all().delete()
                self.connection.status = start
                self.connection.save(update_fields=["status"])
                body = item_body("USER_PERMISSION_REVOKED")
                # Unique body per subtest for idempotency isolation.
                body = body[:-1] + f', "nonce": "{start}"'.encode() + b"}"
                # Re-sign because body changed.
                header = signed_header(body)
                with patched_gateway():
                    response = self.post_webhook(body, header=header)
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.connection.refresh_from_db()
                self.assertEqual(self.connection.status, PlaidConnectionStatus.REVOKED)

    def test_user_permission_revoked_disconnected_stays_disconnected(self):
        self.connection.status = PlaidConnectionStatus.DISCONNECTED
        self.connection.save(update_fields=["status"])
        body = item_body("USER_PERMISSION_REVOKED")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.DISCONNECTED)

    def test_generic_error_active_to_error(self):
        body = item_error_body(error_code="INVALID_CREDENTIALS")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ERROR)

    def test_generic_error_preserves_updating(self):
        self.connection.status = PlaidConnectionStatus.UPDATING
        self.connection.save(update_fields=["status"])
        body = item_error_body(error_code="INVALID_CREDENTIALS")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.UPDATING)

    def test_terminal_revoked_never_resurrected(self):
        self.connection.status = PlaidConnectionStatus.REVOKED
        self.connection.save(update_fields=["status"])
        cases = [
            item_error_body(error_code="ITEM_LOGIN_REQUIRED"),
            item_body("LOGIN_REPAIRED"),
            item_error_body(error_code="INVALID_CREDENTIALS"),
        ]
        for body in cases:
            with self.subTest(body=body[:60]):
                PlaidWebhookEvent.objects.all().delete()
                # Unique idempotency per subtest.
                unique = hashlib.sha256(body).hexdigest()[:8].encode()
                body_u = body[:-1] + b', "nonce": "' + unique + b'"}'
                header = signed_header(body_u)
                with patched_gateway():
                    response = self.post_webhook(body_u, header=header)
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.connection.refresh_from_db()
                self.assertEqual(self.connection.status, PlaidConnectionStatus.REVOKED)

    def test_terminal_disconnected_never_resurrected(self):
        self.connection.status = PlaidConnectionStatus.DISCONNECTED
        self.connection.save(update_fields=["status"])
        cases = [
            item_error_body(error_code="ITEM_LOGIN_REQUIRED"),
            item_body("LOGIN_REPAIRED"),
            item_error_body(error_code="INVALID_CREDENTIALS"),
            item_body("USER_PERMISSION_REVOKED"),
        ]
        for body in cases:
            with self.subTest(body=body[:60]):
                PlaidWebhookEvent.objects.all().delete()
                unique = hashlib.sha256(body).hexdigest()[:8].encode()
                body_u = body[:-1] + b', "nonce": "' + unique + b'"}'
                header = signed_header(body_u)
                with patched_gateway():
                    response = self.post_webhook(body_u, header=header)
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.connection.refresh_from_db()
                self.assertEqual(
                    self.connection.status, PlaidConnectionStatus.DISCONNECTED
                )

    def test_matched_item_sets_processed_at_and_touches_nothing_else(self):
        body = item_error_body(error_code="ITEM_LOGIN_REQUIRED")
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        event = PlaidWebhookEvent.objects.get()
        self.assertEqual(event.connection, self.connection)
        self.assertEqual(event.user, self.user)
        self.assertEqual(event.item_id, self.connection.item_id)
        self.assertEqual(event.idempotency_key, hashlib.sha256(body).hexdigest())
        self.assertIsNotNone(event.received_at)
        self.assertIsNotNone(event.processed_at)
        self.assertFalse(event.initial_update_complete)
        self.assertFalse(event.historical_update_complete)
        self.connection.refresh_from_db()
        self.assertIsNone(self.connection.sync_cursor)
        self.assertIsNone(self.connection.last_synced_at)
        self.assertIsNone(self.connection.transactions_update_status)
        self.assertEqual(self.connection.last_sync_error, "")
        self.assertEqual(Transaction.objects.count(), 0)

    def test_exact_duplicate_returns_200_no_repeat_mutation(self):
        body = item_body("LOGIN_REPAIRED")
        self.connection.status = PlaidConnectionStatus.UPDATING
        self.connection.save(update_fields=["status"])
        header = signed_header(body)
        with patched_gateway():
            first = self.post_webhook(body, header=header)
            self.connection.refresh_from_db()
            updated_at_after_first = self.connection.updated_at
            second = self.post_webhook(body, header=header)
        self.assertEqual(first.status_code, status.HTTP_200_OK)
        self.assertEqual(second.status_code, status.HTTP_200_OK)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertEqual(self.connection.updated_at, updated_at_after_first)

    def test_unmatched_item_returns_200_no_row_no_mutation(self):
        body = item_error_body(item_id=UNKNOWN_ITEM_ID)
        response = self.post_item(body)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
        self.assertFalse(self.connection.sync_due)

    def test_unsupported_item_codes_return_200_no_row_not_quarantine(self):
        for code in ("PENDING_EXPIRATION", "NEW_ACCOUNTS_AVAILABLE"):
            with self.subTest(code=code):
                PlaidWebhookEvent.objects.all().delete()
                body = item_body(code)
                response = self.post_item(body)
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
                self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
                self.connection.refresh_from_db()
                self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
                self.assertFalse(self.connection.sync_due)

    def test_malformed_item_error_missing_error_quarantined(self):
        body = item_body("ERROR", include_error=False)
        header = signed_header(body)
        with patched_gateway():
            response = self.post_webhook(body, header=header)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        event = PlaidWebhookEvent.objects.get()
        self.assertIsNone(event.connection)
        self.assertIsNone(event.user)
        self.assertEqual(event.processed_at, event.received_at)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)

    def test_malformed_item_error_bad_error_code_quarantined(self):
        bad_errors = [
            None,
            "ITEM_LOGIN_REQUIRED",
            123,
            True,
            [],
            {},
            {"error_code": ""},
            {"error_code": None},
            {"error_code": 123},
            {"error_code": True},
            {"error_code": []},
            {"error_code": {}},
            {"error_code": "x" * 51},
        ]
        for bad in bad_errors:
            with self.subTest(bad=bad):
                PlaidWebhookEvent.objects.all().delete()
                body = item_body("ERROR", include_error=True, error=bad)
                header = signed_header(body)
                with patched_gateway():
                    response = self.post_webhook(body, header=header)
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                event = PlaidWebhookEvent.objects.get()
                self.assertIsNone(event.connection)
                self.assertIsNone(event.user)
                self.assertEqual(event.processed_at, event.received_at)
                self.connection.refresh_from_db()
                self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)

    def test_malformed_item_bad_item_id_quarantined(self):
        for bad_item in ("", 123, None, [], {}, True, "i" * 101):
            with self.subTest(bad_item=bad_item):
                PlaidWebhookEvent.objects.all().delete()
                if bad_item == "ITEM_LOGIN_REQUIRED_SPECIAL":
                    continue
                body = item_error_body(item_id=bad_item)
                header = signed_header(body)
                with patched_gateway():
                    response = self.post_webhook(body, header=header)
                self.assertEqual(response.status_code, status.HTTP_200_OK)
                event = PlaidWebhookEvent.objects.get()
                self.assertIsNone(event.connection)
                self.connection.refresh_from_db()
                self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)

    def test_item_quarantine_never_stores_or_logs_body_or_provider_message(self):
        secret = "PROVIDER-SECRET-MESSAGE-12345"
        # Force malformed by making item_id invalid while keeping secret in body.
        bad_body = json.dumps(
            {
                "webhook_type": "ITEM",
                "webhook_code": "ERROR",
                "item_id": "",
                "error": {
                    "error_code": "ITEM_LOGIN_REQUIRED",
                    "error_message": secret,
                },
            }
        ).encode()
        header = signed_header(bad_body)
        with patched_gateway():
            with self.assertLogs(
                "plaid_integration", level=logging.WARNING
            ) as captured:
                response = self.post_webhook(bad_body, header=header)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        raw = response.content.decode()
        self.assertNotIn(secret, raw)
        self.assertNotIn(hashlib.sha256(bad_body).hexdigest(), raw)
        log_text = "\n".join(captured.output)
        self.assertNotIn(secret, log_text)
        self.assertNotIn(hashlib.sha256(bad_body).hexdigest(), log_text)
        event = PlaidWebhookEvent.objects.get()
        self.assertIsNone(event.connection)

    def test_item_invalid_signature_fails_with_zero_mutation(self):
        body = item_error_body()
        with patched_gateway():
            response = self.post_webhook(body, header="not-a-jwt")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)

    def test_item_invalid_signature_performs_zero_database_queries(self):
        body = item_error_body()
        with patched_gateway():
            with self.assertNumQueries(0):
                response = self.post_webhook(body, header="not-a-jwt")
        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_item_verification_precedes_orm(self):
        body = item_error_body()
        header = signed_header(body)
        events = []

        def recording_verify(raw_body, verification_header, *, gateway, now=None):
            events.append("verify")
            from plaid_integration.webhook_verification import VerifiedWebhookClaims

            return VerifiedWebhookClaims(
                kid=SYNTHETIC_KID,
                iat=int(time.time()),
                idempotency_key=hashlib.sha256(raw_body).hexdigest(),
            )

        real_filter = PlaidConnection.objects.filter

        def recording_filter(*args, **kwargs):
            events.append("match")
            return real_filter(*args, **kwargs)

        with (
            patch(
                "plaid_integration.views.verify_plaid_webhook",
                side_effect=recording_verify,
            ),
            patch.object(
                PlaidConnection.objects, "filter", side_effect=recording_filter
            ),
        ):
            response = self.post_webhook(body, header=header)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(events[0], "verify")
        self.assertIn("match", events)

    def test_item_connection_disappears_between_lookup_and_lock(self):
        body = item_error_body()
        header = signed_header(body)
        real_filter = PlaidConnection.objects.filter

        def disappearing_filter(*args, **kwargs):
            qs = real_filter(*args, **kwargs)
            conn = qs.first()
            if conn is not None:
                conn.delete()

            # Return an empty queryset so view treats as unmatched, or
            # return a stale object to exercise DoesNotExist path.
            # Here we return stale via a mock queryset.
            class StaleQS:
                def first(self):
                    return conn

            return StaleQS()

        with patched_gateway():
            with patch.object(
                PlaidConnection.objects, "filter", side_effect=disappearing_filter
            ):
                response = self.post_webhook(body, header=header)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.json(), WEBHOOK_RECEIVED_RESPONSE)
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)

    def test_item_inbox_full_returns_503_without_mutation(self):
        from datetime import timedelta

        from django.test import override_settings
        from django.utils import timezone

        from plaid_integration.views import WEBHOOK_INBOX_FULL_DETAIL

        existing = PlaidWebhookEvent.objects.create(
            connection=self.connection,
            user=self.user,
            webhook_type="TRANSACTIONS",
            webhook_code="SYNC_UPDATES_AVAILABLE",
            item_id=self.connection.item_id,
            idempotency_key="1" * 64,
            received_at=timezone.now() - timedelta(hours=1),
            processed_at=None,
        )
        body = item_error_body(error_code="ITEM_LOGIN_REQUIRED")
        header = signed_header(body)
        with override_settings(PLAID_WEBHOOK_INBOX_CAP=1):
            with patched_gateway():
                response = self.post_webhook(body, header=header)
        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": WEBHOOK_INBOX_FULL_DETAIL})
        self.assertEqual(PlaidWebhookEvent.objects.count(), 1)
        self.assertTrue(PlaidWebhookEvent.objects.filter(pk=existing.pk).exists())
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)

    def test_item_unrelated_integrity_error_propagates(self):
        from plaid_integration.services import persist_verified_item_webhook

        claims = VerifiedWebhookClaims(
            kid=SYNTHETIC_KID,
            iat=int(time.time()),
            idempotency_key="b" * 64,
        )

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
                persist_verified_item_webhook(
                    self.connection,
                    claims,
                    webhook_type="ITEM",
                    webhook_code="ERROR",
                    error_code="ITEM_LOGIN_REQUIRED",
                )
        self.assertEqual(PlaidWebhookEvent.objects.count(), 0)
        self.connection.refresh_from_db()
        self.assertEqual(self.connection.status, PlaidConnectionStatus.ACTIVE)
