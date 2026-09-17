"""Tests for the authenticated link-token endpoint and its gateway seam.

Covers the ``docs/plaid.md`` section 3 ``POST /api/plaid/link-token/``
contract for issue #37 slice A: the safe response shape, the thin Plaid
gateway boundary, the opaque HMAC client user id, and the digest-only
exchange handle persistence foundation. Only synthetic credentials and SDK
objects are used; the network boundary is never exercised.
"""

import hashlib
import hmac
import json
import logging
import string
import traceback
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from plaid import ApiException, Environment
from plaid.model.country_code import CountryCode
from plaid.model.products import Products
from rest_framework import status
from rest_framework.test import APIClient, APITestCase
from urllib3.exceptions import ProtocolError

from plaid_integration.gateway import (
    PLAID_REQUEST_TIMEOUT_SECONDS,
    PLAID_UNAVAILABLE_DETAIL,
    PlaidGateway,
    PlaidGatewayError,
)
from plaid_integration.models import PlaidExchangeHandle
from plaid_integration.services import issue_exchange_handle, plaid_client_user_id
from plaid_integration.tests import assert_constraint_violation

RAW_PROVIDER_BODY_MARKER = "RAW-PROVIDER-BODY-MARKER"


class FakeLinkTokenResponse:
    def __init__(
        self,
        link_token="link-sandbox-00000000-0000-0000-0000-000000000000",
        expiration=None,
    ):
        self.link_token = link_token
        self.expiration = (
            expiration
            if expiration is not None
            else timezone.now() + timedelta(hours=1)
        )


class FakePlaidApi:
    """Records the real SDK request object without any network access."""

    def __init__(self, *, response=None, error=None):
        self.response = response if response is not None else FakeLinkTokenResponse()
        self.error = error
        self.calls = []

    def link_token_create(self, *, link_token_create_request, _request_timeout=None):
        self.calls.append((link_token_create_request, _request_timeout))
        if self.error is not None:
            raise self.error
        return self.response


def gateway_for(plaid_api):
    return PlaidGateway(
        plaid_api,
        client_id="client-id-test",
        secret="secret-test",
    )


PLAID_API_SETTINGS = {
    "PLAID_ENABLED": True,
    "PLAID_ENV": "sandbox",
    "PLAID_CLIENT_ID": "client-id-test",
    "PLAID_SECRET": "secret-test",
}


