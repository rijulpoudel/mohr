"""Focused tests for the Google OpenID Connect sign-in boundary (issue #120).

Every provider double below is a locally generated RSA key and a locally
signed JWT/JWKS. No request leaves the process, no Google credential is
read, and the verifier under test is the real ``users.google`` code path.
"""

import base64
import threading
from datetime import timedelta
from unittest import mock
from urllib.parse import parse_qs, urlparse

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.db import connections
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework import status
from rest_framework.test import APIClient, APITestCase

from users import google

GOOGLE_OVERRIDES = {
    "GOOGLE_AUTH_ENABLED": True,
    "GOOGLE_CLIENT_ID": "synthetic-client-id",
    "GOOGLE_CLIENT_SECRET": "synthetic-client-secret",
    "GOOGLE_REDIRECT_URI": "http://localhost/api/auth/google/callback/",
}


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_int(value: int) -> str:
    length = (value.bit_length() + 7) // 8
    return _b64url(value.to_bytes(length, "big"))


class FakeGoogle:
    """A synthetic Google OIDC provider keyed by a local RSA private key."""

    def __init__(self):
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        numbers = self.key.public_key().public_numbers()
        self.kid = "synthetic-test-key-1"
        self.jwk = {
            "kty": "RSA",
            "kid": self.kid,
            "use": "sig",
            "alg": "RS256",
            "n": _b64url_int(numbers.n),
            "e": _b64url_int(numbers.e),
        }

    @property
    def jwks(self):
        return [self.jwk]

    def sign(
        self,
        *,
        sub="synthetic-sub-1",
        email="new-google@example.com",
        aud=None,
        iss="https://accounts.google.com",
        nonce="synthetic-nonce",
        exp_delta=timedelta(minutes=5),
        iat_delta=timedelta(0),
        email_verified=True,
        key=None,
        kid=None,
        include=("exp", "iat", "aud", "iss", "sub", "nonce", "email", "email_verified"),
        extra=None,
    ):
        now = timezone.now()
        claims = {
            "exp": int((now + exp_delta).timestamp()),
            "iat": int((now + iat_delta).timestamp()),
            "aud": settings.GOOGLE_CLIENT_ID if aud is None else aud,
            "iss": iss,
            "sub": sub,
            "nonce": nonce,
            "email": email,
            "email_verified": email_verified,
        }
        payload = {name: claims[name] for name in include}
        if extra:
            payload.update(extra)
        return jwt.encode(
            payload,
            key if key is not None else self.key,
            algorithm="RS256",
            headers={"kid": kid if kid is not None else self.kid},
        )


