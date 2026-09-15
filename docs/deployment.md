# Deployment runbook

This runbook describes the intended production path for Mohr v0.1: a Render
Free Docker web service in Ohio talking to an external Neon Free PostgreSQL
database over TLS.

This document does not claim that the live cloud deployment is complete. It
is the operational checklist to follow when issue #17 is provisioned and
verified.

## Architecture

```text
Browser
  |
  v
Render-managed HTTPS
  |
  v
Render Free Docker web service (Ohio)
  Gunicorn -> Django + WhiteNoise -> compiled React
  |
  v
Neon Free PostgreSQL (AWS US East Ohio, TLS required)
```

- One Render web service, defined in [`render.yaml`](../render.yaml).
- No Render Postgres resource. All durable data lives in Neon.
- The container starts `docker/start.sh`, which runs migrations before
  Gunicorn. The Dockerfile's `CMD`/`ENTRYPOINT` is authoritative; the
  Blueprint does not set a custom command.

### Zero-cost preview warning

The Free plan is a preview environment, not a production uptime promise.
Render Free spins the service down after about 15 idle minutes, so the next
request pays a cold start of roughly a minute. The filesystem is ephemeral:
anything written inside the container disappears on the next deploy or
restart. There is no shell and no one-off job support. Free rollbacks reach
only the two most recent previous deploys. Neon Free has its own storage and
compute limits. Do not promise availability based on this setup.

## Prerequisites

- A GitHub account with access to this repository and its `main` branch.
- A Render account.
- A Neon account.
- The deployment issue merged so `render.yaml` exists on `main`.

You do not need the `render` CLI, Docker, or a local database for this flow.
Do not install the CLI just for this runbook; the dashboard is the supported
path.

## Step 1: Create the Neon database

1. In the Neon console, create a project for Mohr.
2. Set the region to **AWS US East (Ohio)**, region id `aws-us-east-2`. This
   colocates the database with the Render Ohio service and keeps latency
   low. The region cannot be changed after creation, so verify it before
   continuing.
3. Choose **PostgreSQL 16** if the UI offers a version choice. Django 5.2
   supports it and it matches local development.
4. Keep the default database and role unless you have a reason to change
   them.
5. Copy the **direct** TLS connection string, not a pooled one. The current
   deployment runs exactly one Gunicorn worker, so a direct connection is
   sufficient and simpler to reason about.
6. Confirm the connection string's query parameters include
   `sslmode=require`. Production settings refuse to start without it.
7. Treat that connection string as a secret. Store it only in Render's
   `DATABASE_URL` environment variable. Never paste it into Git, GitHub
   issues or pull requests, logs, notes, chat, or screenshots.

Neon cannot be validated from this repository. Verify the project region and
TLS requirement in the Neon dashboard before moving on.

## Step 2: Create the Render Blueprint

After `render.yaml` is merged to `main`:

1. In the Render dashboard, choose **New** and then **Blueprint**.
2. Connect the Mohr repository.
3. Render reads `render.yaml` from the `main` branch and shows the `mohr`
   web service it plans to create.
4. Before confirming, verify the service is on the **Free** plan and in the
   **Ohio** region. The region is immutable after creation.
5. Render generates and manages `DJANGO_SECRET_KEY`. It is not committed to
   Git.
6. `DJANGO_ALLOWED_HOSTS` self-references `RENDER_EXTERNAL_HOSTNAME` from
   the same `mohr` web service, so Render fills it with the public hostname
   it assigns.
7. The only value the initial flow asks you to supply is `DATABASE_URL`,
   because the Blueprint marks it `sync: false`. Paste the Neon direct TLS
   connection string from Step 1.
8. Create the service. `autoDeployTrigger: checksPass` means future deploys
   from `main` wait for the linked branch CI checks to pass.

`DJANGO_CSRF_TRUSTED_ORIGINS` is intentionally omitted. The frontend and API
are served from the same origin, so no cross-origin trust entry is needed.

`PORT` is intentionally omitted. Render supplies it at runtime and the
container already honors it.

`FORWARDED_ALLOW_IPS` is set to `*`. Gunicorn and Django therefore trust
secure-scheme headers from any source inside the container's network. That is
safe only because Render's edge is the sole public network path to the
container: nothing else can reach it to spoof those headers. If the container
is ever exposed through another path, narrow `FORWARDED_ALLOW_IPS` to the
exact trusted proxy IPs instead of leaving the wildcard.

Service previews are explicitly disabled (`previews` with
`generation: off`). Render omits `sync: false` environment variables such as
`DATABASE_URL` from preview instances, so a preview would start without a
database and fail closed. This zero-cost initial architecture relies on local
and CI testing instead of cloud preview instances.

