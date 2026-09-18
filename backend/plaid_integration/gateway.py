"""Thin server-only gateway around the official Plaid SDK.

The link-token and exchange endpoints talk only to ``PlaidGateway``; tests
inject a fake ``PlaidApi`` at this boundary instead of patching HTTP
internals. The SDK client is built lazily from settings per request and
never at import time; constructing it performs no network call. Every
provider failure (API error, timeout, outage) is normalized to a fixed safe
error that never carries response bodies, credentials, tokens, or key
material. The chained provider exception is suppressed (``raise ... from
None``) so a formatted traceback can never render the raw provider payload.
Permanent access tokens and public tokens are excluded from
result ``repr`` forms by construction.
"""

import base64
import binascii
import json
import logging
from dataclasses import dataclass, field

from django.conf import settings
from plaid import ApiClient, ApiException, Configuration, Environment
from plaid.api.plaid_api import PlaidApi
from plaid.model.country_code import CountryCode
from plaid.model.item_get_request import ItemGetRequest
from plaid.model.item_public_token_exchange_request import (
    ItemPublicTokenExchangeRequest,
)
from plaid.model.item_remove_request import ItemRemoveRequest
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
from plaid.model.transactions_sync_request import TransactionsSyncRequest
from plaid.model.webhook_verification_key_get_request import (
    WebhookVerificationKeyGetRequest,
)
from urllib3.exceptions import HTTPError

logger = logging.getLogger(__name__)

PLAID_API_VERSION = "2020-09-14"
PLAID_REQUEST_TIMEOUT_SECONDS = 30.0

PLAID_UNAVAILABLE_DETAIL = "Plaid service is unavailable. Try again later."


class PlaidGatewayError(Exception):
    """Fixed safe error for any Plaid API, timeout, or outage condition."""


class PlaidExchangeInvalidError(Exception):
    """A provider 400 from the public-token exchange.

    Maps to the same generic 400 as every invalid exchange request so the
    client cannot distinguish a bad public token from a bad handle. Never
    carries a provider body.
    """


def _is_mutation_during_pagination(exc):
    """True only when the structured provider error body names the exact code.

    The provider error body is parsed as JSON and its ``error_code`` field
    must equal ``TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`` exactly; the
    body is never logged, returned, or retained. A body that is not a JSON
    object, or lacks the exact structured field, is never classified as the
    mutation error and falls back to the fixed safe provider failure. This
    deliberately avoids substring classification over an arbitrary response.
    """
    from plaid_integration.transaction_sync import MUTATION_DURING_PAGINATION_CODE

    body = getattr(exc, "body", None)
    if not isinstance(body, str) or not body:
        return False
    try:
        payload = json.loads(body)
    except ValueError:
        return False
    if not isinstance(payload, dict):
        return False
    return payload.get("error_code") == MUTATION_DURING_PAGINATION_CODE


@dataclass(frozen=True)
class PublicTokenExchangeResult:
    """Safe outcome of a public-token exchange.

    ``access_token`` is hidden from ``repr`` so the permanent token can never
    reach logs or error traces through this object.
    """

    access_token: str = field(repr=False)
    item_id: str


@dataclass(frozen=True)
class ItemGetResult:
    """Safe item lookup outcome; institution name only, never secrets."""

    institution_name: str | None


@dataclass(frozen=True)
class WebhookVerificationKey:
    """Validated ES256 webhook verification public key.

    Only the JWK members needed to rebuild the signing key are retained;
    the ``x``/``y`` coordinates are excluded from ``repr`` so they can
    never reach logs or error traces through this object.
    """

    kid: str
    kty: str
    crv: str
    alg: str
    use: str | None
    x: str = field(repr=False)
    y: str = field(repr=False)


_P256_COORDINATE_BYTES = 32

_BASE64URL_CHARS = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
)


