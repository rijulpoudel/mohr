from decimal import Decimal

from django.db.models import DecimalField, Exists, OuterRef, Subquery, Sum, Value
from django.db.models.functions import Coalesce

from accounts.models import Account
from plaid_integration.models import PlaidAccountLink
from transactions.models import Transaction, TransactionType
from transactions.selectors import ledger_transactions_q


def account_ledger_annotations():
    """Owner-scoped income/expense sums and the anchor-pending flag used to
    derive current balances.

    Each sum is a correlated subquery over the account's own transactions
    applying the shared ledger predicate, so provider lifecycle rows and
    rows on not-yet-anchored linked accounts never move a balance and no
    link join can multiply or gate through malformed rows.
    """
    return {
        "_income_total": Coalesce(
            Subquery(
                Transaction.objects.filter(
                    account_id=OuterRef("id"),
                    user_id=OuterRef("user_id"),
                    transaction_type=TransactionType.INCOME,
                )
                .filter(ledger_transactions_q())
                .values("user_id")
                .annotate(total=Sum("amount"))
                .values("total"),
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
            Value(Decimal("0.00")),
            output_field=DecimalField(max_digits=30, decimal_places=2),
        ),
        "_expense_total": Coalesce(
            Subquery(
                Transaction.objects.filter(
                    account_id=OuterRef("id"),
                    user_id=OuterRef("user_id"),
                    transaction_type=TransactionType.EXPENSE,
                )
                .filter(ledger_transactions_q())
                .values("user_id")
                .annotate(total=Sum("amount"))
                .values("total"),
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
            Value(Decimal("0.00")),
            output_field=DecimalField(max_digits=30, decimal_places=2),
        ),
        "_sync_pending": Exists(
            PlaidAccountLink.objects.filter(
                account_id=OuterRef("id"),
                user_id=OuterRef("user_id"),
                anchor_applied_at__isnull=True,
            )
        ),
    }


def owned_accounts_with_balances(user):
    """Accounts owned by `user` annotated with owner-scoped ledger totals."""
    return Account.objects.filter(user=user).annotate(**account_ledger_annotations())
