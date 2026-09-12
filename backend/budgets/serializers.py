from decimal import Decimal

from rest_framework import serializers

from budgets.models import MonthlyBudget
from categories.models import Category

ARCHIVED_CATEGORY_MESSAGE = "Archived categories cannot be used for new budgets."
EXPENSE_CATEGORY_MESSAGE = "Budget category must be an expense category."
NON_FIRST_DAY_MONTH_MESSAGE = "Month must be the first day of the month."
DUPLICATE_BUDGET_MESSAGE = "A budget already exists for this category and month."


class BudgetSerializer(serializers.ModelSerializer):
    category = serializers.PrimaryKeyRelatedField(
        queryset=Category.objects.none(),
        error_messages={"does_not_exist": "Invalid category."},
    )
    budgeted = serializers.DecimalField(
        source="amount",
        max_digits=12,
        decimal_places=2,
        coerce_to_string=True,
        min_value=Decimal("0.01"),
    )
    spent = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
        read_only=True,
    )
    remaining = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
        read_only=True,
    )

    class Meta:
        model = MonthlyBudget
        fields = (
            "id",
            "category",
            "month",
            "budgeted",
            "spent",
            "remaining",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context["request"]
        self.fields["category"].queryset = Category.objects.filter(user=request.user)

    def validate(self, attrs):
        category = attrs.get("category")
        month = attrs.get("month")
        if category is not None and category.is_archived:
            raise serializers.ValidationError({"category": [ARCHIVED_CATEGORY_MESSAGE]})
        if category is not None and category.category_type != "expense":
            raise serializers.ValidationError({"category": [EXPENSE_CATEGORY_MESSAGE]})
        if month is not None and month.day != 1:
            raise serializers.ValidationError({"month": [NON_FIRST_DAY_MONTH_MESSAGE]})
        user = self.context["request"].user
        if (
            category is not None
            and month is not None
            and MonthlyBudget.objects.filter(
                user=user, category=category, month=month
            ).exists()
        ):
            raise serializers.ValidationError(
                {"non_field_errors": [DUPLICATE_BUDGET_MESSAGE]}
            )
        return attrs
