from rest_framework import mixins, status, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from transactions.models import TransactionSource
from transactions.selectors import owned_transactions, visible_transactions
from transactions.serializers import (
    SYNCED_DELETE_MESSAGE,
    TransactionFilterSerializer,
    TransactionSerializer,
)


class TransactionViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated]
    serializer_class = TransactionSerializer
    http_method_names = ["get", "post", "patch", "delete", "head", "options"]

    def get_queryset(self):
        # Owner-scoped rows, annotated for serialization. Provider-removed
        # and superseded audit rows stay reachable by exact ID so detail,
        # PATCH, and DELETE keep their contract; only list() hides them.
        return owned_transactions(self.request.user)

    def list(self, request, *args, **kwargs):
        queryset = visible_transactions(request.user)
        filter_serializer = TransactionFilterSerializer(
            data=request.query_params,
            context={"request": request},
        )
        filter_serializer.is_valid(raise_exception=True)
        filters = filter_serializer.validated_data
        if "account" in filters:
            queryset = queryset.filter(account=filters["account"])
        if "category" in filters:
            queryset = queryset.filter(category=filters["category"])
        if "transaction_type" in filters:
            queryset = queryset.filter(transaction_type=filters["transaction_type"])
        if "start_date" in filters:
            queryset = queryset.filter(date__gte=filters["start_date"])
        if "end_date" in filters:
            queryset = queryset.filter(date__lte=filters["end_date"])
        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.source == TransactionSource.PLAID:
            # A synced row is a provider-owned audit record retained for
            # history; v0.1 deletes are hard deletes, so this is rejected.
            return Response(
                {"detail": SYNCED_DELETE_MESSAGE},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return super().destroy(request, *args, **kwargs)
