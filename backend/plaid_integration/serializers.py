"""Strict request serializers and read-only response serializers for Plaid.

The exchange serializer accepts exactly ``{public_token, exchange_handle}``.
Every serializer rejection is normalized by the endpoint to one fixed generic
400 that never reveals which check failed. Bodies that are syntactically valid
JSON but not a mapping (arrays, strings, numbers, booleans, null) are rejected
without constructing a gateway, claiming a handle, or calling Plaid. Malformed
JSON and unsupported media types are rejected by DRF before this serializer.

The connection and linked-account serializers are output-only: they declare
explicit ``fields`` (never ``__all__``) and are fully read-only, so a stored
secret, cursor, or provider payload can never be rendered even if a new field
is later added to the model without touching this file.
"""

import re
from collections.abc import Mapping

from rest_framework import serializers

from plaid_integration.models import (
    PlaidAccountLink,
    PlaidConnection,
    TransactionsUpdateStatus,
)

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


class LinkedAccountSerializer(serializers.ModelSerializer):
    """Read-only linked-account shape for the connections list.

    ``name`` and ``account_type`` come from the linked Mohr account, and
    account-level ``sync_pending`` derives from the section 5 anchor gate
    (``anchor_applied_at IS NULL``). Explicit fields only, never ``__all__``:
    the link row also carries provider identity fields and balance snapshots
    that must never reach a response.

    ``id`` is the linked Mohr account's id, not the internal link row's id,
    so the connection list lines up with ``/api/accounts/`` without a second
    lookup. The link row is an internal join record and is never exposed.
    """

    id = serializers.IntegerField(source="account.id", read_only=True)
    name = serializers.CharField(source="account.name", read_only=True)
    account_type = serializers.CharField(
        source="account.account_type",
        read_only=True,
    )
    sync_pending = serializers.SerializerMethodField()

    class Meta:
        model = PlaidAccountLink
        fields = ("id", "name", "account_type", "mask", "sync_pending")
        read_only_fields = fields

    def get_sync_pending(self, link):
        return link.anchor_applied_at is None


class ConnectionSerializer(serializers.ModelSerializer):
    """Read-only connection shape for the authenticated connections list.

    Connection-level ``sync_pending`` derives from the frozen
    ``docs/plaid.md`` section 3 rule: ``transactions_update_status !=
    HISTORICAL_UPDATE_COMPLETE`` (a null status is still pending). Explicit
    fields only, never ``__all__``: the connection row also stores the
    encrypted access token, the key id, and the opaque cursor, all of which
    must never reach a response.
    """

    sync_pending = serializers.SerializerMethodField()
    linked_accounts = LinkedAccountSerializer(
        many=True,
        read_only=True,
        source="account_links",
    )

    class Meta:
        model = PlaidConnection
        fields = (
            "id",
            "institution_name",
            "status",
            "sync_pending",
            "last_synced_at",
            "linked_accounts",
        )
        read_only_fields = fields

    def get_sync_pending(self, connection):
        return (
            connection.transactions_update_status
            != TransactionsUpdateStatus.HISTORICAL_UPDATE_COMPLETE
        )
