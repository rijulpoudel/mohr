from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import (
    DecimalField,
    ExpressionWrapper,
    F,
    OuterRef,
    Subquery,
    Sum,
    Value,
)
from django.db.models.functions import Coalesce, ExtractMonth, ExtractYear
from rest_framework import mixins, serializers, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from budgets.models import MonthlyBudget
from budgets.serializers import DUPLICATE_BUDGET_MESSAGE, BudgetSerializer
from transactions.models import Transaction, TransactionType

DUPLICATE_BUDGET_CONSTRAINT_NAME = "budgets_user_category_month_unique"


def _is_duplicate_budget_constraint(error):
    cause = error.__cause__
    while cause is not None:
        diagnostics = getattr(cause, "diag", None)
        if (
            diagnostics is not None
            and getattr(diagnostics, "constraint_name", None)
            == DUPLICATE_BUDGET_CONSTRAINT_NAME
        ):
            return True
        cause = cause.__cause__
    return False


class BudgetViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated]
    serializer_class = BudgetSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        # One aggregate subquery per budget keeps the list at a constant
        # query count instead of an N+1 spent/remaining lookup. The
        # aggregate output fields are wider than the stored 12-digit amount
        # because SUM across many transactions can exceed 12 digits.
        spent = Coalesce(
            Subquery(
                Transaction.objects.filter(
                    user=OuterRef("user"),
                    category=OuterRef("category"),
                    transaction_type=TransactionType.EXPENSE,
                    date__year=ExtractYear(OuterRef("month")),
                    date__month=ExtractMonth(OuterRef("month")),
                )
                .values("user")
                .annotate(total=Sum("amount"))
                .values("total"),
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
            Value(Decimal("0.00")),
            output_field=DecimalField(max_digits=30, decimal_places=2),
        )
        return MonthlyBudget.objects.filter(user=self.request.user).annotate(
            spent=spent,
            remaining=ExpressionWrapper(
                F("amount") - F("spent"),
                output_field=DecimalField(max_digits=30, decimal_places=2),
            ),
        )

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                self.perform_create(serializer)
        except IntegrityError as exc:
            # Translate only the named user/category/month unique constraint;
            # surface every other integrity failure unchanged instead of
            # mislabeling it as a duplicate.
            if not _is_duplicate_budget_constraint(exc):
                raise
            raise serializers.ValidationError(
                {"non_field_errors": [DUPLICATE_BUDGET_MESSAGE]}
            )
        instance = self.get_queryset().get(pk=serializer.instance.pk)
        data = self.get_serializer(instance).data
        return Response(
            data,
            status=status.HTTP_201_CREATED,
            headers=self.get_success_headers(data),
        )

    def update(self, request, *args, **kwargs):
        partial = kwargs.pop("partial", False)
        instance = self.get_object()
        serializer = self.get_serializer(
            instance,
            data=request.data,
            partial=partial,
        )
        serializer.is_valid(raise_exception=True)
        try:
            with transaction.atomic():
                self.perform_update(serializer)
        except IntegrityError as exc:
            if not _is_duplicate_budget_constraint(exc):
                raise
            raise serializers.ValidationError(
                {"non_field_errors": [DUPLICATE_BUDGET_MESSAGE]}
            )
        # Refetch through the annotated owner-scoped queryset so spent and
        # remaining reflect the update instead of stale pre-update values.
        refreshed = self.get_queryset().get(pk=instance.pk)
        return Response(self.get_serializer(refreshed).data)
