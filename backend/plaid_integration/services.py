"""Server-only helpers for the Plaid Link flow and transaction sync.

Implements the opaque client user id (``docs/plaid.md`` section 2), the
digest-only exchange handle issuance foundation and the atomic single-use
claim consumed by the exchange endpoint (section 3), the encrypted
connection persistence bound to the authenticated user (section 4), and the
idempotent per-page application of one normalized ``/transactions/sync``
page (section 7) for issue #38 slice D. One ``transaction.atomic()`` block
writes the applied rows and the next cursor together; a per-Item row lock
serializes concurrent syncs; the cursor never moves backward, on failure, or
on a page that does not continue from the committed state (except by
replaying the same update after mutation-during-pagination); provider
quarantines and unmappable-account rows are recorded in bounded redacted
form on ``last_sync_error`` without ever deadlocking the connection;
provider-owned ``Uncategorized`` categories fail closed when archived; and the
bounded sync orchestration plus the section 5 opening-balance anchor (issue
#38 slice E): ``perform_sync`` decrypts the stored access token (never logged
or returned), guards blocked connection states without any write, fetches
pages from the committed cursor through an injected or settings-built
gateway, imports each page's supported accounts before rows are mapped,
applies every page through ``apply_sync_page`` so rows, cursor, and status
commit together, applies the exactly-once anchor only on the drained final
page (``HISTORICAL_UPDATE_COMPLETE`` with ``has_more=False``) inside that
page's own atomic block, restarts pagination from the update-start cursor on
mutation-during-pagination up to a bounded restart budget (a re-applied page
behind the committed cursor never advances it and contributes nothing to the
run totals), fails closed on outage, token, anchor, and blocked-page
conditions without ever advancing the cursor past a committed value, and
heals the ``error`` status back to ``active`` on a later successful run.
The verified webhook ingest (issue #39 slices B and C) persists the durable
inbox row and connection flags in one atomic block, enforces the bounded
``PLAID_WEBHOOK_INBOX_CAP`` inside that same block by evicting only oldest
processed rows and then oldest quarantine rows (never an unprocessed matched
event, never the just-created row), raises the fixed repr-safe
:class:`WebhookInboxFull` when a recognized event cannot fit, and
quarantines verified but malformed deliveries as minimized null-pair rows
without ever retrying poison forever. A module-level process lock serializes
webhook ingress; this is safe because Render Free runs exactly one web
process, and the database transaction remains the correctness boundary.
"""

import hashlib
import hmac
import secrets
import threading
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import DecimalField, F, Q, Sum, Value
from django.db.models.functions import Coalesce, Lower, Trim
from django.utils import timezone

from accounts.models import AccountType
from categories.models import Category, CategoryType
from plaid_integration.account_import import import_normalized_provider_accounts
from plaid_integration.gateway import PlaidGateway, PlaidGatewayError
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    PlaidExchangeHandle,
    PlaidWebhookEvent,
    TransactionsUpdateStatus,
)
from plaid_integration.token_encryption import TokenCryptoError
from plaid_integration.transaction_sync import PlaidSyncMutationError
from transactions.models import Transaction, TransactionSource, TransactionType

EXCHANGE_HANDLE_LIFETIME = timedelta(minutes=30)
_PLAID_CLIENT_USER_ID_PURPOSE = b"mohr:plaid:client_user_id"

UNKNOWN_INSTITUTION = "Unknown institution"
EXCHANGE_ITEM_ID_MAX_LENGTH = 100
EXCHANGE_INSTITUTION_MAX_LENGTH = 200
_PLAID_CONNECTION_ITEM_ID_UNIQUE = "plaid_connection_item_id_unique"

UNCATEGORIZED_NAME = "Uncategorized"
SYNC_ERROR_TAG = "transaction-sync:"
SYNC_ERROR_MAX_LENGTH = 2000
_SYNC_ERROR_MAX_REASONS = 5
ARCHIVED_CATEGORY_DETAIL = (
    "Uncategorized category is archived; requires explicit user action"
)
BLOCKED_CURSOR_DETAIL = (
    "sync cursor is inconsistent; requires explicit repair or relink"
)
_PLAID_TRANSACTION_UNIQUE_CONSTRAINT = "transactions_user_plaid_transaction_id_unique"
_CATEGORY_UNIQUE_CONSTRAINT = "categories_user_name_type_unique"

PAGE_CAP = 20
MAX_MUTATION_RESTARTS = 2

PROVIDER_HISTORICAL_UPDATE_COMPLETE = "HISTORICAL_UPDATE_COMPLETE"

TOKEN_UNAVAILABLE_DETAIL = (
    "stored access token is unavailable; requires explicit repair or relink"
)
ANCHOR_MISSING_BALANCE_DETAIL = (
    "linked account has no captured anchor balance; requires explicit repair or relink"
)
MUTATION_RESTARTS_EXHAUSTED_DETAIL = (
    "Plaid reported repeated changes during pagination. Try again later."
)

_PROVIDER_UPDATE_STATUS_TO_MODEL = {
    "NOT_READY": TransactionsUpdateStatus.NOT_READY,
    "INITIAL_UPDATE_COMPLETE": TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE,
    "HISTORICAL_UPDATE_COMPLETE": TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE,
}


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


_WEBHOOK_EVENT_IDEMPOTENCY_UNIQUE = "plaid_webhook_event_idempotency_key_unique"

QUARANTINE_UNKNOWN_WEBHOOK_TYPE = "UNKNOWN"
QUARANTINE_UNKNOWN_WEBHOOK_CODE = "UNKNOWN"
QUARANTINE_UNKNOWN_ITEM_ID = "UNKNOWN"

_WEBHOOK_INGEST_LOCK = threading.Lock()


class WebhookDuplicateEvent(Exception):
    """A verified webhook with this exact body was already persisted.

    Raised only for the exact ``plaid_webhook_event_idempotency_key_unique``
    constraint violation (or, on a backend without a constraint diagnostic,
    an existing row with the same idempotency key). Never carries the body,
    its hash, or any connection state.
    """


class WebhookInboxFull(Exception):
    """The bounded webhook inbox cannot accept another recognized event.

    Raised only when the cap consists entirely of unprocessed matched events
    (or rows the priority order forbids evicting) after the inserting
    transaction rolled back, so nothing changed. The exception carries no
    body, hash, item id, connection state, cause, or context by construction,
    and its ``repr`` is a fixed string; the endpoint maps it to a fixed 503
    so Plaid can retry.
    """

    def __repr__(self):
        return "<WebhookInboxFull>"


