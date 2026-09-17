"""Safe page normalization for the Plaid ``/transactions/sync`` gateway call.

Implements the ``docs/plaid.md`` section 7 sync-protocol and decimal rules and
the section 10 redaction contract for issue #38 slice B, at the Plaid
integration boundary:

- ``normalize_provider_transaction`` extracts only the narrow fields Mohr
  persists from one provider ``Transaction`` shape (``transaction_id``,
  ``account_id``, nullable ``pending_transaction_id``, ``amount``, posted
  ``date``, ``merchant_name``/``name`` display fallback, ``pending``) and
  applies the section 7 signed-amount mapping without binary float
  arithmetic: positive becomes expense, negative becomes income, the amount
  is cent-quantized with ``ROUND_HALF_UP``, and any value that quantization
  would change is quarantined rather than silently rounded.
- ``normalize_removed_transaction`` extracts only the exact ``transaction_id``
  of a provider removal.
- ``normalize_sync_page`` validates the page metadata (list shapes, nonempty
  string cursor, bool ``has_more``, one exact supported update status),
  reuses ``normalize_provider_account`` for every account entry and carries
  the ``NormalizationOutcome`` objects forward, and normalizes every
  added/modified/removed row into frozen value objects. One malformed row is
  quarantined with a fixed redacted reason and never fails the page; a
  malformed page (metadata or list shape) fails the whole page with the fixed
  safe gateway error.

The raw provider payload is never retained and never reaches results,
exceptions, logs, or ``repr`` forms: financial values, provider identities,
display names, dates, lists, and the cursor are all ``repr=False`` on the
value objects. ``next_cursor`` is treated as sensitive per ``docs/plaid.md``
section 10. Pending-to-posted fields are preserved in the DTO only; no
reconciliation happens here, and no database or connection state is touched.
"""

import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from plaid_integration.account_import import (
    ACCOUNT_ID_TOO_LONG,
    INVALID_ACCOUNT_ID,
    MISSING_ACCOUNT_ID,
    NormalizationOutcome,
    normalize_provider_account,
)
from plaid_integration.gateway import PLAID_UNAVAILABLE_DETAIL, PlaidGatewayError

logger = logging.getLogger(__name__)

CENT = Decimal("0.01")
# ``Transaction.amount`` is ``DecimalField(max_digits=12, decimal_places=2)``.
_AMOUNT_MAX_MAGNITUDE = Decimal("10") ** (12 - 2)
# ``Transaction.plaid_transaction_id`` / ``plaid_pending_transaction_id`` and
# ``PlaidAccountLink.plaid_account_id`` are bounded at 100 characters.
PLAID_TRANSACTION_ID_MAX_LENGTH = 100
# ``Transaction.provider_name`` is bounded at 200 characters.
PROVIDER_NAME_MAX_LENGTH = 200

OP_ADDED = "added"
OP_MODIFIED = "modified"
OP_REMOVED = "removed"

MALFORMED_TRANSACTION = "malformed transaction"
MISSING_TRANSACTION_ID = "missing transaction id"
INVALID_TRANSACTION_ID = "invalid transaction id"
TRANSACTION_ID_TOO_LONG = "transaction id too long"
INVALID_PENDING_TRANSACTION_ID = "invalid pending transaction id"
INVALID_DISPLAY_NAME = "invalid display name"
INVALID_DATE = "invalid date"
INVALID_AMOUNT = "invalid amount"
ZERO_AMOUNT = "zero amount"
AMOUNT_PRECISION_EXCEEDED = "amount precision exceeded"
AMOUNT_OUT_OF_RANGE = "amount out of range"
INVALID_PENDING_FLAG = "invalid pending flag"

_SUPPORTED_UPDATE_STATUSES = frozenset(
    {
        "NOT_READY",
        "INITIAL_UPDATE_COMPLETE",
        "HISTORICAL_UPDATE_COMPLETE",
    }
)

SYNC_MUTATION_DETAIL = "Plaid reported a change during pagination. Retry the update."

MUTATION_DURING_PAGINATION_CODE = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"


class PlaidSyncMutationError(Exception):
    """Marker for Plaid ``TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION``.

    Raised by the gateway so the sync loop can restart the pagination
    sequence from the cursor held at the start of the update. Carries only the
    fixed safe detail string: no provider body, cursor, token, identifiers, or
    raw data by construction, and it is never raised with a chained cause that
    could expose the provider response (``str``/``repr`` of a plaid
    ``ApiException`` include the raw response body).
    """


