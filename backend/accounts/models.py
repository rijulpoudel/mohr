from decimal import Decimal

from django.conf import settings
from django.db import models


class AccountType(models.TextChoices):
    CHECKING = "checking", "Checking"
    SAVINGS = "savings", "Savings"
    CASH = "cash", "Cash"
    CREDIT_CARD = "credit_card", "Credit card"


class Account(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="accounts",
    )
    name = models.CharField(max_length=100)
    account_type = models.CharField(max_length=20, choices=AccountType.choices)
    opening_balance = models.DecimalField(max_digits=12, decimal_places=2)
    is_archived = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("created_at", "id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(account_type__in=AccountType.values),
                name="accounts_account_type_valid",
            ),
        ]

    def __str__(self):
        return self.name

    @property
    def current_balance(self):
        # Aggregate owner-scoped so a malformed cross-user transaction linked
        # through direct ORM creation can never change this account's balance.
        income_total = getattr(self, "_income_total", None)
        expense_total = getattr(self, "_expense_total", None)
        if income_total is None or expense_total is None:
            totals = self.transactions.filter(user_id=self.user_id).aggregate(
                income_total=models.Sum(
                    "amount",
                    filter=models.Q(transaction_type="income"),
                ),
                expense_total=models.Sum(
                    "amount",
                    filter=models.Q(transaction_type="expense"),
                ),
            )
            income_total = totals["income_total"] or Decimal("0")
            expense_total = totals["expense_total"] or Decimal("0")
        return self.opening_balance + income_total - expense_total