class _InboxCapExceeded(Exception):
    """Internal marker: the inserted row does not fit inside the cap.

    Raised inside the inserting atomic block after every legal eviction was
    applied; the block rolls back and the caller translates the marker to
    :class:`WebhookInboxFull` (recognized events) or drops the insert
    (quarantine rows) outside the failed transaction. Never carries data.
    """


def _enforce_webhook_inbox_cap(keep_pk):
    """Evict enough oldest rows so the inbox fits, or return False.

    Runs inside the inserting atomic block after the insert, so a duplicate
    that violated the idempotency constraint before this point rolled back
    with zero eviction. ``keep_pk`` is the just-created row, which is never
    evicted. Priority order (``docs/plaid.md`` section 4): oldest processed
    rows first (``processed_at`` set, oldest first), then oldest quarantine
    rows (null connection and user pair), oldest first; an unprocessed
    matched event is never evicted merely to accept another event. Returns
    True when the table fits inside ``PLAID_WEBHOOK_INBOX_CAP`` and False
    when only forbidden rows remain.
    """
    cap = settings.PLAID_WEBHOOK_INBOX_CAP
    overflow = PlaidWebhookEvent.objects.count() - cap
    if overflow <= 0:
        return True
    remaining = overflow
    processed_pks = list(
        PlaidWebhookEvent.objects.filter(processed_at__isnull=False)
        .exclude(pk=keep_pk)
        .order_by("received_at", "id")
        .values_list("pk", flat=True)[:remaining]
    )
    if processed_pks:
        PlaidWebhookEvent.objects.filter(pk__in=processed_pks).delete()
        remaining -= len(processed_pks)
    if remaining > 0:
        quarantine_pks = list(
            PlaidWebhookEvent.objects.filter(connection__isnull=True, user__isnull=True)
            .exclude(pk=keep_pk)
            .order_by("received_at", "id")
            .values_list("pk", flat=True)[:remaining]
        )
        if quarantine_pks:
            PlaidWebhookEvent.objects.filter(pk__in=quarantine_pks).delete()
            remaining -= len(quarantine_pks)
    return remaining <= 0


def _advance_transactions_update_status(
    current, *, initial_complete, historical_complete
):
    """Return the monotonic next status from received webhook flags.

    ``initial_complete`` advances only a null or NOT_READY status to
    INITIAL_UPDATE_COMPLETE; ``historical_complete`` always advances to
    HISTORICAL_UPDATE_COMPLETE and wins, so the status never regresses.
    """
    if historical_complete:
        return TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE
    if initial_complete and current in (
        None,
        TransactionsUpdateStatus.NOT_READY,
    ):
        return TransactionsUpdateStatus.INITIAL_UPDATE_COMPLETE
    return current


def persist_verified_webhook(
    connection,
    claims,
    *,
    webhook_type,
    webhook_code,
    initial_update_complete,
    historical_update_complete,
):
    """Persist one verified supported webhook and flip its connection.

    ``claims`` is the frozen :class:`~plaid_integration.webhook_verification.
    VerifiedWebhookClaims` produced by ``verify_plaid_webhook``; its
    ``idempotency_key`` is the authoritative duplicate detector and is stored
    (never the raw body). ``connection`` is the matched
    :class:`PlaidConnection` for the parsed ``item_id``. In ONE
    ``transaction.atomic()`` block the durable inbox row is inserted and the
    connection's ``sync_due`` is set and ``transactions_update_status``
    advances monotonically (``docs/plaid.md`` sections 4, 7, and 8); the
    status, cursor, token, error, ``last_synced_at``, accounts, and
    transactions are never touched. The same block then enforces the
    ``PLAID_WEBHOOK_INBOX_CAP``: only the oldest processed rows and then the
    oldest quarantine rows are evicted (never an unprocessed matched event,
    never the just-created row), and when no legal eviction makes room the
    block rolls back entirely and :class:`WebhookInboxFull` is raised outside
    the failed transaction, so the recognized event never displaces an
    unprocessed matched event and the connection changes never exist.

    A re-delivered exact body raises :class:`WebhookDuplicateEvent` after the
    failed atomic block rolls back, so the duplicate changes neither the
    connection nor the inbox and evicts nothing. An unrelated
    ``IntegrityError`` propagates. The module-level process lock serializes
    ingress under the Render Free single-process architecture; the database
    transaction remains the correctness boundary.
    """
    with _WEBHOOK_INGEST_LOCK:
        try:
            with transaction.atomic():
                conn = PlaidConnection.objects.select_for_update().get(pk=connection.pk)
                event = PlaidWebhookEvent.objects.create(
                    connection=conn,
                    user=conn.user,
                    webhook_type=webhook_type,
                    webhook_code=webhook_code,
                    item_id=conn.item_id,
                    idempotency_key=claims.idempotency_key,
                    initial_update_complete=initial_update_complete,
                    historical_update_complete=historical_update_complete,
                    received_at=timezone.now(),
                    processed_at=None,
                )
                conn.sync_due = True
                conn.transactions_update_status = _advance_transactions_update_status(
                    conn.transactions_update_status,
                    initial_complete=initial_update_complete,
                    historical_complete=historical_update_complete,
                )
                conn.save(update_fields=["sync_due", "transactions_update_status"])
                if not _enforce_webhook_inbox_cap(event.pk):
                    raise _InboxCapExceeded()
        except _InboxCapExceeded:
            raise WebhookInboxFull() from None
        except IntegrityError as exc:
            constraint_name = _constraint_name(exc)
            if constraint_name is not None:
                if constraint_name == _WEBHOOK_EVENT_IDEMPOTENCY_UNIQUE:
                    raise WebhookDuplicateEvent() from None
                raise
            if PlaidWebhookEvent.objects.filter(
                idempotency_key=claims.idempotency_key
            ).exists():
                raise WebhookDuplicateEvent() from None
            raise


