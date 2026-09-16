from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


class TransactionType(models.TextChoices):
    INCOME = "income", "Income"
    EXPENSE = "expense", "Expense"


class TransactionSource(models.TextChoices):
    MANUAL = "manual", "Manual"
    PLAID = "plaid", "Plaid"


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
    source = models.CharField(
        max_length=10,
        choices=TransactionSource.choices,
        default=TransactionSource.MANUAL,
    )
    provider_name = models.CharField(max_length=200, blank=True, default="")
    plaid_transaction_id = models.CharField(max_length=100, null=True, blank=True)
    plaid_pending_transaction_id = models.CharField(
        max_length=100, null=True, blank=True
    )
    is_pending = models.BooleanField(default=False)
    is_provider_removed = models.BooleanField(default=False)
    is_superseded = models.BooleanField(default=False)
    superseded_by = models.ForeignKey(
        "self",
        on_delete=models.RESTRICT,
        null=True,
        blank=True,
        related_name="superseded_rows",
    )
    category_customized = models.BooleanField(default=False)
    note_customized = models.BooleanField(default=False)
    connection = models.ForeignKey(
        "plaid_integration.PlaidConnection",
        on_delete=models.RESTRICT,
        null=True,
        blank=True,
        related_name="transactions",
    )
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
            models.CheckConstraint(
                condition=models.Q(source__in=TransactionSource.values),
                name="transactions_source_valid",
            ),
            models.CheckConstraint(
                condition=(
                    ~models.Q(source=TransactionSource.MANUAL)
                    | (
                        models.Q(connection__isnull=True)
                        & models.Q(plaid_transaction_id__isnull=True)
                        & models.Q(plaid_pending_transaction_id__isnull=True)
                        & models.Q(is_pending=False)
                        & models.Q(is_provider_removed=False)
                        & models.Q(is_superseded=False)
                        & models.Q(superseded_by__isnull=True)
                        & models.Q(category_customized=False)
                        & models.Q(note_customized=False)
                        & models.Q(provider_name="")
                    )
                ),
                name="transactions_manual_row_no_provider_state",
            ),
            models.CheckConstraint(
                condition=(
                    ~models.Q(source=TransactionSource.PLAID)
                    | (
                        models.Q(connection__isnull=False)
                        & models.Q(plaid_transaction_id__isnull=False)
                    )
                ),
                name="transactions_plaid_row_requires_provider_identity",
            ),
            models.CheckConstraint(
                condition=(
                    (
                        models.Q(is_superseded=True)
                        & models.Q(superseded_by__isnull=False)
                    )
                    | (
                        models.Q(is_superseded=False)
                        & models.Q(superseded_by__isnull=True)
                    )
                ),
                name="transactions_superseded_requires_superseded_by",
            ),
            models.UniqueConstraint(
                fields=["user", "plaid_transaction_id"],
                condition=models.Q(plaid_transaction_id__isnull=False),
                name="transactions_user_plaid_transaction_id_unique",
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
        if self.connection_id and self.connection.user_id != self.user_id:
            raise ValidationError(
                {
                    "connection": (
                        "Connection must belong to the same user as the transaction."
                    )
                }
            )
        if self.superseded_by_id and self.superseded_by_id == self.pk:
            raise ValidationError(
                {"superseded_by": "A transaction cannot supersede itself."}
            )
        if self.superseded_by_id and self.superseded_by.user_id != self.user_id:
            raise ValidationError(
                {
                    "superseded_by": (
                        "Superseding transaction must belong to the same user "
                        "as the transaction."
                    )
                }
            )