@override_settings(**GOOGLE_OVERRIDES)
class GoogleTokenVerificationTests(SimpleTestCase):
    def setUp(self):
        self.fake = FakeGoogle()
        self.nonce = "synthetic-nonce"

    def verify(self, token, nonce=None):
        return google.verify_id_token(
            token, jwks=self.fake.jwks, nonce=self.nonce if nonce is None else nonce
        )

    def test_accepts_a_valid_signed_token(self):
        token = self.fake.sign(
            nonce=self.nonce, sub="sub-123", email="person@example.com"
        )

        claims = self.verify(token)

        self.assertEqual(claims, {"sub": "sub-123", "email": "person@example.com"})

    def test_rejects_a_token_signed_by_another_key(self):
        token = self.fake.sign(nonce=self.nonce, key=self.fake.other_key)

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_token_for_another_audience(self):
        token = self.fake.sign(nonce=self.nonce, aud="other-client-id")

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_an_audience_array_containing_the_client(self):
        token = self.fake.sign(
            nonce=self.nonce, aud=[settings.GOOGLE_CLIENT_ID, "other-client-id"]
        )

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_foreign_authorized_party(self):
        token = self.fake.sign(nonce=self.nonce, extra={"azp": "other-client-id"})

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_non_string_authorized_party(self):
        token = self.fake.sign(nonce=self.nonce, extra={"azp": 123})

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_accepts_a_matching_authorized_party(self):
        token = self.fake.sign(
            nonce=self.nonce, extra={"azp": settings.GOOGLE_CLIENT_ID}
        )

        claims = self.verify(token)

        self.assertEqual(claims["sub"], "synthetic-sub-1")

    def test_rejects_a_boolean_issued_at(self):
        token = self.fake.sign(nonce=self.nonce, extra={"iat": True})

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_non_integer_issued_at(self):
        token = self.fake.sign(nonce=self.nonce, extra={"iat": 1.5})

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_non_integer_expiry(self):
        future = int((timezone.now() + timedelta(minutes=5)).timestamp())
        token = self.fake.sign(nonce=self.nonce, extra={"exp": future + 0.5})

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_signed_non_scalar_time_claims(self):
        for claim_name in ("exp", "iat", "nbf"):
            for shape in ({}, []):
                with self.subTest(claim=claim_name, shape=type(shape).__name__):
                    token = self.fake.sign(nonce=self.nonce, extra={claim_name: shape})

                    with self.assertRaises(google.GoogleIdentityError):
                        self.verify(token)

    def test_rejects_a_token_from_another_issuer(self):
        token = self.fake.sign(nonce=self.nonce, iss="https://evil.example")

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_an_expired_token(self):
        token = self.fake.sign(nonce=self.nonce, exp_delta=timedelta(minutes=-5))

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_mismatched_nonce(self):
        token = self.fake.sign(nonce="other-nonce")

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_string_email_verified(self):
        token = self.fake.sign(nonce=self.nonce, email_verified="true")

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_missing_email_verified(self):
        token = self.fake.sign(
            nonce=self.nonce,
            include=("exp", "iat", "aud", "iss", "sub", "nonce", "email"),
        )

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_an_empty_subject(self):
        token = self.fake.sign(nonce=self.nonce, sub="")

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_an_oversized_subject(self):
        token = self.fake.sign(nonce=self.nonce, sub="a" * 256)

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_malformed_email(self):
        token = self.fake.sign(nonce=self.nonce, email="not-an-email")

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_an_unknown_key_id(self):
        token = self.fake.sign(nonce=self.nonce, kid="unknown-key-id")

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_an_unsecured_token(self):
        token = jwt.encode(
            {"sub": "sub", "email": "a@b.co", "aud": settings.GOOGLE_CLIENT_ID},
            key=None,
            algorithm="none",
            headers={"kid": self.fake.kid},
        )

        with self.assertRaises(google.GoogleIdentityError):
            self.verify(token)

    def test_rejects_a_malformed_token(self):
        with self.assertRaises(google.GoogleIdentityError):
            self.verify("not-a-jwt")


class GoogleDisabledTests(APITestCase):
    def test_config_disabled_is_public_and_reports_disabled(self):
        response = self.client.get(reverse("auth-google-config"))

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(response.data, {"enabled": False, "linked": False})

    def test_start_disabled_returns_service_unavailable_without_writes(self):
        response = self.client.post(
            reverse("auth-google-start"), {"intent": "sign-in"}, format="json"
        )

        self.assertEqual(response.status_code, status.HTTP_503_SERVICE_UNAVAILABLE)
        self.assertEqual(get_user_model().objects.count(), 0)

    def test_callback_disabled_redirects_to_failed_without_writes(self):
        response = self.client.get(
            reverse("auth-google-callback"),
            {"code": "synthetic-code", "state": "synthetic-state"},
        )

        self.assertEqual(response.status_code, status.HTTP_302_FOUND)
        self.assertEqual(response["Location"], "/login?google=failed")
        self.assertEqual(get_user_model().objects.count(), 0)