def quarantine_verified_webhook(
    claims,
    *,
    webhook_type,
    webhook_code,
    item_id,
):
    """Quarantine one verified but unprocessable webhook delivery.

    Persists the minimized null-pair quarantine row: no connection, no user,
    only the bounded sentinel strings already chosen by the caller for
    missing or invalid type/code/item values, the verified body hash as the
    ``idempotency_key``, ``received_at`` and ``processed_at`` equal to now,
    and both completeness flags false. The raw body, parsed extras, provider
    error details, JWT, JWK, and digest are never stored. The insert and the
    bounded-cap enforcement run in one atomic block under the same process
    lock as :func:`persist_verified_webhook`.

    Returns True when the quarantine row was persisted (any legal eviction
    already applied) and False when the row was safely dropped instead:
    accepting it at a full cap would have required deleting the row itself
    (only unprocessed matched rows or forbidden rows remain), so the insert
    rolls back, nothing is evicted, and the caller still returns 200 so a
    poison delivery is never retried forever. A re-delivered exact body
    raises :class:`WebhookDuplicateEvent` after the failed atomic block rolls
    back, evicting and mutating nothing; an unrelated ``IntegrityError``
    propagates.
    """
    with _WEBHOOK_INGEST_LOCK:
        try:
            with transaction.atomic():
                received_at = timezone.now()
                event = PlaidWebhookEvent.objects.create(
                    connection=None,
                    user=None,
                    webhook_type=webhook_type,
                    webhook_code=webhook_code,
                    item_id=item_id,
                    idempotency_key=claims.idempotency_key,
                    initial_update_complete=False,
                    historical_update_complete=False,
                    received_at=received_at,
                    processed_at=received_at,
                )
                if not _enforce_webhook_inbox_cap(event.pk):
                    raise _InboxCapExceeded()
        except _InboxCapExceeded:
            return False
        except IntegrityError as exc:
            constraint_name = _constraint_name(exc)
            if constraint_name is not None:
                if constraint_name == _WEBHOOK_EVENT_IDEMPOTENCY_UNIQUE:
                    raise WebhookDuplicateEvent() from None
                raise
            if PlaidWebhookEvent.objects.filter(
                idempotency_key=claims.idempotency_key
            ).exists():
                raise WebhookDuplicateEvent() from None
            raise
    return True


ITEM_LOGIN_REQUIRED_CODE = "ITEM_LOGIN_REQUIRED"


def _next_item_connection_state(current_status, *, webhook_code, error_code):
    """Return (new_status, set_sync_due) for one verified Item event.

    Terminal monotonicity for issue #39 D2: ``revoked`` and ``disconnected``
    never resurrect on LOGIN_REPAIRED, login-required, or generic errors;
    ``disconnected`` is terminal even for USER_PERMISSION_REVOKED; generic
    errors preserve ``updating`` so the actionable repair state is not lost.
    Only LOGIN_REPAIRED sets ``sync_due``, including on an already-active
    connection. Never touches cursor, tokens, readiness, or history.
    """
    if webhook_code == "USER_PERMISSION_REVOKED":
        if current_status == PlaidConnectionStatus.DISCONNECTED:
            return current_status, False
        return PlaidConnectionStatus.REVOKED, False
    if webhook_code == "LOGIN_REPAIRED":
        if current_status in (
            PlaidConnectionStatus.UPDATING,
            PlaidConnectionStatus.ERROR,
        ):
            return PlaidConnectionStatus.ACTIVE, True
        if current_status == PlaidConnectionStatus.ACTIVE:
            return current_status, True
        return current_status, False
    # ITEM + ERROR.
    if error_code == ITEM_LOGIN_REQUIRED_CODE:
        if current_status in (
            PlaidConnectionStatus.ACTIVE,
            PlaidConnectionStatus.ERROR,
        ):
            return PlaidConnectionStatus.UPDATING, False
        return current_status, False
    if current_status == PlaidConnectionStatus.ACTIVE:
        return PlaidConnectionStatus.ERROR, False
    return current_status, False


def persist_verified_item_webhook(
    connection,
    claims,
    *,
    webhook_type,
    webhook_code,
    error_code=None,
):
    """Persist one verified Item lifecycle event and apply its transition.

    Dedicated Item path for issue #39 D2: does not reuse transaction
    persistence semantics. In ONE ``transaction.atomic()`` block under the
    shared ingest lock, the durable inbox row is inserted with
    ``processed_at`` set (the state transition completes inline) and the
    connection's lifecycle ``status`` (and ``sync_due`` for LOGIN_REPAIRED)
    advances per ``_next_item_connection_state``; cursor, tokens,
    ``transactions_update_status``, ``last_sync_error``, ``last_synced_at``,
    accounts, and transactions are never touched. The same block enforces
    ``PLAID_WEBHOOK_INBOX_CAP`` with the existing priority; a full cap of
    unprocessed matched rows raises :class:`WebhookInboxFull` with nothing
    mutated. An exact re-delivery raises :class:`WebhookDuplicateEvent`
    with no repeat mutation. ``PlaidConnection.DoesNotExist`` propagates
    for the caller to treat as unmatched. Unrelated ``IntegrityError``
    propagates; no body or provider message is stored.
    """
    with _WEBHOOK_INGEST_LOCK:
        try:
            with transaction.atomic():
                conn = PlaidConnection.objects.select_for_update().get(pk=connection.pk)
                new_status, set_sync_due = _next_item_connection_state(
                    conn.status,
                    webhook_code=webhook_code,
                    error_code=error_code,
                )
                now = timezone.now()
                event = PlaidWebhookEvent.objects.create(
                    connection=conn,
                    user=conn.user,
                    webhook_type=webhook_type,
                    webhook_code=webhook_code,
                    item_id=conn.item_id,
                    idempotency_key=claims.idempotency_key,
                    initial_update_complete=False,
                    historical_update_complete=False,
                    received_at=now,
                    processed_at=now,
                )
                update_fields = []
                if new_status != conn.status:
                    conn.status = new_status
                    update_fields.append("status")
                if set_sync_due and not conn.sync_due:
                    conn.sync_due = True
                    update_fields.append("sync_due")
                if update_fields:
                    conn.save(update_fields=update_fields)
                if not _enforce_webhook_inbox_cap(event.pk):
                    raise _InboxCapExceeded()
        except _InboxCapExceeded:
            raise WebhookInboxFull() from None
        except IntegrityError as exc:
            constraint_name = _constraint_name(exc)
            if constraint_name is not None:
                if constraint_name == _WEBHOOK_EVENT_IDEMPOTENCY_UNIQUE:
                    raise WebhookDuplicateEvent() from None
                raise
            if PlaidWebhookEvent.objects.filter(
                idempotency_key=claims.idempotency_key
            ).exists():
                raise WebhookDuplicateEvent() from None
            raise


@dataclass(frozen=True)
class SyncPageResult:
    """Safe outcome of one page application; counts only, repr-safe.

    Carries at most booleans and row counts; never provider identities,
    names, amounts, cursors, tokens, or raw values by construction.
    ``applied`` is False when the page was blocked without mutation: either
    because the connection cursor no longer corresponds to the page (already
    advanced or inconsistent), or because the provider categories failed
    closed. In every blocked case ``last_sync_error`` carries the fixed
    redacted reason and nothing else changed.
    """

    applied: bool
    added: int = 0
    modified: int = 0
    removed: int = 0
    superseded: int = 0
    skipped: int = 0
    quarantined: int = 0


