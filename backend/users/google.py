"""Server-only Google OpenID Connect sign-in boundary (issue #120).

This module owns the authorization-code exchange, the RS256 ID-token
verification against Google's fixed JWKS URL, and the one-time flow claim
stored in the platform database session. It never stores a provider token,
never logs a code, state, token, or claim, and never trusts an unsigned
payload. No provider secret ever reaches the browser.
"""

import json
import secrets
import urllib.error
import urllib.request
from datetime import timedelta
from urllib.parse import urlencode

import jwt
from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.sessions.backends.db import SessionStore
from django.contrib.sessions.models import Session
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.db import IntegrityError, transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
GOOGLE_JWKS_ENDPOINT = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = ("https://accounts.google.com", "accounts.google.com")
GOOGLE_CALLBACK_PATH = "/api/auth/google/callback/"
OAUTH_SCOPE = "openid email"
SIGNING_ALGORITHM = "RS256"

NETWORK_TIMEOUT_SECONDS = 10.0
MAX_RESPONSE_BYTES = 64 * 1024
FLOW_TTL = timedelta(minutes=5)
FLOW_SESSION_KEY = "_google_oidc_flow"
MAX_STATE_LENGTH = 256
MAX_CODE_LENGTH = 512
SUB_MAX_LENGTH = 255

ALLOWED_NEXT_PATHS = frozenset(
    {
        "/",
        "/accounts",
        "/categories",
        "/transactions",
        "/budgets",
        "/cash-flow",
        "/connections",
    }
)


class GoogleAuthError(Exception):
    """Base fixed-safe Google flow error; never carries provider detail."""


class GoogleAuthUnavailable(GoogleAuthError):
    """The feature is disabled or the provider/network/response is unusable."""


class GoogleIdentityError(GoogleAuthError):
    """The verified identity failed a policy check."""


class GoogleLinkRequired(GoogleAuthError):
    """An unknown subject collides with an existing local email."""


class GoogleLinkConflict(GoogleAuthError):
    """An intentional link would overwrite an owned or foreign identity."""


def is_enabled():
    return bool(getattr(settings, "GOOGLE_AUTH_ENABLED", False))


def _session(request):
    return getattr(request, "_request", request).session


def build_authorization_url(state, nonce):
    params = {
        "client_id": settings.GOOGLE_CLIENT_ID,
        "redirect_uri": settings.GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": OAUTH_SCOPE,
        "state": state,
        "nonce": nonce,
        "access_type": "online",
        "prompt": "select_account",
    }
    return f"{GOOGLE_AUTHORIZATION_ENDPOINT}?{urlencode(params)}"


def create_flow(*, intent, next_path, actor_id):
    return {
        "state": secrets.token_urlsafe(32),
        "nonce": secrets.token_urlsafe(32),
        "intent": intent,
        "next": next_path,
        "actor_id": actor_id,
        "created_at": timezone.now().isoformat(),
    }


def store_flow(request, flow):
    session = _session(request)
    session[FLOW_SESSION_KEY] = flow
    session.modified = True


def _bind_session(request, store):
    getattr(request, "_request", request).session = store


def consume_flow(request, supplied_state):
    """Claim the stored flow exactly once, or return ``None``.

    The owning Django session row is locked, its current data reloaded
    through a fresh ``SessionStore``, the flow removed, and the removal
    persisted inside the transaction *before* any provider call. A state
    mismatch returns ``None`` without deleting the flow, so an attacker
    cannot erase another valid in-flight flow. The row lock is released
    before the network exchange.
    """
    session_key = _session(request).session_key
    if not session_key:
        return None
    if not isinstance(supplied_state, str) or not supplied_state:
        return None

    with transaction.atomic():
        try:
            Session.objects.select_for_update().get(session_key=session_key)
        except Session.DoesNotExist:
            return None

        store = SessionStore(session_key=session_key)
        # Use the session mapping interface so the loaded data is cached on
        # the store; a bare ``load()`` would let ``save()`` reload the row
        # and silently resurrect the flow we are trying to consume.
        try:
            flow = store.get(FLOW_SESSION_KEY)
        except Exception:
            return None
        if not isinstance(flow, dict):
            return None

        stored_state = flow.get("state")
        if not isinstance(stored_state, str) or not secrets.compare_digest(
            stored_state, supplied_state
        ):
            return None

        created_at = parse_datetime(str(flow.get("created_at", "")))
        expired = created_at is None or timezone.now() - created_at > FLOW_TTL

        try:
            del store[FLOW_SESSION_KEY]
        except KeyError:
            return None
        store.save()
        _bind_session(request, store)

        if expired:
            return None
        return flow


def _read_bounded(response, max_bytes):
    raw = response.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise GoogleAuthUnavailable()
    return raw.decode("utf-8")


def _read_json(request, max_bytes=MAX_RESPONSE_BYTES):
    try:
        with urllib.request.urlopen(request, timeout=NETWORK_TIMEOUT_SECONDS) as opened:
            text = _read_bounded(opened, max_bytes)
    except (
        urllib.error.URLError,
        TimeoutError,
        OSError,
        ValueError,
        UnicodeDecodeError,
    ):
        raise GoogleAuthUnavailable() from None
    try:
        return json.loads(text)
    except ValueError:
        raise GoogleAuthUnavailable() from None


def exchange_code_for_tokens(code):
    """Redeem the one-use authorization code for a fresh ID token only."""
    if not isinstance(code, str) or not code or len(code) > MAX_CODE_LENGTH:
        raise GoogleAuthUnavailable()
    body = urlencode(
        {
            "code": code,
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "redirect_uri": settings.GOOGLE_REDIRECT_URI,
            "grant_type": "authorization_code",
        }
    ).encode("ascii")
    request = urllib.request.Request(
        GOOGLE_TOKEN_ENDPOINT,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
    )
    payload = _read_json(request)
    if not isinstance(payload, dict):
        raise GoogleAuthUnavailable()
    id_token = payload.get("id_token")
    if not isinstance(id_token, str) or not id_token:
        raise GoogleAuthUnavailable()
    return id_token


