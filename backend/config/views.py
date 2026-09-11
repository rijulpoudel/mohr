from django.http import JsonResponse
from rest_framework.decorators import api_view
from rest_framework.response import Response


def csrf_failure(request, reason=""):
    # CSRF checks can fail before DRF handles the request, so return JSON here.
    return JsonResponse({"detail": "CSRF verification failed."}, status=403)


@api_view(["GET"])
def health_check(request):
    return Response({"status": "ok"})
