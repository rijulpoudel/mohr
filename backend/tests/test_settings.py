import json
import os
import subprocess
import sys
import textwrap
from unittest import TestCase

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DUMMY_SECRET_KEY = "django-insecure-settings-test-key"

SCRIPT_TEMPLATE = textwrap.dedent(
    """\
    import json
    import os

    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

    import config.settings as settings

    {body}
    """
)

PRODUCTION_ENV = {
    "DJANGO_PRODUCTION": "True",
    "DJANGO_DEBUG": "False",
    "DJANGO_ALLOWED_HOSTS": "api.mohr.example",
    "DJANGO_CSRF_TRUSTED_ORIGINS": "https://api.mohr.example",
    "DATABASE_URL": (
        "postgres://mohr:settings-test-pass@neon.example:5432/mohr?sslmode=require"
    ),
}

COMPONENT_ENV = {
    "DJANGO_PRODUCTION": "False",
    "DJANGO_DEBUG": "False",
    "DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1",
    "DJANGO_CSRF_TRUSTED_ORIGINS": "",
    "DATABASE_URL": "",
    "POSTGRES_DB": "mohr",
    "POSTGRES_USER": "postgres",
    "POSTGRES_PASSWORD": "settings-test-pass",
    "POSTGRES_HOST": "localhost",
    "POSTGRES_PORT": "5432",
}

DUMP_PRODUCTION = textwrap.dedent(
    """\
    print(
        json.dumps(
            {
                "allowed_hosts": settings.ALLOWED_HOSTS,
                "csrf_trusted_origins": settings.CSRF_TRUSTED_ORIGINS,
                "db_engine": settings.DATABASES["default"]["ENGINE"],
                "db_sslmode": settings.DATABASES["default"]
                .get("OPTIONS", {})
                .get("sslmode"),
                "secure_proxy_ssl_header": settings.SECURE_PROXY_SSL_HEADER,
                "secure_ssl_redirect": settings.SECURE_SSL_REDIRECT,
                "session_cookie_secure": settings.SESSION_COOKIE_SECURE,
                "csrf_cookie_secure": settings.CSRF_COOKIE_SECURE,
                "csrf_cookie_httponly": settings.CSRF_COOKIE_HTTPONLY,
                "hsts_seconds": settings.SECURE_HSTS_SECONDS,
                "hsts_include_subdomains": settings.SECURE_HSTS_INCLUDE_SUBDOMAINS,
                "hsts_preload": settings.SECURE_HSTS_PRELOAD,
                "db_conn_max_age": settings.DATABASES["default"].get(
                    "CONN_MAX_AGE"
                ),
                "db_conn_health_checks": settings.DATABASES["default"].get(
                    "CONN_HEALTH_CHECKS"
                ),
                "debug": settings.DEBUG,
            }
        )
    )
    """
)

DUMP_NON_PRODUCTION = textwrap.dedent(
    """\
    print(
        json.dumps(
            {
                "databases": settings.DATABASES,
                "secure_ssl_redirect": getattr(
                    settings, "SECURE_SSL_REDIRECT", False
                ),
                "secure_proxy_ssl_header": getattr(
                    settings, "SECURE_PROXY_SSL_HEADER", None
                ),
                "session_cookie_secure": getattr(
                    settings, "SESSION_COOKIE_SECURE", False
                ),
                "csrf_cookie_secure": getattr(
                    settings, "CSRF_COOKIE_SECURE", False
                ),
                "hsts_seconds": getattr(settings, "SECURE_HSTS_SECONDS", 0),
                "conn_max_age": getattr(settings, "CONN_MAX_AGE", 0),
                "conn_health_checks": getattr(
                    settings, "CONN_HEALTH_CHECKS", False
                ),
                "csrf_cookie_httponly": settings.CSRF_COOKIE_HTTPONLY,
            }
        )
    )
    """
)


def run_settings(env_overrides, body="pass"):
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.path.expanduser("~"),
        "PYTHONPATH": BACKEND_DIR,
        "DJANGO_SETTINGS_MODULE": "config.settings",
        "DJANGO_SECRET_KEY": DUMMY_SECRET_KEY,
        "DJANGO_PRODUCTION": "False",
        "DJANGO_DEBUG": "False",
        "DJANGO_ALLOWED_HOSTS": "localhost,127.0.0.1",
        "DJANGO_CSRF_TRUSTED_ORIGINS": "",
        "DATABASE_URL": "",
    }
    env.update(env_overrides)
    return subprocess.run(
        [sys.executable, "-c", SCRIPT_TEMPLATE.format(body=body)],
        env=env,
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
    )


