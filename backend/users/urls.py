from django.urls import path

from users.views import csrf_cookie, current_user, login_view, logout_view, register

urlpatterns = [
    path("csrf/", csrf_cookie, name="auth-csrf"),
    path("register/", register, name="auth-register"),
    path("login/", login_view, name="auth-login"),
    path("logout/", logout_view, name="auth-logout"),
    path("me/", current_user, name="auth-me"),
]
