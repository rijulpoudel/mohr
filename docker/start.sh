#!/bin/sh
set -eu

# Idempotent migrations must finish before any traffic is served. set -e
# stops startup on the first failure, so Gunicorn never starts on an
# un-migrated schema.
python manage.py migrate --noinput

# --forwarded-allow-ips accepts * only because Render's edge is the sole network path to this container.
# render.yaml will pin the exact value later.
# The access log records method, path, protocol, and status but never the
# query string, so transient Google callback codes/states and bank sync
# parameters never land in deployed logs.
exec gunicorn config.wsgi:application \
  --bind "0.0.0.0:${PORT:-8000}" \
  --workers "${WEB_CONCURRENCY:-1}" \
  --timeout "${GUNICORN_TIMEOUT:-120}" \
  --access-logfile - \
  --access-logformat "%(h)s %(l)s %(u)s %(t)s \"%(m)s %(U)s %(H)s\" %(s)s %(b)s" \
  --error-logfile - \
  --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-*}"