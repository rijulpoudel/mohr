"""Server-only cryptographic verification boundary for Plaid webhooks.

Implements the ``docs/plaid.md`` section 8 verification order for issue
#39 slice A. The verifier accepts the exact raw request body bytes, the
``Plaid-Verification`` JWT, and an injected gateway, and returns a frozen
minimal claims object or raises one fixed payload-free failure:

1. Decode only the JWT header first, never trusting the payload: the
   ``alg`` must be exactly ``ES256`` and the ``kid`` a nonempty string
   within a fixed length bound, or verification stops before any gateway
   call.
2. Resolve the ES256 public key through the injected gateway by the exact
   ``kid``, revalidating every fetched key before it enters the bounded
   in-process LRU cache; failed fetches are never cached.
3. Verify the signature strictly with ``algorithms=["ES256"]`` and no
   algorithm fallback.
4. Validate ``iat`` as an integer-not-bool within a two-sided bound
   (no older than 5 minutes, no more than 60 seconds in the future) and
   ``exp`` when present as an integer-not-bool that is still in the
   future; boundaries are deterministic through an injected timestamp.
5. Compute SHA-256 over the exact raw body bytes with no decoding or
   re-encoding and compare the lowercase 64-hex
   ``request_body_sha256`` claim in constant time.

Every expected failure raises :class:`PlaidWebhookVerificationError` with
a constant detail. The raise happens outside any exception handler so the
exception carries no cause and no implicit context: a formatted traceback
can never render a JWT, a JWK coordinate, a provider body, a digest, or
the raw body. This module performs no database access, no body JSON
parsing, and no provider call except the key lookup.
"""

import hashlib
import hmac
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock

import jwt

from plaid_integration.gateway import (
    PlaidGatewayError,
    normalize_webhook_verification_key,
)

logger = logging.getLogger(__name__)

WEBHOOK_IAT_MAX_AGE_SECONDS = 300
WEBHOOK_IAT_FUTURE_ALLOWANCE_SECONDS = 60
WEBHOOK_KID_MAX_LENGTH = 128
WEBHOOK_KEY_CACHE_CAPACITY = 32
WEBHOOK_BODY_SHA256_HEX_LENGTH = 64

WEBHOOK_VERIFICATION_FAILED_DETAIL = "Webhook verification failed."

_LOWER_HEX_DIGITS = frozenset("0123456789abcdef")

_HEADER_FAILURE = "malformed header"
_KEY_FAILURE = "key resolution failed"
_SIGNATURE_FAILURE = "signature verification failed"
_CLAIMS_FAILURE = "claims verification failed"


class PlaidWebhookVerificationError(Exception):
    """Fixed safe failure for any expected webhook verification error.

    The message is the constant :data:`WEBHOOK_VERIFICATION_FAILED_DETAIL`
    and never carries the JWT, the JWK, the raw body, a digest, a provider
    response, or credentials. Expected failures are raised outside any
    exception handler, so ``__cause__`` and ``__context__`` are both None
    and a formatted traceback cannot render the suppressed original.
    """


@dataclass(frozen=True)
class VerifiedWebhookClaims:
    """Minimal verified claims the webhook endpoint may rely on.

    ``idempotency_key`` is the lowercase hex SHA-256 of the exact raw
    request body bytes; it was validated in constant time against the JWT
    ``request_body_sha256`` claim and doubles as the durable inbox
    idempotency key. No JWT, raw body, JWK coordinate, provider response,
    or secret is retained or rendered in ``repr``.
    """

    kid: str
    iat: int
    idempotency_key: str


_KEY_CACHE = OrderedDict()
_KEY_CACHE_LOCK = Lock()


def reset_webhook_key_cache():
    """Test-only hook: drop every cached verification key."""
    with _KEY_CACHE_LOCK:
        _KEY_CACHE.clear()


def verify_plaid_webhook(raw_body, verification_header, *, gateway, now=None):
    """Verify a Plaid webhook delivery and return its minimal claims.

    ``raw_body`` must be the exact request body bytes (``request.body``);
    it is hashed verbatim and never parsed. ``verification_header`` is the
    ``Plaid-Verification`` JWT. ``gateway`` must expose
    ``get_webhook_verification_key(key_id)`` and is the only provider
    boundary. ``now`` is an optional integer Unix timestamp for
    deterministic boundary tests; it defaults to the current time.

    Returns a frozen :class:`VerifiedWebhookClaims`. Any expected failure
    raises :class:`PlaidWebhookVerificationError` whose message is the
    fixed detail and whose cause and context are both None.
    """
    if now is None:
        now = int(time.time())
    kid = _validated_kid(verification_header)
    if kid is None:
        logger.warning("Plaid webhook verification failed (%s).", _HEADER_FAILURE)
        raise PlaidWebhookVerificationError(WEBHOOK_VERIFICATION_FAILED_DETAIL)
    key = _cached_verification_key(kid, gateway)
    if key is None:
        logger.warning(
            "Plaid webhook verification failed (%s, kid=%r).",
            _KEY_FAILURE,
            kid,
        )
        raise PlaidWebhookVerificationError(WEBHOOK_VERIFICATION_FAILED_DETAIL)
    payload = _verified_payload(verification_header, key)
    if payload is None:
        logger.warning(
            "Plaid webhook verification failed (%s, kid=%r).",
            _SIGNATURE_FAILURE,
            kid,
        )
        raise PlaidWebhookVerificationError(WEBHOOK_VERIFICATION_FAILED_DETAIL)
    claims = _validated_claims(payload, kid=kid, raw_body=raw_body, now=now)
    if claims is None:
        logger.warning(
            "Plaid webhook verification failed (%s, kid=%r).",
            _CLAIMS_FAILURE,
            kid,
        )
        raise PlaidWebhookVerificationError(WEBHOOK_VERIFICATION_FAILED_DETAIL)
    return claims


