from rest_framework import serializers

from categories.models import Category

DUPLICATE_CATEGORY_MESSAGE = "A category with this name and type already exists."


class CategorySerializer(serializers.ModelSerializer):
    name = serializers.CharField(max_length=100, trim_whitespace=True)

    class Meta:
        model = Category
        fields = (
            "id",
            "name",
            "category_type",
            "is_archived",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("id", "is_archived", "created_at", "updated_at")

    def validate(self, attrs):
        name = attrs.get("name", getattr(self.instance, "name", None))
        category_type = attrs.get(
            "category_type",
            getattr(self.instance, "category_type", None),
        )
        if name is not None and category_type is not None:
            duplicates = Category.objects.filter(
                user=self.context["request"].user,
                name__iexact=name,
                category_type=category_type,
            )
            if self.instance is not None:
                duplicates = duplicates.exclude(pk=self.instance.pk)
            if duplicates.exists():
                raise serializers.ValidationError(
                    {"name": [DUPLICATE_CATEGORY_MESSAGE]}
                )
        return attrs


class CategoryUpdateSerializer(CategorySerializer):
    class Meta(CategorySerializer.Meta):
        read_only_fields = (
            "id",
            "category_type",
            "is_archived",
            "created_at",
            "updated_at",
        )