@dataclass(frozen=True)
class NormalizedProviderTransaction:
    """Narrow extracted provider transaction plus safe mapped values.

    Only the fields Mohr persists exist; the raw provider payload is never
    retained. Provider identity, display name, posted date, and the mapped
    ``Decimal`` amount are hidden from ``repr`` so the value object can never
    leak provider data into logs or error traces. ``transaction_type`` is the
    mapped ``income``/``expense`` enum and ``is_pending`` is the pending
    lifecycle flag preserved for a later reconciliation slice.
    """

    transaction_id: str = field(repr=False)
    account_id: str = field(repr=False)
    pending_transaction_id: str | None = field(repr=False)
    amount: Decimal = field(repr=False)
    transaction_type: str
    date: date = field(repr=False)
    name: str = field(repr=False)
    is_pending: bool


@dataclass(frozen=True)
class RemovedProviderTransaction:
    """Narrow extracted provider removal identity; provider id is ``repr=False``."""

    transaction_id: str = field(repr=False)


@dataclass(frozen=True)
class TransactionQuarantineOutcome:
    """Fixed redacted outcome for one unconvertible provider row.

    Carries at most the operation kind (``added``/``modified``/``removed``)
    and a deterministic reason string; never a provider id, name, amount,
    date, account, cursor, or raw value. Both fields are safe by
    construction, so its ``repr`` is always printable.
    """

    operation: str
    reason: str


@dataclass(frozen=True)
class TransactionNormalizationOutcome:
    """Outcome of normalizing one provider transaction or removal row.

    Exactly one of ``transaction`` or ``quarantine`` is set.
    """

    transaction: NormalizedProviderTransaction | RemovedProviderTransaction | None = (
        None
    )
    quarantine: TransactionQuarantineOutcome | None = None

    @property
    def skipped(self):
        return self.transaction is None


@dataclass(frozen=True)
class NormalizedSyncPage:
    """Safe normalized page of one ``/transactions/sync`` response.

    Holds only frozen internal value objects and the opaque cursor; the raw
    SDK response is never retained. Financial values, provider identities,
    names, dates, row lists, account outcomes, and the cursor are all
    ``repr=False``; ``repr`` shows only the safe boolean ``has_more``, the
    exact supported ``transactions_update_status`` value, and the count of
    quarantined rows. ``account_outcomes`` carries each
    :class:`~plaid_integration.account_import.NormalizationOutcome` forward so
    unsupported or malformed account siblings can be skipped safely by a
    later slice without re-inspecting provider data.
    """

    added: tuple[NormalizedProviderTransaction, ...] = field(repr=False)
    modified: tuple[NormalizedProviderTransaction, ...] = field(repr=False)
    removed: tuple[RemovedProviderTransaction, ...] = field(repr=False)
    account_outcomes: tuple[NormalizationOutcome, ...] = field(repr=False)
    quarantines: tuple[TransactionQuarantineOutcome, ...] = field(repr=False)
    next_cursor: str = field(repr=False)
    has_more: bool
    transactions_update_status: str
    quarantined: int


class _SkipProviderTransaction(Exception):
    def __init__(self, reason):
        self.reason = reason


def _extract_update_status(value):
    """Extract a status from a provider enum object or a plain string.

    The plaid-python v44 ``TransactionsUpdateStatus`` class is a simple enum
    exposing ``.value``; accepting plain strings keeps the boundary tolerant
    of fake and future shapes. Anything else is malformed.
    """
    if isinstance(value, str):
        return value
    inner = getattr(value, "value", None)
    return inner if isinstance(inner, str) else None


def _normalize_exact_identity(value, missing_reason, invalid_reason, too_long_reason):
    """Validate one exact nonblank provider identity within model bounds.

    Provider identities are never stripped, truncated, or normalized: a value
    padded with leading or trailing whitespace is rejected rather than stored
    in a different byte form from its validated trimmed shape.
    """
    if value is None:
        raise _SkipProviderTransaction(missing_reason)
    if not isinstance(value, str) or not value.strip():
        raise _SkipProviderTransaction(invalid_reason)
    if value != value.strip():
        raise _SkipProviderTransaction(invalid_reason)
    if len(value) > PLAID_TRANSACTION_ID_MAX_LENGTH:
        raise _SkipProviderTransaction(too_long_reason)
    return value


