from rest_framework import mixins, viewsets
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from transactions.models import Transaction
from transactions.serializers import TransactionFilterSerializer, TransactionSerializer


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
        return Transaction.objects.filter(user=self.request.user)

    def list(self, request, *args, **kwargs):
        queryset = self.get_queryset()
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
