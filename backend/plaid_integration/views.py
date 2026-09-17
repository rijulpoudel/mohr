"""Authenticated Plaid Link endpoints (issue #37) and connections slice F.

The two connections endpoints for issue #38 slice F follow the frozen
``docs/plaid.md`` section 3 boundaries: ``GET /api/plaid/connections/`` is a
read-only owner-scoped list that never calls Plaid, never writes, and never
renders a stored secret, cursor, key id, or provider payload; ``POST
/api/plaid/connections/<id>/sync/`` is an owner-scoped manual sync trigger
that maps a ``SyncRunResult`` to ``200`` only once the opening-balance anchor
is set, ``202`` while the history window is still incomplete, and a fixed
``503`` when the run was blocked without mutating anything. Per the Render
Free single-process constraint, the GET route only reports persisted state;
it never performs Plaid calls, cursor writes, or any mutation.
"""

from django.conf import settings
from django.shortcuts import get_object_or_404
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
from plaid_integration.models import PlaidConnection
from plaid_integration.serializers import (
    EXCHANGE_INVALID_DETAIL,
    ConnectionSerializer,
    ExchangeRequestSerializer,
)
from plaid_integration.services import (
    PlaidExchangeDuplicateItem,
    PlaidExchangeProviderDataError,
    claim_exchange_handle,
    issue_exchange_handle,
    perform_sync,
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


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def connection_list(request):
    """Owner-scoped read-only connection list.

    Returns only ``request.user``'s connections with their linked accounts in
    a bounded number of queries (one for connections, one for links, one for
    the linked accounts via ``prefetch_related``). This route never calls
    Plaid and never writes anything, per the Render Free single-process
    constraint: it only reports persisted state.
    """
    connections = PlaidConnection.objects.filter(user=request.user).prefetch_related(
        "account_links__account"
    )
    serializer = ConnectionSerializer(connections, many=True)
    return Response(serializer.data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def connection_sync(request, pk):
    """Owner-scoped manual sync trigger for ONE connection.

    The lookup is scoped to ``request.user`` so a missing id and a foreign
    id are the same indistinguishable 404 and nothing is ever fetched,
    written, or called first. The disabled-integration 503 check mirrors the
    link-token and exchange routes and returns before any provider call or
    write. The run result maps to the frozen boundary: ``200`` with the
    frozen field set only once the opening-balance anchor is set (the
    provider reported ``HISTORICAL_UPDATE_COMPLETE`` on the drained final
    page), ``202 {connection_id, status: "processing"}`` while the requested
    history window is still incomplete, and a fixed ``503`` with the
    established detail for every blocked run. A blocked run is never
    reported as a successful sync: ``SyncRunResult`` carries only booleans
    and counts (never the blocking reason), so the smallest consistent
    mapping is one fixed 503 for all blocked conditions rather than
    inspecting ``last_sync_error`` text or status in the view; the redacted
    reason stays on the connection row for the repair path. No provider
    payload, token, cursor, or provider identifier is ever returned.
    """
    if not settings.PLAID_ENABLED:
        return Response(
            {"detail": PLAID_UNAVAILABLE_DETAIL},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    connection = get_object_or_404(
        PlaidConnection.objects.filter(user=request.user),
        pk=pk,
    )
    result = perform_sync(connection)
    if result.blocked:
        return Response(
            {"detail": PLAID_UNAVAILABLE_DETAIL},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )
    if result.history_complete:
        connection.refresh_from_db()
        return Response(
            {
                "connection_id": connection.pk,
                "status": connection.status,
                "added": result.added,
                "modified": result.modified,
                "removed": result.removed,
            }
        )
    return Response(
        {"connection_id": connection.pk, "status": "processing"},
        status=status.HTTP_202_ACCEPTED,
    )
