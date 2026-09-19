from datetime import date
from decimal import Decimal

from django.db.models import Count, DecimalField, Q, Sum
from django.utils import timezone

from accounts.selectors import owned_accounts_with_balances
from budgets.selectors import budgets_with_spending
from transactions.models import Transaction, TransactionType
from transactions.selectors import counting_transactions, ledger_transactions_q


def month_bounds(today):
    """First day of `today`'s month and the exclusive start of the next."""
    month_start = today.replace(day=1)
    if month_start.month == 12:
        next_month_start = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month_start = month_start.replace(month=month_start.month + 1)
    return month_start, next_month_start


def month_bounds_for_key(month_key):
    """(month start, exclusive next-month start) for a validated ``YYYY-MM``.

    December rolls into January. ``9999-12`` has no representable next
    month in ``datetime.date``, so ``None`` signals that the caller must
    bound the month by year and month instead.
    """
    year, month = (int(part) for part in month_key.split("-"))
    month_start = date(year, month, 1)
    if month_start.month == 12:
        if month_start.year == 9999:
            return month_start, None
        next_month_start = month_start.replace(year=month_start.year + 1, month=1)
    else:
        next_month_start = month_start.replace(month=month_start.month + 1)
    return month_start, next_month_start


def total_balance(user):
    """Sum current balances of the user's active accounts."""
    accounts = owned_accounts_with_balances(user).filter(is_archived=False)
    return sum(
        (account.current_balance for account in accounts),
        Decimal("0.00"),
    )


def current_month_totals(user, month_start, next_month_start):
    """Income and expense sums for the user's transactions in the month.

    Applies the shared ledger predicate so provider lifecycle rows and rows
    on not-yet-anchored linked accounts never move month totals.
    """
    totals = (
        Transaction.objects.filter(
            user=user,
            date__gte=month_start,
            date__lt=next_month_start,
        )
        .filter(ledger_transactions_q())
        .aggregate(
            income_total=Sum(
                "amount",
                filter=Q(transaction_type=TransactionType.INCOME),
            ),
            expense_total=Sum(
                "amount",
                filter=Q(transaction_type=TransactionType.EXPENSE),
            ),
        )
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
    """Newest five counting rows owned by `user` in model order."""
    return list(counting_transactions(user)[:5])


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


def cash_flow_summary(user, month_key):
    """Cash-flow totals and category breakdowns for one month.

    `month_key` is a validated ``YYYY-MM`` string. Applies the shared
    ledger predicate so provider lifecycle rows and rows on not-yet-anchored
    linked accounts never count. The category join is restricted to the
    owner's own categories so a defensively malformed cross-user row can
    neither move a total nor leak a foreign category name.
    """
    month_start, next_month_start = month_bounds_for_key(month_key)
    rows = Transaction.objects.filter(
        user=user,
        date__gte=month_start,
    )
    if next_month_start is None:
        rows = rows.filter(
            date__year=month_start.year,
            date__month=month_start.month,
        )
    else:
        rows = rows.filter(date__lt=next_month_start)
    rows = rows.filter(ledger_transactions_q()).filter(category__user=user)

    totals = rows.aggregate(
        income_total=Sum(
            "amount",
            filter=Q(transaction_type=TransactionType.INCOME),
        ),
        expense_total=Sum(
            "amount",
            filter=Q(transaction_type=TransactionType.EXPENSE),
        ),
        transaction_count=Count("id"),
    )
    income_total = totals["income_total"] or Decimal("0.00")
    expense_total = totals["expense_total"] or Decimal("0.00")

    grouped = (
        rows.values("category_id", "category__name", "transaction_type")
        .annotate(
            amount_total=Sum(
                "amount",
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
            category_count=Count("id"),
        )
        .order_by("-amount_total", "category__name", "category_id")
    )
    income_categories = []
    expense_categories = []
    for row in grouped:
        item = {
            "category_id": row["category_id"],
            "category_name": row["category__name"],
            "amount": row["amount_total"],
            "transaction_count": row["category_count"],
        }
        if row["transaction_type"] == TransactionType.INCOME:
            income_categories.append(item)
        else:
            expense_categories.append(item)

    return {
        "month": month_key,
        "income": income_total,
        "expenses": expense_total,
        "net": income_total - expense_total,
        "transaction_count": totals["transaction_count"],
        "income_categories": income_categories,
        "expense_categories": expense_categories,
    }
