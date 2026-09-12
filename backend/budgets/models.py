from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models


class MonthlyBudget(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="monthly_budgets",
    )
    category = models.ForeignKey(
        "categories.Category",
        on_delete=models.RESTRICT,
        related_name="monthly_budgets",
    )
    month = models.DateField()
    amount = models.DecimalField(max_digits=12, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("-month", "created_at", "id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__gt=0),
                name="budgets_amount_positive",
            ),
            models.CheckConstraint(
                condition=models.Q(month__day=1),
                name="budgets_month_first_day",
            ),
            models.UniqueConstraint(
                fields=["user", "category", "month"],
                name="budgets_user_category_month_unique",
            ),
        ]
        indexes = [
            models.Index(fields=["user", "month"], name="budgets_user_month_idx"),
        ]

    def __str__(self):
        return f"{self.month} {self.amount}"

    def clean(self):
        if self.category_id and self.category.user_id != self.user_id:
            raise ValidationError(
                {"category": "Category must belong to the same user as the budget."}
            )
        if self.category_id and self.category.category_type != "expense":
            raise ValidationError(
                {"category": "Budget category must be an expense category."}
            )
        if self.month and self.month.day != 1:
            raise ValidationError(
                {"month": "Month must be the first day of the month."}
            )
