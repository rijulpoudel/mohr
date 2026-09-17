"""Safe provider-account normalization and idempotent account import.

Implements the ``docs/plaid.md`` section 4 account-type mapping, the section
5 anchor capture, and the section 10 redaction contract for issue #38 slice
A, at the Plaid integration boundary:

- ``normalize_provider_account`` extracts only the narrow fields Mohr
  persists from one provider account shape (the ``AccountBase`` objects
  Plaid delivers in the ``accounts`` array of a ``/transactions/sync``
  response: ``account_id``, ``name``, ``type``/``subtype`` enum objects with
  a ``.value`` attribute, nullable ``mask``, and ``balances.current`` /
  ``balances.available``), applies the exact type/subtype mapping, and
  parses balances decimal-safe. The raw provider payload is never retained
  and never reaches results, exceptions, logs, or ``repr`` forms.
- ``import_provider_accounts`` atomically creates one Mohr ``Account`` (zero
  opening balance, mapped type, bounded display name) and one
  ``PlaidAccountLink`` per supported account for one ``PlaidConnection``,
  idempotently reusing existing links and refreshing only provider-owned
  snapshot fields. ``import_normalized_provider_accounts`` performs the same
  batch through the shared core for outcomes that are already normalized
  (the ``NormalizationOutcome`` objects carried on
  ``NormalizedSyncPage.account_outcomes``), so the sync path never
  re-derives values from raw provider shapes.

Unsupported or malformed provider accounts are skipped with a deterministic,
redacted reason and never become Mohr rows. Provider account ids are never
truncated and never normalized: an id padded with leading or trailing
whitespace is rejected rather than stored in a different byte form from its
validated trimmed shape. Masks are minimized to the last four characters,
balances never pass through binary float arithmetic, and a supported account
without a safe current balance cannot be imported because it cannot be
anchored. The connection owner is authoritative: malformed cross-user link
state, and a provider mapping change that would contradict an already linked
Account's immutable type, both fail closed and roll back the whole batch
without revealing identifiers.
"""

from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from django.db import IntegrityError, transaction

from accounts.models import Account, AccountType
from plaid_integration.models import PlaidAccountLink

CENT = Decimal("0.01")
PLAID_ACCOUNT_ID_MAX_LENGTH = 100
ACCOUNT_NAME_MAX_LENGTH = 100
LINK_BALANCE_MAX_DIGITS = 14
LINK_BALANCE_DECIMAL_PLACES = 2
_MAX_BALANCE_MAGNITUDE = Decimal("10") ** (
    LINK_BALANCE_MAX_DIGITS - LINK_BALANCE_DECIMAL_PLACES
)

MALFORMED_ACCOUNT = "malformed account"
MISSING_ACCOUNT_ID = "missing account id"
INVALID_ACCOUNT_ID = "invalid account id"
ACCOUNT_ID_TOO_LONG = "account id too long"
INVALID_NAME = "invalid account name"
INVALID_MASK = "invalid account mask"
INVALID_TYPE = "invalid account type"
UNSUPPORTED_TYPE = "unsupported account type"
MISSING_SUBTYPE = "missing account subtype"
UNSUPPORTED_SUBTYPE = "unsupported account subtype"
MISSING_CURRENT_BALANCE = "missing current balance"
INVALID_CURRENT_BALANCE = "invalid current balance"
INVALID_AVAILABLE_BALANCE = "invalid available balance"
BALANCE_OUT_OF_RANGE = "balance out of range"

_PROVIDER_TYPE_SUBTYPE_TO_MOHR = {
    ("depository", "checking"): AccountType.CHECKING,
    ("depository", "savings"): AccountType.SAVINGS,
    ("credit", "credit card"): AccountType.CREDIT_CARD,
}
_SUPPORTED_PROVIDER_TYPES = ("depository", "credit")

ACCOUNT_IMPORT_ERROR_TAG = "account-import:"
ACCOUNT_IMPORT_ERROR_MAX_LENGTH = 2000
_ACCOUNT_IMPORT_ERROR_MAX_REASONS = 5

_PLAID_ACCOUNT_LINK_UNIQUE_CONSTRAINT = (
    "plaid_account_link_connection_plaid_account_id_unique"
)


