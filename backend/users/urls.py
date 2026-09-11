from django.urls import path

from users.views import csrf_cookie, login_view, register

urlpatterns = [
    path("csrf/", csrf_cookie, name="auth-csrf"),
    path("register/", register, name="auth-register"),
    path("login/", login_view, name="auth-login"),
]
