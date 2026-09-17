"""Tests for the Plaid webhook cryptographic verification boundary.

Covers ``docs/plaid.md`` section 8 for issue #39 slice A: the strict
``/webhook_verification_key/get`` gateway normalization, the header-first
JWT decode, strict ES256 signature verification, the two-sided ``iat``
bound and ``exp`` check, and the constant-time raw-body SHA-256 compare.
A real P-256 key pair is generated and ES256 JWTs are signed in-process
and verified through production code; only synthetic credentials, key
ids, bodies, and SDK objects are used and no network call is made. Every
expected failure must leave the database untouched and render nothing
sensitive in the exception, its cause/context, or a formatted traceback.
"""

import base64
import hashlib
import json
import logging
import time
import traceback
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import ec
from django.test import SimpleTestCase, TestCase
from plaid import ApiException
from plaid.model.jwk_public_key import JWKPublicKey
from plaid.model.webhook_verification_key_get_request import (
    WebhookVerificationKeyGetRequest,
)
from plaid.model.webhook_verification_key_get_response import (
    WebhookVerificationKeyGetResponse,
)
from urllib3.exceptions import ProtocolError

from plaid_integration import webhook_verification
from plaid_integration.gateway import (
    PLAID_REQUEST_TIMEOUT_SECONDS,
    PLAID_UNAVAILABLE_DETAIL,
    PlaidGateway,
    PlaidGatewayError,
    WebhookVerificationKey,
    normalize_webhook_verification_key,
)
from plaid_integration.models import PlaidConnection, PlaidWebhookEvent
from plaid_integration.webhook_verification import (
    WEBHOOK_IAT_FUTURE_ALLOWANCE_SECONDS,
    WEBHOOK_IAT_MAX_AGE_SECONDS,
    WEBHOOK_KEY_CACHE_CAPACITY,
    WEBHOOK_KID_MAX_LENGTH,
    WEBHOOK_VERIFICATION_FAILED_DETAIL,
    PlaidWebhookVerificationError,
    VerifiedWebhookClaims,
    reset_webhook_key_cache,
    verify_plaid_webhook,
)

SYNTHETIC_CLIENT_ID = "client-id-test"
SYNTHETIC_SECRET = "secret-test"
SYNTHETIC_KID = "kid-synthetic-0001"
OTHER_KID = "kid-synthetic-0002"

FIXED_NOW = 1_700_000_000

RAW_BODY_MARKER = "RAW-WEBHOOK-BODY-MARKER"
RAW_PROVIDER_BODY_MARKER = "RAW-PROVIDER-BODY-MARKER"
JWT_MARKER = "JWT-SECRET-MARKER"
COORDINATE_MARKER = "COORDINATE-MARKER"

_OMIT = object()

SYNTHETIC_PRIVATE_KEY = ec.generate_private_key(ec.SECP256R1())


def p256_coordinates(private_key):
    numbers = private_key.public_key().public_numbers()
    return (
        base64.urlsafe_b64encode(numbers.x.to_bytes(32, "big")).rstrip(b"=").decode(),
        base64.urlsafe_b64encode(numbers.y.to_bytes(32, "big")).rstrip(b"=").decode(),
    )


def webhook_key(private_key, *, kid=SYNTHETIC_KID, **overrides):
    x, y = p256_coordinates(private_key)
    members = {
        "kid": kid,
        "kty": "EC",
        "crv": "P-256",
        "alg": "ES256",
        "use": "sig",
        "x": x,
        "y": y,
    }
    members.update(overrides)
    return WebhookVerificationKey(**members)


class FakeProviderKey:
    """Duck-typed provider key object for malformed-member cases."""

    def __init__(self, **members):
        self.__dict__.update(members)


class FakeKeyResponse:
    """Minimal provider response object carrying one key member."""

    def __init__(self, key):
        self.key = key


def sign_webhook(
    private_key,
    body,
    *,
    kid=SYNTHETIC_KID,
    iat=FIXED_NOW,
    exp=_OMIT,
    digest=None,
    omit_digest=False,
    extra_claims=None,
    algorithm="ES256",
    headers=None,
):
    payload = {}
    if iat is not None:
        payload["iat"] = iat
    if not omit_digest:
        payload["request_body_sha256"] = (
            digest if digest is not None else hashlib.sha256(body).hexdigest()
        )
    if exp is not _OMIT:
        payload["exp"] = exp
    if extra_claims:
        payload.update(extra_claims)
    return jwt.encode(
        payload,
        private_key,
        algorithm=algorithm,
        headers=headers if headers is not None else {"kid": kid},
    )


