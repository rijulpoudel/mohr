from rest_framework import serializers

from accounts.models import Account


class AccountSerializer(serializers.ModelSerializer):
    opening_balance = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        coerce_to_string=True,
    )
    current_balance = serializers.SerializerMethodField()
    sync_pending = serializers.SerializerMethodField()

    class Meta:
        model = Account
        fields = (
            "id",
            "name",
            "account_type",
            "opening_balance",
            "current_balance",
            "sync_pending",
            "is_archived",
            "created_at",
            "updated_at",
        )
        read_only_fields = (
            "id",
            "current_balance",
            "sync_pending",
            "is_archived",
            "created_at",
            "updated_at",
        )

    def get_current_balance(self, account):
        return format(account.current_balance, ".2f")

    def get_sync_pending(self, account):
        return account.sync_pending