class ProductionSettingsTests(TestCase):
    def test_production_enables_security_flags_and_parses_settings(self):
        result = run_settings(PRODUCTION_ENV, body=DUMP_PRODUCTION)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["allowed_hosts"], ["api.mohr.example"])
        self.assertEqual(payload["csrf_trusted_origins"], ["https://api.mohr.example"])
        self.assertEqual(payload["db_engine"], "django.db.backends.postgresql")
        self.assertEqual(payload["db_sslmode"], "require")
        self.assertEqual(
            payload["secure_proxy_ssl_header"],
            ["HTTP_X_FORWARDED_PROTO", "https"],
        )
        self.assertIs(payload["secure_ssl_redirect"], True)
        self.assertIs(payload["session_cookie_secure"], True)
        self.assertIs(payload["csrf_cookie_secure"], True)
        self.assertIs(payload["csrf_cookie_httponly"], False)
        self.assertEqual(payload["hsts_seconds"], 3600)
        self.assertIs(payload["hsts_include_subdomains"], False)
        self.assertIs(payload["hsts_preload"], False)
        self.assertEqual(payload["db_conn_max_age"], 60)
        self.assertIs(payload["db_conn_health_checks"], True)

        combined_output = result.stdout + result.stderr
        self.assertNotIn("settings-test-pass", combined_output)
        self.assertNotIn("postgres://", combined_output)

    def test_production_rejects_debug_true(self):
        env = {**PRODUCTION_ENV, "DJANGO_DEBUG": "True"}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("DJANGO_DEBUG must be False", result.stderr)

    def test_production_rejects_empty_allowed_hosts(self):
        env = {**PRODUCTION_ENV, "DJANGO_ALLOWED_HOSTS": ""}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("must list every allowed host", result.stderr)

    def test_production_rejects_wildcard_allowed_host(self):
        env = {**PRODUCTION_ENV, "DJANGO_ALLOWED_HOSTS": "*"}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("must not contain", result.stderr)

    def test_production_rejects_subdomain_wildcard_allowed_host(self):
        env = {**PRODUCTION_ENV, "DJANGO_ALLOWED_HOSTS": ".mohr.example"}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("begin with '.'", result.stderr)
        self.assertNotIn(".mohr.example", result.stderr)

    def test_production_rejects_insecure_csrf_trusted_origin(self):
        env = {
            **PRODUCTION_ENV,
            "DJANGO_CSRF_TRUSTED_ORIGINS": "http://mohr.example",
        }
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("must start with 'https://'", result.stderr)
        self.assertNotIn("http://mohr.example", result.stderr)

    def test_production_rejects_wildcard_csrf_trusted_origin(self):
        env = {
            **PRODUCTION_ENV,
            "DJANGO_CSRF_TRUSTED_ORIGINS": "https://*.mohr.example",
        }
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("must not contain '*'", result.stderr)
        self.assertNotIn("https://*.mohr.example", result.stderr)

    def test_production_rejects_missing_database_url(self):
        env = {**PRODUCTION_ENV, "DATABASE_URL": ""}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("DATABASE_URL is required", result.stderr)

    def test_production_rejects_database_url_without_sslmode(self):
        env = {
            **PRODUCTION_ENV,
            "DATABASE_URL": (
                "postgres://mohr:settings-test-pass@neon.example:5432/mohr"
            ),
        }
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("sslmode=require", result.stderr)

    def test_production_rejects_non_postgres_database_url(self):
        env = {
            **PRODUCTION_ENV,
            "DATABASE_URL": ("mysql://mohr:settings-test-pass@neon.example:5432/mohr"),
        }
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("must point to a PostgreSQL database", result.stderr)
        self.assertNotIn("mysql://", result.stderr)
        self.assertNotIn("settings-test-pass", result.stderr)


class NonProductionSettingsTests(TestCase):
    def test_component_based_database_config_remains_correct(self):
        result = run_settings(COMPONENT_ENV, body=DUMP_NON_PRODUCTION)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(
            payload["databases"]["default"],
            {
                "ENGINE": "django.db.backends.postgresql",
                "NAME": "mohr",
                "USER": "postgres",
                "PASSWORD": "settings-test-pass",
                "HOST": "localhost",
                "PORT": "5432",
            },
        )
        self.assertNotIn("CONN_MAX_AGE", payload["databases"]["default"])
        self.assertNotIn("CONN_HEALTH_CHECKS", payload["databases"]["default"])
        self.assertIs(payload["secure_ssl_redirect"], False)
        self.assertIsNone(payload["secure_proxy_ssl_header"])
        self.assertIs(payload["session_cookie_secure"], False)
        self.assertIs(payload["csrf_cookie_secure"], False)
        self.assertEqual(payload["hsts_seconds"], 0)
        self.assertEqual(payload["conn_max_age"], 0)
        self.assertIs(payload["conn_health_checks"], False)

    def test_csrf_cookie_is_not_httponly(self):
        body = textwrap.dedent(
            """\
            print(json.dumps({"csrf_cookie_httponly": settings.CSRF_COOKIE_HTTPONLY}))
            """
        )
        result = run_settings(COMPONENT_ENV, body=body)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIs(payload["csrf_cookie_httponly"], False)

    def test_non_production_allows_database_url_without_forced_security(self):
        env = {
            "DJANGO_PRODUCTION": "False",
            "DJANGO_ALLOWED_HOSTS": "localhost",
            "DATABASE_URL": (
                "postgres://mohr:settings-test-pass@neon.example:5432/mohr"
                "?sslmode=require"
            ),
        }
        body = textwrap.dedent(
            """\
            print(
                json.dumps(
                    {
                        "db_engine": settings.DATABASES["default"]["ENGINE"],
                        "db_sslmode": settings.DATABASES["default"]
                        .get("OPTIONS", {})
                        .get("sslmode"),
                        "secure_ssl_redirect": getattr(
                            settings, "SECURE_SSL_REDIRECT", False
                        ),
                    }
                )
            )
            """
        )
        result = run_settings(env, body=body)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["db_engine"], "django.db.backends.postgresql")
        self.assertEqual(payload["db_sslmode"], "require")
        self.assertIs(payload["secure_ssl_redirect"], False)