def _normalize_display_name(provider_transaction):
    """Pick the provider display name: ``merchant_name`` when nonblank.

    ``merchant_name`` wins over ``name`` whenever it is a nonblank string;
    otherwise ``name`` is used. The chosen label is stripped, must be
    nonblank, and is deliberately bounded to the ``provider_name`` model max
    so the field can never overflow.
    """
    merchant_name = getattr(provider_transaction, "merchant_name", None)
    if isinstance(merchant_name, str) and merchant_name.strip():
        return merchant_name.strip()[:PROVIDER_NAME_MAX_LENGTH]
    name = getattr(provider_transaction, "name", None)
    if not isinstance(name, str) or not name.strip():
        raise _SkipProviderTransaction(INVALID_DISPLAY_NAME)
    return name.strip()[:PROVIDER_NAME_MAX_LENGTH]


def _normalize_date(value):
    """Convert the posted ``date`` into a Python ``date`` safely.

    The official SDK delivers a ``datetime.date``; ``datetime`` instances and
    ISO-8601 strings are also accepted so the boundary stays tolerant of fake
    and future shapes. ``authorized_date`` is never consulted.
    """
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            raise _SkipProviderTransaction(INVALID_DATE) from None
    raise _SkipProviderTransaction(INVALID_DATE)


def _normalize_amount(value):
    """Map one signed provider amount into positive ``Decimal`` plus type.

    Follows the ``docs/plaid.md`` section 7 rule: serialize to the shortest
    string form immediately (``str(value)``) and construct ``Decimal`` from
    that string, never passing through binary float arithmetic. Booleans,
    non-finite values, unparseable values, zero, and values beyond the model
    field limits are rejected; anything else is quantized to two places with
    ``ROUND_HALF_UP`` and, if quantization changes the value at all, the row
    is quarantined rather than silently rounded. Positive is expense,
    negative is income, and the stored amount is always positive ``abs``.
    """
    if isinstance(value, bool):
        raise _SkipProviderTransaction(INVALID_AMOUNT)
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise _SkipProviderTransaction(INVALID_AMOUNT) from None
    if not parsed.is_finite():
        raise _SkipProviderTransaction(INVALID_AMOUNT)
    if parsed == 0:
        raise _SkipProviderTransaction(ZERO_AMOUNT)
    try:
        quantized = parsed.quantize(CENT, rounding=ROUND_HALF_UP)
    except InvalidOperation:
        raise _SkipProviderTransaction(AMOUNT_OUT_OF_RANGE) from None
    if quantized != parsed:
        raise _SkipProviderTransaction(AMOUNT_PRECISION_EXCEEDED)
    amount = abs(quantized)
    if amount >= _AMOUNT_MAX_MAGNITUDE:
        raise _SkipProviderTransaction(AMOUNT_OUT_OF_RANGE)
    if parsed > 0:
        return amount, "expense"
    return amount, "income"


def _normalize_pending(value):
    if not isinstance(value, bool):
        raise _SkipProviderTransaction(INVALID_PENDING_FLAG)
    return value


def normalize_provider_transaction(provider_transaction, operation):
    """Normalize one provider added/modified row into the narrow value object.

    Returns a :class:`TransactionNormalizationOutcome`. A supported row
    yields a :class:`NormalizedProviderTransaction` with exact identities,
    the section 7 amount mapping, the posted date, and the bounded display
    name; anything else yields a deterministic redacted
    :class:`TransactionQuarantineOutcome` carrying the operation kind and a
    fixed reason, and never fails the page.
    """
    if provider_transaction is None:
        return TransactionNormalizationOutcome(
            quarantine=TransactionQuarantineOutcome(
                operation=operation, reason=MALFORMED_TRANSACTION
            )
        )
    try:
        transaction_id = _normalize_exact_identity(
            getattr(provider_transaction, "transaction_id", None),
            MISSING_TRANSACTION_ID,
            INVALID_TRANSACTION_ID,
            TRANSACTION_ID_TOO_LONG,
        )
        account_id = _normalize_exact_identity(
            getattr(provider_transaction, "account_id", None),
            MISSING_ACCOUNT_ID,
            INVALID_ACCOUNT_ID,
            ACCOUNT_ID_TOO_LONG,
        )
        pending_transaction_id = getattr(
            provider_transaction, "pending_transaction_id", None
        )
        if pending_transaction_id is not None:
            pending_transaction_id = _normalize_exact_identity(
                pending_transaction_id,
                INVALID_PENDING_TRANSACTION_ID,
                INVALID_PENDING_TRANSACTION_ID,
                INVALID_PENDING_TRANSACTION_ID,
            )
        amount, transaction_type = _normalize_amount(
            getattr(provider_transaction, "amount", None)
        )
        transaction_date = _normalize_date(getattr(provider_transaction, "date", None))
        name = _normalize_display_name(provider_transaction)
        is_pending = _normalize_pending(getattr(provider_transaction, "pending", None))
        return TransactionNormalizationOutcome(
            transaction=NormalizedProviderTransaction(
                transaction_id=transaction_id,
                account_id=account_id,
                pending_transaction_id=pending_transaction_id,
                amount=amount,
                transaction_type=transaction_type,
                date=transaction_date,
                name=name,
                is_pending=is_pending,
            )
        )
    except _SkipProviderTransaction as skip:
        return TransactionNormalizationOutcome(
            quarantine=TransactionQuarantineOutcome(
                operation=operation, reason=skip.reason
            )
        )


