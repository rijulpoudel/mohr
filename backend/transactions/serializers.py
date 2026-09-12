from decimal import Decimal

from rest_framework import serializers

from accounts.models import Account
from categories.models import Category
from transactions.models import Transaction, TransactionType

ARCHIVED_ACCOUNT_MESSAGE = "Archived accounts cannot be used for new transactions."
ARCHIVED_CATEGORY_MESSAGE = "Archived categories cannot be used for new transactions."
CATEGORY_TYPE_MISMATCH_MESSAGE = "Category type must match the transaction type."


# DRF treats an explicit blank value for an optional field in QueryDict/HTML
# input as "not provided" (get_value returns the `empty` sentinel), but this
# API must reject explicit blanks with a field-level 400.
class StrictPrimaryKeyRelatedField(serializers.PrimaryKeyRelatedField):
    def get_value(self, dictionary):
        value = super().get_value(dictionary)
        if value is serializers.empty and self.field_name in dictionary:
            return ""
        return value


class StrictChoiceField(serializers.ChoiceField):
    def get_value(self, dictionary):
        value = super().get_value(dictionary)
        if value is serializers.empty and self.field_name in dictionary:
            return ""
        return value


class StrictDateField(serializers.DateField):
    def get_value(self, dictionary):
        value = super().get_value(dictionary)
        if value is serializers.empty and self.field_name in dictionary:
            return ""
        return value


REVERSED_DATE_RANGE_MESSAGE = "Start date must not be after end date."


class TransactionFilterSerializer(serializers.Serializer):
    account = StrictPrimaryKeyRelatedField(
        queryset=Account.objects.none(),
        required=False,
        error_messages={
            "does_not_exist": "Invalid account.",
            "incorrect_type": "Invalid account.",
        },
    )
    category = StrictPrimaryKeyRelatedField(
        queryset=Category.objects.none(),
        required=False,
        error_messages={
            "does_not_exist": "Invalid category.",
            "incorrect_type": "Invalid category.",
        },
    )
    transaction_type = StrictChoiceField(
        choices=TransactionType.choices,
        required=False,
    )
    start_date = StrictDateField(required=False)
    end_date = StrictDateField(required=False)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        request = self.context["request"]
        self.fields["account"].queryset = Account.objects.filter(user=request.user)
        self.fields["category"].queryset = Category.objects.filter(user=request.user)

    def validate(self, attrs):
        start_date = attrs.get("start_date")
        end_date = attrs.get("end_date")
        if start_date is not None and end_date is not None and start_date > end_date:
            raise serializers.ValidationError(
                {"end_date": [REVERSED_DATE_RANGE_MESSAGE]}
            )
        return attrs


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
        transaction_type = attrs.get(
            "transaction_type",
            getattr(self.instance, "transaction_type", None),
        )
        if account is not None and account.is_archived:
            raise serializers.ValidationError({"account": [ARCHIVED_ACCOUNT_MESSAGE]})
        if category is not None and category.is_archived:
            raise serializers.ValidationError({"category": [ARCHIVED_CATEGORY_MESSAGE]})
        effective_category = category or getattr(self.instance, "category", None)
        if (
            effective_category is not None
            and transaction_type is not None
            and effective_category.category_type != transaction_type
        ):
            raise serializers.ValidationError(
                {"category": [CATEGORY_TYPE_MISMATCH_MESSAGE]}
            )
        return attrs
