"""Authenticated Plaid Link endpoints (issue #37 slice A)."""

from django.conf import settings
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from plaid_integration.gateway import (
    PLAID_UNAVAILABLE_DETAIL,
    PlaidGateway,
    PlaidGatewayError,
)
from plaid_integration.services import issue_exchange_handle, plaid_client_user_id


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