def normalize_removed_transaction(provider_transaction):
    """Normalize one provider removal into its exact transaction identity.

    Only the exact nonblank ``transaction_id`` within model bounds is
    extracted; a malformed removal becomes a per-row redacted quarantine
    outcome carrying the ``removed`` operation kind.
    """
    if provider_transaction is None:
        return TransactionNormalizationOutcome(
            quarantine=TransactionQuarantineOutcome(
                operation=OP_REMOVED, reason=MALFORMED_TRANSACTION
            )
        )
    try:
        transaction_id = _normalize_exact_identity(
            getattr(provider_transaction, "transaction_id", None),
            MISSING_TRANSACTION_ID,
            INVALID_TRANSACTION_ID,
            TRANSACTION_ID_TOO_LONG,
        )
        return TransactionNormalizationOutcome(
            transaction=RemovedProviderTransaction(transaction_id=transaction_id)
        )
    except _SkipProviderTransaction as skip:
        return TransactionNormalizationOutcome(
            quarantine=TransactionQuarantineOutcome(
                operation=OP_REMOVED, reason=skip.reason
            )
        )


def _require_list(provider_response, name):
    value = getattr(provider_response, name, None)
    if not isinstance(value, list):
        raise _fail_page()
    return value


def _fail_page():
    logger.warning("Plaid transaction sync returned malformed data.")
    return PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)


def normalize_sync_page(provider_response):
    """Normalize one raw ``/transactions/sync`` response into the safe page.

    Validates the page metadata first: ``added``/``modified``/``removed``/
    ``accounts`` must be lists, ``next_cursor`` a nonempty string,
    ``has_more`` a bool, and ``transactions_update_status`` exactly one
    supported value (``NOT_READY``, ``INITIAL_UPDATE_COMPLETE``, or
    ``HISTORICAL_UPDATE_COMPLETE``) from a string or an SDK enum ``.value``.
    Any violation fails the whole page with the fixed safe gateway error and
    never reveals raw values.

    Each account entry goes through ``normalize_provider_account`` and every
    ``NormalizationOutcome`` is carried forward. Each added/modified/
    removed row is normalized independently: one malformed row produces a
    fixed redacted quarantine outcome and valid siblings stay normalized.
    The raw provider response is never retained.
    """
    status = _extract_update_status(
        getattr(provider_response, "transactions_update_status", None)
    )
    if status not in _SUPPORTED_UPDATE_STATUSES:
        raise _fail_page()
    added_rows = _require_list(provider_response, "added")
    modified_rows = _require_list(provider_response, "modified")
    removed_rows = _require_list(provider_response, "removed")
    account_rows = _require_list(provider_response, "accounts")
    next_cursor = getattr(provider_response, "next_cursor", None)
    if not isinstance(next_cursor, str) or not next_cursor:
        raise _fail_page()
    has_more = getattr(provider_response, "has_more", None)
    if not isinstance(has_more, bool):
        raise _fail_page()

    account_outcomes = tuple(
        normalize_provider_account(provider_account)
        for provider_account in account_rows
    )

    added = []
    modified = []
    removed = []
    quarantines = []
    for row in added_rows:
        outcome = normalize_provider_transaction(row, OP_ADDED)
        if outcome.skipped:
            quarantines.append(outcome.quarantine)
        else:
            added.append(outcome.transaction)
    for row in modified_rows:
        outcome = normalize_provider_transaction(row, OP_MODIFIED)
        if outcome.skipped:
            quarantines.append(outcome.quarantine)
        else:
            modified.append(outcome.transaction)
    for row in removed_rows:
        outcome = normalize_removed_transaction(row)
        if outcome.skipped:
            quarantines.append(outcome.quarantine)
        else:
            removed.append(outcome.transaction)

    return NormalizedSyncPage(
        added=tuple(added),
        modified=tuple(modified),
        removed=tuple(removed),
        account_outcomes=account_outcomes,
        quarantines=tuple(quarantines),
        next_cursor=next_cursor,
        has_more=has_more,
        transactions_update_status=status,
        quarantined=len(quarantines),
    )
