from rest_framework import serializers

from transactions.serializers import TransactionSerializer


class DashboardSummarySerializer(serializers.Serializer):
    total_balance = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )
    current_month_income = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )
    current_month_expenses = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )
    total_budgeted = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )
    remaining_budget = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )

    def get_fields(self):
        fields = super().get_fields()
        fields["recent_transactions"] = TransactionSerializer(
            many=True,
            read_only=True,
            context=self.context,
        )
        return fields


MONTH_KEY_PATTERN = r"^(?!0000)\d{4}-(0[1-9]|1[0-2])\Z"
INVALID_MONTH_KEY_MESSAGE = "Enter a valid month in YYYY-MM format."
DUPLICATE_MONTH_KEY_MESSAGE = "Exactly one month value is required."
UNKNOWN_QUERY_PARAMETER_MESSAGE = "Unknown query parameters are not allowed."


class StrictMonthKeyField(serializers.RegexField):
    """Reject an explicit blank ``month`` query value instead of treating
    it as missing, matching the strict filter-field convention."""

    def get_value(self, dictionary):
        value = super().get_value(dictionary)
        if value is serializers.empty and self.field_name in dictionary:
            return ""
        return value


class CashFlowMonthQuerySerializer(serializers.Serializer):
    month = StrictMonthKeyField(
        regex=MONTH_KEY_PATTERN,
        error_messages={"invalid": INVALID_MONTH_KEY_MESSAGE},
    )

    def to_internal_value(self, data):
        query_params = self.context["request"].query_params
        unknown = set(query_params.keys()) - {"month"}
        if unknown:
            raise serializers.ValidationError(
                {"non_field_errors": [UNKNOWN_QUERY_PARAMETER_MESSAGE]}
            )
        if len(query_params.getlist("month")) > 1:
            raise serializers.ValidationError({"month": [DUPLICATE_MONTH_KEY_MESSAGE]})
        return super().to_internal_value(data)


class CashFlowCategorySerializer(serializers.Serializer):
    category_id = serializers.IntegerField()
    category_name = serializers.CharField()
    amount = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )
    transaction_count = serializers.IntegerField()


class CashFlowSummarySerializer(serializers.Serializer):
    month = serializers.CharField()
    income = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )
    expenses = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )
    net = serializers.DecimalField(
        max_digits=30,
        decimal_places=2,
        coerce_to_string=True,
    )
    transaction_count = serializers.IntegerField()
    income_categories = CashFlowCategorySerializer(many=True, read_only=True)
    expense_categories = CashFlowCategorySerializer(many=True, read_only=True)