def manual_token(header, payload):
    """Build an unsigned JWT-shaped token for header-shape tests."""

    def segment(value):
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    return f"{segment(header)}.{segment(payload)}."


class FakeKeyGateway:
    """Injected gateway stand-in returning per-kid keys and counting fetches."""

    def __init__(self, keys=None, error=None):
        self.keys = dict(keys or {})
        self.error = error
        self.fetched_kids = []

    def get_webhook_verification_key(self, key_id):
        self.fetched_kids.append(key_id)
        if self.error is not None:
            raise self.error
        key = self.keys.get(key_id)
        if key is None:
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
        return key


def sdk_jwk(private_key, *, kid=SYNTHETIC_KID, **overrides):
    x, y = p256_coordinates(private_key)
    members = {
        "alg": "ES256",
        "crv": "P-256",
        "kid": kid,
        "kty": "EC",
        "use": "sig",
        "x": x,
        "y": y,
        "created_at": FIXED_NOW,
        "expired_at": None,
    }
    members.update(overrides)
    return JWKPublicKey(**members)


class FakeKeyApi:
    """Records the real SDK request objects without any network access."""

    def __init__(self, *, response=None, error=None):
        self.response = response
        self.error = error
        self.key_calls = []

    def webhook_verification_key_get(
        self, *, webhook_verification_key_get_request, _request_timeout=None
    ):
        self.key_calls.append((webhook_verification_key_get_request, _request_timeout))
        if self.error is not None:
            raise self.error
        return self.response


def gateway_for(plaid_api):
    return PlaidGateway(
        plaid_api,
        client_id=SYNTHETIC_CLIENT_ID,
        secret=SYNTHETIC_SECRET,
    )


def api_error(status_code, body_payload):
    error = ApiException(status=status_code, reason="PROVIDER", http_resp=None)
    error.body = json.dumps(body_payload)
    return error


