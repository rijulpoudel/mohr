import ipaddress

from axes.signals import user_locked_out
from django.dispatch import receiver
from rest_framework.authentication import (
    SessionAuthentication as DRFSessionAuthentication,
)
from rest_framework.exceptions import APIException, PermissionDenied


class SessionAuthentication(DRFSessionAuthentication):
    """Use DRF session auth while reporting missing sessions as HTTP 401."""

    def authenticate_header(self, request):
        return "Session"

    def enforce_csrf(self, request):
        try:
            super().enforce_csrf(request)
        except PermissionDenied:
            raise PermissionDenied("CSRF verification failed.") from None


# On a public Render web service Cloudflare writes CF-Connecting-IP on every
# request and overwrites client-supplied values. X-Forwarded-For is deliberately
# ignored: its left-most entry is spoofable. Local and test environments fall
# back to REMOTE_ADDR; on Render that is the proxy socket address, not a useful
# client discriminator if the Cloudflare header is ever missing.
CLIENT_IP_HEADER = "HTTP_CF_CONNECTING_IP"

LOCKOUT_DETAIL = "Too many failed login attempts. Try again later."


def _validated_ip(value):
    if not value:
        return None
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        return None


def get_client_ip(request):
    """Return the trusted client IP for django-axes attempt tracking."""
    return _validated_ip(request.META.get(CLIENT_IP_HEADER)) or _validated_ip(
        request.META.get("REMOTE_ADDR")
    )


class LoginLockedOut(APIException):
    status_code = 429
    default_detail = LOCKOUT_DETAIL
    default_code = "login_locked_out"


@receiver(user_locked_out)
def reject_locked_out_api_login(request=None, **kwargs):
    """Return a fixed JSON 429 for lockouts on API authentication attempts.

    Admin and other Django views keep django-axes' default lockout handling
    in AxesMiddleware, so no DRF exception leaks into a non-DRF request.
    """
    if getattr(request, "path", "").startswith("/api/"):
        raise LoginLockedOut()