@dataclass(frozen=True)
class SyncRunResult:
    """Safe outcome of one bounded sync run; counts only, repr-safe.

    Carries at most booleans and row counts; never cursors, tokens, provider
    identities, names, amounts, or raw provider values by construction.
    ``blocked`` is True when the run stopped without applying its requested
    pages: a guarded connection state, an unavailable token, a provider
    outage, an exhausted mutation-restart budget, an anchor fail-closed, or
    a page the page-applier blocked. ``history_complete`` is True only when
    the run drained the provider's pagination (the final applied page
    reported ``has_more=False``) and that page reported
    ``HISTORICAL_UPDATE_COMPLETE``; a run stopped at the page cap reports
    not complete and resumes later from the committed cursor.
    ``anchors_applied`` counts the section 5 anchors applied during this run.
    """

    blocked: bool = False
    pages_applied: int = 0
    added: int = 0
    modified: int = 0
    removed: int = 0
    superseded: int = 0
    skipped: int = 0
    quarantined: int = 0
    history_complete: bool = False
    anchors_applied: int = 0


class _AnchorFailClosed(Exception):
    """Completion was reported but a link cannot be anchored.

    Internal fail-closed marker: the caller's atomic block (the page commit
    that reports completion) rolls back entirely, so rows, cursor, status,
    and any partial anchor writes never exist without the history that
    justifies them. The fixed redacted error is recorded after the rollback
    and the whole window is re-requested later.
    """


class _ArchivedCategoryError(Exception):
    """The only same-name/type provider category row is archived.

    Internal fail-closed marker for ``docs/plaid.md`` section 6: the page is
    never half-applied, the category is never un-archived or duplicated, and
    the cursor is left unmoved.
    """


class _PageCounters:
    __slots__ = ("added", "modified", "removed", "superseded", "skipped")

    def __init__(self):
        self.added = 0
        self.modified = 0
        self.removed = 0
        self.superseded = 0
        self.skipped = 0


def _owned_error(detail):
    return f"{SYNC_ERROR_TAG} {detail}"


def _replace_owned_error(connection, message):
    """Record ``message`` only when the field is empty or already ours.

    Preserves an unrelated (for example account-import-owned) error exactly;
    the same rule as the existing ``account_import`` error-field semantics.
    """
    current = connection.last_sync_error
    if not current or current.startswith(SYNC_ERROR_TAG):
        connection.last_sync_error = message


def _sync_error_summary(quarantines, skipped_rows):
    """Build the bounded, redacted page-error summary.

    Contains only deterministic fixed reason strings and counts, never a
    provider id, name, amount, date, account, cursor, or token. Mirrors the
    bounded ``account_import`` summary shape.
    """
    parts = []
    if quarantines:
        reasons = list(dict.fromkeys(q.reason for q in quarantines))
        shown = reasons[:_SYNC_ERROR_MAX_REASONS]
        listing = "; ".join(shown)
        if len(reasons) > len(shown):
            listing += "; and more"
        parts.append(f"quarantined {len(quarantines)} row(s): {listing}")
    if skipped_rows:
        parts.append(f"skipped {skipped_rows} unlinked row(s)")
    return _owned_error("; ".join(parts))[:SYNC_ERROR_MAX_LENGTH]


def _find_provider_categories(user, category_type):
    """Rows whose trimmed lowercased name equals the provider category name.

    Uses the exact functional key of the ``categories_user_name_type_unique``
    constraint (``Lower(Trim(name))``) so a same-key archived row is found
    and never silently duplicated.
    """
    return list(
        Category.objects.annotate(_name_key=Lower(Trim(F("name"))))
        .filter(
            user=user,
            category_type=category_type,
            _name_key=UNCATEGORIZED_NAME.strip().lower(),
        )
        .order_by("created_at", "id")
    )


def _ensure_provider_category(user, category_type):
    """Return the provider-owned ``Uncategorized`` row, creating it once.

    Reuses an existing non-archived same-key row; creates one only when none
    exists. When the only same-key row is archived the sync fails closed with
    :class:`_ArchivedCategoryError` and nothing is imported, never
    un-archiving or auto-creating a duplicate. The concurrent-insert race
    (two Items of one user syncing at once) is translated to a reuse of the
    exact same-key row exactly as the ``account_import`` duplicate path does.
    """
    existing = _find_provider_categories(user, category_type)
    active = [row for row in existing if not row.is_archived]
    if active:
        return active[0]
    if existing:
        raise _ArchivedCategoryError()
    row = Category(user=user, name=UNCATEGORIZED_NAME, category_type=category_type)
    try:
        with transaction.atomic():
            row.full_clean(validate_unique=False, validate_constraints=False)
            row.save()
    except IntegrityError as exc:
        constraint_name = _constraint_name(exc)
        if (
            constraint_name is not None
            and constraint_name != _CATEGORY_UNIQUE_CONSTRAINT
        ):
            raise
        raced = _find_provider_categories(user, category_type)
        if not raced:
            raise
        active = [row for row in raced if not row.is_archived]
        if not active:
            raise _ArchivedCategoryError()
        return active[0]
    return row


def _linked_account_map(connection):
    """Provider account id -> linked Account owned by the connection owner.

    A link whose user or linked account belongs to another user is malformed
    state and is never usable: rows referencing it are skipped, never
    created or mutated (``docs/plaid.md`` section 4 ownership).
    """
    mapping = {}
    links = PlaidAccountLink.objects.filter(connection=connection).select_related(
        "account"
    )
    for link in links:
        if (
            link.user_id != connection.user_id
            or link.account.user_id != connection.user_id
        ):
            continue
        mapping[link.plaid_account_id] = link.account
    return mapping


def _apply_added(connection, tx, categories, account_map, counters):
    """Insert one added row unless already stored; returns the row or None.

    Duplicate delivery is safe: an existing ``plaid_transaction_id`` for this
    user skips the insert, and the concurrent duplicate race (the per-user
    unique constraint) is translated to the same skip. Every inserted row
    carries ``source=plaid``, the connection, the linked Mohr account for the
    provider account id, the pending flag, the mapped positive ``Decimal``
    amount, the mapped type, the posted date, and the matching default
    provider category. An unmappable provider account skips the row with a
    fixed redacted reason and continues.
    """
    account = account_map.get(tx.account_id)
    if account is None:
        counters.skipped += 1
        return None
    if Transaction.objects.filter(
        user=connection.user, plaid_transaction_id=tx.transaction_id
    ).exists():
        return None
    row = Transaction(
        user=connection.user,
        connection=connection,
        account=account,
        category=categories[tx.transaction_type],
        transaction_type=tx.transaction_type,
        amount=tx.amount,
        date=tx.date,
        provider_name=tx.name,
        source=TransactionSource.PLAID,
        is_pending=tx.is_pending,
        plaid_transaction_id=tx.transaction_id,
        plaid_pending_transaction_id=tx.pending_transaction_id,
    )
    try:
        with transaction.atomic():
            row.full_clean(validate_unique=False, validate_constraints=False)
            row.save()
    except IntegrityError as exc:
        constraint_name = _constraint_name(exc)
        if (
            constraint_name is not None
            and constraint_name != _PLAID_TRANSACTION_UNIQUE_CONSTRAINT
        ):
            raise
        raced = Transaction.objects.filter(
            user=connection.user, plaid_transaction_id=tx.transaction_id
        ).exists()
        if not raced:
            raise
        return None
    counters.added += 1
    return row


