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
