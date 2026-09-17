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
    def sync_pending(self):
        """True while a link to this account exists without an applied anchor.

        The entire account then contributes exactly zero until the
        opening-balance anchor is applied. Prefers the ``_sync_pending``
        annotation produced by ``accounts.selectors`` and falls back to one
        lookup for instances serialized without an annotated queryset.
        """
        annotated = getattr(self, "_sync_pending", None)
        if annotated is not None:
            return annotated
        if self.pk is None:
            return False
        from plaid_integration.models import PlaidAccountLink

        return PlaidAccountLink.objects.filter(
            account_id=self.pk,
            user_id=self.user_id,
            anchor_applied_at__isnull=True,
        ).exists()

    @property
    def current_balance(self):
        # Aggregate owner-scoped so a malformed cross-user transaction linked
        # through direct ORM creation can never change this account's balance.
        income_total = getattr(self, "_income_total", None)
        expense_total = getattr(self, "_expense_total", None)
        sync_pending = getattr(self, "_sync_pending", None)
        if income_total is None or expense_total is None or sync_pending is None:
            if self.pk is None:
                sync_pending = False
                income_total = Decimal("0.00")
                expense_total = Decimal("0.00")
            else:
                from accounts.selectors import account_ledger_annotations

                row = (
                    Account.objects.filter(pk=self.pk)
                    .annotate(**account_ledger_annotations())
                    .get()
                )
                income_total = row._income_total
                expense_total = row._expense_total
                sync_pending = row._sync_pending
        if sync_pending:
            return Decimal("0.00")
        return self.opening_balance + income_total - expense_total
