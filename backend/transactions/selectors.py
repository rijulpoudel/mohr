from django.db.models import Exists, OuterRef, Q

from plaid_integration.models import PlaidAccountLink
from transactions.models import Transaction


def ledger_transactions_q():
    """Rows that count in financial calculations.

    Manual rows on ordinary manual accounts pass unchanged. Excludes
    provider-removed, superseded, and pending rows, plus every row whose
    account is linked by ``PlaidAccountLink`` with ``anchor_applied_at``
    still null (the not-yet-anchored gate from docs/plaid.md section 5).

    The account condition is a correlated ``Exists`` subquery matched on
    BOTH ``account_id`` and ``user_id``. It never joins the link table, so
    malformed or duplicated cross-user link rows can neither multiply sums
    nor gate another user's account.
    """
    return (
        Q(is_provider_removed=False)
        & Q(is_pending=False)
        & Q(is_superseded=False)
        & ~Exists(
            PlaidAccountLink.objects.filter(
                account_id=OuterRef("account_id"),
                user_id=OuterRef("user_id"),
                anchor_applied_at__isnull=True,
            )
        )
    )


def with_pending_initial_import(queryset):
    """Annotate rows with their not-yet-anchored link state so serialization
    never runs a per-row lookup."""
    return queryset.annotate(
        _is_pending_initial_import=Exists(
            PlaidAccountLink.objects.filter(
                account_id=OuterRef("account_id"),
                user_id=OuterRef("user_id"),
                anchor_applied_at__isnull=True,
            )
        )
    )


def owned_transactions(user):
    """Owner-scoped rows annotated for serialization.

    Provider-removed and superseded audit rows are NOT hidden here: they
    stay reachable by exact ID so detail, PATCH, and DELETE keep their
    v0.2 semantics on owned audit records. Hiding them is the list
    route's job.
    """
    return with_pending_initial_import(Transaction.objects.filter(user=user))


def visible_transactions(user):
    """Owner-scoped rows for the normal list.

    Provider-removed and superseded rows are hidden; pending and
    not-yet-anchored rows stay visible with their read-only state.
    """
    return owned_transactions(user).filter(
        is_provider_removed=False,
        is_superseded=False,
    )


def counting_transactions(user):
    """Owner-scoped rows that count in financial calculations, annotated for
    serialization."""
    return with_pending_initial_import(
        Transaction.objects.filter(user=user).filter(ledger_transactions_q())
    )
