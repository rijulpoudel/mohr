from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from dashboard.selectors import cash_flow_summary, dashboard_summary
from dashboard.serializers import (
    CashFlowMonthQuerySerializer,
    CashFlowSummarySerializer,
    DashboardSummarySerializer,
)


class DashboardSummaryView(APIView):
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "head", "options"]

    def get(self, request):
        serializer = DashboardSummarySerializer(
            dashboard_summary(request.user),
            context={"request": request},
        )
        return Response(serializer.data)


class CashFlowSummaryView(APIView):
    permission_classes = [IsAuthenticated]
    http_method_names = ["get", "head", "options"]

    def get(self, request):
        query_serializer = CashFlowMonthQuerySerializer(
            data=request.query_params,
            context={"request": request},
        )
        query_serializer.is_valid(raise_exception=True)
        summary = cash_flow_summary(
            request.user,
            query_serializer.validated_data["month"],
        )
        serializer = CashFlowSummarySerializer(summary)
        return Response(serializer.data)
