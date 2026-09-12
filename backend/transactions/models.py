from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


class TransactionType(models.TextChoices):
    INCOME = "income", "Income"
    EXPENSE = "expense", "Expense"


class Transaction(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="transactions",
    )
    account = models.ForeignKey(
        "accounts.Account",
        on_delete=models.RESTRICT,
        related_name="transactions",
    )
    category = models.ForeignKey(
        "categories.Category",
        on_delete=models.RESTRICT,
        related_name="transactions",
    )
    transaction_type = models.CharField(
        max_length=20,
        choices=TransactionType.choices,
    )
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    date = models.DateField()
    note = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-date", "-created_at", "-id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(transaction_type__in=TransactionType.values),
                name="transactions_transaction_type_valid",
            ),
            models.CheckConstraint(
                condition=models.Q(amount__gt=0),
                name="transactions_amount_positive",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "date"], name="transactions_user_date_idx"),
        ]

    def __str__(self):
        return f"{self.date} {self.transaction_type} {self.amount}"

    def clean(self):
        if self.account_id and self.account.user_id != self.user_id:
            raise ValidationError(
                {"account": "Account must belong to the same user as the transaction."}
            )
        if self.category_id and self.category.user_id != self.user_id:
            raise ValidationError(
                {
                    "category": "Category must belong to the same user as the transaction."
                }
            )
        if (
            self.category_id
            and self.transaction_type
            and self.category.category_type != self.transaction_type
        ):
            raise ValidationError(
                {"category": "Category type must match the transaction type."}
            )
