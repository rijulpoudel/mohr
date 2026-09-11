from rest_framework.routers import SimpleRouter

from accounts.views import AccountViewSet

router = SimpleRouter()
router.register("accounts", AccountViewSet, basename="account")

urlpatterns = router.urls
