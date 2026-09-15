#!/bin/sh
set -eu

# Idempotent migrations must finish before any traffic is served. set -e
# stops startup on the first failure, so Gunicorn never starts on an
# un-migrated schema.
python manage.py migrate --noinput

# --forwarded-allow-ips accepts * only because Render's edge is the sole network path to this container.
# render.yaml will pin the exact value later.
exec gunicorn config.wsgi:application \
  --bind "0.0.0.0:${PORT:-8000}" \
  --workers "${WEB_CONCURRENCY:-1}" \
  --timeout "${GUNICORN_TIMEOUT:-120}" \
  --access-logfile - \
  --error-logfile - \
  --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-*}"