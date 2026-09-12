from decimal import Decimal

from django.db.models import (
    DecimalField,
    ExpressionWrapper,
    F,
    OuterRef,
    Subquery,
    Sum,
    Value,
)
from django.db.models.functions import Coalesce, ExtractMonth, ExtractYear

from budgets.models import MonthlyBudget
from transactions.models import Transaction, TransactionType


def budget_spent_subquery():
    """Per-budget expense sum following the shared monthly budget formula."""
    return Coalesce(
        Subquery(
            Transaction.objects.filter(
                user=OuterRef("user"),
                category=OuterRef("category"),
                transaction_type=TransactionType.EXPENSE,
                date__year=ExtractYear(OuterRef("month")),
                date__month=ExtractMonth(OuterRef("month")),
            )
            .values("user")
            .annotate(total=Sum("amount"))
            .values("total"),
            output_field=DecimalField(max_digits=30, decimal_places=2),
        ),
        Value(Decimal("0.00")),
        output_field=DecimalField(max_digits=30, decimal_places=2),
    )


def budgets_with_spending(user):
    """Budgets owned by `user` annotated with live spent and remaining."""
    return MonthlyBudget.objects.filter(user=user).annotate(
        spent=budget_spent_subquery(),
        remaining=ExpressionWrapper(
            F("amount") - F("spent"),
            output_field=DecimalField(max_digits=30, decimal_places=2),
        ),
    )
