from rest_framework.authentication import (
    SessionAuthentication as DRFSessionAuthentication,
)
from rest_framework.exceptions import PermissionDenied


class SessionAuthentication(DRFSessionAuthentication):
    """Use DRF session auth while reporting missing sessions as HTTP 401."""

    def authenticate_header(self, request):
        return "Session"

    def enforce_csrf(self, request):
        try:
            super().enforce_csrf(request)
        except PermissionDenied:
            raise PermissionDenied("CSRF verification failed.") from None
