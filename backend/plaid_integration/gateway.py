"""Thin server-only gateway around the official Plaid SDK.

The link-token and exchange endpoints talk only to ``PlaidGateway``; tests
inject a fake ``PlaidApi`` at this boundary instead of patching HTTP
internals. The SDK client is built lazily from settings per request and
never at import time; constructing it performs no network call. Every
provider failure (API error, timeout, outage) is normalized to a fixed safe
error that never carries response bodies, credentials, tokens, or key
material. Permanent access tokens and public tokens are excluded from
result ``repr`` forms by construction.
"""

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
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.link_token_transactions import LinkTokenTransactions
from plaid.model.products import Products
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

    def create_link_token(self, client_user_id):
        request = LinkTokenCreateRequest(
            client_id=self._client_id,
            secret=self._secret,
            client_name="Mohr",
            language="en",
            country_codes=[CountryCode("US")],
            user=LinkTokenCreateRequestUser(client_user_id=client_user_id),
            products=[Products("transactions")],
            transactions=LinkTokenTransactions(days_requested=90),
        )
        try:
            return self._plaid_api.link_token_create(
                link_token_create_request=request,
                _request_timeout=PLAID_REQUEST_TIMEOUT_SECONDS,
            )
        except (ApiException, HTTPError, TimeoutError) as exc:
            logger.warning("Plaid link token creation failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from exc

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
                raise PlaidExchangeInvalidError() from exc
            logger.warning("Plaid public token exchange failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from exc
        except (HTTPError, TimeoutError) as exc:
            logger.warning("Plaid public token exchange failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from exc
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
        except (ApiException, HTTPError, TimeoutError) as exc:
            logger.warning("Plaid item lookup failed.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL) from exc
        item = getattr(response, "item", None)
        if item is None:
            logger.warning("Plaid item lookup returned malformed data.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
        institution_name = getattr(item, "institution_name", None)
        if institution_name is not None and not isinstance(institution_name, str):
            logger.warning("Plaid item lookup returned malformed data.")
            raise PlaidGatewayError(PLAID_UNAVAILABLE_DETAIL)
        return ItemGetResult(institution_name=institution_name)