@dataclass(frozen=True)
class NormalizedProviderAccount:
    """Narrow extracted provider account identity plus safe balance values.

    Only the fields Mohr persists exist; the raw provider payload is never
    retained. The provider account id, display name, and mask are hidden
    from ``repr`` so the value object can never leak provider identity into
    logs or error traces, and balance values are quantized ``Decimal``
    instances produced without binary float arithmetic.
    """

    account_type: str
    plaid_type: str
    plaid_subtype: str
    plaid_account_id: str = field(repr=False)
    name: str = field(repr=False)
    mask: str = field(repr=False)
    current_balance: Decimal = field(repr=False)
    available_balance: Decimal | None = field(repr=False)


@dataclass(frozen=True)
class NormalizationOutcome:
    """Outcome of normalizing one provider account.

    Exactly one of ``account`` or ``reason`` is set. The reason is a fixed,
    deterministic, redacted string that never carries provider values.
    """

    account: NormalizedProviderAccount | None = None
    reason: str | None = None

    @property
    def skipped(self):
        return self.account is None


@dataclass(frozen=True)
class AccountImportResult:
    """Internal outcome of one account-import pass.

    Imported, reused, and skipped counts plus deterministic redacted skip
    reasons. Never carries provider identity, masks, item ids, or raw
    balance values, and its ``repr`` is safe by construction.
    """

    imported: int
    reused: int
    skipped: int
    reasons: tuple[str, ...]


class AccountImportError(Exception):
    """Fail-closed batch error for malformed cross-user link state.

    Raised when an existing link for this connection references another
    user's account or user. The whole batch rolls back, the other user's
    existence is never revealed, and the exception carries no identifiers.
    """


class _SkipProviderAccount(Exception):
    def __init__(self, reason):
        self.reason = reason


def _extract_string(value):
    """Extract a string from a provider enum object or a plain string.

    The plaid-python v44 ``AccountType``/``AccountSubtype`` classes are
    simple enums exposing ``.value``; accepting plain strings keeps the
    boundary tolerant of fake and future shapes.
    """
    if isinstance(value, str):
        return value
    inner = getattr(value, "value", None)
    return inner if isinstance(inner, str) else None


def _normalize_display_name(value):
    if not isinstance(value, str):
        raise _SkipProviderAccount(INVALID_NAME)
    name = value.strip()
    if not name:
        raise _SkipProviderAccount(INVALID_NAME)
    return name[:ACCOUNT_NAME_MAX_LENGTH]