@override_settings(**GOOGLE_OVERRIDES)
class GoogleStartTests(APITestCase):
    def test_config_enabled_reports_link_state_for_the_actor(self):
        anonymous = self.client.get(reverse("auth-google-config"))
        self.assertEqual(anonymous.data, {"enabled": True, "linked": False})

        user = get_user_model().objects.create_user(
            email="linked@example.com", password="StrongTestPassword123!"
        )
        user.google_sub = "synthetic-linked-sub"
        user.save(update_fields=["google_sub"])
        self.client.force_login(user)

        linked = self.client.get(reverse("auth-google-config"))
        self.assertEqual(linked.data, {"enabled": True, "linked": True})

    def test_start_sign_in_returns_a_fixed_google_authorization_url(self):
        response = self.client.post(
            reverse("auth-google-start"),
            {"intent": "sign-in", "next": "/accounts"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertEqual(set(response.data.keys()), {"authorization_url"})
        parsed = urlparse(response.data["authorization_url"])
        query = parse_qs(parsed.query)
        self.assertEqual(parsed.scheme, "https")
        self.assertEqual(parsed.netloc, "accounts.google.com")
        self.assertEqual(parsed.path, "/o/oauth2/v2/auth")
        self.assertEqual(query["client_id"], ["synthetic-client-id"])
        self.assertEqual(
            query["redirect_uri"], [GOOGLE_OVERRIDES["GOOGLE_REDIRECT_URI"]]
        )
        self.assertEqual(query["response_type"], ["code"])
        self.assertEqual(query["scope"], ["openid email"])
        self.assertTrue(query["state"][0])
        self.assertTrue(query["nonce"][0])

    def test_start_creates_a_persisted_anonymous_session(self):
        self.client.post(
            reverse("auth-google-start"), {"intent": "sign-in"}, format="json"
        )

        self.assertIsNotNone(self.client.session.session_key)
        self.assertTrue(
            Session.objects.filter(session_key=self.client.session.session_key).exists()
        )
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_start_link_requires_authentication(self):
        response = self.client.post(
            reverse("auth-google-start"), {"intent": "link"}, format="json"
        )

        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_start_sign_in_refuses_an_existing_identity(self):
        user = get_user_model().objects.create_user(
            email="signed-in@example.com", password="StrongTestPassword123!"
        )
        self.client.force_login(user)

        response = self.client.post(
            reverse("auth-google-start"), {"intent": "sign-in"}, format="json"
        )

        self.assertEqual(response.status_code, status.HTTP_409_CONFLICT)
        self.assertEqual(int(self.client.session["_auth_user_id"]), user.id)

    def test_start_rejects_unknown_intent(self):
        response = self.client.post(
            reverse("auth-google-start"), {"intent": "merge"}, format="json"
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_start_rejects_a_non_object_payload_before_any_side_effect(self):
        for payload in ([{"intent": "sign-in"}], "sign-in", 7):
            with self.subTest(payload=payload):
                response = self.client.post(
                    reverse("auth-google-start"), payload, format="json"
                )

                self.assertEqual(
                    response.status_code, status.HTTP_400_BAD_REQUEST, response.data
                )
                self.assertNotIn(google.FLOW_SESSION_KEY, self.client.session)

    def test_start_rejects_an_unlisted_next_path(self):
        response = self.client.post(
            reverse("auth-google-start"),
            {"intent": "sign-in", "next": "https://evil.example/steal"},
            format="json",
        )

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)

    def test_start_requires_csrf_for_an_anonymous_caller(self):
        csrf_client = APIClient(enforce_csrf_checks=True)

        response = csrf_client.post(
            reverse("auth-google-start"), {"intent": "sign-in"}, format="json"
        )

        self.assertEqual(response.status_code, status.HTTP_403_FORBIDDEN)


@override_settings(**GOOGLE_OVERRIDES)
class GoogleCallbackTests(APITestCase):
    def setUp(self):
        self.fake = FakeGoogle()

    def _start(self, client, intent="sign-in", next_path="/"):
        response = client.post(
            reverse("auth-google-start"),
            {"intent": intent, "next": next_path},
            format="json",
        )
        self.assertEqual(response.status_code, status.HTTP_200_OK, response.data)
        query = parse_qs(urlparse(response.data["authorization_url"]).query)
        return query["state"][0], query["nonce"][0]

    def _callback(self, client, state, token, code="synthetic-code"):
        with (
            mock.patch.object(google, "exchange_code_for_tokens", return_value=token),
            mock.patch.object(google, "fetch_google_jwks", return_value=self.fake.jwks),
        ):
            return client.get(
                reverse("auth-google-callback"),
                {"code": code, "state": state},
            )

    def test_callback_creates_a_local_user_and_starts_a_session(self):
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-new", email="new-google@example.com"
        )

        response = self._callback(self.client, state, token)

        self.assertEqual(response.status_code, status.HTTP_302_FOUND)
        self.assertEqual(response["Location"], "/")
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response["Referrer-Policy"], "no-referrer")
        user = get_user_model().objects.get(google_sub="synthetic-sub-new")
        self.assertEqual(user.email, "new-google@example.com")
        self.assertFalse(user.has_usable_password())
        self.assertEqual(int(self.client.session["_auth_user_id"]), user.id)

    def test_callback_signs_in_a_known_google_subject(self):
        user = get_user_model().objects.create_user(
            email="known@example.com", password="StrongTestPassword123!"
        )
        user.google_sub = "synthetic-sub-known"
        user.save(update_fields=["google_sub"])
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-known", email="known@example.com"
        )

        response = self._callback(self.client, state, token)

        self.assertEqual(response.status_code, status.HTTP_302_FOUND)
        self.assertEqual(get_user_model().objects.count(), 1)
        user.refresh_from_db()
        self.assertTrue(user.has_usable_password())
        self.assertEqual(int(self.client.session["_auth_user_id"]), user.id)

    def test_callback_refuses_to_auto_link_an_existing_email(self):
        existing = get_user_model().objects.create_user(
            email="Person@example.com", password="StrongTestPassword123!"
        )
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-collision", email="person@example.com"
        )

        response = self._callback(self.client, state, token)

        self.assertEqual(response["Location"], "/login?google=link-required")
        existing.refresh_from_db()
        self.assertIsNone(existing.google_sub)
        self.assertEqual(get_user_model().objects.count(), 1)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_callback_rejects_an_inactive_local_user(self):
        user = get_user_model().objects.create_user(
            email="inactive@example.com", password="StrongTestPassword123!"
        )
        user.google_sub = "synthetic-sub-inactive"
        user.is_active = False
        user.save(update_fields=["google_sub", "is_active"])
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-inactive", email="inactive@example.com"
        )

        response = self._callback(self.client, state, token)

        self.assertEqual(response["Location"], "/login?google=failed")
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_state_mismatch_fails_without_erasing_the_valid_flow(self):
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-state", email="state@example.com"
        )

        rejected = self._callback(self.client, "wrong-state", token)
        self.assertEqual(rejected["Location"], "/login?google=failed")
        self.assertEqual(get_user_model().objects.count(), 0)

        accepted = self._callback(self.client, state, token)
        self.assertEqual(accepted.status_code, status.HTTP_302_FOUND)
        self.assertEqual(get_user_model().objects.count(), 1)

    def test_callback_consumes_the_flow_once(self):
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-replay", email="replay@example.com"
        )

        first = self._callback(self.client, state, token)
        second = self._callback(self.client, state, token)

        self.assertEqual(first.status_code, status.HTTP_302_FOUND)
        self.assertEqual(second["Location"], "/login?google=failed")
        self.assertEqual(
            get_user_model().objects.filter(google_sub="synthetic-sub-replay").count(),
            1,
        )

    def test_callback_rejects_missing_and_duplicate_parameters(self):
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-params", email="params@example.com"
        )
        with (
            mock.patch.object(google, "exchange_code_for_tokens", return_value=token),
            mock.patch.object(google, "fetch_google_jwks", return_value=self.fake.jwks),
        ):
            missing = self.client.get(reverse("auth-google-callback"))
            duplicate = self.client.get(
                reverse("auth-google-callback"),
                {"code": "c", "state": [state, state]},
            )
            oversized = self.client.get(
                reverse("auth-google-callback"),
                {"code": "c", "state": "s" * 600},
            )

        for response in (missing, duplicate, oversized):
            self.assertEqual(response["Location"], "/login?google=failed")
        self.assertEqual(get_user_model().objects.count(), 0)

    def test_callback_fails_safely_when_the_provider_is_unavailable(self):
        state, nonce = self._start(self.client)
        with (
            mock.patch.object(
                google,
                "exchange_code_for_tokens",
                side_effect=google.GoogleAuthUnavailable(),
            ),
            mock.patch.object(google, "fetch_google_jwks", return_value=self.fake.jwks),
        ):
            response = self.client.get(
                reverse("auth-google-callback"),
                {"code": "synthetic-code", "state": state},
            )

        self.assertEqual(response["Location"], "/login?google=failed")
        self.assertEqual(get_user_model().objects.count(), 0)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_callback_survives_non_scalar_time_claims_without_identity(self):
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce,
            sub="synthetic-sub-bad-time",
            email="bad-time@example.com",
            extra={"exp": {}},
        )

        response = self._callback(self.client, state, token)

        self.assertEqual(response["Location"], "/login?google=failed")
        self.assertEqual(get_user_model().objects.count(), 0)
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_callback_response_never_echoes_provider_parameters(self):
        state, nonce = self._start(self.client)
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-echo", email="echo@example.com"
        )

        response = self._callback(
            self.client, state, token, code="synthetic-code-value"
        )

        combined = response["Location"] + response.content.decode()
        self.assertNotIn("synthetic-code-value", combined)
        self.assertNotIn(state, combined)

    def test_link_binds_google_sub_to_the_current_actor(self):
        actor = get_user_model().objects.create_user(
            email="actor@example.com", password="StrongTestPassword123!"
        )
        self.client.force_login(actor)
        state, nonce = self._start(self.client, intent="link")
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-link", email="actor@example.com"
        )

        response = self._callback(self.client, state, token)

        self.assertEqual(response.status_code, status.HTTP_302_FOUND)
        actor.refresh_from_db()
        self.assertEqual(actor.google_sub, "synthetic-sub-link")
        self.assertEqual(actor.email, "actor@example.com")
        self.assertEqual(int(self.client.session["_auth_user_id"]), actor.id)

    def test_link_refuses_a_subject_owned_by_another_user(self):
        owner = get_user_model().objects.create_user(
            email="owner@example.com", password="StrongTestPassword123!"
        )
        owner.google_sub = "synthetic-sub-taken"
        owner.save(update_fields=["google_sub"])
        actor = get_user_model().objects.create_user(
            email="linker@example.com", password="StrongTestPassword123!"
        )
        self.client.force_login(actor)
        state, nonce = self._start(self.client, intent="link")
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-taken", email="linker@example.com"
        )

        response = self._callback(self.client, state, token)

        self.assertEqual(response["Location"], "/login?google=failed")
        actor.refresh_from_db()
        owner.refresh_from_db()
        self.assertIsNone(actor.google_sub)
        self.assertEqual(owner.google_sub, "synthetic-sub-taken")

    def test_link_refuses_to_replace_a_different_existing_subject(self):
        actor = get_user_model().objects.create_user(
            email="replace@example.com", password="StrongTestPassword123!"
        )
        actor.google_sub = "synthetic-sub-original"
        actor.save(update_fields=["google_sub"])
        self.client.force_login(actor)
        state, nonce = self._start(self.client, intent="link")
        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-replacement", email="replace@example.com"
        )

        response = self._callback(self.client, state, token)

        self.assertEqual(response["Location"], "/login?google=failed")
        actor.refresh_from_db()
        self.assertEqual(actor.google_sub, "synthetic-sub-original")

    def test_link_rejects_a_changed_session_actor(self):
        first = get_user_model().objects.create_user(
            email="first@example.com", password="StrongTestPassword123!"
        )
        second = get_user_model().objects.create_user(
            email="second@example.com", password="StrongTestPassword123!"
        )
        self.client.force_login(first)
        state, nonce = self._start(self.client, intent="link")

        session = self.client.session
        session["_auth_user_id"] = str(second.id)
        session.save()

        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-changed", email="second@example.com"
        )
        response = self._callback(self.client, state, token)

        self.assertEqual(response["Location"], "/login?google=failed")
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertIsNone(first.google_sub)
        self.assertIsNone(second.google_sub)

    def test_link_invalidates_when_the_actor_password_changed_during_consent(self):
        actor = get_user_model().objects.create_user(
            email="reset@example.com", password="StrongTestPassword123!"
        )
        self.client.force_login(actor)
        state, nonce = self._start(self.client, intent="link")

        actor.set_password("DifferentStrongPassword456!")
        actor.save(update_fields=["password"])

        token = self.fake.sign(
            nonce=nonce, sub="synthetic-sub-reset", email="reset@example.com"
        )
        response = self._callback(self.client, state, token)

        self.assertEqual(response["Location"], "/login?google=failed")
        actor.refresh_from_db()
        self.assertIsNone(actor.google_sub)
        self.assertNotIn("_auth_user_id", self.client.session)


