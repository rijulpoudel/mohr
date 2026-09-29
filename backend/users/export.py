"""Read-only owner data export for the privacy download endpoint.

Builds a plain JSON-serializable payload from explicit field allowlists, so a
new model field can never leak into a download by accident. Every queryset is
scoped to the signed-in user. A relationship ID is included only when the
related row is owned by that same user; a malformed cross-user relation is
reported as null instead of disclosing the other user's ID.

Schema and exclusions are documented in ``docs/data-export.md``.
"""

from accounts.models import Account
from budgets.models import MonthlyBudget
from categories.models import Category
from transactions.models import Transaction

EXPORT_SCHEMA_VERSION = 1


def _money(value):
    """Render a decimal field as an exact decimal string, never a float."""
    return format(value, "f")


def _account_payload(account):
    return {
        "id": account.id,
        "name": account.name,
        "account_type": account.account_type,
        "opening_balance": _money(account.opening_balance),
        "is_archived": account.is_archived,
        "created_at": account.created_at.isoformat(),
        "updated_at": account.updated_at.isoformat(),
    }


def _category_payload(category):
    return {
        "id": category.id,
        "name": category.name,
        "category_type": category.category_type,
        "is_archived": category.is_archived,
        "created_at": category.created_at.isoformat(),
        "updated_at": category.updated_at.isoformat(),
    }


def _transaction_payload(
    transaction,
    owned_account_ids,
    owned_category_ids,
    owned_transaction_ids,
):
    account_id = transaction.account_id
    if account_id not in owned_account_ids:
        account_id = None
    category_id = transaction.category_id
    if category_id not in owned_category_ids:
        category_id = None
    superseded_by_id = transaction.superseded_by_id
    if superseded_by_id not in owned_transaction_ids:
        superseded_by_id = None
    return {
        "id": transaction.id,
        "account_id": account_id,
        "category_id": category_id,
        "transaction_type": transaction.transaction_type,
        "amount": _money(transaction.amount),
        "date": transaction.date.isoformat(),
        "note": transaction.note,
        "source": transaction.source,
        "is_pending": transaction.is_pending,
        "is_provider_removed": transaction.is_provider_removed,
        "is_superseded": transaction.is_superseded,
        "superseded_by_id": superseded_by_id,
        "category_customized": transaction.category_customized,
        "note_customized": transaction.note_customized,
        "is_transfer": transaction.is_transfer,
        "created_at": transaction.created_at.isoformat(),
        "updated_at": transaction.updated_at.isoformat(),
    }


def _budget_payload(budget, owned_category_ids):
    category_id = budget.category_id
    if category_id not in owned_category_ids:
        category_id = None
    return {
        "id": budget.id,
        "category_id": category_id,
        "month": budget.month.isoformat(),
        "amount": _money(budget.amount),
        "created_at": budget.created_at.isoformat(),
        "updated_at": budget.updated_at.isoformat(),
    }


def build_export(user):
    """Return the versioned, owner-scoped, allowlisted export for ``user``."""
    accounts = list(Account.objects.filter(user=user).order_by("id"))
    categories = list(Category.objects.filter(user=user).order_by("id"))
    transactions = list(Transaction.objects.filter(user=user).order_by("id"))
    budgets = list(MonthlyBudget.objects.filter(user=user).order_by("id"))

    owned_account_ids = {account.id for account in accounts}
    owned_category_ids = {category.id for category in categories}
    owned_transaction_ids = {transaction.id for transaction in transactions}

    return {
        "schema_version": EXPORT_SCHEMA_VERSION,
        "accounts": [_account_payload(account) for account in accounts],
        "categories": [_category_payload(category) for category in categories],
        "transactions": [
            _transaction_payload(
                transaction,
                owned_account_ids,
                owned_category_ids,
                owned_transaction_ids,
            )
            for transaction in transactions
        ],
        "monthly_budgets": [
            _budget_payload(budget, owned_category_ids) for budget in budgets
        ],
    }