class WebhookGatewayKeyFetchTests(SimpleTestCase):
    def test_fetch_builds_exact_sdk_request_with_client_secret_and_timeout(self):
        fake_api = FakeKeyApi(
            response=WebhookVerificationKeyGetResponse(
                key=sdk_jwk(SYNTHETIC_PRIVATE_KEY),
                request_id="request-synthetic-0001",
            )
        )

        result = gateway_for(fake_api).get_webhook_verification_key(SYNTHETIC_KID)

        self.assertEqual(len(fake_api.key_calls), 1)
        request, timeout = fake_api.key_calls[0]
        self.assertIsInstance(request, WebhookVerificationKeyGetRequest)
        self.assertEqual(request.key_id, SYNTHETIC_KID)
        self.assertEqual(request.client_id, SYNTHETIC_CLIENT_ID)
        self.assertEqual(request.secret, SYNTHETIC_SECRET)
        self.assertEqual(timeout, PLAID_REQUEST_TIMEOUT_SECONDS)
        x, y = p256_coordinates(SYNTHETIC_PRIVATE_KEY)
        self.assertEqual(result.kid, SYNTHETIC_KID)
        self.assertEqual(result.kty, "EC")
        self.assertEqual(result.crv, "P-256")
        self.assertEqual(result.alg, "ES256")
        self.assertEqual(result.use, "sig")
        self.assertEqual(result.x, x)
        self.assertEqual(result.y, y)

    def test_fetch_normalizes_real_sdk_response_into_repr_safe_value(self):
        response = WebhookVerificationKeyGetResponse(
            key=sdk_jwk(SYNTHETIC_PRIVATE_KEY),
            request_id="request-synthetic-0001",
        )

        result = gateway_for(
            FakeKeyApi(response=response)
        ).get_webhook_verification_key(SYNTHETIC_KID)

        self.assertIsInstance(result, WebhookVerificationKey)
        x, y = p256_coordinates(SYNTHETIC_PRIVATE_KEY)
        self.assertNotIn(x, repr(result))
        self.assertNotIn(y, repr(result))
        self.assertNotIn(x, str(result))
        self.assertNotIn(y, str(result))

    def test_fetch_rejects_invalid_requested_kid_without_provider_call(self):
        for key_id in ("", None, 123, b"kid-bytes"):
            with self.subTest(key_id=key_id):
                fake_api = FakeKeyApi(
                    response=WebhookVerificationKeyGetResponse(
                        key=sdk_jwk(SYNTHETIC_PRIVATE_KEY),
                        request_id="request-synthetic-0001",
                    )
                )
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(fake_api).get_webhook_verification_key(key_id)
                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)
                self.assertEqual(fake_api.key_calls, [])

    def test_fetch_rejects_mismatched_returned_kid(self):
        response = WebhookVerificationKeyGetResponse(
            key=sdk_jwk(SYNTHETIC_PRIVATE_KEY, kid=OTHER_KID),
            request_id="request-synthetic-0001",
        )

        with self.assertRaises(PlaidGatewayError) as raised:
            gateway_for(FakeKeyApi(response=response)).get_webhook_verification_key(
                SYNTHETIC_KID
            )

        self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_fetch_rejects_missing_or_malformed_response_key(self):
        malformed_responses = [
            FakeKeyResponse(FakeProviderKey()),
            FakeKeyResponse(None),
            FakeProviderKey(),
        ]
        for response in malformed_responses:
            with self.subTest(response=response):
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(
                        FakeKeyApi(response=response)
                    ).get_webhook_verification_key(SYNTHETIC_KID)
                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_fetch_rejects_jwk_members_not_suitable_for_es256(self):
        malformed_members = [
            {"kty": "RSA"},
            {"kty": None},
            {"crv": "P-384"},
            {"crv": None},
            {"alg": "ES256K"},
            {"alg": "none"},
            {"alg": None},
            {"use": "enc"},
            {"x": ""},
            {"y": ""},
            {"x": 12345},
            {"y": 12345},
            {"kid": ""},
            {"kid": OTHER_KID},
            {"kid": None},
        ]
        for overrides in malformed_members:
            with self.subTest(overrides=overrides):
                members = sdk_jwk(SYNTHETIC_PRIVATE_KEY).to_dict()
                members.update(overrides)
                key = FakeProviderKey(**members)
                with self.assertRaises(PlaidGatewayError) as raised:
                    gateway_for(
                        FakeKeyApi(response=FakeKeyResponse(key))
                    ).get_webhook_verification_key(SYNTHETIC_KID)
                self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_fetch_rejects_coordinates_that_are_not_p256_points(self):
        bad_coordinates = [
            "not-base64!",
            "A",
            base64.urlsafe_b64encode(b"short").rstrip(b"=").decode(),
            base64.urlsafe_b64encode(b"\x00" * 33).rstrip(b"=").decode(),
        ]
        for value in bad_coordinates:
            for member in ("x", "y"):
                with self.subTest(member=member, value=value):
                    overrides = {member: value}
                    members = sdk_jwk(SYNTHETIC_PRIVATE_KEY).to_dict()
                    members.update(overrides)
                    key = FakeProviderKey(**members)
                    with self.assertRaises(PlaidGatewayError) as raised:
                        gateway_for(
                            FakeKeyApi(response=FakeKeyResponse(key))
                        ).get_webhook_verification_key(SYNTHETIC_KID)
                    self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_fetch_rejects_coordinates_with_non_base64url_characters(self):
        valid_x, valid_y = p256_coordinates(SYNTHETIC_PRIVATE_KEY)
        polluted_values = [
            valid_x + "!!!!",
            valid_x + " \t",
            valid_x + "\n",
            " " + valid_x,
            valid_x[:10] + "+" + valid_x[11:],
            valid_x[:10] + "/" + valid_x[11:],
        ]
        for value in polluted_values:
            for member in ("x", "y"):
                with self.subTest(member=member, value=value):
                    members = sdk_jwk(SYNTHETIC_PRIVATE_KEY).to_dict()
                    members[member] = value
                    key = FakeProviderKey(**members)
                    with self.assertRaises(PlaidGatewayError) as raised:
                        gateway_for(
                            FakeKeyApi(response=FakeKeyResponse(key))
                        ).get_webhook_verification_key(SYNTHETIC_KID)
                    self.assertEqual(str(raised.exception), PLAID_UNAVAILABLE_DETAIL)

    def test_fetch_accepts_unpadded_clean_coordinates(self):
        valid_x, valid_y = p256_coordinates(SYNTHETIC_PRIVATE_KEY)
        result = gateway_for(
            FakeKeyApi(
                response=FakeKeyResponse(
                    FakeProviderKey(**sdk_jwk(SYNTHETIC_PRIVATE_KEY).to_dict())
                )
            )
        ).get_webhook_verification_key(SYNTHETIC_KID)

        self.assertEqual(result.x, valid_x)
        self.assertEqual(result.y, valid_y)

    def test_fetch_accepts_missing_use_member(self):
        key = FakeProviderKey(**sdk_jwk(SYNTHETIC_PRIVATE_KEY).to_dict())
        del key.use

        result = gateway_for(
            FakeKeyApi(response=FakeKeyResponse(key))
        ).get_webhook_verification_key(SYNTHETIC_KID)

        self.assertIsNone(result.use)

    def test_fetch_provider_transport_and_timeout_failures_are_fixed_and_safe(self):
        for error in (
            api_error(
                500,
                {
                    "error_type": "API_ERROR",
                    "error_code": "PROVIDER_ERROR",
                    "error_message": (f"{RAW_PROVIDER_BODY_MARKER} {SYNTHETIC_SECRET}"),
                },
            ),
            TimeoutError("Connection timed out"),
            ProtocolError("Connection aborted."),
        ):
            with self.subTest(error=error):
                with self.assertLogs(
                    "plaid_integration.gateway", level=logging.WARNING
                ) as captured:
                    with self.assertRaises(PlaidGatewayError) as raised:
                        gateway_for(
                            FakeKeyApi(error=error)
                        ).get_webhook_verification_key(SYNTHETIC_KID)

                exception = raised.exception
                self.assertEqual(str(exception), PLAID_UNAVAILABLE_DETAIL)
                self.assertIsNone(exception.__cause__)
                formatted = "".join(traceback.format_exception(exception))
                for forbidden in (
                    RAW_PROVIDER_BODY_MARKER,
                    SYNTHETIC_SECRET,
                    SYNTHETIC_KID,
                ):
                    self.assertNotIn(forbidden, str(exception))
                    self.assertNotIn(forbidden, repr(exception))
                    self.assertNotIn(forbidden, formatted)
                self.assertNotIn(RAW_PROVIDER_BODY_MARKER, "\n".join(captured.output))
                self.assertNotIn(SYNTHETIC_SECRET, "\n".join(captured.output))

    def test_normalize_rejects_invalid_expected_kid(self):
        key = webhook_key(SYNTHETIC_PRIVATE_KEY)
        for expected_kid in ("", None, 123):
            with self.subTest(expected_kid=expected_kid):
                self.assertIsNone(
                    normalize_webhook_verification_key(key, expected_kid=expected_kid)
                )

    def test_normalize_revalidates_already_normalized_value(self):
        key = webhook_key(SYNTHETIC_PRIVATE_KEY)

        normalized = normalize_webhook_verification_key(key, expected_kid=SYNTHETIC_KID)

        self.assertEqual(normalized, key)
        self.assertIsNone(
            normalize_webhook_verification_key(key, expected_kid=OTHER_KID)
        )


