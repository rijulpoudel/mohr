import tempfile
from pathlib import Path

from django.test import SimpleTestCase, override_settings
from django.urls import reverse

SHELL_SENTINEL = b"mohr-spa-shell-v0.1"


class StaticDeliveryTests(SimpleTestCase):
    @staticmethod
    def _build_shell(root: Path) -> Path:
        index = root / "index.html"
        index.write_bytes(SHELL_SENTINEL)
        return index

    def test_route_serves_built_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/accounts")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "text/html")
        self.assertEqual(response.content, SHELL_SENTINEL)

    def test_root_serves_same_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, SHELL_SENTINEL)

    def test_shell_response_is_not_cached_by_browsers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/accounts")

        self.assertEqual(response["Cache-Control"], "no-cache")

    def test_missing_shell_returns_404_without_sentinel(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/accounts")

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(SHELL_SENTINEL, response.content)

    def test_unknown_api_path_is_a_real_404_not_the_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/api/does-not-exist/")

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(SHELL_SENTINEL, response.content)

    def test_missing_static_file_is_a_real_404_not_the_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/static/missing.css")

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(SHELL_SENTINEL, response.content)

    def test_admin_login_does_not_return_the_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/admin/login/")

        self.assertNotIn(SHELL_SENTINEL, response.content)

    def test_spa_fallback_route_resolves(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get(
                    reverse("spa-index", kwargs={"path": "accounts"})
                )

        self.assertEqual(response.status_code, 200)

    def test_bare_api_path_is_a_real_404_not_the_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/api")

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(SHELL_SENTINEL, response.content)

    def test_bare_admin_path_is_a_real_404_not_the_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/admin")

        # APPEND_SLASH redirects bare /admin to /admin/ before the fallback
        # could ever match, so the shell must never be served either way.
        self.assertNotEqual(response.status_code, 200)
        self.assertNotIn(SHELL_SENTINEL, response.content)

    def test_bare_static_path_is_a_real_404_not_the_shell(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/static")

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(SHELL_SENTINEL, response.content)

    def test_post_to_spa_route_is_not_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._build_shell(root)
            with override_settings(STATIC_ROOT=root):
                response = self.client.post("/accounts")

        self.assertEqual(response.status_code, 405)
        self.assertNotIn(SHELL_SENTINEL, response.content)

    def test_missing_shell_404_does_not_leak_static_root_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with override_settings(STATIC_ROOT=root):
                response = self.client.get("/accounts")

        self.assertEqual(response.status_code, 404)
        self.assertNotIn(str(root).encode(), response.content)
        # Django's default 404 handler suppresses the Http404 reason outside
        # DEBUG, so even the safe message never reaches the client.
        self.assertNotIn(b"Frontend build is not available.", response.content)
