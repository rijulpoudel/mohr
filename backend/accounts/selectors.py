from decimal import Decimal

from django.db.models import DecimalField, F, Q, Sum, Value
from django.db.models.functions import Coalesce

from accounts.models import Account
from transactions.models import TransactionType


def account_ledger_annotations():
    """Owner-scoped income/expense sums used to derive current balances."""
    return {
        "_income_total": Coalesce(
            Sum(
                "transactions__amount",
                filter=Q(
                    transactions__user=F("user"),
                    transactions__transaction_type=TransactionType.INCOME,
                ),
            ),
            Value(Decimal("0.00")),
            output_field=DecimalField(max_digits=30, decimal_places=2),
        ),
        "_expense_total": Coalesce(
            Sum(
                "transactions__amount",
                filter=Q(
                    transactions__user=F("user"),
                    transactions__transaction_type=TransactionType.EXPENSE,
                ),
            ),
            Value(Decimal("0.00")),
            output_field=DecimalField(max_digits=30, decimal_places=2),
        ),
    }


def owned_accounts_with_balances(user):
    """Accounts owned by `user` annotated with owner-scoped ledger totals."""
    return Account.objects.filter(user=user).annotate(**account_ledger_annotations())
