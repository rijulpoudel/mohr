from django.urls import path

from users.views import (
    csrf_cookie,
    current_user,
    export_data,
    google_callback,
    google_config,
    google_start,
    login_view,
    logout_view,
    register,
)

urlpatterns = [
    path("csrf/", csrf_cookie, name="auth-csrf"),
    path("register/", register, name="auth-register"),
    path("login/", login_view, name="auth-login"),
    path("logout/", logout_view, name="auth-logout"),
    path("me/", current_user, name="auth-me"),
    path("export/", export_data, name="auth-export"),
    path("google/config/", google_config, name="auth-google-config"),
    path("google/start/", google_start, name="auth-google-start"),
    path("google/callback/", google_callback, name="auth-google-callback"),
]