def _supersede_pending(connection, posted_row, counters):
    """Mark the pending row superseded by its posted replacement, once.

    An ``added`` posted row carrying ``pending_transaction_id`` supersedes
    the matching pending row in the same atomic block, so spend counts
    exactly once. Idempotent when replayed: an already-superseded row is
    never re-annotated and an existing annotation is never cleared. A pending
    row Plaid separately reports in ``removed`` keeps both flags (either
    event order converges).

    The pending row is scoped to this connection, so a same-user row owned by
    another Item can never be superseded by this Item's posted replacement.
    """
    if posted_row.is_pending:
        return
    pending_id = posted_row.plaid_pending_transaction_id
    if not pending_id:
        return
    pending = Transaction.objects.filter(
        user=connection.user,
        connection=connection,
        plaid_transaction_id=pending_id,
    ).first()
    if pending is None or pending.pk == posted_row.pk or pending.is_superseded:
        return
    pending.is_superseded = True
    pending.superseded_by = posted_row
    pending.save(update_fields=["is_superseded", "superseded_by"])
    counters.superseded += 1


def _apply_modified(connection, tx, categories, account_map, counters):
    """Update provider-owned fields of the matching row only.

    Amount, type, date, name, pending flag, and the provider pending id come
    from the provider. ``note`` is never touched, and ``category`` is
    restored to the default provider category only while
    ``category_customized`` is False; neither override flag is ever cleared.
    The matching row is scoped to this connection, so a row stored by a
    different connection of the same user is never read or mutated. An
    unmappable provider account skips the row without mutating it, and a
    row that does not exist (or nothing to change) is a no-op.
    """
    account = account_map.get(tx.account_id)
    if account is None:
        counters.skipped += 1
        return
    row = Transaction.objects.filter(
        user=connection.user,
        connection=connection,
        plaid_transaction_id=tx.transaction_id,
    ).first()
    if row is None:
        return
    updates = {
        "amount": tx.amount,
        "transaction_type": tx.transaction_type,
        "date": tx.date,
        "provider_name": tx.name,
        "is_pending": tx.is_pending,
        "plaid_pending_transaction_id": tx.pending_transaction_id,
    }
    if not row.category_customized:
        updates["category"] = categories[tx.transaction_type]
    changed = {
        name: value for name, value in updates.items() if getattr(row, name) != value
    }
    if not changed:
        return
    for name, value in changed.items():
        setattr(row, name, value)
    row.save(update_fields=list(changed))
    counters.modified += 1


def _apply_removed(connection, removed, counters):
    """Set ``is_provider_removed`` on the matching row, never hard delete.

    Idempotent: an already-removed row (including one already superseded)
    keeps every existing flag and annotation; only the removal flag is set.
    The matching row is scoped to this connection, so a row stored by a
    different connection of the same user is never flagged.
    """
    row = Transaction.objects.filter(
        user=connection.user,
        connection=connection,
        plaid_transaction_id=removed.transaction_id,
    ).first()
    if row is None:
        return
    if not row.is_provider_removed:
        row.is_provider_removed = True
        row.save(update_fields=["is_provider_removed"])
        counters.removed += 1


def apply_sync_page(connection, page, request_cursor=None):
    """Atomically apply ONE normalized sync page for ONE connection.

    ``connection`` is a persisted :class:`PlaidConnection` and the page one
    :class:`~plaid_integration.transaction_sync.NormalizedSyncPage` already
    produced from this Item's own ``/transactions/sync`` response. The whole
    application (rows, ``last_sync_error``, status, ``last_synced_at``, and
    the new cursor) commits in one ``transaction.atomic()`` block, so a
    failed page changes nothing: no rows, no cursor, no status, no error.

    The connection row is locked with ``select_for_update()`` inside the same
    block, before the stored cursor is read, serializing concurrent syncs
    per Item. The cursor is only ever written in the same commit as the page
    and only when the page continues from the committed state:

    - ``stored == next_cursor``: the page is already committed (a
      mutation-during-pagination replay or a concurrent duplicate delivery);
      it is re-applied idempotently and the cursor stays put.
    - ``stored == request_cursor`` (including both None for the initial
      call): a fresh forward page; rows apply and the cursor advances to
      ``next_cursor``.
    - otherwise the connection cursor is already advanced, lost, or
      inconsistent: the page is blocked with a fixed redacted
      ``last_sync_error`` and nothing is applied or moved. ``request_cursor``
      is the exact cursor sent to the provider to fetch ``page``; the
      initial call sends none.

    Provider-owned ``Uncategorized`` categories are ensured for the
    connection's user first; when the only same-key row of either type is
    archived the page fails closed with ``last_sync_error`` and the cursor
    unmoved. Provider rows whose provider account has no supported link for
    this connection are skipped with a fixed redacted reason, and every
    normalization quarantine is recorded in bounded redacted form while the
    cursor still advances, so one bad row never deadlocks the connection.
    Returns the repr-safe :class:`SyncPageResult`.
    """
    result, _ = _apply_sync_page(
        connection, page, request_cursor=request_cursor, replaying=False
    )
    return result


