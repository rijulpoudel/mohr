from decimal import Decimal

from django.db.models import DecimalField, Q, Sum, Value
from django.db.models.functions import Coalesce
from rest_framework import mixins, viewsets
from rest_framework.permissions import IsAuthenticated

from accounts.models import Account
from accounts.serializers import AccountSerializer
from transactions.models import TransactionType


class AccountViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated]
    serializer_class = AccountSerializer
    http_method_names = ["get", "post", "head", "options", "patch", "delete"]

    def get_queryset(self):
        # Annotate owner-scoped ledger totals once so list/detail never run a
        # per-account aggregate; Account.current_balance uses these when set.
        return Account.objects.filter(user=self.request.user).annotate(
            _income_total=Coalesce(
                Sum(
                    "transactions__amount",
                    filter=Q(
                        transactions__user=self.request.user,
                        transactions__transaction_type=TransactionType.INCOME,
                    ),
                ),
                Value(Decimal("0.00")),
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
            _expense_total=Coalesce(
                Sum(
                    "transactions__amount",
                    filter=Q(
                        transactions__user=self.request.user,
                        transactions__transaction_type=TransactionType.EXPENSE,
                    ),
                ),
                Value(Decimal("0.00")),
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
        )

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    def perform_destroy(self, instance):
        # Mohr never permanently deletes accounts: keep the row so historical
        # transactions can still reference it after it is archived.
        instance.is_archived = True
        instance.save(update_fields=["is_archived", "updated_at"])
