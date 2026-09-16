"""Server-only helpers for the Plaid Link flow.

Implements the opaque client user id (``docs/plaid.md`` section 2) and the
digest-only exchange handle issuance foundation (section 3). The raw
exchange handle crosses to the browser once and is never persisted; only its
SHA-256 digest is stored, bound to the authenticated user.
"""

import hashlib
import hmac
import secrets
from datetime import timedelta

from django.conf import settings
from django.utils import timezone

from plaid_integration.models import PlaidExchangeHandle

EXCHANGE_HANDLE_LIFETIME = timedelta(minutes=30)
_PLAID_CLIENT_USER_ID_PURPOSE = b"mohr:plaid:client_user_id"


def plaid_client_user_id(user):
    """Stable opaque Plaid client id: HMAC over the immutable database id.

    Derived from the user's immutable database id and Django SECRET_KEY with
    a Plaid-specific purpose label. Never the email and never reversible.
    """
    message = _PLAID_CLIENT_USER_ID_PURPOSE + b":" + str(user.id).encode("ascii")
    return hmac.new(
        settings.SECRET_KEY.encode("utf-8"),
        message,
        hashlib.sha256,
    ).hexdigest()


def issue_exchange_handle(user, link_token_expiration):
    """Issue a single-use exchange handle and persist only its digest.

    Expires 30 minutes after issuance or at the Plaid link-token expiration
    when that comes earlier. The raw handle is returned to the caller and
    never stored; the row is bound to ``user``.
    """
    raw_handle = secrets.token_urlsafe(32)
    digest = hashlib.sha256(raw_handle.encode("ascii")).hexdigest()
    expires_at = min(timezone.now() + EXCHANGE_HANDLE_LIFETIME, link_token_expiration)
    PlaidExchangeHandle.objects.create(
        user=user,
        digest=digest,
        expires_at=expires_at,
    )
    return raw_handle
