"""Server-only helpers for the Plaid Link flow and transaction sync.

Implements the opaque client user id (``docs/plaid.md`` section 2), the
digest-only exchange handle issuance foundation and the atomic single-use
claim consumed by the exchange endpoint (section 3), the encrypted
connection persistence bound to the authenticated user (section 4), and the
idempotent per-page application of one normalized ``/transactions/sync``
page (section 7) for issue #38 slice D. One ``transaction.atomic()`` block
writes the applied rows and the next cursor together; a per-Item row lock
serializes concurrent syncs; the cursor never moves backward, on failure, or
on a page that does not continue from the committed state; provider
quarantines and unmappable-account rows are recorded in bounded redacted
form on ``last_sync_error`` without ever deadlocking the connection; and
provider-owned ``Uncategorized`` categories fail closed when archived.
"""

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction
from django.db.models import F
from django.db.models.functions import Lower, Trim
from django.utils import timezone

from categories.models import Category, CategoryType
from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    PlaidConnectionStatus,
    PlaidExchangeHandle,
    TransactionsUpdateStatus,
)
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
    with transaction.atomic():
        conn = PlaidConnection.objects.select_for_update().get(pk=connection.pk)
        replayed = conn.sync_cursor == page.next_cursor
        if not replayed and conn.sync_cursor != request_cursor:
            _replace_owned_error(conn, _owned_error(BLOCKED_CURSOR_DETAIL))
            conn.save(update_fields=["last_sync_error"])
            return SyncPageResult(applied=False)
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
            return SyncPageResult(applied=False)

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

    return SyncPageResult(
        applied=True,
        added=counters.added,
        modified=counters.modified,
        removed=counters.removed,
        superseded=counters.superseded,
        skipped=counters.skipped,
        quarantined=len(page.quarantines),
    )
