from django.conf import settings
from django.db import models
from django.db.models.functions import Lower, Trim


class CategoryType(models.TextChoices):
    INCOME = "income", "Income"
    EXPENSE = "expense", "Expense"


class Category(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="categories",
    )
    name = models.CharField(max_length=100)
    category_type = models.CharField(max_length=20, choices=CategoryType.choices)
    is_archived = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ("created_at", "id")
        constraints = [
            models.CheckConstraint(
                condition=models.Q(category_type__in=CategoryType.values),
                name="categories_category_type_valid",
            ),
            models.UniqueConstraint(
                models.F("user"),
                Lower(Trim(models.F("name"))),
                models.F("category_type"),
                name="categories_user_name_type_unique",
            ),
        ]

    def __str__(self):
        return self.name
