"""Structural regression tests for the container packaging.

These tests read only the repository's Dockerfile, .dockerignore,
.gitignore, and docker/start.sh. They deliberately avoid Docker itself so
they run fast and offline in CI; real image behavior is exercised by the
deployment smoke flow on the issue branch.

The pinned digests below were resolved live from the multi-platform manifest
lists of the trusted base images and must stay immutable in the Dockerfile.
"""

import re
import stat
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SYNTAX_DIGEST = (
    "sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32"
)
NODE_DIGEST = "sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5"
PYTHON_DIGEST = (
    "sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84"
)
UV_DIGEST = "sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1"

EXISTING_GITIGNORE_RULES = [
    "# Environment and operating system",
    ".env",
    ".DS_Store",
    "",
    "# JavaScript",
    "node_modules/",
    "",
    "# Python",
    ".venv/",
    "__pycache__/",
    "*.py[cod]",
    ".pytest_cache/",
    ".ruff_cache/",
    ".coverage",
    "htmlcov/",
    "",
    "# Django",
    "*.sqlite",
    "*.sqlite3",
    "staticfiles/",
]


def repo_file(relpath: str) -> Path:
    return REPO_ROOT / relpath


def lines_of(relpath: str) -> list:
    path = repo_file(relpath)
    if not path.is_file():
        return []
    return path.read_text(encoding="utf-8").splitlines()


def stage_block(name: str) -> list:
    """Return the Dockerfile lines belonging to the named named-stage block."""
    dockerfile = lines_of("Dockerfile")
    starts = []
    for index, line in enumerate(dockerfile):
        match = re.match(r"^FROM\s+\S+.*\bAS\s+([\w-]+)\s*$", line)
        if match:
            starts.append((index, match.group(1)))
    stage_start = next((i for i, n in starts if n == name), None)
    if stage_start is None:
        return []
    stage_end = len(dockerfile)
    for start, other in starts:
        if start > stage_start:
            stage_end = start
            break
    return dockerfile[stage_start + 1 : stage_end]


def find_block_text(start_line: str) -> str:
    """Return the joined text of a RUN/HEALTHCHECK block starting at a line."""
    dockerfile = lines_of("Dockerfile")
    index = next(
        (i for i, line in enumerate(dockerfile) if line.startswith(start_line)),
        None,
    )
    if index is None:
        return ""
    block = [dockerfile[index]]
    index += 1
    while index < len(dockerfile) and block[-1].rstrip().endswith("\\"):
        block.append(dockerfile[index].rstrip()[:-1])
        index += 1
    return "\n".join(block)


def dockerignore_patterns() -> list:
    return [
        line.strip()
        for line in lines_of(".dockerignore")
        if line.strip() and not line.lstrip().startswith("#")
    ]


def _pattern_matches(relpath: str, pattern: str) -> bool:
    """Match one dockerignore pattern against a context-relative path.

    This intentionally requires explicit ``**/`` forms for nested paths
    instead of relying on Docker's basename matching for slash-less patterns.
    The stricter model keeps nested exclusions visible and deliberate.
    """
    if pattern.startswith("!"):
        pattern = pattern[1:]
    pattern = pattern.strip("/")
    regex = "^" + re.escape(pattern)
    regex = regex.replace(r"\*\*/", "(?:.*/)?")
    regex = regex.replace(r"\*\*", ".*")
    regex = regex.replace(r"\*", "[^/]*")
    regex = regex.replace(r"\?", "[^/]")
    regex += "$"
    return re.match(regex, relpath) is not None


def _matches_with_contents(relpath: str, pattern: str) -> bool:
    """A pattern matches a path or any of its ancestor directories."""
    if _pattern_matches(relpath, pattern):
        return True
    parts = relpath.split("/")
    return any(
        _pattern_matches("/".join(parts[: index + 1]), pattern)
        for index in range(len(parts) - 1)
    )


def is_dockerignored(relpath: str) -> bool:
    ignored = False
    for pattern in dockerignore_patterns():
        negated = pattern.startswith("!")
        if not _matches_with_contents(relpath, pattern):
            continue
        ignored = not negated
    return ignored


