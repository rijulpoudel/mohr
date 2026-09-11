# Mohr

Mohr is a personal-finance and monthly-budgeting web application for people who want a clear answer to two questions:

1. Where did my money go?
2. What can I safely spend this month?

## Project status

Mohr is under active development toward its `v0.1 MVP`.

The backend uses Django REST Framework and PostgreSQL. The preserved Express and Prisma prototype remains available through Git history and the `express-prototype-v0.1` tag.

## MVP capabilities

The first usable release will support:

- User registration and authentication
- User-owned financial accounts
- Income and expense categories
- Transaction CRUD and filtering
- Monthly category budgets
- Dashboard summaries for balance, income, spending, and remaining budget
- Automated backend tests
- React and TypeScript web interface
- Deployed application

See [`PLAN.md`](PLAN.md) for the complete scope, data model, non-goals, and implementation order.

## Technology

### Backend

- Python 3.11
- Django 5.2 LTS
- Django REST Framework
- PostgreSQL

### Frontend

- React
- TypeScript
- Vite

### Engineering workflow

- GitHub issues and milestones
- One issue branch per change
- Conventional commits
- Automated tests before merge
- Pull requests with squash merges
- Stable `main`

## Core ownership rule

Every private financial record belongs to an authenticated user. API queries must always be scoped to that user, and object IDs alone never grant access.

```text
User
├── Accounts
│   └── Transactions
├── Categories
│   ├── Transactions
│   └── Monthly Budgets
└── Dashboard summaries
```

## Authentication API

Mohr uses Django server-side session authentication, not JWT. This fits a first-party browser frontend: the session cookie is HttpOnly, the server can revoke a session at any time, and no token has to be stored or refreshed in JavaScript. All authentication routes live under `/api/auth/`.

Successful responses return only the public user shape:

```json
{"id": 1, "email": "user@example.com"}
```

Password hashes, `is_staff`, and `is_superuser` are never returned.

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/api/auth/csrf/` | Set the CSRF cookie before an unsafe request | `200` |
| `POST` | `/api/auth/register/` | Create a user from `email` and `password` | `201` with the public user shape |
| `POST` | `/api/auth/login/` | Start a session | `200` with the public user shape |
| `POST` | `/api/auth/logout/` | End the session | `204` with no body |
| `GET` | `/api/auth/me/` | Return the authenticated user | `200` with the public user shape |

Registration does not start a session; the user logs in afterward.

### Browser flow

1. `GET /api/auth/csrf/` to receive the `csrftoken` cookie.
2. Read the cookie value and send it as the `X-CSRFToken` header on `POST /api/auth/login/` and on later authenticated unsafe requests.
3. On successful login, Django sends the session cookie. The browser sends it automatically on later requests.
4. `GET /api/auth/me/` restores the current user after a page reload.
5. `POST /api/auth/logout/` with the CSRF header ends the session and clears the session cookie.

Safe `GET` requests such as `/api/auth/csrf/` and `/api/auth/me/` do not require a CSRF token. Login and logout are CSRF protected. Same-origin requests include cookies automatically. If the frontend and backend run on different origins, three separate requirements apply, and none is configured yet:

1. Include credentials on requests (`credentials: "include"` with `fetch`, `withCredentials: true` with axios).
2. Allow the exact frontend origin in credentialed CORS.
3. List that origin in Django's `CSRF_TRUSTED_ORIGINS` so unsafe requests pass CSRF checks.

CORS alone does not make CSRF checks pass; `CSRF_TRUSTED_ORIGINS` is separate.

### Authentication errors

- Missing authentication returns JSON `401` with `{"detail": "Authentication credentials were not provided."}`.
- A failed login returns JSON `401` with `{"detail": "Invalid email or password."}` for an unknown email, a wrong password, or an inactive user, so the response never reveals which part failed.
- Invalid registration or login input returns JSON `400` with field errors.
- A failed CSRF check returns JSON `403` with a generic detail. Internal failure reasons are not exposed.
- Unsupported methods return `405`.

## Repository history

Mohr began as an Express, TypeScript, and Prisma prototype. That work remains preserved in Git history and the `express-prototype-v0.1` tag for reference. The production direction is now Django REST Framework.

## Local development

### Prerequisites

- Python 3.11
- [uv](https://docs.astral.sh/uv/)
- PostgreSQL 16 or another version supported by Django 5.2

### Backend setup

From the repository root:

```bash
cd backend
uv sync
cp .env.example .env
```

Fill the blank values in `.env`. Generate a development secret with:

```bash
uv run python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
```

Create the local PostgreSQL database if it does not exist, then apply migrations:

```bash
createdb mohr
uv run python manage.py migrate
```

Run the checks and automated tests:

```bash
uv run ruff check .
uv run ruff format --check .
uv run python manage.py check --database default
uv run python manage.py test
```

Start the development server:

```bash
uv run python manage.py runserver
```

Verify the health endpoint at `http://127.0.0.1:8000/api/health/`. A healthy backend returns:

```json
{"status": "ok"}
```

## Contributing

Mohr currently follows a solo-founder workflow:

```text
Issue → issue-N branch → logical commits → pull request → checks → squash merge
```

Each feature must include tests for successful behavior, invalid input, authentication, ownership isolation, and database side effects where relevant.

## License

This project is available under the repository's MIT License.
