import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path
from unittest import TestCase

from cryptography.fernet import Fernet

PLAID_TEST_KEYS = [Fernet.generate_key().decode() for _ in range(2)]
PLAID_VALID_TOKEN_KEYS = f"key-a:{PLAID_TEST_KEYS[0]},key-b:{PLAID_TEST_KEYS[1]}"
PLAID_ENABLED_ENV = {
    "PLAID_ENABLED": "True",
    "PLAID_ENV": "sandbox",
    "PLAID_CLIENT_ID": "settings-test-client-id",
    "PLAID_SECRET": "settings-test-secret",
    "PLAID_TOKEN_KEYS": PLAID_VALID_TOKEN_KEYS,
}

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

DUMP_STATIC_CONFIG = textwrap.dedent(
    """\
    print(
        json.dumps(
            {
                "static_url": settings.STATIC_URL,
                "static_root": str(settings.STATIC_ROOT),
                "middleware": settings.MIDDLEWARE,
                "staticfiles_storage": settings.STORAGES["staticfiles"][
                    "BACKEND"
                ],
                "default_storage": settings.STORAGES["default"]["BACKEND"],
                "secure_redirect_exempt": getattr(
                    settings, "SECURE_REDIRECT_EXEMPT", None
                ),
                "whitenoise_autorefresh": getattr(
                    settings, "WHITENOISE_AUTOREFRESH", None
                ),
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

DUMP_PLAID_DISABLED = textwrap.dedent(
    """\
    print(
        json.dumps(
            {
                "plaid_enabled": getattr(settings, "PLAID_ENABLED", None),
                "plaid_env": getattr(settings, "PLAID_ENV", None),
                "plaid_token_ring": getattr(settings, "PLAID_TOKEN_RING", None),
            }
        )
    )
    """
)

DUMP_PLAID_ENABLED = textwrap.dedent(
    """\
    print(
        json.dumps(
            {
                "plaid_enabled": settings.PLAID_ENABLED,
                "plaid_env": settings.PLAID_ENV,
                "client_id_set": bool(settings.PLAID_CLIENT_ID),
                "secret_set": bool(settings.PLAID_SECRET),
                "key_ids": settings.PLAID_TOKEN_RING.key_ids(),
                "primary_key_id": settings.PLAID_TOKEN_RING.primary_key_id,
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
        **COMPONENT_ENV,
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

    def test_production_uses_absolute_static_url_and_static_root(self):
        result = run_settings(PRODUCTION_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["static_url"], "/static/")
        self.assertEqual(payload["static_root"], str(Path(BACKEND_DIR) / "staticfiles"))

    def test_production_places_whitenoise_after_security_middleware(self):
        result = run_settings(PRODUCTION_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(
            payload["middleware"].index("whitenoise.middleware.WhiteNoiseMiddleware"),
            payload["middleware"].index("django.middleware.security.SecurityMiddleware")
            + 1,
        )

    def test_production_uses_compressed_staticfiles_storage(self):
        result = run_settings(PRODUCTION_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(
            payload["staticfiles_storage"],
            "whitenoise.storage.CompressedStaticFilesStorage",
        )
        self.assertEqual(
            payload["default_storage"],
            "django.core.files.storage.FileSystemStorage",
        )

    def test_production_does_not_use_whitenoise_autorefresh(self):
        result = run_settings(PRODUCTION_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIs(payload["whitenoise_autorefresh"], False)

    def test_production_exempts_health_check_from_ssl_redirect(self):
        result = run_settings(PRODUCTION_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn(r"^api/health/$", payload["secure_redirect_exempt"])


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

    def test_non_production_uses_absolute_static_url_and_static_root(self):
        result = run_settings(COMPONENT_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["static_url"], "/static/")
        self.assertEqual(payload["static_root"], str(Path(BACKEND_DIR) / "staticfiles"))

    def test_non_production_places_whitenoise_after_security_middleware(self):
        result = run_settings(COMPONENT_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(
            payload["middleware"].index("whitenoise.middleware.WhiteNoiseMiddleware"),
            payload["middleware"].index("django.middleware.security.SecurityMiddleware")
            + 1,
        )

    def test_non_production_uses_compressed_staticfiles_storage(self):
        result = run_settings(COMPONENT_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(
            payload["staticfiles_storage"],
            "whitenoise.storage.CompressedStaticFilesStorage",
        )

    def test_non_production_uses_whitenoise_autorefresh(self):
        result = run_settings(COMPONENT_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIs(payload["whitenoise_autorefresh"], True)

    def test_non_production_does_not_exempt_health_check_from_ssl_redirect(self):
        result = run_settings(COMPONENT_ENV, body=DUMP_STATIC_CONFIG)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIsNone(payload["secure_redirect_exempt"])

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


class PlaidSettingsTests(TestCase):
    def test_plaid_disabled_is_default_and_requires_no_credentials(self):
        result = run_settings({}, body=DUMP_PLAID_DISABLED)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIs(payload["plaid_enabled"], False)
        self.assertEqual(payload["plaid_env"], "sandbox")
        self.assertIsNone(payload["plaid_token_ring"])

    def test_plaid_disabled_ignores_incomplete_or_foreign_credentials(self):
        env = {
            "PLAID_ENABLED": "",
            "PLAID_ENV": "production",
            "PLAID_CLIENT_ID": "",
            "PLAID_SECRET": "",
            "PLAID_TOKEN_KEYS": "",
        }
        result = run_settings(env, body=DUMP_PLAID_DISABLED)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIs(payload["plaid_enabled"], False)
        self.assertIsNone(payload["plaid_token_ring"])

    def test_plaid_enabled_accepts_complete_sandbox_configuration(self):
        result = run_settings(PLAID_ENABLED_ENV, body=DUMP_PLAID_ENABLED)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIs(payload["plaid_enabled"], True)
        self.assertEqual(payload["plaid_env"], "sandbox")
        self.assertIs(payload["client_id_set"], True)
        self.assertIs(payload["secret_set"], True)
        self.assertEqual(payload["key_ids"], ["key-a", "key-b"])
        self.assertEqual(payload["primary_key_id"], "key-a")

        combined_output = result.stdout + result.stderr
        for key in PLAID_TEST_KEYS:
            self.assertNotIn(key, combined_output)
        self.assertNotIn("settings-test-client-id", combined_output)
        self.assertNotIn("settings-test-secret", combined_output)

    def test_plaid_enabled_rejects_non_sandbox_env(self):
        env = {**PLAID_ENABLED_ENV, "PLAID_ENV": "development"}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("PLAID_ENV must be exactly 'sandbox'", result.stderr)
        self.assertNotIn("development", result.stderr)

    def test_plaid_enabled_rejects_empty_client_id(self):
        env = {**PLAID_ENABLED_ENV, "PLAID_CLIENT_ID": ""}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("PLAID_CLIENT_ID must be non-empty", result.stderr)

    def test_plaid_enabled_rejects_empty_secret(self):
        env = {**PLAID_ENABLED_ENV, "PLAID_SECRET": ""}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("PLAID_SECRET must be non-empty", result.stderr)

    def test_plaid_enabled_rejects_whitespace_only_client_id(self):
        env = {**PLAID_ENABLED_ENV, "PLAID_CLIENT_ID": " \t "}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("PLAID_CLIENT_ID must be non-empty", result.stderr)
        self.assertNotIn("\t", result.stderr)

    def test_plaid_enabled_rejects_whitespace_only_secret(self):
        env = {**PLAID_ENABLED_ENV, "PLAID_SECRET": " \t "}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("PLAID_SECRET must be non-empty", result.stderr)
        self.assertNotIn("\t", result.stderr)

    def test_plaid_enabled_preserves_exact_non_empty_credential_strings(self):
        env = {
            **PLAID_ENABLED_ENV,
            "PLAID_CLIENT_ID": "  exact-client-id  ",
            "PLAID_SECRET": "  exact-secret  ",
        }
        body = textwrap.dedent(
            """\
            print(
                json.dumps(
                    {
                        "client_id": settings.PLAID_CLIENT_ID,
                        "secret": settings.PLAID_SECRET,
                    }
                )
            )
            """
        )
        result = run_settings(env, body=body)

        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["client_id"], "  exact-client-id  ")
        self.assertEqual(payload["secret"], "  exact-secret  ")

    def test_plaid_enabled_rejects_empty_token_keys(self):
        env = {**PLAID_ENABLED_ENV, "PLAID_TOKEN_KEYS": ""}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("PLAID_TOKEN_KEYS", result.stderr)

    def test_plaid_enabled_rejects_malformed_token_keys(self):
        env = {**PLAID_ENABLED_ENV, "PLAID_TOKEN_KEYS": "key-a"}
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("PLAID_TOKEN_KEYS", result.stderr)

    def test_plaid_enabled_rejects_duplicate_key_ids(self):
        env = {
            **PLAID_ENABLED_ENV,
            "PLAID_TOKEN_KEYS": (
                f"key-a:{PLAID_TEST_KEYS[0]},key-a:{PLAID_TEST_KEYS[1]}"
            ),
        }
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("duplicate key id", result.stderr)

    def test_plaid_enabled_rejects_unsafe_key_id(self):
        env = {
            **PLAID_ENABLED_ENV,
            "PLAID_TOKEN_KEYS": f"bad id!:{PLAID_TEST_KEYS[0]}",
        }
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("unsafe key id", result.stderr)
        self.assertNotIn("bad id!", result.stderr)

    def test_plaid_enabled_rejects_invalid_fernet_key(self):
        env = {
            **PLAID_ENABLED_ENV,
            "PLAID_TOKEN_KEYS": "key-a:not-a-fernet-key",
        }
        result = run_settings(env)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ImproperlyConfigured", result.stderr)
        self.assertIn("invalid Fernet key", result.stderr)
        self.assertNotIn("not-a-fernet-key", result.stderr)