def _is_p256_coordinate(value):
    """True only for a nonempty base64url string decoding to 32 bytes.

    A P-256 coordinate is the 32-byte big-endian encoding of one curve
    point member; Plaid delivers it as unpadded base64url. The explicit
    alphabet check plus strict decoding reject any character outside the
    base64url alphabet (junk suffixes, whitespace, ``+``/``/``), so a
    malformed key can never reach verification by silently ignoring
    non-base64 characters.
    """
    if not isinstance(value, str) or not value:
        return False
    if not all(char in _BASE64URL_CHARS for char in value):
        return False
    padded = value + "=" * (-len(value) % 4)
    try:
        decoded = base64.b64decode(padded, altchars=b"-_", validate=True)
    except (binascii.Error, ValueError):
        return False
    return len(decoded) == _P256_COORDINATE_BYTES


def normalize_webhook_verification_key(key, *, expected_kid):
    """Validate a provider webhook verification key into a safe value.

    Accepts the plaid-python ``JWKPublicKey`` model, a duck-typed provider
    key object, or an already normalized :class:`WebhookVerificationKey`.
    Returns ``None`` unless the requested ``kid`` is a nonempty string,
    the key ``kid`` matches it exactly, and every member is suitable for
    ES256 (``kty=EC``, ``crv=P-256``, ``alg=ES256``, 32-byte base64url
    ``x``/``y``; ``use`` when supplied must be ``sig``). Coordinates are
    never logged, returned in the error path, or rendered by ``repr``.
    """
    if not isinstance(expected_kid, str) or not expected_kid:
        return None
    kid = getattr(key, "kid", None)
    if not isinstance(kid, str) or kid != expected_kid:
        return None
    if getattr(key, "kty", None) != "EC":
        return None
    if getattr(key, "crv", None) != "P-256":
        return None
    if getattr(key, "alg", None) != "ES256":
        return None
    use = getattr(key, "use", None)
    if use is not None and use != "sig":
        return None
    x = getattr(key, "x", None)
    y = getattr(key, "y", None)
    if not _is_p256_coordinate(x) or not _is_p256_coordinate(y):
        return None
    return WebhookVerificationKey(
        kid=kid,
        kty="EC",
        crv="P-256",
        alg="ES256",
        use=use,
        x=x,
        y=y,
    )


def _environment_host():
    """Return the Sandbox host or fail closed.

    Mohr v0.2 supports Plaid Sandbox only. Any other value, including a
    runtime ``override_settings`` after startup validation, must never
    select a Production client.
    """
    if settings.PLAID_ENV != "sandbox":
        logger.warning("Plaid environment is not sandbox; refusing to build a client.")
        raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
    return Environment.Sandbox


