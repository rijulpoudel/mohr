"""Authenticated Plaid Link endpoints (issue #37)."""

from django.conf import settings
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from plaid_integration.gateway import (
    PLAID_UNAVAILABLE_DETAIL,
    PlaidExchangeInvalidError,
    PlaidGateway,
    PlaidGatewayError,
)
from plaid_integration.serializers import (
    EXCHANGE_INVALID_DETAIL,
    ExchangeRequestSerializer,
)
from plaid_integration.services import (
    PlaidExchangeDuplicateItem,
    PlaidExchangeProviderDataError,
    claim_exchange_handle,
    issue_exchange_handle,
    persist_exchange_connection,
    plaid_client_user_id,
)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def link_token(request):
    if not settings.PLAID_ENABLED:
        return Response(
            {"detail": PLAID_UNAVAILABLE_DETAIL},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    try:
        gateway = PlaidGateway.from_settings()
        response = gateway.create_link_token(plaid_client_user_id(request.user))
    except PlaidGatewayError:
        return Response(
            {"detail": PLAID_UNAVAILABLE_DETAIL},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    exchange_handle = issue_exchange_handle(request.user, response.expiration)
    return Response(
        {
            "link_token": response.link_token,
            "expiration": response.expiration,
            "exchange_handle": exchange_handle,
        }
    )


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def exchange(request):
    if not settings.PLAID_ENABLED:
        return Response(
            {"detail": PLAID_UNAVAILABLE_DETAIL},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    serializer = ExchangeRequestSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(
            {"detail": EXCHANGE_INVALID_DETAIL},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # Build and validate the Sandbox gateway before claiming the handle so an
    # invalid runtime configuration (for example a non-Sandbox PLAID_ENV
    # override) fails closed without consuming anything or calling Plaid.
    try:
        gateway = PlaidGateway.from_settings()
    except PlaidGatewayError:
        return Response(
            {"detail": PLAID_UNAVAILABLE_DETAIL},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    if not claim_exchange_handle(
        request.user, serializer.validated_data["exchange_handle"]
    ):
        return Response(
            {"detail": EXCHANGE_INVALID_DETAIL},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # From here the handle stays consumed: on provider error, timeout,
    # invalid or replayed public token, item lookup failure, or local
    # validation failure. Retry means restarting Link for a new handle and
    # public token; a consumed handle is never reset.
    try:
        exchanged = gateway.exchange_public_token(
            serializer.validated_data["public_token"]
        )
        item = gateway.get_item(exchanged.access_token)
    except PlaidExchangeInvalidError:
        return Response(
            {"detail": EXCHANGE_INVALID_DETAIL},
            status=status.HTTP_400_BAD_REQUEST,
        )
    except PlaidGatewayError:
        return Response(
            {"detail": PLAID_UNAVAILABLE_DETAIL},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    token_package, key_id = settings.PLAID_TOKEN_RING.encrypt(
        exchanged.access_token.encode("utf-8")
    )
    try:
        connection = persist_exchange_connection(
            request.user,
            exchanged.item_id,
            item.institution_name,
            token_package,
            key_id,
        )
    except PlaidExchangeDuplicateItem:
        return Response(
            {"detail": EXCHANGE_INVALID_DETAIL},
            status=status.HTTP_400_BAD_REQUEST,
        )
    except PlaidExchangeProviderDataError:
        return Response(
            {"detail": PLAID_UNAVAILABLE_DETAIL},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    return Response(
        {
            "connection": {
                "id": connection.pk,
                "institution_name": connection.institution_name,
                "status": connection.status,
                "linked_accounts": [],
            }
        },
        status=status.HTTP_201_CREATED,
    )
