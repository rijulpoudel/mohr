from rest_framework import serializers

from accounts.models import Account


class AccountSerializer(serializers.ModelSerializer):
    opening_balance = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        coerce_to_string=True,
    )

    class Meta:
        model = Account
        fields = (
            "id",
            "name",
            "account_type",
            "opening_balance",
            "is_archived",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("id", "is_archived", "created_at", "updated_at")
