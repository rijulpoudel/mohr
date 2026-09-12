from decimal import Decimal

from django.db.models import Q, Sum
from django.utils import timezone

from accounts.selectors import owned_accounts_with_balances
from budgets.selectors import budgets_with_spending
from transactions.models import Transaction, TransactionType


def month_bounds(today):
    """First day of `today`'s month and the exclusive start of the next."""
    month_start = today.replace(day=1)
    if month_start.month == 12:
        next_month_start = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month_start = month_start.replace(month=month_start.month + 1)
    return month_start, next_month_start


def total_balance(user):
    """Sum current balances of the user's active accounts."""
    accounts = owned_accounts_with_balances(user).filter(is_archived=False)
    return sum(
        (
            account.opening_balance + account._income_total - account._expense_total
            for account in accounts
        ),
        Decimal("0.00"),
    )


def current_month_totals(user, month_start, next_month_start):
    """Income and expense sums for the user's transactions in the month."""
    totals = Transaction.objects.filter(
        user=user,
        date__gte=month_start,
        date__lt=next_month_start,
    ).aggregate(
        income_total=Sum(
            "amount",
            filter=Q(transaction_type=TransactionType.INCOME),
        ),
        expense_total=Sum(
            "amount",
            filter=Q(transaction_type=TransactionType.EXPENSE),
        ),
    )
    return (
        totals["income_total"] or Decimal("0.00"),
        totals["expense_total"] or Decimal("0.00"),
    )


def budget_totals(user, month_start):
    """Budgeted and remaining sums for the user's budgets in the month."""
    budgets = budgets_with_spending(user).filter(month=month_start)
    budgeted = sum((budget.amount for budget in budgets), Decimal("0.00"))
    remaining = sum((budget.remaining for budget in budgets), Decimal("0.00"))
    return budgeted, remaining


def recent_transactions(user):
    """Newest five transactions owned by `user` in model order."""
    return list(Transaction.objects.filter(user=user)[:5])


def dashboard_summary(user):
    """Aggregate dashboard values for the authenticated user."""
    month_start, next_month_start = month_bounds(timezone.localdate())
    income_total, expense_total = current_month_totals(
        user,
        month_start,
        next_month_start,
    )
    budgeted_total, remaining_total = budget_totals(user, month_start)
    return {
        "total_balance": total_balance(user),
        "current_month_income": income_total,
        "current_month_expenses": expense_total,
        "total_budgeted": budgeted_total,
        "remaining_budget": remaining_total,
        "recent_transactions": recent_transactions(user),
    }
