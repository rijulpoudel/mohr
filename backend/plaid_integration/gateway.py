"""Thin server-only gateway around the official Plaid SDK.

The link-token endpoint talks only to ``PlaidGateway``; tests inject a fake
``PlaidApi`` at this boundary instead of patching HTTP internals. The SDK
client is built lazily from settings per request and never at import time.
Every provider failure (API error, timeout, outage) is normalized to a
fixed safe ``PlaidGatewayError`` that never carries response bodies,
credentials, tokens, or key material.
"""

import logging

from django.conf import settings
from plaid import ApiClient, ApiException, Configuration, Environment
from plaid.api.plaid_api import PlaidApi
from plaid.model.country_code import CountryCode
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
