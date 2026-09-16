"""Strict request serializers for the authenticated Plaid Link endpoints.

The exchange serializer accepts exactly ``{public_token, exchange_handle}``.
Every serializer rejection is normalized by the endpoint to one fixed generic
400 that never reveals which check failed. Bodies that are syntactically valid
JSON but not a mapping (arrays, strings, numbers, booleans, null) are rejected
without constructing a gateway, claiming a handle, or calling Plaid. Malformed
JSON and unsupported media types are rejected by DRF before this serializer.
"""

import re
from collections.abc import Mapping

from rest_framework import serializers

EXCHANGE_INVALID_DETAIL = "Invalid exchange request."
PUBLIC_TOKEN_MAX_LENGTH = 200
EXCHANGE_HANDLE_MAX_LENGTH = 43
EXCHANGE_HANDLE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_EXCHANGE_FIELDS = frozenset({"public_token", "exchange_handle"})


class ExchangeRequestSerializer(serializers.Serializer):
    """Validate exactly ``{public_token, exchange_handle}``.

    Both values must be nonempty strings within bounded lengths; the exchange
    handle must exactly match the URL-safe ``secrets.token_urlsafe(32)``
    shape (43 characters from ``[A-Za-z0-9_-]``). Unknown fields are
    rejected. Nothing here distinguishes a malformed handle from an expired
    or consumed one: the endpoint collapses every failure to the same fixed
    generic 400.
    """

    public_token = serializers.CharField(
        max_length=PUBLIC_TOKEN_MAX_LENGTH,
        trim_whitespace=False,
    )
    exchange_handle = serializers.CharField(
        max_length=EXCHANGE_HANDLE_MAX_LENGTH,
        trim_whitespace=False,
    )

    def validate_exchange_handle(self, value):
        if not EXCHANGE_HANDLE_PATTERN.fullmatch(value):
            raise serializers.ValidationError(EXCHANGE_INVALID_DETAIL)
        return value

    def validate(self, attrs):
        initial = self.initial_data
        if not isinstance(initial, Mapping):
            raise serializers.ValidationError(EXCHANGE_INVALID_DETAIL)
        if set(initial.keys()) != _EXCHANGE_FIELDS:
            raise serializers.ValidationError(EXCHANGE_INVALID_DETAIL)
        if not all(isinstance(initial[key], str) for key in _EXCHANGE_FIELDS):
            raise serializers.ValidationError(EXCHANGE_INVALID_DETAIL)
        if any(not value.strip() for value in attrs.values()):
            raise serializers.ValidationError(EXCHANGE_INVALID_DETAIL)
        return attrs
