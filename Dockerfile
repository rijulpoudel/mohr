# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# ---------------------------------------------------------------------------
# Stage 1: build the Vite React frontend shell.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS frontend-build
WORKDIR /app/frontend

# Dependency manifests first so `npm ci` is cached unless they change.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Full source for the production build.
COPY frontend/ .
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2: install production dependencies and prepare the static root.
# ---------------------------------------------------------------------------
FROM python:3.11-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84 AS backend-build

# uv is a build-time tool only and is not carried into the runtime image.
COPY --from=ghcr.io/astral-sh/uv:0.12.5@sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1 /uv /uvx /usr/local/bin/

WORKDIR /app/backend
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# Locked production-only dependencies, installed before any source is copied.
COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

# Backend source, then the compiled frontend, then a DB-free collectstatic.
COPY backend/ .
COPY --from=frontend-build /app/frontend/dist /app/backend/frontend_dist

# collectstatic never connects to the database; the dummy values below only
# let Django's settings module load. No secret or build arg is referenced.
RUN --mount=type=cache,target=/root/.cache/uv \
    DJANGO_PRODUCTION=False \
    DJANGO_DEBUG=False \
    DJANGO_SECRET_KEY=collectstatic-only-dummy-key \
    DJANGO_ALLOWED_HOSTS=localhost \
    DJANGO_CSRF_TRUSTED_ORIGINS= \
    POSTGRES_DB=mohr \
    POSTGRES_USER=mohr \
    POSTGRES_PASSWORD=collectstatic-only-dummy \
    POSTGRES_HOST=localhost \
    POSTGRES_PORT=5432 \
    .venv/bin/python manage.py collectstatic --noinput

# ---------------------------------------------------------------------------
# Stage 3: minimal non-root runtime image.
# ---------------------------------------------------------------------------
FROM python:3.11-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84 AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/backend/.venv/bin:${PATH}"

WORKDIR /app/backend

# Dedicated non-root identity with numeric IDs so nothing depends on passwd.
# The owned home directory lets Gunicorn's control server write its socket.
RUN groupadd --gid 10001 mohr \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin mohr

COPY --from=backend-build --chown=10001:10001 /app/backend /app/backend
COPY --chown=10001:10001 docker/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request\nhost = os.environ.get('DJANGO_ALLOWED_HOSTS', '').split(',')[0].strip()\nif not host:\n    raise SystemExit('DJANGO_ALLOWED_HOSTS is empty')\nport = os.environ.get('PORT', '8000')\nrequest = urllib.request.Request('http://127.0.0.1:{}/api/health/'.format(port), headers={'Host': host})\nurllib.request.urlopen(request, timeout=3)"]

ENTRYPOINT ["/usr/local/bin/start.sh"]