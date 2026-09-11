from rest_framework.authentication import (
    SessionAuthentication as DRFSessionAuthentication,
)


class SessionAuthentication(DRFSessionAuthentication):
    """Use DRF session auth while reporting missing sessions as HTTP 401."""

    def authenticate_header(self, request):
        return "Session"
