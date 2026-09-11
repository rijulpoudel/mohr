from rest_framework import mixins, viewsets
from rest_framework.permissions import IsAuthenticated

from accounts.models import Account
from accounts.serializers import AccountSerializer


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
        return Account.objects.filter(user=self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    def perform_destroy(self, instance):
        # Mohr never permanently deletes accounts: keep the row so historical
        # transactions can still reference it after it is archived.
        instance.is_archived = True
        instance.save(update_fields=["is_archived", "updated_at"])