def _normalize_mask(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise _SkipProviderAccount(INVALID_MASK)
    return value[-4:]


def _parse_balance(value, missing_reason, invalid_reason):
    """Parse one provider balance into a cent-quantized finite Decimal.

    Follows the ``docs/plaid.md`` section 7 rule: serialize to the shortest
    string form immediately (``str(value)``) and construct ``Decimal`` from
    that string, never passing through binary float arithmetic. Booleans,
    non-finite values, unparseable values, and values beyond the model field
    limits are rejected; anything else is quantized to two places with
    ``ROUND_HALF_UP``.
    """
    if value is None:
        raise _SkipProviderAccount(missing_reason)
    if isinstance(value, bool):
        raise _SkipProviderAccount(invalid_reason)
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise _SkipProviderAccount(invalid_reason) from None
    if not parsed.is_finite():
        raise _SkipProviderAccount(invalid_reason)
    try:
        quantized = parsed.quantize(CENT, rounding=ROUND_HALF_UP)
    except InvalidOperation:
        raise _SkipProviderAccount(BALANCE_OUT_OF_RANGE) from None
    if abs(quantized) >= _MAX_BALANCE_MAGNITUDE:
        raise _SkipProviderAccount(BALANCE_OUT_OF_RANGE)
    return quantized


def normalize_provider_account(provider_account):
    """Normalize one provider account shape into the narrow value object.

    Returns a :class:`NormalizationOutcome`. Supported accounts yield a
    :class:`NormalizedProviderAccount` with the exact ``docs/plaid.md``
    section 4 mapping applied; everything else yields a deterministic
    redacted skip reason and never becomes a Mohr row. Provider identity is
    never truncated or normalized (an account id with leading or trailing
    whitespace is rejected as invalid, never stripped), no provider shape
    ever maps to Mohr ``cash``, and a missing or unsafe current balance
    always skips the account because it cannot be anchored.
    """
    if provider_account is None:
        return NormalizationOutcome(reason=MALFORMED_ACCOUNT)
    try:
        account_id = getattr(provider_account, "account_id", None)
        if account_id is None:
            raise _SkipProviderAccount(MISSING_ACCOUNT_ID)
        if not isinstance(account_id, str) or not account_id.strip():
            raise _SkipProviderAccount(INVALID_ACCOUNT_ID)
        if account_id != account_id.strip():
            raise _SkipProviderAccount(INVALID_ACCOUNT_ID)
        if len(account_id) > PLAID_ACCOUNT_ID_MAX_LENGTH:
            raise _SkipProviderAccount(ACCOUNT_ID_TOO_LONG)

        name = _normalize_display_name(getattr(provider_account, "name", None))
        mask = _normalize_mask(getattr(provider_account, "mask", None))

        plaid_type = _extract_string(getattr(provider_account, "type", None))
        if plaid_type is None:
            raise _SkipProviderAccount(INVALID_TYPE)
        if plaid_type not in _SUPPORTED_PROVIDER_TYPES:
            raise _SkipProviderAccount(UNSUPPORTED_TYPE)

        plaid_subtype = _extract_string(getattr(provider_account, "subtype", None))
        if plaid_subtype is None:
            raise _SkipProviderAccount(MISSING_SUBTYPE)
        account_type = _PROVIDER_TYPE_SUBTYPE_TO_MOHR.get((plaid_type, plaid_subtype))
        if account_type is None:
            raise _SkipProviderAccount(UNSUPPORTED_SUBTYPE)

        balances = getattr(provider_account, "balances", None)
        if balances is None:
            raise _SkipProviderAccount(MISSING_CURRENT_BALANCE)
        current_balance = _parse_balance(
            getattr(balances, "current", None),
            MISSING_CURRENT_BALANCE,
            INVALID_CURRENT_BALANCE,
        )
        available_balance = None
        available = getattr(balances, "available", None)
        if available is not None:
            available_balance = _parse_balance(
                available,
                INVALID_AVAILABLE_BALANCE,
                INVALID_AVAILABLE_BALANCE,
            )

        return NormalizationOutcome(
            account=NormalizedProviderAccount(
                plaid_account_id=account_id,
                name=name,
                mask=mask,
                account_type=account_type,
                plaid_type=plaid_type,
                plaid_subtype=plaid_subtype,
                current_balance=current_balance,
                available_balance=available_balance,
            )
        )
    except _SkipProviderAccount as skip:
        return NormalizationOutcome(reason=skip.reason)


def _constraint_name(integrity_error):
    """Return the database constraint name behind an IntegrityError, or None."""
    cause = integrity_error.__cause__
    if cause is None:
        return None
    return getattr(getattr(cause, "diag", None), "constraint_name", None)


def _find_existing_link(connection, plaid_account_id):
    return (
        PlaidAccountLink.objects.select_related("account")
        .filter(connection=connection, plaid_account_id=plaid_account_id)
        .first()
    )


def _assert_link_owned(connection, link):
    """Fail closed when an existing link is not owned by the connection owner.

    The connection owner is authoritative: a link whose user or linked
    account belongs to another user is malformed state that must never be
    refreshed or reused, and the batch must roll back without revealing the
    other user's existence.
    """
    if link.user_id != connection.user_id or link.account.user_id != connection.user_id:
        raise AccountImportError()


def _refresh_link(link, normalized):
    """Refresh only provider-owned safe fields on an existing link.

    Fails closed with :class:`AccountImportError` when the normalized account
    type contradicts the linked Account's immutable type: the linked account
    type is never silently reinterpreted, and a provider type/subtype change
    that still maps to the same Mohr type remains a safe snapshot refresh.
    Updates the provider mapping/display snapshot fields and the immutable
    anchor only while it is still null. Never changes ``link.user``,
    ``link.connection``, ``link.account``, the linked Account's type or
    opening balance, or a non-null anchor, and never overwrites the user's
    Account name.
    """
    if normalized.account_type != link.account.account_type:
        raise AccountImportError()
    updates = {}
    if link.plaid_type != normalized.plaid_type:
        updates["plaid_type"] = normalized.plaid_type
    if link.plaid_subtype != normalized.plaid_subtype:
        updates["plaid_subtype"] = normalized.plaid_subtype
    if link.mask != normalized.mask:
        updates["mask"] = normalized.mask
    if link.anchor_provider_current_balance is None:
        updates["anchor_provider_current_balance"] = normalized.current_balance
    if link.provider_current_balance != normalized.current_balance:
        updates["provider_current_balance"] = normalized.current_balance
    if link.provider_available_balance != normalized.available_balance:
        updates["provider_available_balance"] = normalized.available_balance
    if updates:
        PlaidAccountLink.objects.filter(pk=link.pk).update(**updates)


def _import_or_reuse_account(connection, normalized):
    """Import one normalized account, or reuse and refresh its existing link.

    Returns True when a new Account/link pair was created, False when an
    existing link was refreshed. Creation and refresh happen under the
    caller's atomic block: a failed link write rolls back the fresh Account
    row so no orphan ever survives. The exact expected duplicate race (the
    ``(connection, plaid_account_id)`` unique constraint) is translated to a
    reuse whether identified by the named PostgreSQL diagnostic or, on a
    backend without one, by the exact link now existing; a different named
    constraint, or no diagnostic with no exact existing link, always
    propagates.
    """
    existing = _find_existing_link(connection, normalized.plaid_account_id)
    if existing is not None:
        _assert_link_owned(connection, existing)
        _refresh_link(existing, normalized)
        return False

    account = Account(
        user=connection.user,
        name=normalized.name,
        account_type=normalized.account_type,
        opening_balance=Decimal("0.00"),
    )
    try:
        with transaction.atomic():
            account.full_clean(validate_unique=False, validate_constraints=False)
            account.save()
            link = PlaidAccountLink(
                connection=connection,
                user=connection.user,
                account=account,
                plaid_account_id=normalized.plaid_account_id,
                plaid_type=normalized.plaid_type,
                plaid_subtype=normalized.plaid_subtype,
                mask=normalized.mask,
                anchor_provider_current_balance=normalized.current_balance,
                provider_current_balance=normalized.current_balance,
                provider_available_balance=normalized.available_balance,
            )
            link.full_clean(validate_unique=False, validate_constraints=False)
            link.save()
    except IntegrityError as exc:
        constraint_name = _constraint_name(exc)
        if (
            constraint_name is not None
            and constraint_name != _PLAID_ACCOUNT_LINK_UNIQUE_CONSTRAINT
        ):
            raise
        # Concurrent duplicate: the inner savepoint rolled back the fresh
        # Account row, so no orphan exists. Whether the duplicate is named by
        # the PostgreSQL diagnostic or, on a backend without one, proven only
        # by the exact ``(connection, plaid_account_id)`` link now existing,
        # re-fetch the committed link, verify ownership, and reuse it. A
        # different named constraint, or no diagnostic with no exact existing
        # link, always re-raises.
        raced = _find_existing_link(connection, normalized.plaid_account_id)
        if raced is None:
            raise
        _assert_link_owned(connection, raced)
        _refresh_link(raced, normalized)
        return False
    return True


def _account_import_error_summary(skipped, reasons):
    """Build the bounded, redacted account-import error summary.

    Contains only deterministic fixed reason strings and counts, never
    provider account ids, names, masks, raw values, item ids, tokens, or
    payloads. Carries the stable account-import tag so a later fully clean
    pass can clear exactly the error state this module owns and preserve
    unrelated sync/provider errors sharing the same field.
    """
    unique = list(dict.fromkeys(reasons))
    shown = unique[:_ACCOUNT_IMPORT_ERROR_MAX_REASONS]
    listing = "; ".join(shown)
    if len(unique) > len(shown):
        listing += "; and more"
    summary = f"{ACCOUNT_IMPORT_ERROR_TAG} skipped {skipped} account(s): {listing}"
    return summary[:ACCOUNT_IMPORT_ERROR_MAX_LENGTH]


def _import_normalized_outcomes(connection, normalizations):
    """Shared internal core: apply already-normalized outcomes atomically.

    One atomic batch per call, with the same reuse/anchor-capture/rollback
    semantics via ``_import_or_reuse_account`` and the same bounded redacted
    error-summary behavior tied to this module's own error tag. Returns the
    repr-safe :class:`AccountImportResult`. The input is materialized so
    generators and tuples are both accepted.
    """
    normalizations = list(normalizations)
    reasons = []
    for normalization in normalizations:
        reason = normalization.reason
        if reason is not None and reason not in reasons:
            reasons.append(reason)

    imported = 0
    reused = 0
    skipped = 0
    with transaction.atomic():
        for normalization in normalizations:
            if normalization.skipped:
                skipped += 1
                continue
            if _import_or_reuse_account(connection, normalization.account):
                imported += 1
            else:
                reused += 1
        if skipped:
            current = connection.last_sync_error
            if not current or current.startswith(ACCOUNT_IMPORT_ERROR_TAG):
                connection.last_sync_error = _account_import_error_summary(
                    skipped, reasons
                )
        elif connection.last_sync_error.startswith(ACCOUNT_IMPORT_ERROR_TAG):
            connection.last_sync_error = ""
        connection.save(update_fields=["last_sync_error"])
    return AccountImportResult(
        imported=imported,
        reused=reused,
        skipped=skipped,
        reasons=tuple(reasons),
    )


def import_normalized_provider_accounts(connection, outcomes):
    """Atomically import already-normalized account outcomes for one connection.

    ``outcomes`` are the :class:`NormalizationOutcome` objects carried on a
    ``NormalizedSyncPage.account_outcomes``: already normalized by
    ``normalize_provider_account``, so nothing is re-derived from raw
    provider shapes. ``connection`` is a persisted :class:`PlaidConnection`
    and its owner is authoritative for every row created or refreshed. Each
    supported outcome becomes one ``accounts.Account`` (owned by
    ``connection.user``, mapped type, ``opening_balance`` exactly
    ``Decimal("0.00")``) and one ``PlaidAccountLink`` carrying the stable
    provider identity, the immutable anchor captured from the current
    balance (written only while null), and the refreshable display
    snapshots. Skipped outcomes create nothing; valid siblings still
    import. The whole batch is one transaction, so a fail-closed ownership
    violation or a failed link write rolls back everything and no orphan
    Account row survives.

    ``last_sync_error`` on the connection carries a bounded redacted summary
    when any account is skipped and the field is empty or already carries the
    account-import-owned summary; an unrelated sync/provider error is
    preserved exactly and never replaced. A fully clean pass clears only the
    account-import-owned error state, preserving unrelated sync/provider
    errors. Returns a small internal :class:`AccountImportResult`.
    """
    return _import_normalized_outcomes(connection, outcomes)


def import_provider_accounts(connection, provider_accounts):
    """Atomically import normalized supported accounts for one connection.

    ``connection`` is a persisted :class:`PlaidConnection` and its owner is
    authoritative for every row created or refreshed. Each supported
    provider account becomes one ``accounts.Account`` (owned by
    ``connection.user``, mapped type, ``opening_balance`` exactly
    ``Decimal("0.00")``) and one ``PlaidAccountLink`` carrying the stable
    provider identity, the immutable anchor captured from the current
    balance (written only while null), and the refreshable display
    snapshots. Unsupported and malformed accounts create nothing; valid
    siblings still import. The whole batch is one transaction, so a
    fail-closed ownership violation or a failed link write rolls back
    everything and no orphan Account row survives.

    ``last_sync_error`` on the connection carries a bounded redacted summary
    when any account is skipped and the field is empty or already carries the
    account-import-owned summary; an unrelated sync/provider error is
    preserved exactly and never replaced. A fully clean pass clears only the
    account-import-owned error state, preserving unrelated sync/provider
    errors. Returns a small internal :class:`AccountImportResult`.
    """
    normalizations = [
        normalize_provider_account(provider_account)
        for provider_account in provider_accounts
    ]
    return _import_normalized_outcomes(connection, normalizations)
