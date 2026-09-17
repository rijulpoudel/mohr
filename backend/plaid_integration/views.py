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

The public ``POST /api/plaid/webhooks/transactions/`` receiver (issue #39
slice B) is a server-to-server Plaid callback per ``docs/plaid.md`` section
8: it reads the exact raw body and the ``Plaid-Verification`` JWT first,
verifies the ES256 signature through the gateway before any JSON parsing or
database access, and only then parses, validates, matches, and persists a
supported ``TRANSACTIONS`` webhook. It requires no session authentication
and is CSRF exempt only here because signature verification replaces browser
CSRF protection; the exemption never weakens the authenticated Plaid routes.
"""

import json
import logging
from dataclasses import dataclass

from django.conf import settings
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import csrf_exempt
from rest_framework import status
from rest_framework.decorators import (
    api_view,
    authentication_classes,
    permission_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle

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
    WebhookDuplicateEvent,
    claim_exchange_handle,
    issue_exchange_handle,
    perform_sync,
    persist_exchange_connection,
    persist_verified_webhook,
    plaid_client_user_id,
)
from plaid_integration.webhook_verification import (
    WEBHOOK_VERIFICATION_FAILED_DETAIL,
    PlaidWebhookVerificationError,
    verify_plaid_webhook,
)

logger = logging.getLogger(__name__)

WEBHOOK_PAYLOAD_INVALID_DETAIL = "Invalid webhook payload."
WEBHOOK_RECEIVED_RESPONSE = {"status": "ok"}

_WEBHOOK_TYPE_TRANSACTIONS = "TRANSACTIONS"
_WEBHOOK_TRANSACTIONS_SUPPORTED_CODES = frozenset(
    {"SYNC_UPDATES_AVAILABLE", "DEFAULT_UPDATE"}
)
_WEBHOOK_TYPE_MAX_LENGTH = 50
_WEBHOOK_CODE_MAX_LENGTH = 50
_WEBHOOK_ITEM_ID_MAX_LENGTH = 100


class PlaidWebhookRateThrottle(SimpleRateThrottle):
    """Rate limit the public webhook receiver per source IP (60/min).

    The rate is configured under the dedicated ``plaid_webhook`` scope in
    ``REST_FRAMEWORK.DEFAULT_THROTTLE_RATES`` and is applied only to this
    view via ``throttle_classes``, so unrelated APIs are never throttled.
    """

    scope = "plaid_webhook"

    def get_cache_key(self, request, view):
        return self.cache_format % {
            "scope": self.scope,
            "ident": self.get_ident(request),
        }


class _LazyPlaidWebhookGateway:
    """Build the configured gateway only after the JWT header is trusted.

    ``verify_plaid_webhook`` rejects a missing or malformed header before it
    asks for a key. Keeping gateway construction behind that key lookup makes
    malformed deliveries fail as verification errors even when Plaid is
    disabled or misconfigured, without touching settings secrets or the ORM.
    """

    def __init__(self):
        self._gateway = None

    def get_webhook_verification_key(self, key_id):
        if self._gateway is None:
            self._gateway = PlaidGateway.from_settings()
        return self._gateway.get_webhook_verification_key(key_id)


@dataclass(frozen=True)
class _WebhookPayload:
    webhook_type: str
    webhook_code: str
    item_id: str
    initial_update_complete: bool
    historical_update_complete: bool


def _is_bounded_nonempty_string(value, max_length):
    return isinstance(value, str) and bool(value) and len(value) <= max_length


def _parse_webhook_payload(raw_body):
    """Parse the exact verified bytes into a validated payload, or None.

    Runs only after verification. The raw bytes are decoded as UTF-8 and
    parsed with ``json.loads``; the result must be a JSON object whose
    ``webhook_type``, ``webhook_code``, and ``item_id`` are bounded nonempty
    strings (model max lengths) and whose ``initial_update_complete`` and
    ``historical_update_complete`` flags, when present, are actual booleans.
    Any deviation returns None and the endpoint mutates nothing.
    """
    try:
        data = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    webhook_type = data.get("webhook_type")
    webhook_code = data.get("webhook_code")
    item_id = data.get("item_id")
    if not _is_bounded_nonempty_string(webhook_type, _WEBHOOK_TYPE_MAX_LENGTH):
        return None
    if not _is_bounded_nonempty_string(webhook_code, _WEBHOOK_CODE_MAX_LENGTH):
        return None
    if not _is_bounded_nonempty_string(item_id, _WEBHOOK_ITEM_ID_MAX_LENGTH):
        return None
    initial_update_complete = data.get("initial_update_complete", False)
    historical_update_complete = data.get("historical_update_complete", False)
    if not isinstance(initial_update_complete, bool):
        return None
    if not isinstance(historical_update_complete, bool):
        return None
    return _WebhookPayload(
        webhook_type=webhook_type,
        webhook_code=webhook_code,
        item_id=item_id,
        initial_update_complete=initial_update_complete,
        historical_update_complete=historical_update_complete,
    )


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
@csrf_exempt
@throttle_classes([PlaidWebhookRateThrottle])
def webhook_transactions(request):
    """Verify and durably persist a Plaid transactions webhook.

    Public server-to-server receiver per ``docs/plaid.md`` section 8. The
    exact raw ``request.body`` bytes and the ``Plaid-Verification`` JWT are
    read first; the ES256 signature is verified through the injected-or-built
    gateway before any JSON parsing or ORM query, and an unverifiable
    delivery returns the fixed 400 and mutates nothing. Only after
    verification is the body parsed and validated; verified unsupported
    type/code and unmatched ``item_id`` deliveries return the fixed 200 and
    persist nothing. A supported matched event is persisted inside one atomic
    block (inbox row + ``sync_due`` + monotonic status advance), and a
    re-delivered exact body is translated from the idempotency constraint to
    the same fixed 200. Responses never reflect provider or body data, the
    raw body is never stored, and requests are rate limited per source IP.
    """
    raw_body = request.body
    verification_header = request.META.get("HTTP_PLAID_VERIFICATION")
    try:
        claims = verify_plaid_webhook(
            raw_body,
            verification_header,
            gateway=_LazyPlaidWebhookGateway(),
        )
    except PlaidWebhookVerificationError:
        return Response(
            {"detail": WEBHOOK_VERIFICATION_FAILED_DETAIL},
            status=status.HTTP_400_BAD_REQUEST,
        )
    payload = _parse_webhook_payload(raw_body)
    if payload is None:
        return Response(
            {"detail": WEBHOOK_PAYLOAD_INVALID_DETAIL},
            status=status.HTTP_400_BAD_REQUEST,
        )
    if (
        payload.webhook_type != _WEBHOOK_TYPE_TRANSACTIONS
        or payload.webhook_code not in _WEBHOOK_TRANSACTIONS_SUPPORTED_CODES
    ):
        logger.warning(
            "Ignoring unsupported Plaid webhook (type=%r code=%r).",
            payload.webhook_type,
            payload.webhook_code,
        )
        return Response(WEBHOOK_RECEIVED_RESPONSE)
    connection = PlaidConnection.objects.filter(item_id=payload.item_id).first()
    if connection is None:
        return Response(WEBHOOK_RECEIVED_RESPONSE)
    try:
        persist_verified_webhook(
            connection,
            claims,
            webhook_type=payload.webhook_type,
            webhook_code=payload.webhook_code,
            initial_update_complete=payload.initial_update_complete,
            historical_update_complete=payload.historical_update_complete,
        )
    except WebhookDuplicateEvent:
        logger.info(
            "Duplicate Plaid webhook ignored (type=%r code=%r).",
            payload.webhook_type,
            payload.webhook_code,
        )
    return Response(WEBHOOK_RECEIVED_RESPONSE)


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
