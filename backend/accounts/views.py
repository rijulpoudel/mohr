from rest_framework import mixins, viewsets
from rest_framework.permissions import IsAuthenticated

from accounts.selectors import owned_accounts_with_balances
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
        # Annotate owner-scoped ledger totals once so list/detail never run a
        # per-account aggregate; Account.current_balance uses these when set.
        return owned_accounts_with_balances(self.request.user)

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    def perform_destroy(self, instance):
        # Mohr never permanently deletes accounts: keep the row so historical
        # transactions can still reference it after it is archived.
        instance.is_archived = True
        instance.save(update_fields=["is_archived", "updated_at"])
