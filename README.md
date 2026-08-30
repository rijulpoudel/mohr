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
