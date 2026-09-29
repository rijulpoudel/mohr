from django.apps import AppConfig


class UsersConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "users"

    def ready(self):
        # Importing this module connects the django-axes lockout receiver.
        import users.authentication  # noqa: F401