class DockerfileStructuralTests(unittest.TestCase):
    def test_syntax_directive_is_digest_pinned(self):
        first_line = lines_of("Dockerfile")[0]
        self.assertEqual(first_line, f"# syntax=docker/dockerfile:1@{SYNTAX_DIGEST}")
        for line in lines_of("Dockerfile"):
            if line.startswith("# syntax="):
                self.assertIn("@sha256:", line)
                self.assertNotEqual(line, "# syntax=docker/dockerfile:1")

    def test_has_named_frontend_backend_and_runtime_stages(self):
        names = set(re.findall(r"\bAS\s+([\w-]+)", "\n".join(lines_of("Dockerfile"))))
        for expected in ("frontend-build", "backend-build", "runtime"):
            self.assertIn(expected, names)

    def test_base_images_use_exact_pinned_digests(self):
        dockerfile = "\n".join(lines_of("Dockerfile"))
        self.assertRegex(
            dockerfile,
            r"FROM node:22-bookworm-slim@sha256:[0-9a-f]{64} AS frontend-build",
        )
        self.assertIn(
            f"FROM node:22-bookworm-slim@{NODE_DIGEST} AS frontend-build",
            dockerfile,
        )
        python_froms = re.findall(
            r"FROM python:3.11-slim-bookworm@sha256:[0-9a-f]{64}", dockerfile
        )
        self.assertGreaterEqual(len(python_froms), 2)
        digests = {line.split("@")[1] for line in python_froms}
        self.assertEqual(digests, {PYTHON_DIGEST})
        self.assertIn(f"ghcr.io/astral-sh/uv:0.12.5@{UV_DIGEST}", dockerfile)

    def test_no_unpinned_or_latest_base_references(self):
        for line in lines_of("Dockerfile"):
            if not line.startswith("FROM"):
                continue
            self.assertIn("@sha256:", line)
            self.assertNotIn("latest", line)

    def test_frontend_stage_ci_before_source_copy_then_build(self):
        block = stage_block("frontend-build")
        manifest_copy = next(
            i for i, line in enumerate(block) if "package-lock.json" in line
        )
        ci = next(
            i
            for i, line in enumerate(block)
            if line.lstrip().startswith("RUN") and "npm ci" in line
        )
        source_copy = next(
            i
            for i, line in enumerate(block)
            if line.startswith("COPY") and re.search(r"frontend/?\s+\.\s*$", line)
        )
        build = next(i for i, line in enumerate(block) if "npm run build" in line)
        self.assertLess(manifest_copy, ci)
        self.assertLess(ci, source_copy)
        self.assertLess(source_copy, build)

    def test_backend_stage_syncs_locked_prod_deps_before_source(self):
        block = stage_block("backend-build")
        manifest_copy = next(
            i
            for i, line in enumerate(block)
            if "pyproject.toml" in line and "uv.lock" in line
        )
        sync = next(
            i
            for i, line in enumerate(block)
            if "uv sync --locked --no-dev --no-install-project" in line
        )
        source_copy = next(
            i
            for i, line in enumerate(block)
            if line.startswith("COPY") and re.search(r"backend/?\s+\.\s*$", line)
        )
        self.assertLess(manifest_copy, sync)
        self.assertLess(sync, source_copy)

    def test_backend_stage_copies_frontend_dist_before_collectstatic(self):
        block = stage_block("backend-build")
        dist_copy = next(
            i
            for i, line in enumerate(block)
            if "frontend-build" in line and "frontend_dist" in line
        )
        self.assertRegex(block[dist_copy], r"frontend_dist/?\s*$")
        collectstatic = next(
            i for i, line in enumerate(block) if "collectstatic --noinput" in line
        )
        self.assertLess(dist_copy, collectstatic)

    def test_collectstatic_uses_only_dummy_non_secret_settings(self):
        block = stage_block("backend-build")
        collectstatic_index = next(
            i for i, line in enumerate(block) if "collectstatic --noinput" in line
        )
        run_index = next(
            i
            for i in range(collectstatic_index, -1, -1)
            if block[i].lstrip().startswith("RUN")
        )
        run_block = "\n".join(block[run_index : collectstatic_index + 1])
        self.assertIn(
            ".venv/bin/python manage.py collectstatic", block[collectstatic_index]
        )
        self.assertIn("DJANGO_SECRET_KEY=", run_block)
        self.assertIn("DJANGO_PRODUCTION=", run_block)
        self.assertIn("DJANGO_ALLOWED_HOSTS=", run_block)
        self.assertIn("POSTGRES_DB=", run_block)
        self.assertIn("POSTGRES_USER=", run_block)
        self.assertIn("POSTGRES_HOST=", run_block)
        self.assertIn("POSTGRES_PORT=", run_block)
        self.assertNotIn("DATABASE_URL", run_block)
        self.assertNotIn("$", run_block)
        self.assertNotIn("RENDER", run_block)
        secret_value = re.search(r"DJANGO_SECRET_KEY=(\S+)", run_block)
        self.assertIsNotNone(secret_value)
        self.assertTrue(secret_value.group(1))

    def test_runtime_uses_dedicated_non_root_numeric_identity(self):
        block = "\n".join(stage_block("runtime"))
        self.assertRegex(block, r"groupadd .*--gid 10001")
        self.assertRegex(
            block, r"useradd .*--uid 10001 .*--gid 10001 .*--create-home .*mohr"
        )
        self.assertRegex(block, r"--shell /usr/sbin/nologin")
        self.assertIn("USER 10001:10001", block)
        self.assertIn("WORKDIR /app/backend", block)

    def test_runtime_copies_only_prepared_backend_and_start_script(self):
        block = "\n".join(stage_block("runtime"))
        copy_lines = [
            line
            for line in stage_block("runtime")
            if line.startswith("COPY") and "--from" in line
        ]
        self.assertTrue(copy_lines)
        for line in copy_lines:
            self.assertIn("--from=backend-build", line)
        self.assertRegex(block, r"COPY .*docker/start.sh")
        self.assertNotIn("--from=frontend-build", block)
        self.assertNotIn("npm", block)
        self.assertNotIn("node_modules", block)
        self.assertNotIn("ghcr.io/astral-sh/uv", block)
        self.assertNotIn("frontend/", block)

    def test_runtime_env_and_path(self):
        block = "\n".join(stage_block("runtime"))
        self.assertIn("PYTHONDONTWRITEBYTECODE=1", block)
        self.assertIn("PYTHONUNBUFFERED=1", block)
        self.assertRegex(block, r"PATH=.*\.venv/bin")

    def test_runtime_exposes_8000_and_start_script_in_exec_form(self):
        block = "\n".join(stage_block("runtime"))
        self.assertIn("EXPOSE 8000", block)
        entrypoint = next(
            line for line in stage_block("runtime") if line.startswith("ENTRYPOINT")
        )
        self.assertRegex(entrypoint, r"^ENTRYPOINT\s+\[")
        self.assertIn("start.sh", entrypoint)

    def test_healthcheck_is_python_stdlib_and_honors_port(self):
        healthcheck_text = find_block_text("HEALTHCHECK")
        self.assertIn("HEALTHCHECK", healthcheck_text)
        self.assertIn("urllib", healthcheck_text)
        self.assertIn("/api/health/", healthcheck_text)
        self.assertIn("PORT", healthcheck_text)
        self.assertIn("8000", healthcheck_text)
        self.assertIn("DJANGO_ALLOWED_HOSTS", healthcheck_text)
        self.assertIn("127.0.0.1", healthcheck_text)
        self.assertIn("headers={'Host': host}", healthcheck_text)
        self.assertIn("if not host:", healthcheck_text)
        self.assertIn("raise SystemExit", healthcheck_text)
        self.assertNotIn("assert host", healthcheck_text)
        self.assertIn(".split(',')[0].strip()", healthcheck_text)
        self.assertNotIn("curl", healthcheck_text)
        self.assertNotIn("wget", healthcheck_text)
        self.assertNotIn("X-Forwarded-Proto", healthcheck_text)
        cmd_line = next(
            line for line in lines_of("Dockerfile") if line.strip().startswith("CMD [")
        )
        self.assertTrue(cmd_line.strip().startswith("CMD ["))


