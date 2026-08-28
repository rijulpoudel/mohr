# Mohr

Mohr is a personal-finance and monthly-budgeting web application for people who want a clear answer to two questions:

1. Where did my money go?
2. What can I safely spend this month?

## Project status

Mohr is under active development toward its `v0.1 MVP`.

The project is migrating from a preserved Express and Prisma prototype to a production direction built with Django REST Framework and PostgreSQL. The Django scaffold has not been merged yet, so local setup instructions will be added with the scaffold issue rather than documented prematurely.

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

Local development instructions will be added when the Django scaffold is merged. Until then, the existing root `backend/` directory is legacy prototype code and should not be treated as the final application structure.

## Contributing

Mohr currently follows a solo-founder workflow:

```text
Issue → issue-N branch → logical commits → pull request → checks → squash merge
```

Each feature must include tests for successful behavior, invalid input, authentication, ownership isolation, and database side effects where relevant.

## License

This project is available under the repository's MIT License.
