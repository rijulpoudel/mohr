from django.urls import path

from dashboard.views import CashFlowSummaryView, DashboardSummaryView

urlpatterns = [
    path(
        "dashboard/summary/",
        DashboardSummaryView.as_view(),
        name="dashboard-summary",
    ),
    path(
        "cash-flow/summary/",
        CashFlowSummaryView.as_view(),
        name="cash-flow-summary",
    ),
]
