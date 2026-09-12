from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dashboard.selectors import dashboard_summary
from dashboard.serializers import DashboardSummarySerializer


class DashboardSummaryView(APIView):
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "head", "options"]

    def get(self, request):
        serializer = DashboardSummarySerializer(
            dashboard_summary(request.user),
            context={"request": request},
        )
        return Response(serializer.data)