def fetch_google_jwks():
    request = urllib.request.Request(
        GOOGLE_JWKS_ENDPOINT,
        method="GET",
        headers={"Accept": "application/json"},
    )
    payload = _read_json(request)
    keys = payload.get("keys") if isinstance(payload, dict) else None
    if not isinstance(keys, list) or not keys:
        raise GoogleAuthUnavailable()
    return keys


def verify_id_token(id_token, *, jwks, nonce):
    """Verify a Google ID token and return only the trusted subject and email."""
    if not isinstance(id_token, str) or not id_token or "." not in id_token:
        raise GoogleIdentityError()
    try:
        header = jwt.get_unverified_header(id_token)
    except jwt.PyJWTError:
        raise GoogleIdentityError() from None

    if header.get("alg") != SIGNING_ALGORITHM:
        raise GoogleIdentityError()
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise GoogleIdentityError()
    jwk = next(
        (
            candidate
            for candidate in jwks
            if isinstance(candidate, dict) and candidate.get("kid") == kid
        ),
        None,
    )
    if jwk is None:
        raise GoogleIdentityError()
    try:
        signing_key = jwt.algorithms.RSAAlgorithm.from_jwk(json.dumps(jwk))
    except (jwt.PyJWTError, ValueError, TypeError):
        raise GoogleIdentityError() from None

    try:
        claims = jwt.decode(
            id_token,
            signing_key,
            algorithms=[SIGNING_ALGORITHM],
            audience=settings.GOOGLE_CLIENT_ID,
            issuer=list(GOOGLE_ISSUERS),
            options={
                "require": [
                    "exp",
                    "iat",
                    "sub",
                    "aud",
                    "iss",
                    "nonce",
                    "email",
                    "email_verified",
                ]
            },
        )
    except (jwt.PyJWTError, TypeError):
        # PyJWT raises a bare ``TypeError`` when a signed ``exp``/``iat``/``nbf``
        # is a non-scalar such as a dict or list; treat it as an invalid token
        # rather than letting it escape the fixed-safe boundary.
        raise GoogleIdentityError() from None

    # PyJWT accepts an ``aud`` array that merely *contains* the client ID, but
    # Google issues the audience as exactly this application's client ID.
    audience = claims.get("aud")
    if not isinstance(audience, str) or audience != settings.GOOGLE_CLIENT_ID:
        raise GoogleIdentityError()
    azp = claims.get("azp")
    if azp is not None and (
        not isinstance(azp, str) or azp != settings.GOOGLE_CLIENT_ID
    ):
        raise GoogleIdentityError()
    for claim_name in ("iat", "exp"):
        claim_value = claims.get(claim_name)
        if isinstance(claim_value, bool) or not isinstance(claim_value, int):
            raise GoogleIdentityError()

    token_nonce = claims.get("nonce")
    if (
        not isinstance(token_nonce, str)
        or not isinstance(nonce, str)
        or not secrets.compare_digest(token_nonce, nonce)
    ):
        raise GoogleIdentityError()
    if claims.get("email_verified") is not True:
        raise GoogleIdentityError()

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub or len(sub) > SUB_MAX_LENGTH:
        raise GoogleIdentityError()
    email = claims.get("email")
    if not isinstance(email, str):
        raise GoogleIdentityError()
    email = email.strip()
    try:
        validate_email(email)
    except ValidationError:
        raise GoogleIdentityError() from None
    return {"sub": sub, "email": email}


def resolve_identity(claims, *, intent, actor):
    """Resolve the verified Google subject into a local user, or refuse.

    Returns ``(user, outcome)`` where outcome is ``signed_in``, ``created``,
    or ``linked``. An existing email is never merged automatically, and an
    intentional link never changes the primary email or financial owner.
    """
    user_model = get_user_model()
    sub = claims["sub"]
    email = claims["email"]

    if intent == "link":
        if actor is None or not actor.is_active:
            raise GoogleLinkConflict()
        # Reload and lock the actor inside the transaction so an intervening
        # link made while consent was in flight cannot be overwritten by a
        # stale in-memory object.
        try:
            with transaction.atomic():
                locked = (
                    user_model.objects.select_for_update().filter(pk=actor.pk).first()
                )
                if locked is None or not locked.is_active:
                    raise GoogleLinkConflict()
                if (
                    user_model.objects.filter(google_sub=sub)
                    .exclude(pk=locked.pk)
                    .exists()
                ):
                    raise GoogleLinkConflict()
                if locked.google_sub and locked.google_sub != sub:
                    raise GoogleLinkConflict()
                if locked.google_sub == sub:
                    return locked, "linked"
                locked.google_sub = sub
                locked.save(update_fields=["google_sub"])
        except IntegrityError:
            raise GoogleLinkConflict() from None
        return locked, "linked"

    known = user_model.objects.filter(google_sub=sub).first()
    if known is not None:
        if not known.is_active:
            raise GoogleIdentityError()
        return known, "signed_in"

    if user_model.objects.filter(email__iexact=email).exists():
        raise GoogleLinkRequired()

    try:
        with transaction.atomic():
            created = user_model.objects.create_user(
                email=email, password=None, google_sub=sub
            )
    except IntegrityError:
        same = user_model.objects.filter(google_sub=sub).first()
        if same is not None and same.is_active:
            return same, "signed_in"
        raise GoogleIdentityError() from None
    return created, "created"