class WebhookVerificationSuccessTests(TestCase):
    def setUp(self):
        reset_webhook_key_cache()

    def tearDown(self):
        reset_webhook_key_cache()

    def test_verified_claims_from_real_es256_signature(self):
        body = (
            b'{"webhook_type":"TRANSACTIONS",'
            b'"webhook_code":"SYNC_UPDATES_AVAILABLE","item_id":"item-1"}'
        )
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body)

        claims = verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)

        self.assertIsInstance(claims, VerifiedWebhookClaims)
        self.assertEqual(claims.kid, SYNTHETIC_KID)
        self.assertEqual(claims.iat, FIXED_NOW)
        self.assertEqual(claims.idempotency_key, hashlib.sha256(body).hexdigest())
        self.assertEqual(gateway.fetched_kids, [SYNTHETIC_KID])
        payload = jwt.decode(header, options={"verify_signature": False})
        self.assertEqual(claims.idempotency_key, payload["request_body_sha256"])

    def test_exact_raw_body_bytes_are_hashed_without_normalization(self):
        body = b'{\n  "webhook_type": "TRANSACTIONS"\n}\n'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})

        claims = verify_plaid_webhook(
            body,
            sign_webhook(SYNTHETIC_PRIVATE_KEY, body),
            gateway=gateway,
            now=FIXED_NOW,
        )

        self.assertEqual(claims.idempotency_key, hashlib.sha256(body).hexdigest())
        self.assertNotEqual(
            claims.idempotency_key,
            hashlib.sha256(body.strip()).hexdigest(),
        )

    def test_raw_body_that_is_not_json_still_verifies_without_body_parsing(self):
        body = b"\x00\xff this is not json at all {"
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})

        claims = verify_plaid_webhook(
            body,
            sign_webhook(SYNTHETIC_PRIVATE_KEY, body),
            gateway=gateway,
            now=FIXED_NOW,
        )

        self.assertEqual(claims.idempotency_key, hashlib.sha256(body).hexdigest())

    def test_present_unexpired_exp_is_accepted(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body, exp=FIXED_NOW + 60)

        claims = verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)

        self.assertEqual(claims.iat, FIXED_NOW)

    def test_default_now_uses_current_time(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        iat = int(time.time())
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body, iat=iat)

        claims = verify_plaid_webhook(body, header, gateway=gateway)

        self.assertEqual(claims.iat, iat)

    def test_programmer_defect_is_not_swallowed(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body)

        with self.assertRaises(TypeError):
            verify_plaid_webhook(
                "not-bytes",
                header,
                gateway=gateway,
                now=FIXED_NOW,
            )

    def test_success_performs_no_database_writes(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        before = (
            PlaidConnection.objects.count(),
            PlaidWebhookEvent.objects.count(),
        )

        verify_plaid_webhook(
            body,
            sign_webhook(SYNTHETIC_PRIVATE_KEY, body),
            gateway=gateway,
            now=FIXED_NOW,
        )

        after = (
            PlaidConnection.objects.count(),
            PlaidWebhookEvent.objects.count(),
        )
        self.assertEqual(before, after)


class WebhookVerificationFailureTests(TestCase):
    BODY = b'{"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE"}'

    def setUp(self):
        reset_webhook_key_cache()

    def tearDown(self):
        reset_webhook_key_cache()

    def assert_verification_failure(
        self,
        header,
        *,
        body=BODY,
        gateway=None,
        markers=(),
        expect_fetch=False,
        now=FIXED_NOW,
    ):
        if gateway is None:
            gateway = FakeKeyGateway()
        before = (
            PlaidConnection.objects.count(),
            PlaidWebhookEvent.objects.count(),
        )
        with self.assertRaises(PlaidWebhookVerificationError) as raised:
            verify_plaid_webhook(body, header, gateway=gateway, now=now)
        exception = raised.exception
        self.assertEqual(str(exception), WEBHOOK_VERIFICATION_FAILED_DETAIL)
        after = (
            PlaidConnection.objects.count(),
            PlaidWebhookEvent.objects.count(),
        )
        self.assertEqual(before, after)
        self.assertIsNone(exception.__cause__)
        self.assertIsNone(exception.__context__)
        formatted = "".join(traceback.format_exception(exception))
        for marker in markers:
            self.assertNotIn(marker, str(exception))
            self.assertNotIn(marker, repr(exception))
            self.assertNotIn(marker, formatted)
        if not expect_fetch:
            self.assertEqual(gateway.fetched_kids, [])
        return gateway

    def test_missing_or_empty_verification_header_fails_before_gateway(self):
        for header in (None, "", "   "):
            with self.subTest(header=header):
                self.assert_verification_failure(header)

    def test_malformed_jwt_fails_before_gateway(self):
        for header in (
            "not-a-jwt",
            "abc.def.ghi",
            "....",
            "eyJhbGciOiJFUzI1NiJ9.not-json.",
        ):
            with self.subTest(header=header):
                self.assert_verification_failure(header)

    def test_wrong_algorithm_is_rejected_before_gateway(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = jwt.encode(
            {"iat": FIXED_NOW, "request_body_sha256": "0" * 64},
            "s" * 64,
            algorithm="HS256",
            headers={"kid": SYNTHETIC_KID},
        )

        self.assert_verification_failure(header, body=body, gateway=gateway)

    def test_none_algorithm_is_rejected_before_gateway(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = manual_token(
            {"alg": "none", "kid": SYNTHETIC_KID},
            {"iat": FIXED_NOW, "request_body_sha256": "0" * 64},
        )

        self.assert_verification_failure(header, body=body, gateway=gateway)

    def test_missing_kid_is_rejected_before_gateway(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = manual_token(
            {"alg": "ES256"},
            {"iat": FIXED_NOW, "request_body_sha256": "0" * 64},
        )

        self.assert_verification_failure(header, body=body, gateway=gateway)

    def test_non_string_kid_is_rejected_before_gateway(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = manual_token(
            {"alg": "ES256", "kid": 12345},
            {"iat": FIXED_NOW, "request_body_sha256": "0" * 64},
        )

        self.assert_verification_failure(header, body=body, gateway=gateway)

    def test_oversized_kid_is_rejected_before_gateway(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = sign_webhook(
            SYNTHETIC_PRIVATE_KEY,
            body,
            kid="k" * (WEBHOOK_KID_MAX_LENGTH + 1),
        )

        self.assert_verification_failure(header, body=body, gateway=gateway)

    def test_malicious_header_markers_never_leak_before_gateway(self):
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = manual_token(
            {"alg": "RS256", "kid": SYNTHETIC_KID},
            {"iat": FIXED_NOW, "marker": JWT_MARKER},
        )

        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(JWT_MARKER, RAW_BODY_MARKER),
        )

    def test_unknown_kid_gateway_failure_collapses_to_fixed_error(self):
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY)
        gateway = FakeKeyGateway(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))

        gateway = self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(JWT_MARKER, RAW_BODY_MARKER),
            expect_fetch=True,
        )

        self.assertEqual(gateway.fetched_kids, [SYNTHETIC_KID])

    def test_mismatched_returned_kid_is_rejected(self):
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY)
        gateway = FakeKeyGateway(
            {SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY, kid=OTHER_KID)}
        )

        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(JWT_MARKER, RAW_BODY_MARKER),
            expect_fetch=True,
        )

    def test_malformed_returned_jwk_is_rejected(self):
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY)
        malformed_keys = [
            webhook_key(SYNTHETIC_PRIVATE_KEY, kty="RSA"),
            webhook_key(SYNTHETIC_PRIVATE_KEY, crv="P-384"),
            webhook_key(SYNTHETIC_PRIVATE_KEY, alg="ES256K"),
            webhook_key(SYNTHETIC_PRIVATE_KEY, use="enc"),
            webhook_key(SYNTHETIC_PRIVATE_KEY, x=COORDINATE_MARKER),
            webhook_key(SYNTHETIC_PRIVATE_KEY, y=""),
        ]
        for key in malformed_keys:
            with self.subTest(key=key):
                gateway = FakeKeyGateway({SYNTHETIC_KID: key})
                self.assert_verification_failure(
                    header,
                    gateway=gateway,
                    markers=(COORDINATE_MARKER, RAW_BODY_MARKER),
                    expect_fetch=True,
                )

    def test_returned_key_with_unusable_curve_point_is_never_cached(self):
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY)
        zero = base64.urlsafe_b64encode(b"\x00" * 32).rstrip(b"=").decode()
        gateway = FakeKeyGateway(
            {SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY, x=zero)}
        )

        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(RAW_BODY_MARKER, JWT_MARKER),
            expect_fetch=True,
        )
        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(RAW_BODY_MARKER, JWT_MARKER),
            expect_fetch=True,
        )
        self.assertEqual(gateway.fetched_kids, [SYNTHETIC_KID, SYNTHETIC_KID])

    def test_bad_signature_fails_after_key_fetch(self):
        other_key = ec.generate_private_key(ec.SECP256R1())
        header = sign_webhook(other_key, self.BODY)
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})

        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(JWT_MARKER, RAW_BODY_MARKER),
            expect_fetch=True,
        )

    def test_stale_iat_is_rejected(self):
        header = sign_webhook(
            SYNTHETIC_PRIVATE_KEY,
            self.BODY,
            iat=FIXED_NOW - WEBHOOK_IAT_MAX_AGE_SECONDS - 1,
        )
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})

        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(JWT_MARKER, RAW_BODY_MARKER),
            expect_fetch=True,
        )

    def test_future_iat_is_rejected(self):
        header = sign_webhook(
            SYNTHETIC_PRIVATE_KEY,
            self.BODY,
            iat=FIXED_NOW + WEBHOOK_IAT_FUTURE_ALLOWANCE_SECONDS + 1,
        )
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})

        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(JWT_MARKER, RAW_BODY_MARKER),
            expect_fetch=True,
        )

    def test_present_expired_exp_is_rejected(self):
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        for exp in (FIXED_NOW, FIXED_NOW - 1):
            with self.subTest(exp=exp):
                header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY, exp=exp)
                self.assert_verification_failure(
                    header,
                    gateway=gateway,
                    markers=(JWT_MARKER, RAW_BODY_MARKER),
                    expect_fetch=True,
                )

    def test_missing_iat_is_rejected(self):
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY, iat=None)
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})

        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(JWT_MARKER, RAW_BODY_MARKER),
            expect_fetch=True,
        )

    def test_malformed_iat_is_rejected(self):
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        for iat in (str(FIXED_NOW), float(FIXED_NOW), True, None, "1"):
            with self.subTest(iat=iat):
                header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY, iat=iat)
                self.assert_verification_failure(
                    header,
                    gateway=gateway,
                    markers=(JWT_MARKER, RAW_BODY_MARKER),
                    expect_fetch=True,
                )

    def test_malformed_exp_is_rejected(self):
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        for exp in (str(FIXED_NOW), float(FIXED_NOW), True, None):
            with self.subTest(exp=exp):
                header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY, exp=exp)
                self.assert_verification_failure(
                    header,
                    gateway=gateway,
                    markers=(JWT_MARKER, RAW_BODY_MARKER),
                    expect_fetch=True,
                )

    def test_missing_request_body_sha256_is_rejected(self):
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY, omit_digest=True)
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})

        self.assert_verification_failure(
            header,
            gateway=gateway,
            markers=(JWT_MARKER, RAW_BODY_MARKER),
            expect_fetch=True,
        )

    def test_malformed_request_body_sha256_is_rejected(self):
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        for digest in (
            "abc",
            "0" * 63,
            "A" * 64,
            "z" * 64,
            "0" * 64 + "0",
            hashlib.sha256(self.BODY).hexdigest().upper(),
        ):
            with self.subTest(digest=digest):
                header = sign_webhook(SYNTHETIC_PRIVATE_KEY, self.BODY, digest=digest)
                self.assert_verification_failure(
                    header,
                    gateway=gateway,
                    markers=(JWT_MARKER, RAW_BODY_MARKER),
                    expect_fetch=True,
                )

    def test_body_hash_mismatch_is_rejected(self):
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        body = b'{"webhook_type":"TRANSACTIONS"}'
        other_body = b'{"webhook_type": "TRANSACTIONS"}'
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body)

        self.assert_verification_failure(
            header,
            body=other_body,
            gateway=gateway,
            markers=(RAW_BODY_MARKER,),
            expect_fetch=True,
        )

    def test_whitespace_sensitive_digest_mismatch_is_rejected(self):
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        body = b'{"a":1}'
        normalized_other = b'{"a": 1}'
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body)

        self.assert_verification_failure(
            header,
            body=normalized_other,
            gateway=gateway,
            markers=(RAW_BODY_MARKER,),
            expect_fetch=True,
        )

    def test_failure_repr_is_fixed_and_payload_free(self):
        header = sign_webhook(
            SYNTHETIC_PRIVATE_KEY,
            self.BODY,
            extra_claims={"marker": JWT_MARKER},
        )
        gateway = FakeKeyGateway(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))

        with self.assertRaises(PlaidWebhookVerificationError) as raised:
            verify_plaid_webhook(self.BODY, header, gateway=gateway, now=FIXED_NOW)

        self.assertIn(WEBHOOK_VERIFICATION_FAILED_DETAIL, repr(raised.exception))
        self.assertNotIn(JWT_MARKER, repr(raised.exception))
        self.assertNotIn(RAW_BODY_MARKER, repr(raised.exception))