class DockerignoreTests(unittest.TestCase):
    def test_nested_env_files_excluded_except_example(self):
        for path in (
            ".env",
            "backend/.env",
            "frontend/.env",
            ".env.local",
            "backend/.env.production",
            "frontend/.env.development.local",
        ):
            self.assertTrue(is_dockerignored(path), path)
        for path in (".env.example", "backend/.env.example", "frontend/.env.example"):
            self.assertFalse(is_dockerignored(path), path)

    def test_generated_frontend_dist_dirs_excluded(self):
        for path in (
            "backend/frontend_dist/index.html",
            "frontend_dist/assets/index.js",
            "backend/frontend_dist/assets/index-C_ezQ-8H.js",
        ):
            self.assertTrue(is_dockerignored(path), path)

    def test_build_excluded_directories(self):
        ignored = [
            ".git/config",
            "backend/.venv/bin/python",
            "frontend/node_modules/react/index.js",
            "frontend/dist/assets/index.js",
            "backend/frontend_dist/index.html",
            "backend/__pycache__/settings.cpython-311.pyc",
            "backend/.ruff_cache/0.16.5/x.py",
            "backend/.pytest_cache/README.md",
            "backend/staticfiles/index.html",
        ]
        for path in ignored:
            self.assertTrue(is_dockerignored(path), path)

    def test_local_databases_excluded_root_and_nested(self):
        for path in (
            "local.sqlite",
            "local.sqlite3",
            "backend/db.sqlite3",
            "backend/local.sqlite",
        ):
            self.assertTrue(is_dockerignored(path), path)

    def test_coverage_output_excluded_root_and_nested(self):
        for path in (
            ".coverage",
            "backend/.coverage",
            "coverage/index.html",
            "frontend/coverage/index.html",
            "htmlcov/index.html",
            "backend/htmlcov/index.html",
        ):
            self.assertTrue(is_dockerignored(path), path)

    def test_os_junk_and_local_notes_excluded_root_and_nested(self):
        for path in (
            ".DS_Store",
            "frontend/.DS_Store",
            ".claude/notes.md",
            "backend/.claude/notes.md",
            ".hermes/state.json",
            "backend/.hermes/state.json",
            "notes.local",
            "frontend/notes.local",
        ):
            self.assertTrue(is_dockerignored(path), path)

    def test_source_and_lockfiles_never_excluded(self):
        kept = [
            "backend/pyproject.toml",
            "backend/uv.lock",
            "backend/manage.py",
            "backend/config/settings.py",
            "backend/accounts/migrations/0001_initial.py",
            "backend/tests/test_health.py",
            "frontend/package.json",
            "frontend/package-lock.json",
            "frontend/src/App.tsx",
            "frontend/vite.config.ts",
            "frontend/index.html",
            "docker/start.sh",
        ]
        for path in kept:
            self.assertFalse(is_dockerignored(path), path)