def _apply_sync_page(connection, page, request_cursor=None, replaying=False):
    """Replay-capable core of :func:`apply_sync_page`.

    ``replaying`` is True only for a page fetched as part of a restarted
    pagination sequence of the same update (``TRANSACTIONS_SYNC_MUTATION_
    DURING_PAGINATION``): a page that neither continues from the committed
    cursor nor is the already-committed last page is a re-served page of the
    same update whose rows are already committed, so it is re-applied
    idempotently and the cursor stays put. The cursor never moves backward
    past a committed value except by replaying the same update
    (``docs/plaid.md`` section 7). The flag is private to the sync run's
    restart path; the public :func:`apply_sync_page` never re-serves pages
    behind the committed cursor.

    Returns the repr-safe :class:`SyncPageResult` and whether the page
    actually advanced the committed cursor (a re-applied page from behind
    the cursor contributes nothing to a run's totals because its rows are
    already stored).
    """
    with transaction.atomic():
        conn = PlaidConnection.objects.select_for_update().get(pk=connection.pk)
        replayed = conn.sync_cursor == page.next_cursor
        fresh = conn.sync_cursor == request_cursor
        if not replayed and not fresh and not replaying:
            _replace_owned_error(conn, _owned_error(BLOCKED_CURSOR_DETAIL))
            conn.save(update_fields=["last_sync_error"])
            return SyncPageResult(applied=False), False
        try:
            categories = {
                TransactionType.INCOME: _ensure_provider_category(
                    conn.user, CategoryType.INCOME
                ),
                TransactionType.EXPENSE: _ensure_provider_category(
                    conn.user, CategoryType.EXPENSE
                ),
            }
        except _ArchivedCategoryError:
            _replace_owned_error(conn, _owned_error(ARCHIVED_CATEGORY_DETAIL))
            conn.save(update_fields=["last_sync_error"])
            return SyncPageResult(applied=False), False

        account_map = _linked_account_map(conn)
        counters = _PageCounters()
        for added in page.added:
            row = _apply_added(conn, added, categories, account_map, counters)
            if row is not None:
                _supersede_pending(conn, row, counters)
        for modified in page.modified:
            _apply_modified(conn, modified, categories, account_map, counters)
        for removed in page.removed:
            _apply_removed(conn, removed, counters)

        if page.quarantines or counters.skipped:
            _replace_owned_error(
                conn,
                _sync_error_summary(page.quarantines, counters.skipped),
            )
        elif conn.last_sync_error.startswith(SYNC_ERROR_TAG):
            conn.last_sync_error = ""

        if fresh:
            conn.sync_cursor = page.next_cursor
        conn.transactions_update_status = _PROVIDER_UPDATE_STATUS_TO_MODEL[
            page.transactions_update_status
        ]
        conn.last_synced_at = timezone.now()
        conn.save(
            update_fields=[
                "sync_cursor",
                "transactions_update_status",
                "last_synced_at",
                "last_sync_error",
            ]
        )

    return (
        SyncPageResult(
            applied=True,
            added=counters.added,
            modified=counters.modified,
            removed=counters.removed,
            superseded=counters.superseded,
            skipped=counters.skipped,
            quarantined=len(page.quarantines),
        ),
        fresh,
    )


def _decrypt_access_token(connection):
    """Return the plaintext access token, or None when it is unavailable.

    Decrypts the stored package with the configured key ring. A missing
    stored token, a missing key ring, or an undecryptable package is an
    error state. The plaintext is held in memory only for the outgoing
    gateway calls and is never logged, stored, interpolated, or returned.
    """
    ring = settings.PLAID_TOKEN_RING
    package = connection.access_token_encrypted
    key_id = connection.encryption_key_id
    if ring is None or not package or not key_id:
        return None
    try:
        decrypted = ring.decrypt(package, key_id)
    except TokenCryptoError:
        return None
    return decrypted.plaintext.decode()


def decrypt_connection_access_token(connection):
    """Return the decrypted stored access token for ONE owned connection.

    Narrow safe accessor for server-only flows that must reuse a stored
    Item's permanent token (update-mode Link token issuance). A missing,
    cleared, wrong-key, malformed, or undecryptable token returns None so
    the caller fails closed; the plaintext is held in memory only for the
    outgoing gateway call and is never logged, stored, interpolated, or
    returned.
    """
    return _decrypt_access_token(connection)


def _record_owned_error(connection, message):
    """Record ``message`` through the owned-error convention, nothing else.

    Writes only when the field is empty or already ours, so an unrelated
    error is preserved exactly; the row is briefly locked for the read-check
    and write. Never touches the cursor or status.
    """
    with transaction.atomic():
        conn = PlaidConnection.objects.select_for_update().get(pk=connection.pk)
        _replace_owned_error(conn, message)
        conn.save(update_fields=["last_sync_error"])


def _record_outage_error(connection, detail):
    """Record the fixed redacted outage detail and set the ``error`` status.

    The cursor is never touched: it stays exactly where the last committed
    page put it, so a later retry is always safe (``docs/plaid.md`` section
    9). A previously recorded error tag that is not ours is preserved.
    """
    with transaction.atomic():
        conn = PlaidConnection.objects.select_for_update().get(pk=connection.pk)
        _replace_owned_error(conn, _owned_error(detail))
        conn.status = PlaidConnectionStatus.ERROR
        conn.save(update_fields=["last_sync_error", "status"])


def _record_anchor_error(connection):
    """Record the anchor fail-closed reason unconditionally.

    The whole window is blocked by the missing anchor balance, so the reason
    the run stopped must be the anchor reason even when the shared field
    already carries another owned summary (for example an account-import
    tag): the user must be able to see why nothing was applied. Only the
    fixed redacted reason is written; the cursor, status, and rows are never
    touched, and the window is re-requested later.
    """
    with transaction.atomic():
        conn = PlaidConnection.objects.select_for_update().get(pk=connection.pk)
        conn.last_sync_error = _owned_error(ANCHOR_MISSING_BALANCE_DETAIL)
        conn.save(update_fields=["last_sync_error"])


def _restore_active_status(connection):
    """Heal the connection status back to ``active`` after a successful run.

    Called only when a pagination attempt completed without blocking. Sets
    ``status`` to ``active`` if and only if it is currently ``error`` (the
    single transient provider-outage symptom); every other status is left
    untouched, and the cursor and ``last_sync_error`` are never written. The
    row is briefly locked so the status-only update is atomic and never
    bypasses the page commit block (``docs/plaid.md`` section 9).
    """
    with transaction.atomic():
        conn = PlaidConnection.objects.select_for_update().get(pk=connection.pk)
        if conn.status == PlaidConnectionStatus.ERROR:
            conn.status = PlaidConnectionStatus.ACTIVE
            conn.save(update_fields=["status"])


def _import_page_accounts(connection, page):
    """Import the page's supported provider accounts before rows are mapped.

    The page already carries normalized account outcomes, so they are passed
    to the normalized import entry point directly and never re-derived from
    raw provider shapes. Idempotent and safe to repeat on a replay. The
    import runs in its own atomic block, before the page apply; a page that
    later fails still leaves only unanchored accounts, which contribute
    exact zero to every aggregate by construction (``docs/plaid.md`` section
    5).
    """
    supported = [outcome for outcome in page.account_outcomes if not outcome.skipped]
    if not supported:
        return
    import_normalized_provider_accounts(connection, supported)