class WebhookTimeBoundaryTests(TestCase):
    def setUp(self):
        reset_webhook_key_cache()

    def tearDown(self):
        reset_webhook_key_cache()

    def verify(self, *, iat=FIXED_NOW, exp=_OMIT):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body, iat=iat, exp=exp)
        return verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)

    def test_iat_exactly_max_age_old_is_accepted(self):
        claims = self.verify(iat=FIXED_NOW - WEBHOOK_IAT_MAX_AGE_SECONDS)
        self.assertEqual(claims.iat, FIXED_NOW - WEBHOOK_IAT_MAX_AGE_SECONDS)

    def test_iat_one_second_older_is_rejected(self):
        with self.assertRaises(PlaidWebhookVerificationError):
            self.verify(iat=FIXED_NOW - WEBHOOK_IAT_MAX_AGE_SECONDS - 1)

    def test_iat_exactly_future_allowance_is_accepted(self):
        claims = self.verify(iat=FIXED_NOW + WEBHOOK_IAT_FUTURE_ALLOWANCE_SECONDS)
        self.assertEqual(claims.iat, FIXED_NOW + WEBHOOK_IAT_FUTURE_ALLOWANCE_SECONDS)

    def test_iat_one_second_more_future_is_rejected(self):
        with self.assertRaises(PlaidWebhookVerificationError):
            self.verify(iat=FIXED_NOW + WEBHOOK_IAT_FUTURE_ALLOWANCE_SECONDS + 1)

    def test_exp_at_now_is_rejected(self):
        with self.assertRaises(PlaidWebhookVerificationError):
            self.verify(exp=FIXED_NOW)

    def test_exp_one_second_after_now_is_accepted(self):
        claims = self.verify(exp=FIXED_NOW + 1)
        self.assertEqual(claims.iat, FIXED_NOW)


