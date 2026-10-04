from django.contrib.auth import authenticate, get_user
from django.contrib.auth import login as django_login
from django.contrib.auth import logout as django_logout
from django.http import HttpResponseRedirect
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import status
from rest_framework.decorators import (
    api_view,
    permission_classes,
    renderer_classes,
    throttle_classes,
)
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle

from users import google
from users.authentication import get_client_ip
from users.export import build_export
from users.serializers import LoginSerializer, RegistrationSerializer, UserSerializer


class GoogleStartThrottle(SimpleRateThrottle):
    """Bound the public start endpoint per trusted client IP."""

    scope = "google_start"

    def get_cache_key(self, request, view):
        ident = get_client_ip(request) or "unknown"
        return self.cache_format % {"scope": self.scope, "ident": ident}


@ensure_csrf_cookie
@api_view(["GET"])
@permission_classes([AllowAny])
def csrf_cookie(request):
    return Response({"detail": "CSRF cookie set."})


@api_view(["POST"])
@permission_classes([AllowAny])
# @csrf_protect must stay innermost: @api_view marks the outer view csrf_exempt,
# so the global middleware skips it and only this wrapper enforces CSRF.
@csrf_protect
def register(request):
    serializer = RegistrationSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    user = serializer.save()
    return Response(UserSerializer(user).data, status=status.HTTP_201_CREATED)


@api_view(["POST"])
@permission_classes([AllowAny])
# @csrf_protect must stay innermost: @api_view marks the outer view csrf_exempt,
# so the global middleware skips it and only this wrapper enforces CSRF.
@csrf_protect
def login_view(request):
    serializer = LoginSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    user = authenticate(
        request=request,
        username=serializer.validated_data["email"],
        password=serializer.validated_data["password"],
    )
    if user is None:
        return Response(
            {"detail": "Invalid email or password."},
            status=status.HTTP_401_UNAUTHORIZED,
        )

    django_login(request, user)
    return Response(UserSerializer(user).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def current_user(request):
    return Response(UserSerializer(request.user).data)


@api_view(["POST"])
@permission_classes([IsAuthenticated])
def logout_view(request):
    django_logout(request)
    return Response(status=status.HTTP_204_NO_CONTENT)


@api_view(["GET"])
@permission_classes([AllowAny])
def google_config(request):
    if not google.is_enabled():
        return Response({"enabled": False, "linked": False})
    linked = request.user.is_authenticated and bool(request.user.google_sub)
    return Response({"enabled": True, "linked": linked})


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([GoogleStartThrottle])
# @csrf_protect must stay innermost: @api_view marks the outer view csrf_exempt,
# so the global middleware skips it and only this wrapper enforces CSRF.
@csrf_protect
def google_start(request):
    if not google.is_enabled():
        return Response(
            {"detail": "Google sign-in is unavailable."},
            status=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    data = request.data
    if not isinstance(data, dict):
        return Response(
            {"detail": "Invalid Google sign-in request."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    intent = data.get("intent")
    if intent not in ("sign-in", "link"):
        return Response(
            {"detail": "Invalid Google sign-in request."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    next_path = data.get("next", "/")
    if not isinstance(next_path, str) or next_path not in google.ALLOWED_NEXT_PATHS:
        return Response(
            {"detail": "Invalid next path."},
            status=status.HTTP_400_BAD_REQUEST,
        )

    if intent == "link":
        if not request.user.is_authenticated:
            return Response(
                {"detail": "Authentication credentials were not provided."},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        actor_id = request.user.pk
    else:
        if request.user.is_authenticated:
            return Response(
                {"detail": "Already signed in."},
                status=status.HTTP_409_CONFLICT,
            )
        actor_id = None

    flow = google.create_flow(intent=intent, next_path=next_path, actor_id=actor_id)
    google.store_flow(request, flow)
    authorization_url = google.build_authorization_url(flow["state"], flow["nonce"])
    return Response({"authorization_url": authorization_url})


def _single_param(request, name, max_length):
    values = request.GET.getlist(name)
    if len(values) != 1:
        return None
    value = values[0]
    if not isinstance(value, str) or not value or len(value) > max_length:
        return None
    return value


def _finish_google_flow(target):
    response = HttpResponseRedirect(target)
    response["Cache-Control"] = "no-store"
    response["Referrer-Policy"] = "no-referrer"
    return response


def _link_actor(request, flow):
    actor_id = flow.get("actor_id")
    if not isinstance(actor_id, int):
        raise google.GoogleLinkConflict()
    # Re-authenticate against the freshly bound session so Django revalidates
    # the session auth hash. A password change during consent makes the stored
    # hash stale, so ``get_user`` flushes the session and returns an anonymous
    # user instead of the raw ``_auth_user_id`` value.
    actor = get_user(request)
    if not actor.is_authenticated or not actor.is_active or actor.pk != actor_id:
        raise google.GoogleLinkConflict()
    return actor


def google_callback(request):
    if not google.is_enabled():
        return _finish_google_flow("/login?google=failed")

    state = _single_param(request, "state", google.MAX_STATE_LENGTH)
    code = _single_param(request, "code", google.MAX_CODE_LENGTH)
    if state is None or code is None:
        return _finish_google_flow("/login?google=failed")

    flow = google.consume_flow(request, state)
    if flow is None:
        return _finish_google_flow("/login?google=failed")

    try:
        id_token = google.exchange_code_for_tokens(code)
        jwks = google.fetch_google_jwks()
        claims = google.verify_id_token(id_token, jwks=jwks, nonce=flow["nonce"])
        actor = _link_actor(request, flow) if flow.get("intent") == "link" else None
        user, _outcome = google.resolve_identity(
            claims, intent=flow.get("intent"), actor=actor
        )
    except google.GoogleLinkRequired:
        return _finish_google_flow("/login?google=link-required")
    except google.GoogleAuthError:
        return _finish_google_flow("/login?google=failed")

    django_login(request, user, backend="django.contrib.auth.backends.ModelBackend")
    target = flow.get("next")
    if target not in google.ALLOWED_NEXT_PATHS:
        target = "/"
    return _finish_google_flow(target)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
@renderer_classes([JSONRenderer])
def export_data(request):
    """Download the signed-in user's records as a versioned JSON attachment."""
    response = Response(build_export(request.user))
    response["Content-Disposition"] = 'attachment; filename="mohr-export-v1.json"'
    response["Cache-Control"] = "no-store"
    return response
