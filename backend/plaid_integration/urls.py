from django.urls import path

from plaid_integration.views import (
    connection_list,
    connection_sync,
    exchange,
    link_token,
)

urlpatterns = [
    path("link-token/", link_token, name="plaid-link-token"),
    path("exchange/", exchange, name="plaid-exchange"),
    path("connections/", connection_list, name="plaid-connections"),
    path(
        "connections/<int:pk>/sync/",
        connection_sync,
        name="plaid-connection-sync",
    ),
]