def _validated_kid(verification_header):
    """Return the header ``kid`` or None when the header cannot be trusted.

    Only the JWT header is decoded here; the payload is not parsed and
    nothing is verified yet. The ``alg`` must be exactly ``ES256`` and the
    ``kid`` a nonempty string within the fixed length bound. Any other
    header shape fails before a gateway call.
    """
    if not isinstance(verification_header, str) or not verification_header:
        return None
    try:
        header = jwt.get_unverified_header(verification_header)
    except jwt.PyJWTError:
        return None
    if header.get("alg") != "ES256":
        return None
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid or len(kid) > WEBHOOK_KID_MAX_LENGTH:
        return None
    return kid


def _cached_verification_key(kid, gateway):
    """Return a validated key for ``kid``, fetching on cache miss only.

    The bounded LRU cache is keyed by the exact ``kid``. Only a fully
    revalidated key is inserted; failed or malformed fetches are never
    cached so a transient failure is retried on the next delivery.
    """
    with _KEY_CACHE_LOCK:
        cached = _KEY_CACHE.get(kid)
        if cached is not None:
            _KEY_CACHE.move_to_end(kid)
            return cached
    fetched = _fetch_verification_key(kid, gateway)
    if fetched is None:
        return None
    with _KEY_CACHE_LOCK:
        _KEY_CACHE[kid] = fetched
        _KEY_CACHE.move_to_end(kid)
        while len(_KEY_CACHE) > WEBHOOK_KEY_CACHE_CAPACITY:
            _KEY_CACHE.popitem(last=False)
    return fetched


def _fetch_verification_key(kid, gateway):
    """Fetch one key through the gateway, revalidate it, or return None.

    The gateway failure is collapsed here so the caller can raise its
    fixed error outside any exception handler. The key must also rebuild a
    usable ES256 verification key before it is considered fetchable, so a
    structurally plausible but unusable JWK is never cached.
    """
    try:
        fetched = gateway.get_webhook_verification_key(kid)
    except PlaidGatewayError:
        return None
    normalized = normalize_webhook_verification_key(fetched, expected_kid=kid)
    if normalized is None:
        return None
    if _build_verification_key(normalized) is None:
        return None
    return normalized


def _build_verification_key(key):
    """Rebuild the PyJWT ES256 key from a normalized JWK, or return None."""
    try:
        return jwt.PyJWK.from_dict(
            {
                "kty": key.kty,
                "crv": key.crv,
                "x": key.x,
                "y": key.y,
                "alg": key.alg,
            }
        )
    except jwt.PyJWTError:
        return None


def _verified_payload(verification_header, key):
    """Return the verified JWT payload dict or None.

    The signature is checked strictly with ``algorithms=["ES256"]`` using
    the key rebuilt from the revalidated JWK; claim validation is left to
    the caller so the two-sided time bounds are deterministic. PyJWT
    failures collapse to None and are re-raised by the caller outside any
    handler.
    """
    verification_key = _build_verification_key(key)
    if verification_key is None:
        return None
    try:
        return jwt.decode(
            verification_header,
            key=verification_key,
            algorithms=["ES256"],
            options={
                "verify_signature": True,
                "verify_exp": False,
                "verify_iat": False,
                "verify_nbf": False,
                "verify_aud": False,
                "verify_iss": False,
                "require": [],
            },
        )
    except jwt.PyJWTError:
        return None


def _validated_claims(payload, *, kid, raw_body, now):
    """Validate the time bounds and body digest, or return None.

    ``iat`` is required and must be an integer but not a bool, no older
    than :data:`WEBHOOK_IAT_MAX_AGE_SECONDS` and no more than
    :data:`WEBHOOK_IAT_FUTURE_ALLOWANCE_SECONDS` in the future. ``exp``
    when present must be an integer but not a bool and still in the
    future. ``request_body_sha256`` is required, must be the lowercase
    64-hex SHA-256 of the exact raw bytes, and is compared in constant
    time only after the signature and time checks. Malformed numeric or
    string claims are never silently accepted.
    """
    iat = payload.get("iat")
    if not _is_int_not_bool(iat):
        return None
    if now - iat > WEBHOOK_IAT_MAX_AGE_SECONDS:
        return None
    if iat - now > WEBHOOK_IAT_FUTURE_ALLOWANCE_SECONDS:
        return None
    if "exp" in payload:
        exp = payload.get("exp")
        if not _is_int_not_bool(exp) or now >= exp:
            return None
    claim = payload.get("request_body_sha256")
    if not _is_lowercase_hex_sha256(claim):
        return None
    computed = hashlib.sha256(raw_body).hexdigest()
    if not hmac.compare_digest(computed, claim):
        return None
    return VerifiedWebhookClaims(kid=kid, iat=iat, idempotency_key=computed)


def _is_int_not_bool(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _is_lowercase_hex_sha256(value):
    if not isinstance(value, str):
        return False
    if len(value) != WEBHOOK_BODY_SHA256_HEX_LENGTH:
        return False
    return all(char in _LOWER_HEX_DIGITS for char in value)