class WebhookKeyCacheTests(TestCase):
    def setUp(self):
        reset_webhook_key_cache()

    def tearDown(self):
        reset_webhook_key_cache()

    def test_default_cache_capacity_is_the_fixed_small_cap(self):
        self.assertEqual(WEBHOOK_KEY_CACHE_CAPACITY, 32)

    def test_cache_hit_avoids_second_provider_fetch(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body)

        verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)
        verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)

        self.assertEqual(gateway.fetched_kids, [SYNTHETIC_KID])

    def test_reset_hook_forces_a_refetch(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body)

        verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)
        reset_webhook_key_cache()
        verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)

        self.assertEqual(gateway.fetched_kids, [SYNTHETIC_KID, SYNTHETIC_KID])

    def test_bounded_eviction_evicts_the_least_recently_used_kid(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        kids = ["kid-cache-0001", "kid-cache-0002", "kid-cache-0003"]
        keys = [ec.generate_private_key(ec.SECP256R1()) for _ in kids]
        gateway = FakeKeyGateway(
            {
                kid: webhook_key(key, kid=kid)
                for kid, key in zip(kids, keys, strict=True)
            }
        )
        tokens = {
            kid: sign_webhook(key, body, kid=kid)
            for kid, key in zip(kids, keys, strict=True)
        }

        with patch.object(webhook_verification, "WEBHOOK_KEY_CACHE_CAPACITY", 2):
            for kid in kids:
                verify_plaid_webhook(body, tokens[kid], gateway=gateway, now=FIXED_NOW)
            verify_plaid_webhook(body, tokens[kids[0]], gateway=gateway, now=FIXED_NOW)
            verify_plaid_webhook(body, tokens[kids[2]], gateway=gateway, now=FIXED_NOW)

        self.assertEqual(
            gateway.fetched_kids,
            [kids[0], kids[1], kids[2], kids[0]],
        )

    def test_failed_fetch_is_never_cached_and_is_retried(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        gateway = FakeKeyGateway(
            {SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)},
            error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL),
        )
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body)

        with self.assertRaises(PlaidWebhookVerificationError):
            verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)
        gateway.error = None
        claims = verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)

        self.assertEqual(claims.iat, FIXED_NOW)
        self.assertEqual(gateway.fetched_kids, [SYNTHETIC_KID, SYNTHETIC_KID])

    def test_malformed_fetched_key_is_never_cached(self):
        body = b'{"webhook_type":"TRANSACTIONS"}'
        header = sign_webhook(SYNTHETIC_PRIVATE_KEY, body)

        class RecoveringGateway(FakeKeyGateway):
            def __init__(self):
                super().__init__({SYNTHETIC_KID: webhook_key(SYNTHETIC_PRIVATE_KEY)})
                self.malformed = webhook_key(SYNTHETIC_PRIVATE_KEY, kty="RSA")
                self.calls = 0

            def get_webhook_verification_key(self, key_id):
                self.calls += 1
                if self.calls == 1:
                    return self.malformed
                return super().get_webhook_verification_key(key_id)

        gateway = RecoveringGateway()

        with self.assertRaises(PlaidWebhookVerificationError):
            verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)
        claims = verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)

        self.assertEqual(claims.iat, FIXED_NOW)
        self.assertEqual(gateway.calls, 2)


