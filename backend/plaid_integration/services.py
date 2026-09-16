"""Server-only helpers for the Plaid Link flow.

Implements the opaque client user id (``docs/plaid.md`` section 2), the
digest-only exchange handle issuance foundation and the atomic single-use
claim consumed by the exchange endpoint (section 3), and the encrypted
connection persistence bound to the authenticated user (section 4).
"""

import hashlib
import hmac
import secrets
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.utils import timezone

from plaid_integration.models import (
    PlaidConnection,
    PlaidConnectionStatus,
    PlaidExchangeHandle,
    TransactionsUpdateStatus,
)

EXCHANGE_HANDLE_LIFETIME = timedelta(minutes=30)
_PLAID_CLIENT_USER_ID_PURPOSE = b"mohr:plaid:client_user_id"

UNKNOWN_INSTITUTION = "Unknown institution"
EXCHANGE_ITEM_ID_MAX_LENGTH = 100
EXCHANGE_INSTITUTION_MAX_LENGTH = 200
_PLAID_CONNECTION_ITEM_ID_UNIQUE = "plaid_connection_item_id_unique"


class PlaidExchangeDuplicateItem(Exception):
    """The provider Item already belongs to an existing connection.

    Deliberately indistinguishable from every other invalid exchange: the
    endpoint maps it to the same generic 400 without revealing the owner or
    existence of the existing connection, and never changes that row.
    """


class PlaidExchangeProviderDataError(Exception):
    """Provider-derived values cannot be persisted safely.

    Raised when the provider item id or institution name exceeds the model
    bounds or fails model validation. The provider item id is never
    truncated; the caller treats this as a fixed safe provider failure and
    persists nothing.
    """


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


def claim_exchange_handle(user, raw_handle):
    """Atomically consume a single-use exchange handle owned by ``user``.

    One conditional database UPDATE scoped by user, the SHA-256 digest, an
    unused handle (``consumed_at IS NULL``), and an unexpired handle
    (``expires_at > now``), setting ``consumed_at = now``. Returns True only
    when exactly one row transitioned to consumed. The handle row is never
    loaded or compared against another user's object; the conditional UPDATE
    is the concurrency primitive that lets exactly one of several
    concurrent or replayed requests win.
    """
    digest = hashlib.sha256(raw_handle.encode("ascii")).hexdigest()
    now = timezone.now()
    updated = PlaidExchangeHandle.objects.filter(
        user=user,
        digest=digest,
        consumed_at__isnull=True,
        expires_at__gt=now,
    ).update(consumed_at=now)
    return updated == 1


def _constraint_name(integrity_error):
    """Return the database constraint name behind an IntegrityError, or None."""
    cause = integrity_error.__cause__
    if cause is None:
        return None
    return getattr(getattr(cause, "diag", None), "constraint_name", None)


def persist_exchange_connection(user, item_id, institution_name, token_package, key_id):
    """Persist one encrypted connection from provider exchange data.

    Provider-derived values are validated before anything is persisted: the
    ``item_id`` must be a nonempty string within the model bound, and the
    ``institution_name`` must be None or a string. Blank institution names
    normalize to ``UNKNOWN_INSTITUTION``; values that exceed the model
    bounds, or the wrong type, fail as a safe provider error and nothing is
    persisted. The provider item id is never truncated (the display
    institution name is bounded deliberately to the model maximum).
    ``full_clean()`` enforces the model bounds; the database constraints
    (the globally unique item id and the status checks) are enforced by the
    insert itself. An already-existing Item (the globally unique item id)
    surfaces as :class:`PlaidExchangeDuplicateItem` without touching the
    existing row, whether detected as the concurrent-insert race at save
    time or against an already-committed duplicate. Unrelated integrity
    errors propagate.
    """
    if not isinstance(item_id, str) or not item_id:
        raise PlaidExchangeProviderDataError()
    if len(item_id) > EXCHANGE_ITEM_ID_MAX_LENGTH:
        raise PlaidExchangeProviderDataError()
    if institution_name is not None and not isinstance(institution_name, str):
        raise PlaidExchangeProviderDataError()
    display_name = (institution_name or "").strip() or UNKNOWN_INSTITUTION
    if len(display_name) > EXCHANGE_INSTITUTION_MAX_LENGTH:
        raise PlaidExchangeProviderDataError()
    connection = PlaidConnection(
        user=user,
        item_id=item_id,
        access_token_encrypted=token_package,
        encryption_key_id=key_id,
        institution_name=display_name,
        status=PlaidConnectionStatus.ACTIVE,
        transactions_update_status=TransactionsUpdateStatus.NOT_READY,
    )
    try:
        connection.full_clean(validate_unique=False, validate_constraints=False)
    except ValidationError:
        raise PlaidExchangeProviderDataError() from None
    try:
        with transaction.atomic():
            connection.save()
    except IntegrityError as exc:
        constraint_name = _constraint_name(exc)
        if constraint_name is not None:
            if constraint_name == _PLAID_CONNECTION_ITEM_ID_UNIQUE:
                raise PlaidExchangeDuplicateItem() from None
            raise
        # No diagnostic constraint name (for example SQLite): the failed
        # inner atomic block has already rolled back, so re-check whether
        # the exact provider item id now exists. Translate only that exact
        # duplicate; any other integrity error propagates.
        if PlaidConnection.objects.filter(item_id=item_id).exists():
            raise PlaidExchangeDuplicateItem() from None
        raise
    return connection