## Step 3: Follow the first deploy

The expected order in the deploy log is:

1. **Image build** — the Dockerfile builds the React bundle, syncs locked
   production Python dependencies with `--no-dev`, and collects static
   files.
2. **Container start** — `docker/start.sh` begins.
3. **Migrations finish** — `python manage.py migrate --noinput` completes.
   If it fails, `set -e` stops the script and Gunicorn never starts on an
   un-migrated schema.
4. **Gunicorn listens** — Gunicorn binds the runtime `PORT` with one worker.
5. **Health check passes** — Render requests `/api/health/`.
6. **Live** — Render marks the deploy live.

Read the log lines in that order. A deploy that goes live without the
migration lines is a warning sign, not a success.

## Step 4: Verify the live service

These checks use no credentials and expose no secrets:

- `GET /` returns the compiled React shell.
- `GET /api/health/` returns `{"status": "ok"}` with HTTP `200`.
- `GET /api/auth/csrf/` returns HTTP `200` and sets the `csrftoken` cookie.
- `GET /api/auth/me/` returns HTTP `401` when signed out.

Then check sessions and CSRF at a high level using a real account you
control:

1. Register a user through the UI.
2. Log in and confirm the browser stores the session cookie for the Render
   hostname.
3. Reload the page and confirm the session is restored.
4. Create, edit, and delete a throwaway account, category, transaction, and
   budget.
5. Log out and confirm the session ends.

Because the frontend and API share one origin, the browser sends cookies
automatically and the CSRF cookie value is echoed in the `X-CSRFToken`
header. No cross-origin configuration is involved.

## Free tier limitations to expect

- **Cold start**: after about 15 idle minutes the service spins down. The
  first request afterward can take about a minute.
- **Ephemeral filesystem**: uploads, logs, and any file written at runtime
  vanish on redeploy or restart. Only Neon holds durable data.
- **No shell**: you cannot exec into the container or run one-off
  management commands.
- **Two previous deploys**: Free rollback only reaches the two most recent
  previous deploys, so act quickly when something breaks.

## Rollback

Stop and inspect before changing anything:

1. Open the Render service's **Events** page and read the failing deploy's
   log lines. Confirm whether the failure is the image build, the
   migrations, Gunicorn startup, or the health check.
2. Check `/api/health/` directly to see whether the current instance is
   serving.
3. Confirm the database itself is reachable from Neon's dashboard.

To roll back the application:

1. In Render, open **Events**, find the last known-good deploy, and choose
   **Rollback**.
2. A dashboard rollback disables auto-deploy. Re-enable it only after the
   incident is resolved and the fixed commit is on `main`.
3. Remember that Free rollback reaches only the two most recent previous
   deploys. If the good deploy is older than that, redeploy the known-good
   commit instead.

Important database rules:

- A rollback does **not** reverse database migrations. The old code runs
  against the new schema.
- Do not reverse migrations blindly. Django migrations are not always
  reversible, and reversing one can destroy data.
- If the database is damaged, restore through a tested Neon branch or
  restore point. Test the restore before pointing the service at it.
- Treat application rollback and database recovery as separate operations.

After recovery, verify all of the following before re-enabling auto-deploy:

- Migrations are applied (`manage.py migrate --check` locally against the
  same schema, or inspect the Neon schema).
- `/api/health/` returns `{"status": "ok"}`.
- Registration and login work.
- Cross-user ownership isolation still holds: another user's object IDs
  return `404`.
- Core CRUD works for accounts, categories, transactions, and budgets.

## Startup migrations and scaling

Running migrations in `docker/start.sh` is acceptable only for this
single-instance preview. It guarantees the schema is ready before the only
worker starts, and there is no second instance to race.

Before scaling beyond one instance, move to a paid plan and run migrations
as a pre-deploy command or a dedicated release step so exactly one process
migrates while old instances keep serving. Do not raise
`WEB_CONCURRENCY` while migrations run at startup.

## Cleanup and incident verification

- Delete throwaway accounts and records created during verification.
- If a secret or connection string was exposed, rotate it in Neon and update
  `DATABASE_URL` in Render; do not leave the old value anywhere.
- After any incident, confirm the service is live, health checks pass, the
  deploy log shows migrations before Gunicorn, and the verification steps
  above still hold.
- Environment variables are configured in the Render dashboard and are not
  stored in Git. A saved change takes effect on the next deploy or restart:
  **Save and deploy** starts that deploy immediately, while **Save only**
  waits for a later deploy.