@override_settings(**GOOGLE_OVERRIDES)
class GoogleResolveIdentityTests(APITestCase):
    def test_link_refuses_a_stale_actor_object_over_an_intervening_link(self):
        actor = get_user_model().objects.create_user(
            email="stale@example.com", password="StrongTestPassword123!"
        )
        stale_actor = actor
        get_user_model().objects.filter(pk=actor.pk).update(
            google_sub="synthetic-sub-intervening"
        )

        with self.assertRaises(google.GoogleLinkConflict):
            google.resolve_identity(
                {"sub": "synthetic-sub-new", "email": "stale@example.com"},
                intent="link",
                actor=stale_actor,
            )

        actor.refresh_from_db()
        self.assertEqual(actor.google_sub, "synthetic-sub-intervening")


@override_settings(**GOOGLE_OVERRIDES)
class GoogleFlowConcurrencyTests(TransactionTestCase):
    def test_parallel_callbacks_claim_one_flow_once(self):
        fake = FakeGoogle()
        state = "synthetic-parallel-state"
        nonce = "synthetic-parallel-nonce"
        store = SessionStore()
        store[google.FLOW_SESSION_KEY] = {
            "state": state,
            "nonce": nonce,
            "intent": "sign-in",
            "next": "/",
            "actor_id": None,
            "created_at": timezone.now().isoformat(),
        }
        store.save()
        session_key = store.session_key
        token = fake.sign(
            nonce=nonce, sub="synthetic-sub-parallel", email="parallel@example.com"
        )
        results = []
        barrier = threading.Barrier(2)

        def run():
            client = APIClient()
            client.cookies["sessionid"] = session_key
            barrier.wait()
            response = client.get(
                reverse("auth-google-callback"),
                {"code": "synthetic-code", "state": state},
            )
            results.append(response["Location"])
            connections.close_all()

        with (
            mock.patch.object(google, "exchange_code_for_tokens", return_value=token),
            mock.patch.object(google, "fetch_google_jwks", return_value=fake.jwks),
        ):
            threads = [threading.Thread(target=run) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=30)

        self.assertEqual(results.count("/"), 1)
        self.assertEqual(
            get_user_model()
            .objects.filter(google_sub="synthetic-sub-parallel")
            .count(),
            1,
        )
        self.assertFalse(Session.objects.filter(session_key=session_key).exists())
