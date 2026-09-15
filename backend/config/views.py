from django.conf import settings
from django.http import Http404, HttpResponse, JsonResponse
from django.views.decorators.http import require_GET
from rest_framework.decorators import api_view
from rest_framework.response import Response


def csrf_failure(request, reason=""):
    # CSRF checks can fail before DRF handles the request, so return JSON here.
    return JsonResponse({"detail": "CSRF verification failed."}, status=403)


@api_view(["GET"])
def health_check(request):
    return Response({"status": "ok"})


@require_GET
def spa_index(request, path):
    index_file = settings.STATIC_ROOT / "index.html"
    if not index_file.is_file():
        raise Http404("Frontend build is not available.")
    return HttpResponse(
        index_file.read_bytes(),
        content_type="text/html",
        status=200,
        headers={"Cache-Control": "no-cache"},
    )
