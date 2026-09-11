from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers


class RegistrationSerializer(serializers.ModelSerializer):
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    class Meta:
        model = get_user_model()
        fields = ("id", "email", "password")
        read_only_fields = ("id",)

    def validate(self, attrs):
        # An unsaved user lets Django compare the password with the submitted email.
        user = self.Meta.model(email=attrs["email"])
        try:
            validate_password(attrs["password"], user=user)
        except DjangoValidationError as error:
            raise serializers.ValidationError({"password": error.messages}) from error
        return attrs

    def create(self, validated_data):
        return self.Meta.model.objects.create_user(**validated_data)