class GitignoreTests(unittest.TestCase):
    def test_protects_frontend_dist(self):
        content = "\n".join(lines_of(".gitignore"))
        self.assertIn("frontend_dist/", content)

    def test_preserves_existing_rules(self):
        current = lines_of(".gitignore")
        for rule in EXISTING_GITIGNORE_RULES:
            self.assertIn(rule, current)


class StartScriptTests(unittest.TestCase):
    def setUp(self):
        self.path = repo_file("docker/start.sh")
        self.content = (
            self.path.read_text(encoding="utf-8") if self.path.is_file() else ""
        )
        self.lines = self.content.splitlines()

    def test_posix_shell_with_set_eu(self):
        self.assertTrue(self.path.is_file())
        self.assertTrue(self.lines[0].startswith("#!/bin/sh"))
        self.assertIn("set -eu", self.lines)

    def test_migrate_runs_before_gunicorn(self):
        migrate = next(
            i for i, line in enumerate(self.lines) if "migrate --noinput" in line
        )
        gunicorn = next(
            i for i, line in enumerate(self.lines) if "exec gunicorn" in line
        )
        self.assertLess(migrate, gunicorn)

    def test_gunicorn_flags_are_separate_quoted_argv_values(self):
        expected = [
            '--bind "0.0.0.0:${PORT:-8000}"',
            '--workers "${WEB_CONCURRENCY:-1}"',
            '--timeout "${GUNICORN_TIMEOUT:-120}"',
            "--access-logfile -",
            "--error-logfile -",
            '--forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-*}"',
        ]
        for flag in expected:
            self.assertIn(flag, self.content)

    def test_forwarded_ips_wildcard_comment_explains_render_safety(self):
        self.assertIn("sole network path", self.content)
        self.assertIn("render.yaml", self.content)

    def test_no_eval_sh_c_or_embedded_credentials(self):
        self.assertNotRegex(self.content, r"\beval\b")
        self.assertNotIn("sh -c", self.content)
        self.assertNotIn("postgres://", self.content)
        self.assertNotIn("DATABASE_URL", self.content)
        self.assertNotIn("password", self.content.lower())
        self.assertNotIn("secret", self.content.lower())

    def test_gunicorn_is_executed_not_backgrounded(self):
        exec_index = next(
            i for i, line in enumerate(self.lines) if "exec gunicorn" in line
        )
        migrate_index = next(
            i for i, line in enumerate(self.lines) if "migrate --noinput" in line
        )
        self.assertLess(migrate_index, exec_index)
        self.assertNotIn(" &", self.lines[exec_index])
        # Everything after the exec line is a flag continuation, never a
        # separate backgrounded command.
        for line in self.lines[exec_index + 1 :]:
            if line.strip() and not line.lstrip().startswith("#"):
                self.assertTrue(
                    line.strip().startswith("--"),
                    f"unexpected command after exec: {line!r}",
                )

    def test_script_is_executable(self):
        mode = stat.S_IMODE(self.path.stat().st_mode)
        self.assertTrue(mode & 0o111, "docker/start.sh must be executable")


if __name__ == "__main__":
    unittest.main()