class PlaidGatewayTests(SimpleTestCase):
    def test_create_link_token_builds_exact_sdk_request(self):
        fake_api = FakePlaidApi()

        gateway_for(fake_api).create_link_token("opaque-client-user-id")

        self.assertEqual(len(fake_api.calls), 1)
        request, timeout = fake_api.calls[0]
        self.assertEqual(request.client_name, "Mohr")
        self.assertEqual(request.language, "en")
        self.assertEqual(request.country_codes, [CountryCode("US")])
        self.assertEqual(request.products, [Products("transactions")])
        self.assertEqual(request.transactions.days_requested, 90)
        self.assertEqual(request.user.client_user_id, "opaque-client-user-id")
        self.assertIsInstance(timeout, (int, float))
        self.assertGreater(timeout, 0)
        self.assertEqual(timeout, PLAID_REQUEST_TIMEOUT_SECONDS)

    @override_settings(**PLAID_API_SETTINGS)
    def test_from_settings_configures_exact_sandbox_environment_and_credentials(self):
        with patch("plaid_integration.gateway.PlaidApi") as plaid_api_class:
            PlaidGateway.from_settings()

        configuration = plaid_api_class.call_args.args[0].configuration
        self.assertEqual(configuration.host, Environment.Sandbox)
        self.assertNotEqual(configuration.host, Environment.Production)
        self.assertEqual(configuration.api_key["clientId"], "client-id-test")
        self.assertEqual(configuration.api_key["secret"], "secret-test")
        self.assertEqual(configuration.api_key["plaidVersion"], "2020-09-14")

    @override_settings(**{**PLAID_API_SETTINGS, "PLAID_ENV": "production"})
    def test_from_settings_refuses_non_sandbox_environment(self):
        with patch("plaid_integration.gateway.PlaidApi") as plaid_api_class:
            with self.assertRaises(PlaidGatewayError) as raised:
                PlaidGateway.from_settings()

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
        plaid_api_class.assert_not_called()

    def test_success_returns_sdk_link_token_and_expiration(self):
        expiration = timezone.now() + timedelta(hours=1)
        fake_api = FakePlaidApi(
            response=FakeLinkTokenResponse("link-sandbox-gateway", expiration)
        )

        response = gateway_for(fake_api).create_link_token("opaque-client-user-id")

        self.assertEqual(response.link_token, "link-sandbox-gateway")
        self.assertEqual(response.expiration, expiration)

    def test_api_error_translates_to_fixed_safe_error(self):
        error = ApiException(status=400, reason="Invalid Input", http_resp=None)
        error.body = json.dumps(
            {"error_code": "INVALID_SECRET", "error_message": "synthetic-leak"}
        )

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakePlaidApi(error=error)).create_link_token(
                "opaque-client-user-id"
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_transport_timeout_translates_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(
                FakePlaidApi(error=TimeoutError("Connection timed out"))
            ).create_link_token("opaque-client-user-id")

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_urllib3_transport_error_translates_to_fixed_safe_error(self):
        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(
                FakePlaidApi(error=ProtocolError("Connection aborted."))
            ).create_link_token("opaque-client-user-id")

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_unexpected_programmer_error_propagates(self):
        with self.assertRaises(TypeError) as raised:
            gateway_for(
                FakePlaidApi(error=TypeError("programmer defect"))
            ).create_link_token("opaque-client-user-id")

        self.assertEqual(str(raised.exception), "programmer defect")

    def test_failure_logs_and_error_never_echo_sdk_details(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps(
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": (
                    "synthetic-secret-test client-id-test link-sandbox-leak "
                    "opaque-client-user-id"
                ),
            }
        )

        with self.assertLogs(
            "plaid_integration.gateway", level=logging.WARNING
        ) as captured:
            with self.assertRaises(PlaidGatewayError):
                gateway_for(FakePlaidApi(error=error)).create_link_token(
                    "opaque-client-user-id"
                )

        log_text = "\n".join(captured.output)
        for forbidden in (
            "synthetic-secret-test",
            "client-id-test",
            "link-sandbox-leak",
            "opaque-client-user-id",
        ):
            self.assertNotIn(forbidden, log_text)

    def test_failures_suppress_cause_and_never_render_provider_body(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps(
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": (
                    f"{RAW_PROVIDER_BODY_MARKER} link-sandbox-leak "
                    "opaque-client-user-id"
                ),
                "request_id": "req-link-leak",
            }
        )

        for provider_error in (
            error,
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ):
            with self.subTest(provider_error=provider_error):
                with self.assertLogs(
                    "plaid_integration.gateway", level=logging.WARNING
                ) as captured:
                    with self.assertRaises(PlaidGatewayError) as raised:
                        gateway_for(
                            FakePlaidApi(error=provider_error)
                        ).create_link_token("opaque-client-user-id")

                exception = raised.exception
                self.assertIsNone(exception.__cause__)
                self.assertEqual(str(exception), PLAID_UNAVAILABLE_DETAIL)
                formatted = "".join(traceback.format_exception(exception))
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    "link-sandbox-leak",
                    "opaque-client-user-id",
                    "req-link-leak",
                ):
                    self.assertNotIn(forbidden, str(exception))
                    self.assertNotIn(forbidden, repr(exception))
                    self.assertNotIn(forbidden, formatted)
                log_text = "\n".join(captured.output)
                self.assertEqual(len(captured.output), 1)
                self.assertIn("Plaid link token creation failed.", log_text)
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    "link-sandbox-leak",
                    "opaque-client-user-id",
                    "req-link-leak",
                ):
                    self.assertNotIn(forbidden, log_text)


class PlaidClientUserIdTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="hmac-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.other_user = get_user_model().objects.create_user(
            email="hmac-other@example.com",
            password="TestOnlyPassword123!",
        )

    def test_hmac_is_stable_for_same_user(self):
        self.assertEqual(
            plaid_client_user_id(self.user), plaid_client_user_id(self.user)
        )

    def test_hmac_differs_for_different_users(self):
        self.assertNotEqual(
            plaid_client_user_id(self.user),
            plaid_client_user_id(self.other_user),
        )

    def test_hmac_is_opaque_hex_containing_neither_email_nor_raw_id(self):
        digest = plaid_client_user_id(self.user)

        self.assertEqual(len(digest), 64)
        self.assertTrue(all(char in string.hexdigits for char in digest))
        self.assertNotEqual(digest, str(self.user.id))
        self.assertNotEqual(digest, self.user.email)
        self.assertNotIn(self.user.email, digest)

    def test_hmac_derives_from_secret_key_and_database_id_with_purpose_label(self):
        digest = plaid_client_user_id(self.user)

        expected = hmac.new(
            settings.SECRET_KEY.encode("utf-8"),
            b"mohr:plaid:client_user_id:" + str(self.user.id).encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(digest, expected)

    @override_settings(SECRET_KEY="möhr-密钥-🔐-unicode")
    def test_hmac_is_stable_and_opaque_with_unicode_secret_key(self):
        digest = plaid_client_user_id(self.user)

        expected = hmac.new(
            "möhr-密钥-🔐-unicode".encode("utf-8"),
            b"mohr:plaid:client_user_id:" + str(self.user.id).encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        self.assertEqual(digest, expected)
        self.assertEqual(digest, plaid_client_user_id(self.user))
        self.assertEqual(len(digest), 64)
        self.assertTrue(all(char in string.hexdigits for char in digest))
        self.assertNotEqual(digest, "möhr-密钥-🔐-unicode")

    def test_hmac_does_not_depend_on_email(self):
        digest = plaid_client_user_id(self.user)

        self.user.email = "renamed-hmac-owner@example.com"
        self.user.save(update_fields=["email"])

        self.assertEqual(plaid_client_user_id(self.user), digest)


class PlaidExchangeHandleModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = get_user_model().objects.create_user(
            email="handle-owner@example.com",
            password="TestOnlyPassword123!",
        )
        cls.other_user = get_user_model().objects.create_user(
            email="handle-other@example.com",
            password="TestOnlyPassword123!",
        )

    def issue(self, user=None, expiration=None):
        return issue_exchange_handle(
            user or self.user,
            expiration
            if expiration is not None
            else timezone.now() + timedelta(hours=2),
        )

    def test_handle_persists_only_digest_bound_to_owner(self):
        raw_handle = self.issue()

        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertEqual(
            row.digest,
            hashlib.sha256(raw_handle.encode("ascii")).hexdigest(),
        )
        self.assertNotEqual(row.digest, raw_handle)
        self.assertEqual(row.user, self.user)
        self.assertIsNone(row.consumed_at)
        self.assertIsNotNone(row.created_at)

    def test_expiration_is_capped_at_thirty_minutes_when_link_token_is_later(self):
        self.issue()

        row = PlaidExchangeHandle.objects.get(user=self.user)
        lifetime = row.expires_at - row.created_at
        self.assertGreaterEqual(lifetime, timedelta(minutes=29, seconds=59))
        self.assertLessEqual(lifetime, timedelta(minutes=30))

    def test_expiration_uses_link_token_expiration_when_earlier(self):
        link_expiration = timezone.now() + timedelta(minutes=5)

        self.issue(expiration=link_expiration)

        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertEqual(row.expires_at, link_expiration)

    def test_raw_handle_is_absent_from_database_and_string_forms(self):
        raw_handle = self.issue()

        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertFalse(PlaidExchangeHandle.objects.filter(digest=raw_handle).exists())
        self.assertNotIn(raw_handle, str(row))
        self.assertNotIn(raw_handle, repr(row))
        self.assertNotIn(row.digest, str(row))
        self.assertNotIn(row.digest, repr(row))
        self.assertFalse(hasattr(row, "raw_handle"))
        self.assertFalse(hasattr(row, "handle"))

    def test_digest_is_unique_across_users(self):
        self.issue()
        first = PlaidExchangeHandle.objects.get(user=self.user)

        assert_constraint_violation(
            self,
            lambda: PlaidExchangeHandle.objects.create(
                user=self.other_user,
                digest=first.digest,
                expires_at=timezone.now() + timedelta(minutes=30),
            ),
            "plaid_exchange_handle_digest_unique",
        )

        self.assertEqual(PlaidExchangeHandle.objects.count(), 1)

    def test_deleting_user_cascades_handles_and_preserves_other_user(self):
        self.issue(user=self.other_user)
        self.issue(user=self.user)

        self.user.delete()

        self.assertFalse(
            PlaidExchangeHandle.objects.filter(user_id=self.user.pk).exists()
        )
        self.assertEqual(PlaidExchangeHandle.objects.count(), 1)
        self.assertEqual(PlaidExchangeHandle.objects.get().user, self.other_user)


class LinkTokenAPITests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            email="link-api-owner@example.com",
            password="TestOnlyPassword123!",
        )
        self.csrf_client = APIClient(enforce_csrf_checks=True)
        self.csrf_client.force_login(self.user)
        csrf_response = self.csrf_client.get(reverse("auth-csrf"))
        self.csrf_token = csrf_response.cookies["csrftoken"].value

    def post_link_token(self, client=None, *, data=None, csrf_token=None, **extra):
        client = client if client is not None else self.csrf_client
        return client.post(
            reverse("plaid-link-token"),
            data if data is not None else {},
            format="json",
            HTTP_X_CSRFTOKEN=csrf_token if csrf_token is not None else self.csrf_token,
            **extra,
        )

    def patched_gateway(self, fake_api):
        return patch(
            "plaid_integration.views.PlaidGateway.from_settings",
            return_value=gateway_for(fake_api),
        )

    @override_settings(**PLAID_API_SETTINGS)
    def test_authenticated_link_token_creation_succeeds(self):
        expiration = timezone.now() + timedelta(hours=1)
        fake_api = FakePlaidApi(
            response=FakeLinkTokenResponse("link-sandbox-api-test", expiration)
        )

        with self.patched_gateway(fake_api):
            response = self.post_link_token()

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data["link_token"], "link-sandbox-api-test")
        self.assertEqual(response.data["expiration"], expiration)
        exchange_handle = response.data["exchange_handle"]
        self.assertEqual(len(exchange_handle), 43)
        self.assertEqual(len(fake_api.calls), 1)
        row = PlaidExchangeHandle.objects.get(user=self.user)
        self.assertEqual(
            row.digest,
            hashlib.sha256(exchange_handle.encode("ascii")).hexdigest(),
        )

    @override_settings(**PLAID_API_SETTINGS)
    def test_response_contains_exactly_the_safe_fields(self):
        fake_api = FakePlaidApi()

        with self.patched_gateway(fake_api):
            response = self.post_link_token()

        self.assertEqual(
            set(response.data.keys()),
            {"link_token", "expiration", "exchange_handle"},
        )
        raw = response.content.decode()
        for forbidden in (
            "access_token",
            "public_token",
            "item_id",
            "client_id",
            "secret",
        ):
            self.assertNotIn(forbidden, raw)

    def test_anonymous_post_returns_401_without_provider_call_or_row(self):
        with patch("plaid_integration.views.PlaidGateway") as gateway_class:
            response = self.client.post(reverse("plaid-link-token"))

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)
        self.assertEqual(
            response.data,
            {"detail": "Authentication credentials were not provided."},
        )
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.create_link_token.assert_not_called()
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)

    def test_authenticated_post_without_csrf_returns_403_without_provider_call_or_row(
        self,
    ):
        csrf_client = APIClient(enforce_csrf_checks=True)
        csrf_client.force_login(self.user)

        with patch("plaid_integration.views.PlaidGateway") as gateway_class:
            response = csrf_client.post(reverse("plaid-link-token"))

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"detail": "CSRF verification failed."})
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.create_link_token.assert_not_called()
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)

    @override_settings(PLAID_ENABLED=False)
    def test_disabled_integration_returns_fixed_503_without_provider_call_or_row(self):
        with patch("plaid_integration.views.PlaidGateway") as gateway_class:
            response = self.post_link_token()

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        gateway_class.from_settings.assert_not_called()
        gateway_class.return_value.create_link_token.assert_not_called()
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)

    @override_settings(**PLAID_API_SETTINGS)
    def test_provider_failure_returns_fixed_503_without_handle_or_leaked_values(self):
        error = ApiException(status=500, reason="PROVIDER_ERROR", http_resp=None)
        error.body = json.dumps(
            {
                "error_type": "API_ERROR",
                "error_code": "PROVIDER_ERROR",
                "error_message": (
                    "synthetic-secret-test client-id-test link-sandbox-leak"
                ),
            }
        )

        with self.patched_gateway(FakePlaidApi(error=error)):
            response = self.post_link_token()

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)
        raw = response.content.decode()
        for forbidden in (
            "synthetic-secret-test",
            "client-id-test",
            "link-sandbox-leak",
        ):
            self.assertNotIn(forbidden, raw)

    @override_settings(**PLAID_API_SETTINGS)
    def test_non_sandbox_runtime_override_returns_fixed_503_without_sdk_client(self):
        for plaid_env in ("production", "development", "", "Sandbox"):
            with (
                self.subTest(plaid_env=plaid_env),
                override_settings(PLAID_ENV=plaid_env),
            ):
                with (
                    patch("plaid_integration.gateway.PlaidApi") as plaid_api_class,
                    patch("plaid_integration.gateway.ApiClient") as api_client_class,
                ):
                    response = self.post_link_token()

                self.assertEqual(
                    response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE
                )
                self.assertEqual(response.json(), {"detail": PLAID_UNAVAILABLE_DETAIL})
                plaid_api_class.assert_not_called()
                api_client_class.assert_not_called()

        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)

    @override_settings(**PLAID_API_SETTINGS)
    def test_credentials_stay_server_side_in_sdk_configuration_and_response(self):
        fake_api = FakePlaidApi()
        with (
            patch(
                "plaid_integration.gateway.PlaidApi", return_value=fake_api
            ) as plaid_api_class,
            self.assertNoLogs("plaid_integration", level=logging.DEBUG),
        ):
            response = self.post_link_token()

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        configuration = plaid_api_class.call_args.args[0].configuration
        self.assertEqual(configuration.api_key["clientId"], "client-id-test")
        self.assertEqual(configuration.api_key["secret"], "secret-test")
        self.assertEqual(len(fake_api.calls), 1)
        raw = response.content.decode()
        for forbidden in ("client-id-test", "secret-test"):
            self.assertNotIn(forbidden, raw)

    def test_unsupported_methods_return_405_without_side_effects(self):
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.csrf_client, method)(
                    reverse("plaid-link-token"),
                    HTTP_X_CSRFTOKEN=self.csrf_token,
                )
                self.assertEqual(
                    response.status_code, status.HTTP_405_METHOD_NOT_ALLOWED
                )

        self.assertEqual(PlaidExchangeHandle.objects.count(), 0)

    @override_settings(**PLAID_API_SETTINGS)
    def test_extra_request_body_is_ignored(self):
        fake_api = FakePlaidApi()

        with self.patched_gateway(fake_api):
            response = self.post_link_token(
                data={"unexpected": "payload", "nested": {"x": 1}}
            )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(len(fake_api.calls), 1)
        self.assertEqual(PlaidExchangeHandle.objects.count(), 1)