class PlaidGateway:
    def __init__(self, plaid_api, *, client_id, secret):
        self._plaid_api = plaid_api
        self._client_id = client_id
        self._secret = secret

    @classmethod
    def from_settings(cls):
        host = _environment_host()
        configuration = Configuration(
            host=host,
            api_key={
                "clientId": settings.PLAID_CLIENT_ID,
                "secret": settings.PLAID_SECRET,
                "plaidVersion": PLAID_API_VERSION,
            },
        )
        return cls(
            PlaidApi(ApiClient(configuration=configuration)),
            client_id=settings.PLAID_CLIENT_ID,
            secret=settings.PLAID_SECRET,
        )

    def create_link_token(self, client_user_id, webhook_url):
        """Create an initial Link token that tells Plaid where to send webhooks.

        ``webhook_url`` is the exact absolute URL of the public verified
        webhook receiver; it is built server-side from the authenticated
        request by the caller (never accepted from the browser) and passed to
        Plaid's ``LinkTokenCreateRequest.webhook`` so Items created through
        the Link flow know where to deliver Transactions and Item webhooks.
        Update mode intentionally omits the field, per Plaid's docs.
        """
        request = LinkTokenCreateRequest(
            client_id=self._client_id,
            secret=self._secret,
            client_name="Mohr",
            language="en",
            country_codes=[CountryCode("US")],
            user=LinkTokenCreateRequestUser(client_user_id=client_user_id),
            products=[Products("transactions")],
            transactions=LinkTokenTransactions(days_requested=90),
            webhook=webhook_url,
        )
        try:
            return self._plaid_api.link_token_create(
                link_token_create_request=request,
                _request_timeout=PLAID_REQUEST_TIMEOUT_SECONDS,
            )
        except (ApiException, HTTPError, TimeoutError):
            logger.warning("Plaid link token creation failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None

    def create_update_link_token(self, client_user_id, access_token):
        """Create a server-only update-mode Link token for ONE existing Item.

        Update mode reuses the stored permanent ``access_token`` and sends
        the same Mohr client/language/country/user settings as initial Link
        creation, but requests NO ``products`` and NO Transactions-days
        window (the 90-day history is fixed at the initial Link). The
        ``access_token`` is never logged or interpolated and the raw
        provider response never leaves this boundary. Every provider,
        transport, or timeout condition raises the fixed safe
        :class:`PlaidGatewayError` after the bounded request timeout.
        """
        request = LinkTokenCreateRequest(
            client_id=self._client_id,
            secret=self._secret,
            client_name="Mohr",
            language="en",
            country_codes=[CountryCode("US")],
            user=LinkTokenCreateRequestUser(client_user_id=client_user_id),
            access_token=access_token,
        )
        try:
            return self._plaid_api.link_token_create(
                link_token_create_request=request,
                _request_timeout=PLAID_REQUEST_TIMEOUT_SECONDS,
            )
        except (ApiException, HTTPError, TimeoutError):
            logger.warning("Plaid update-mode link token creation failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None

    def exchange_public_token(self, public_token):
        """Exchange a server-only one-time public token for an access token.

        A provider 400 (for example an invalid, already-exchanged, or expired
        public token) raises :class:`PlaidExchangeInvalidError`; every other
        provider, transport, timeout, or malformed-response condition raises
        the fixed safe :class:`PlaidGatewayError`. Both are raised only
        after the bounded request timeout. The permanent access token must
        be a nonempty string before it is returned (``.encode`` callers can
        rely on it) and is returned inside a repr-safe result that is never
        logged or interpolated.
        """
        request = ItemPublicTokenExchangeRequest(
            client_id=self._client_id,
            secret=self._secret,
            public_token=public_token,
        )
        try:
            response = self._plaid_api.item_public_token_exchange(
                item_public_token_exchange_request=request,
                _request_timeout=PLAID_REQUEST_TIMEOUT_SECONDS,
            )
        except ApiException as exc:
            if exc.status == 400:
                raise PlaidExchangeInvalidError() from None
            logger.warning("Plaid public token exchange failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None
        except (HTTPError, TimeoutError):
            logger.warning("Plaid public token exchange failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None
        access_token = getattr(response, "access_token", None)
        item_id = getattr(response, "item_id", None)
        if (
            not isinstance(access_token, str)
            or not access_token
            or not isinstance(item_id, str)
            or not item_id
        ):
            logger.warning("Plaid public token exchange returned malformed data.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
        return PublicTokenExchangeResult(
            access_token=access_token,
            item_id=item_id,
        )

    def get_item(self, access_token):
        """Look up the Item with the permanent access token, server-side.

        Returns only ``item.institution_name`` (None or a string); the
        browser never supplies institution metadata. Every provider,
        transport, timeout, or malformed-response condition (including a 400
        from a now-invalid access token or a missing/non-string institution
        name) raises the fixed safe :class:`PlaidGatewayError`. The access
        token is never logged or interpolated.
        """
        request = ItemGetRequest(
            client_id=self._client_id,
            secret=self._secret,
            access_token=access_token,
        )
        try:
            response = self._plaid_api.item_get(
                item_get_request=request,
                _request_timeout=PLAID_REQUEST_TIMEOUT_SECONDS,
            )
        except (ApiException, HTTPError, TimeoutError):
            logger.warning("Plaid item lookup failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None
        item = getattr(response, "item", None)
        if item is None:
            logger.warning("Plaid item lookup returned malformed data.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
        institution_name = getattr(item, "institution_name", None)
        if institution_name is not None and not isinstance(institution_name, str):
            logger.warning("Plaid item lookup returned malformed data.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
        return ItemGetResult(institution_name=institution_name)

    def remove_item(self, access_token):
        """Revoke the Item for a relocated access token, server-side.

        Mirrors :meth:`get_item` exactly: builds the official
        ``ItemRemoveRequest`` and calls ``item_remove`` with the bounded
        request timeout. Every provider, transport, or timeout condition
        raises the fixed safe :class:`PlaidGatewayError`. The access token
        is never logged or interpolated.
        """
        request = ItemRemoveRequest(access_token=access_token)
        try:
            return self._plaid_api.item_remove(
                item_remove_request=request,
                _request_timeout=PLAID_REQUEST_TIMEOUT_SECONDS,
            )
        except (ApiException, HTTPError, TimeoutError):
            logger.warning("Plaid item removal failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None

    def get_webhook_verification_key(self, key_id):
        """Fetch and validate the ES256 verification key for one ``kid``.

        Only a nonempty string ``key_id`` is accepted; the returned key
        must carry the exact same ``kid`` and members suitable for ES256
        (see :func:`normalize_webhook_verification_key`). Every provider,
        transport, timeout, or malformed-response condition raises the
        fixed safe :class:`PlaidGatewayError`; the raw provider response
        never leaves this boundary. The caller is responsible for caching
        the returned repr-safe value by ``kid``.
        """
        if not isinstance(key_id, str) or not key_id:
            logger.warning("Plaid webhook verification key request refused.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
        request = WebhookVerificationKeyGetRequest(
            key_id=key_id,
            client_id=self._client_id,
            secret=self._secret,
        )
        try:
            response = self._plaid_api.webhook_verification_key_get(
                webhook_verification_key_get_request=request,
                _request_timeout=PLAID_REQUEST_TIMEOUT_SECONDS,
            )
        except (ApiException, HTTPError, TimeoutError):
            logger.warning("Plaid webhook verification key fetch failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None
        key = getattr(response, "key", None)
        normalized = normalize_webhook_verification_key(key, expected_kid=key_id)
        if normalized is None:
            logger.warning(
                "Plaid webhook verification key fetch returned malformed data."
            )
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
        return normalized

    def sync_transactions(self, access_token, cursor=None):
        """Fetch one page of ``/transactions/sync`` and normalize it safely.

        The initial call omits the cursor entirely; an incremental call sends
        the exact opaque cursor passed in, never a synthesized one. No
        enrichment options are requested. Every provider, transport, timeout,
        or malformed-response condition raises the fixed safe
        :class:`PlaidGatewayError`; a provider
        ``TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`` error, recognized
        only from the structured ``error_code`` in the parsed error body,
        raises the dedicated payload-free :class:`PlaidSyncMutationError`
        marker so the sync loop can restart the update from its original
        cursor. The access token and cursor are never logged or interpolated,
        and the raw provider response never leaves this boundary: the method
        returns only the frozen :class:`NormalizedSyncPage` value object. A
        page normalization defect is a programmer error and propagates.
        """
        from plaid_integration.transaction_sync import (
            SYNC_MUTATION_DETAIL,
            PlaidSyncMutationError,
            normalize_sync_page,
        )

        request_kwargs = {
            "client_id": self._client_id,
            "secret": self._secret,
            "access_token": access_token,
        }
        if cursor is not None:
            request_kwargs["cursor"] = cursor
        request = TransactionsSyncRequest(**request_kwargs)
        try:
            response = self._plaid_api.transactions_sync(
                transactions_sync_request=request,
                _request_timeout=PLAID_REQUEST_TIMEOUT_SECONDS,
            )
        except ApiException as exc:
            if _is_mutation_during_pagination(exc):
                # Suppress the handled exception context: the plaid ApiException
                # renders its raw response body in a formatted traceback, which
                # section 10 forbids. The marker carries only the fixed detail.
                raise PlaidSyncMutationError(SYNC_MUTATION_DETAIL) from None
            logger.warning("Plaid transaction sync failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None
        except (HTTPError, TimeoutError):
            logger.warning("Plaid transaction sync failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from None
        return normalize_sync_page(response)