def _apply_anchors(connection):
    """Apply the section 5 opening-balance anchor inside the caller's atomic block.

    Called only for a page whose commit reports ``HISTORICAL_UPDATE_COMPLETE``
    and is the drained final page of the window (``has_more=False``), so the
    anchor is pinned against the complete imported history, never a partial
    one. For every link of this connection whose ``anchor_applied_at`` is still
    null, the opening balance is seeded from the immutable captured anchor
    balance and the sums of the imported POSTED rows only (pending,
    provider-removed, and superseded rows are excluded), per the frozen
    formulas:

    - checking and savings:
        opening_balance = anchor_provider_current_balance
                        - (posted_income - posted_expense)
    - credit card (a negative liability in Mohr):
        opening_balance = -anchor_provider_current_balance
                        - (posted_income - posted_expense)

    The linked Account's ``opening_balance`` and the link's
    ``anchor_applied_at`` are written here so they commit together with the
    page rows and cursor that justify them, and the ``anchor_applied_at IS
    NULL`` guard makes a replayed completion page a no-op. Malformed links
    whose user or linked account belongs to another user, or whose Account
    type is not a supported account class, are never written. A link without
    a captured anchor balance fails closed with :class:`_AnchorFailClosed`
    so the whole page commit rolls back and the window is re-requested later.
    """
    links = PlaidAccountLink.objects.filter(
        connection=connection,
        anchor_applied_at__isnull=True,
    ).select_related("account")
    applied = 0
    for link in links:
        if (
            link.user_id != connection.user_id
            or link.account.user_id != connection.user_id
        ):
            continue
        if link.account.account_type not in (
            AccountType.CHECKING,
            AccountType.SAVINGS,
            AccountType.CREDIT_CARD,
        ):
            continue
        if link.anchor_provider_current_balance is None:
            raise _AnchorFailClosed()
        totals = Transaction.objects.filter(
            user=connection.user,
            connection=connection,
            account_id=link.account_id,
            is_provider_removed=False,
            is_pending=False,
            is_superseded=False,
        ).aggregate(
            income=Coalesce(
                Sum("amount", filter=Q(transaction_type=TransactionType.INCOME)),
                Value(Decimal("0.00")),
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
            expense=Coalesce(
                Sum("amount", filter=Q(transaction_type=TransactionType.EXPENSE)),
                Value(Decimal("0.00")),
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
        )
        net_income = totals["income"] - totals["expense"]
        anchor = link.anchor_provider_current_balance
        if link.account.account_type == AccountType.CREDIT_CARD:
            opening_balance = -anchor - net_income
        else:
            opening_balance = anchor - net_income
        link.account.opening_balance = opening_balance
        link.account.save(update_fields=["opening_balance"])
        link.anchor_applied_at = timezone.now()
        link.save(update_fields=["anchor_applied_at"])
        applied += 1
    return applied


def _blocked_run(state):
    """The repr-safe blocked result carrying the run's counts so far."""
    return SyncRunResult(
        blocked=True,
        pages_applied=state.pages_applied,
        added=state.added,
        modified=state.modified,
        removed=state.removed,
        superseded=state.superseded,
        skipped=state.skipped,
        quarantined=state.quarantined,
    )


@dataclass
class _SyncRunState:
    """Mutable per-run counts shared across mutation-restart attempts.

    A restarted pagination attempt re-applies already-committed pages, so the
    run totals must survive the abort of the attempt that raised
    ``TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION``. Only pages that
    actually advanced the committed cursor contribute to the totals; a
    re-applied page from behind the cursor contributes nothing because its
    rows are already stored. Only counts and booleans live here; cursors,
    tokens, and provider values never do.
    """

    pages_applied: int = 0
    added: int = 0
    modified: int = 0
    removed: int = 0
    superseded: int = 0
    skipped: int = 0
    quarantined: int = 0
    anchors_applied: int = 0
    history_complete: bool = False


def _run_pagination_attempt(
    connection, gateway, access_token, start_cursor, page_cap, state, replaying
):
    """One pagination sequence starting from ``start_cursor``.

    Fetches pages and, per page in order: imports the supported accounts
    carried on the page so linked Mohr accounts exist before rows are mapped,
    then applies the page through the private replay-capable page applier so
    rows and the new cursor commit in one atomic block; when that page
    reports ``HISTORICAL_UPDATE_COMPLETE`` AND is the drained final page
    (``has_more=False``) the section 5 anchor is applied in the same block,
    so the anchor commits exactly with the complete history window. Stops at
    the page cap (reported not complete) or when the provider reports
    ``has_more=False``. ``request_cursor`` is always the
    exact cursor sent to the provider for that page, so an already-committed
    page from a previous attempt re-applies idempotently and the cursor never
    moves backward past a committed value. ``replaying`` is True for a
    restarted sequence (mutation-during-pagination), which is the one legal
    case for re-serving pages behind the committed cursor
    (``docs/plaid.md`` section 7). ``state`` accumulates the run totals so
    counts survive an aborted attempt; a page only contributes to the
    totals when it actually advanced the committed cursor, so re-applied
    pages from behind the cursor are never double-counted. Returns None on
    success or the repr-safe blocked :class:`SyncRunResult` when a page
    blocked the run. Provider error conditions (outage,
    mutation-during-pagination) propagate to the caller.
    """
    request_cursor = start_cursor
    while state.pages_applied < page_cap:
        page = gateway.sync_transactions(access_token, cursor=request_cursor)
        _import_page_accounts(connection, page)
        try:
            with transaction.atomic():
                page_result, cursor_advanced = _apply_sync_page(
                    connection,
                    page,
                    request_cursor=request_cursor,
                    replaying=replaying,
                )
                if (
                    page_result.applied
                    and page.transactions_update_status
                    == PROVIDER_HISTORICAL_UPDATE_COMPLETE
                    and not page.has_more
                ):
                    state.anchors_applied += _apply_anchors(connection)
        except _AnchorFailClosed:
            _record_anchor_error(connection)
            return _blocked_run(state)
        if not page_result.applied:
            return _blocked_run(state)
        if cursor_advanced:
            state.pages_applied += 1
            state.added += page_result.added
            state.modified += page_result.modified
            state.removed += page_result.removed
            state.superseded += page_result.superseded
            state.skipped += page_result.skipped
            state.quarantined += page_result.quarantined
        request_cursor = page.next_cursor
        if not page.has_more:
            state.history_complete = (
                page.transactions_update_status == PROVIDER_HISTORICAL_UPDATE_COMPLETE
            )
            break


def perform_sync(
    connection,
    *,
    gateway=None,
    page_cap=PAGE_CAP,
    max_mutation_restarts=MAX_MUTATION_RESTARTS,
):
    """Drive one bounded sync of ONE PlaidConnection (issue #38 slice E).

    ``gateway`` is injectable so tests never touch the network; when it is
    not supplied it is built from settings (constructing it performs no
    network call). The stored access token is decrypted with the configured
    key ring and held in memory only for the gateway calls; a missing or
    undecryptable token blocks the run with the fixed redacted owned error
    and no other write. A ``disconnected``, ``revoked``, or ``updating``
    connection is blocked without any fetch or write.

    Pages are fetched from the connection's committed cursor (none on the
    initial call) and applied one at a time: the supported accounts carried
    on the page are imported first (idempotent), then the page applier
    commits the rows, the cursor, and the status in one atomic block, and
    the opening-balance anchor is applied in that same block only when the
    page reports ``HISTORICAL_UPDATE_COMPLETE`` and is the drained final
    page (``has_more=False``). Pagination continues while ``has_more`` and
    the page cap allow; a run stopped at the cap is reported not complete
    and resumes later from the committed cursor.

    A ``TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`` error restarts the
    whole pagination sequence from the cursor held at the start of that
    update, re-applying already-committed pages idempotently, up to
    ``max_mutation_restarts`` restarts; a re-applied page from behind the
    committed cursor never advances it and contributes nothing to the run
    totals. Exhausting the restarts blocks with a fixed
    redacted error and the cursor at its last committed value. A provider
    outage blocks with the fixed redacted detail, sets the ``error`` status,
    and never moves the cursor, so a later retry is always safe; a later run
    that completes without blocking heals the status back to ``active``.
    Returns the repr-safe :class:`SyncRunResult`; provider conditions never
    raise.
    """
    if gateway is None:
        gateway = PlaidGateway.from_settings()

    conn = PlaidConnection.objects.get(pk=connection.pk)
    if conn.status in (
        PlaidConnectionStatus.DISCONNECTED,
        PlaidConnectionStatus.REVOKED,
        PlaidConnectionStatus.UPDATING,
    ):
        return SyncRunResult(blocked=True)

    access_token = _decrypt_access_token(conn)
    if access_token is None:
        _record_owned_error(conn, _owned_error(TOKEN_UNAVAILABLE_DETAIL))
        return SyncRunResult(blocked=True)

    start_cursor = conn.sync_cursor
    state = _SyncRunState()
    restarts_left = max_mutation_restarts
    replaying = False
    while True:
        try:
            result = _run_pagination_attempt(
                conn,
                gateway,
                access_token,
                start_cursor,
                page_cap,
                state,
                replaying,
            )
            if result is not None:
                return result
            _restore_active_status(conn)
            return SyncRunResult(
                blocked=False,
                pages_applied=state.pages_applied,
                added=state.added,
                modified=state.modified,
                removed=state.removed,
                superseded=state.superseded,
                skipped=state.skipped,
                quarantined=state.quarantined,
                history_complete=state.history_complete,
                anchors_applied=state.anchors_applied,
            )
        except PlaidSyncMutationError:
            if restarts_left <= 0:
                _record_owned_error(
                    conn, _owned_error(MUTATION_RESTARTS_EXHAUSTED_DETAIL)
                )
                return _blocked_run(state)
            restarts_left -= 1
            replaying = True
        except PlaidGatewayError as exc:
            _record_outage_error(conn, str(exc))
            return _blocked_run(state)


@dataclass(frozen=True)
class PlaidStateCleanupResult:
    """Counts-only outcome of one bounded cleanup invocation.

    Carries nothing but integer counts; never digests, item ids, bodies,
    tokens, or user details, so the caller can print it verbatim.
    """

    webhook_events_deleted: int = 0
    exchange_handles_deleted: int = 0


def cleanup_plaid_state(batch_size, now=None):
    """Bound the webhook inbox and purge expired handles in one invocation.

    Runs the ``cleanup_plaid_state`` management command's work with a
    deterministic injected ``now`` (defaults to the current time). In one
    bounded invocation it deletes, oldest first and each kind capped at
    ``batch_size``:

    1. processed webhook rows older than the configured
       ``PLAID_WEBHOOK_PROCESSED_RETENTION_DAYS`` window (strictly older: a
       row whose ``processed_at`` equals the cutoff is retained);
    2. exchange handles that are expired (``expires_at <= now``) OR consumed
       (``consumed_at`` set), never an unconsumed unexpired handle;
    3. additional oldest processed webhook rows when the table remains above
       ``PLAID_WEBHOOK_INBOX_CAP``, again at most ``batch_size``.

    Unprocessed matched webhook rows are never deleted. Deletion uses PK
    lists gathered first, then one bounded delete per kind, so behavior is
    deterministic across PostgreSQL and Django. The whole invocation commits
    atomically. Returns the counts-only :class:`PlaidStateCleanupResult`;
    ``batch_size`` validation belongs to the command.
    """
    if now is None:
        now = timezone.now()
    retention_days = settings.PLAID_WEBHOOK_PROCESSED_RETENTION_DAYS
    cutoff = now - timedelta(days=retention_days)
    cap = settings.PLAID_WEBHOOK_INBOX_CAP
    with transaction.atomic():
        events_deleted = 0
        expired_pks = list(
            PlaidWebhookEvent.objects.filter(
                processed_at__isnull=False, processed_at__lt=cutoff
            )
            .order_by("received_at", "id")
            .values_list("pk", flat=True)[:batch_size]
        )
        if expired_pks:
            events_deleted += PlaidWebhookEvent.objects.filter(
                pk__in=expired_pks
            ).delete()[0]
        handles_deleted = 0
        spent_pks = list(
            PlaidExchangeHandle.objects.filter(
                Q(expires_at__lte=now) | Q(consumed_at__isnull=False)
            )
            .order_by("created_at", "id")
            .values_list("pk", flat=True)[:batch_size]
        )
        if spent_pks:
            handles_deleted += PlaidExchangeHandle.objects.filter(
                pk__in=spent_pks
            ).delete()[0]
        overflow = PlaidWebhookEvent.objects.count() - cap
        if overflow > 0:
            extra_pks = list(
                PlaidWebhookEvent.objects.filter(processed_at__isnull=False)
                .order_by("received_at", "id")
                .values_list("pk", flat=True)[: min(overflow, batch_size)]
            )
            if extra_pks:
                events_deleted += PlaidWebhookEvent.objects.filter(
                    pk__in=extra_pks
                ).delete()[0]
    return PlaidStateCleanupResult(
        webhook_events_deleted=events_deleted,
        exchange_handles_deleted=handles_deleted,
    )