class WebhookVerificationLogTests(SimpleTestCase):
    def setUp(self):
        reset_webhook_key_cache()

    def tearDown(self):
        reset_webhook_key_cache()

    def test_failure_logs_only_reason_and_key_id(self):
        body = f'{{"webhook_type":"{RAW_BODY_MARKER}"}}'.encode()
        header = sign_webhook(
            SYNTHETIC_PRIVATE_KEY,
            body,
            extra_claims={"marker": JWT_MARKER},
        )
        gateway = FakeKeyGateway(error=PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL))

        with self.assertLogs(
            "plaid_integration.webhook_verification", level=logging.WARNING
        ) as captured:
            with self.assertRaises(PlaidWebhookVerificationError):
                verify_plaid_webhook(body, header, gateway=gateway, now=FIXED_NOW)

        log_text = "\n".join(captured.output)
        self.assertIn(SYNTHETIC_KID, log_text)
        for forbidden in (
            RAW_BODY_MARKER,
            JWT_MARKER,
            hashlib.sha256(body).hexdigest(),
        ):
            self.assertNotIn(forbidden, log_text)

    def test_header_failure_logs_no_untrusted_kid_or_body(self):
        body = f'{{"webhook_type":"{RAW_BODY_MARKER}"}}'.encode()
        header = manual_token(
            {"alg": "RS256", "kid": JWT_MARKER},
            {"iat": FIXED_NOW, "request_body_sha256": "0" * 64},
        )

        with self.assertLogs(
            "plaid_integration.webhook_verification", level=logging.WARNING
        ) as captured:
            with self.assertRaises(PlaidWebhookVerificationError):
                verify_plaid_webhook(
                    body,
                    header,
                    gateway=FakeKeyGateway(),
                    now=FIXED_NOW,
                )

        log_text = "\n".join(captured.output)
        self.assertNotIn(JWT_MARKER, log_text)
        self.assertNotIn(RAW_BODY_MARKER, log_text)
