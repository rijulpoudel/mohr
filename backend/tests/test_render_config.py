"""Structural regression tests for the Render Blueprint and runbook.

These tests read only the repository's render.yaml, docs/deployment.md, and
README.md. They parse the blueprint with ``yaml.safe_load`` and assert the
exact service shape, environment variables, and safety properties the
deployment issue requires. They never contact Render, Neon, or any network
service, so they run fast and offline in CI.

No literal credential, database URL, or connection string belongs in any
assertion or fixture here. Public values are asserted as exact strings only.
"""

import re
import unittest
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
BLUEPRINT_PATH = REPO_ROOT / "render.yaml"
DOC_PATH = REPO_ROOT / "docs" / "deployment.md"
README_PATH = REPO_ROOT / "README.md"

SERVICE_NAME = "mohr"

PREVIEW_URL = "https://mohr-mnws.onrender.com"

EXPECTED_SERVICE_FIELDS = {
    "type": "web",
    "name": SERVICE_NAME,
    "runtime": "docker",
    "plan": "free",
    "region": "ohio",
    "branch": "main",
    "autoDeployTrigger": "checksPass",
    "healthCheckPath": "/api/health/",
    "dockerfilePath": "./Dockerfile",
    "dockerContext": ".",
    "previews": {"generation": "off"},
}

EXPECTED_ENV_KEYS = {
    "DJANGO_PRODUCTION",
    "DJANGO_DEBUG",
    "DJANGO_SECRET_KEY",
    "DJANGO_ALLOWED_HOSTS",
    "DATABASE_URL",
    "FORWARDED_ALLOW_IPS",
    "WEB_CONCURRENCY",
    "GUNICORN_TIMEOUT",
}

EXPECTED_PUBLIC_VALUES = {
    "DJANGO_PRODUCTION": "True",
    "DJANGO_DEBUG": "False",
    "FORWARDED_ALLOW_IPS": "*",
    "WEB_CONCURRENCY": "1",
    "GUNICORN_TIMEOUT": "120",
}

FORBIDDEN_SERVICE_FIELDS = {
    "dockerCommand",
    "buildCommand",
    "startCommand",
    "preDeployCommand",
    "disk",
    "disks",
    "scaling",
    "numInstances",
}

DATABASE_URL_SCHEME = re.compile(
    r"\b(?:postgres|postgresql|psql|mysql|redis)://", re.IGNORECASE
)

SECRET_VALUE_PATTERNS = (
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"sk_live_[A-Za-z0-9]{10,}"),
)


def env_var_map(service):
    """Return env vars as a {key: entry} mapping, failing on duplicates."""
    entries = service.get("envVars") or []
    mapping = {}
    for entry in entries:
        key = entry["key"]
        if key in mapping:
            raise AssertionError(f"duplicate environment variable {key}")
        mapping[key] = entry
    return mapping


class RenderBlueprintShapeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(
            BLUEPRINT_PATH.is_file(), f"missing blueprint at {BLUEPRINT_PATH}"
        )
        self.text = BLUEPRINT_PATH.read_text(encoding="utf-8")
        self.blueprint = yaml.safe_load(self.text)
        self.assertTrue(
            isinstance(self.blueprint, dict), "render.yaml must be a mapping"
        )
        self.services = self.blueprint.get("services") or []

    def test_root_keys_are_exactly_services(self):
        self.assertEqual(set(self.blueprint), {"services"})

    def test_exactly_one_web_service_and_no_render_database(self):
        self.assertNotIn(
            "databases", self.blueprint, "do not provision a Render database"
        )
        self.assertEqual(len(self.services), 1)
        self.assertEqual(self.services[0]["type"], "web")

    def test_service_keys_are_exactly_expected(self):
        service = self.services[0]
        self.assertEqual(set(service), set(EXPECTED_SERVICE_FIELDS) | {"envVars"})

    def test_service_fields_match_the_contract_exactly(self):
        service = self.services[0]
        for field, expected in EXPECTED_SERVICE_FIELDS.items():
            self.assertIn(field, service, f"missing service field {field}")
            self.assertEqual(service[field], expected, field)

    def test_previews_are_explicitly_off_without_overrides(self):
        service = self.services[0]
        self.assertEqual(service["previews"], {"generation": "off"})
        self.assertEqual(set(service["previews"]), {"generation"})

    def test_no_command_scaling_disk_or_preview_fields(self):
        service = self.services[0]
        for field in FORBIDDEN_SERVICE_FIELDS:
            self.assertNotIn(field, service, f"{field} must not be set")

    def test_environment_variable_keys_are_exact(self):
        mapping = env_var_map(self.services[0])
        self.assertEqual(set(mapping), EXPECTED_ENV_KEYS)

    def test_public_values_are_explicit_strings(self):
        mapping = env_var_map(self.services[0])
        for key, expected in EXPECTED_PUBLIC_VALUES.items():
            entry = mapping[key]
            self.assertIn("value", entry, f"{key} must set an explicit value")
            self.assertIsInstance(entry["value"], str, f"{key} must be a string")
            self.assertEqual(entry["value"], expected, key)

    def test_secret_key_uses_generated_value_only(self):
        entry = env_var_map(self.services[0])["DJANGO_SECRET_KEY"]
        self.assertEqual(set(entry), {"key", "generateValue"})
        self.assertIs(entry["generateValue"], True)

    def test_database_url_uses_sync_false_only(self):
        entry = env_var_map(self.services[0])["DATABASE_URL"]
        self.assertEqual(set(entry), {"key", "sync"})
        self.assertIs(entry["sync"], False)

    def test_allowed_hosts_self_references_the_web_service_hostname(self):
        entry = env_var_map(self.services[0])["DJANGO_ALLOWED_HOSTS"]
        self.assertEqual(set(entry), {"key", "fromService"})
        self.assertEqual(
            entry["fromService"],
            {
                "name": SERVICE_NAME,
                "type": "web",
                "envVarKey": "RENDER_EXTERNAL_HOSTNAME",
            },
        )

    def test_no_committed_env_value_is_a_credential(self):
        self.assertIsNone(
            DATABASE_URL_SCHEME.search(self.text),
            "render.yaml must not contain a database URL",
        )
        allowed = set(EXPECTED_PUBLIC_VALUES.values())
        for entry in self.services[0].get("envVars") or []:
            if "value" not in entry:
                continue
            value = entry["value"]
            self.assertIn(
                value,
                allowed,
                f"{entry['key']} commits a non-public literal value",
            )
            for pattern in SECRET_VALUE_PATTERNS:
                self.assertIsNone(pattern.search(value), entry["key"])


class DeploymentRunbookTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(DOC_PATH.is_file(), f"missing runbook at {DOC_PATH}")
        self.doc = DOC_PATH.read_text(encoding="utf-8")
        self.flat = " ".join(self.doc.split()).lower()
        self.assertTrue(README_PATH.is_file(), f"missing README at {README_PATH}")
        self.readme = README_PATH.read_text(encoding="utf-8")

    def test_readme_links_the_deployment_doc(self):
        self.assertIn("docs/deployment.md", self.readme)

    def test_readme_describes_regular_merge_commits(self):
        self.assertNotIn("squash", self.readme.lower())
        self.assertIn("merge commit", self.readme.lower())

    def test_readme_links_the_live_preview_and_deployment_doc(self):
        self.assertIn(PREVIEW_URL, self.readme)
        self.assertIn("docs/deployment.md", self.readme)

    def test_readme_has_no_stale_no_live_deployment_claim(self):
        self.assertNotIn("no live deployment exists", self.readme.lower())

    def test_covers_neon_console_projects_get_production_root_branch(self):
        self.assertIn("neon console", self.flat)
        self.assertIn("root branch", self.flat)
        self.assertIn("production", self.flat)

    def test_covers_neon_api_cli_projects_get_main_root_branch(self):
        self.assertIn("neon api or cli", self.flat)
        self.assertIn("root branch", self.flat)
        self.assertIn("main", self.flat)

    def test_covers_this_project_was_console_created_with_production_branch(self):
        self.assertIn("created in the console", self.flat)
        self.assertIn("console branch", self.flat)
        self.assertIn("production", self.flat)

    def test_neon_naming_is_not_one_branch_with_two_names(self):
        self.assertNotIn("shown as", self.flat)
        self.assertNotIn("is named", self.flat)

    def test_covers_neon_branch_unrelated_to_github_main_and_no_rename(self):
        self.assertIn("github", self.flat)
        self.assertIn("unrelated", self.flat)
        self.assertIn("rename", self.flat)

    def test_covers_connect_modal_flow_and_connection_pooling_off(self):
        self.assertIn("project dashboard", self.flat)
        self.assertIn("connect", self.flat)
        self.assertIn("connection pooling", self.flat)
        self.assertIn("pooler", self.flat)
        self.assertIn("single-worker", self.flat)

    def test_covers_sslmode_require_and_channel_binding_require(self):
        self.assertIn("sslmode=require", self.doc)
        self.assertIn("channel_binding=require", self.doc)

    def test_cleanup_covers_delete_and_archive_lifecycle(self):
        self.assertIn("transactions and budgets", self.flat)
        self.assertIn("archived, not permanently deleted", self.flat)
        self.assertIn("historical", self.flat)

    def test_cleanup_does_not_instruct_deleting_throwaway_accounts(self):
        self.assertNotIn("delete throwaway account", self.flat)
        self.assertNotIn("delete throwaway category", self.flat)

    def test_runbook_has_current_preview_section(self):
        self.assertIn("current preview", self.flat)
        self.assertIn(PREVIEW_URL, self.doc)

    def test_preview_is_zero_cost_not_uptime_promise_or_final_release(self):
        self.assertIn("zero-cost", self.flat)
        self.assertIn("not an uptime promise", self.flat)
        self.assertIn("v0.1.0", self.flat)

    def test_preview_records_only_verified_public_behavior(self):
        self.assertIn("ohio", self.flat)
        self.assertIn("neon", self.flat)
        self.assertIn("tls", self.flat)
        self.assertIn("redirect", self.flat)
        self.assertIn("react shell", self.flat)
        self.assertIn("deep route", self.flat)
        self.assertIn("static asset", self.flat)
        self.assertIn("390px", self.flat)
        self.assertIn("overflow", self.flat)
        self.assertIn("session", self.flat)
        self.assertIn("archive lifecycle", self.flat)
        self.assertIn("csrftoken", self.doc)

    def test_cross_user_isolation_remains_covered_by_automated_tests(self):
        self.assertIn("automated test", self.flat)
        self.assertIn("cross-user", self.flat)
        self.assertNotIn("manually verified cross-user", self.flat)

    def test_preview_claims_registration_login_logout_relogin_only(self):
        self.assertIn("registration, login, logout, and re-login", self.flat)
        self.assertNotIn("session persistence", self.flat)
        self.assertNotIn("across reloads", self.flat)

    def test_covers_neon_ohio_and_tls_requirement(self):
        self.assertIn("neon", self.flat)
        self.assertIn("ohio", self.flat)
        self.assertIn("aws-us-east-2", self.doc)
        self.assertIn("sslmode=require", self.doc)
        self.assertIn("tls", self.flat)

    def test_covers_blueprint_initial_flow(self):
        self.assertIn("render.yaml", self.doc)
        self.assertIn("blueprint", self.flat)
        self.assertIn("DATABASE_URL", self.doc)
        self.assertIn("main", self.doc)

    def test_covers_postgres_16_and_direct_connection(self):
        self.assertIn("postgresql 16", self.flat)
        self.assertIn("direct", self.flat)

    def test_covers_region_immutability(self):
        self.assertIn("cannot be changed after creation", self.flat)

    def test_covers_only_database_url_is_user_supplied(self):
        self.assertIn("only value", self.flat)
        self.assertIn("database_url", self.flat)

    def test_covers_same_origin_csrf(self):
        self.assertIn("same origin", self.flat)
        self.assertIn("csrf", self.flat)

    def test_covers_single_instance_startup_migrations(self):
        self.assertIn("single-instance", self.flat)

    def test_covers_forwarded_allow_ips_wildcard_trust(self):
        self.assertIn("forwarded_allow_ips", self.flat)
        self.assertIn("sole public network path", self.flat)
        self.assertIn("proxy", self.flat)

    def test_forwarded_allow_ips_scope_is_secure_scheme_only(self):
        self.assertIn("secure-scheme", self.flat)
        self.assertNotIn("client headers", self.flat)

    def test_covers_previews_explicitly_disabled(self):
        self.assertIn("previews", self.flat)
        self.assertIn("fail closed", self.flat)
        self.assertIn("sync: false", self.doc)

    def test_covers_migrations_before_gunicorn_and_health_checks(self):
        self.assertIn("migrat", self.flat)
        self.assertIn("gunicorn", self.flat)
        self.assertIn("/api/health/", self.doc)
        self.assertIn("log", self.flat)

    def test_covers_free_tier_limits(self):
        self.assertIn("cold start", self.flat)
        self.assertIn("ephemeral", self.flat)
        self.assertIn("free", self.flat)

    def test_covers_rollback_safety_and_limits(self):
        self.assertIn("rollback", self.flat)
        self.assertIn("auto-deploy", self.flat)
        self.assertIn("two most recent", self.flat)
        self.assertIn("database", self.flat)

    def test_covers_environment_variables_and_incident_verification(self):
        self.assertIn("environment variable", self.flat)
        self.assertIn("git", self.flat)
        self.assertIn("verify", self.flat)

    def test_runbook_contains_no_connection_string_example(self):
        self.assertIsNone(
            DATABASE_URL_SCHEME.search(self.doc),
            "runbook must not print a sample connection string",
        )


if __name__ == "__main__":
    unittest.main()
