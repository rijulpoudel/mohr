from rest_framework import mixins, viewsets
from rest_framework.permissions import IsAuthenticated

from categories.models import Category
from categories.serializers import CategorySerializer, CategoryUpdateSerializer


class CategoryViewSet(
    mixins.ListModelMixin,
    mixins.CreateModelMixin,
    mixins.RetrieveModelMixin,
    mixins.UpdateModelMixin,
    mixins.DestroyModelMixin,
    viewsets.GenericViewSet,
):
    permission_classes = [IsAuthenticated]
    serializer_class = CategorySerializer
    http_method_names = ["get", "post", "head", "options", "patch", "delete"]

    def get_queryset(self):
        return Category.objects.filter(user=self.request.user)

    def get_serializer_class(self):
        if self.action == "partial_update":
            return CategoryUpdateSerializer
        return CategorySerializer

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)

    def perform_destroy(self, instance):
        # Mohr never permanently deletes categories: keep the row so historical
        # transactions can still reference it after it is archived. updated_at
        # records the archive operation, matching the accounts behavior.
        instance.is_archived = True
        instance.save(update_fields=["is_archived", "updated_at"])
