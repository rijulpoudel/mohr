from decimal import Decimal

from rest_framework import serializers

from accounts.models import Account
from categories.models import Category
from transactions.models import Transaction

ARCHIVED_ACCOUNT_MESSAGE = "Archived accounts cannot be used for new transactions."
ARCHIVED_CATEGORY_MESSAGE = "Archived categories cannot be used for new transactions."
CATEGORY_TYPE_MISMATCH_MESSAGE = "Category type must match the transaction type."


class TransactionSerializer(serializers.ModelSerializer):
    account = serializers.PrimaryKeyRelatedField(
        queryset=Account.objects.none(),
        error_messages={"does_not_exist": "Invalid account."},
    )
    category = serializers.PrimaryKeyRelatedField(
        queryset=Category.objects.none(),
        error_messages={"does_not_exist": "Invalid category."},
    )
    amount = serializers.DecimalField(
        max_digits=12,
        decimal_places=2,
        coerce_to_string=True,
        min_value=Decimal("0.01"),
    )
    note = serializers.CharField(required=False, allow_blank=True, trim_whitespace=True)

    class Meta:
        model = Transaction
        fields = (
            "id",
            "account",
            "category",
            "transaction_type",
            "amount",
            "date",
            "note",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context["request"]
        self.fields["account"].queryset = Account.objects.filter(user=request.user)
        self.fields["category"].queryset = Category.objects.filter(user=request.user)

    def validate(self, attrs):
        account = attrs.get("account")
        category = attrs.get("category")
        transaction_type = attrs.get("transaction_type")
        if account is not None and account.is_archived:
            raise serializers.ValidationError({"account": [ARCHIVED_ACCOUNT_MESSAGE]})
        if category is not None and category.is_archived:
            raise serializers.ValidationError({"category": [ARCHIVED_CATEGORY_MESSAGE]})
        if (
            category is not None
            and transaction_type is not None
            and category.category_type != transaction_type
        ):
            raise serializers.ValidationError(
                {"category": [CATEGORY_TYPE_MISMATCH_MESSAGE]}
            )
        return attrs
