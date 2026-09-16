from django.urls import path

from plaid_integration.views import link_token

urlpatterns = [
    path("link-token/", link_token, name="plaid-link-token"),
]
