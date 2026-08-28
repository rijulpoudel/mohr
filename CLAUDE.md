# Mohr AI Assistant Guidelines

## Product

Mohr is a personal-finance and monthly-budgeting web application created by Rijul Poudel.

The v0.1 product promise:

> Help students and young professionals understand where their money went and what they can safely spend this month.

`PLAN.md` is the authoritative MVP scope.

## Production stack

### Backend

- Python 3.11
- Django 5.2 LTS
- Django REST Framework
- PostgreSQL
- Django migrations
- DRF `APITestCase`

### Frontend

- React
- TypeScript
- Vite

### Delivery

- GitHub issues and milestones
- One issue branch per change
- Conventional commits
- Pull requests
- Squash merges
- Stable `main`
- CI before merge

## Current migration state

The repository began as an Express, TypeScript, Prisma prototype.

That prototype is preserved in:

- Git history
- The `express-prototype-v0.1` tag
- The remote `issue-5` branch for the paused TypeScript migration

The old TypeScript migration must not be resumed or merged automatically. The current production direction is Django REST Framework.

Until the Django scaffold issue replaces it, the existing root `backend/` directory contains legacy Express code. Do not mix Django files into that directory without the dedicated migration issue and branch.

## Planned structure

```text
mohr/
├── backend/
│   ├── manage.py
│   ├── config/
│   ├── users/
│   ├── accounts/
│   ├── categories/
│   ├── transactions/
│   ├── budgets/
│   └── tests/
├── frontend/
├── PLAN.md
├── README.md
├── CLAUDE.md
└── .gitignore
```

The final Django app boundaries may change through deliberate architecture decisions. Do not create every app at once without an issue requiring it.

## Product rules

- Every financial record belongs to an authenticated user.
- Every private query is scoped to `request.user`.
- An object ID never grants access by itself.
- Cross-user object requests return HTTP 404.
- Monetary values use decimal types, never binary floating point.
- Transaction amounts are positive. The transaction type determines income versus expense.
- Account balances are derived from opening balance and transactions unless an issue deliberately changes that rule.
- Archived accounts and categories remain available to historical transactions.
- Database constraints back up serializer validation where practical.

## API conventions

- API routes begin with `/api/`.
- Collection responses use named envelopes when metadata is included.
- Errors use consistent JSON objects.
- Use correct HTTP statuses:
  - `200` for successful reads and updates
  - `201` for creation
  - `204` for deletion with no body
  - `400` for invalid client data
  - `401` for missing or invalid authentication
  - `403` only when revealing the resource is acceptable
  - `404` for missing resources and hidden cross-user resources
  - `405` for unsupported methods
- PATCH performs partial updates.
- Never expose password hashes, secrets, or internal exception details.

## Django conventions

- Use Django migrations for every schema change.
- Use data migrations for transformations of retained rows.
- Migration functions use historical models through `apps.get_model()`.
- Do not edit an applied migration to change production history.
- Prefer model and database constraints for invariants.
- Keep serializers responsible for input validation and representation.
- Keep views focused on HTTP orchestration and ownership scoping.
- Avoid hidden business logic in signals unless an issue explicitly justifies it.
- Use `select_related()` and `prefetch_related()` only after understanding query behavior.

## Testing rules

Every backend feature requires tests for:

- Successful behavior
- Invalid input
- Missing authentication
- Cross-user isolation
- Missing objects
- Database side effects
- Unsupported methods where relevant

Workflow:

```text
Write focused test → verify RED → implement → verify GREEN → run full suite → refactor
```

A green test suite is not enough if Django did not discover the intended test. Confirm the discovered test count and inspect meaningful assertions.

## Security rules

- Never commit `.env` files or credentials.
- Use environment variables for secrets and connection strings.
- Use Django password hashing.
- Validate ownership on every private operation.
- Do not log passwords, tokens, cookies, or database credentials.
- Do not invent authentication behavior. Document the selected mechanism and threat model in its issue.
- Apply secure cookie, CSRF, CORS, and production settings deliberately before deployment.

## Git workflow

```text
GitHub issue
    ↓
Branch named issue-N
    ↓
Small logical commits
    ↓
Pull request
    ↓
Tests and review
    ↓
Squash merge
    ↓
Stable main
```

Rules:

- Never commit directly to `main`.
- Do not mix unrelated issues in one branch.
- Commit each meaningful concern separately.
- Use conventional commit prefixes such as `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, and `chore:`.
- Never rewrite, delete, or merge preserved prototype work without explicit direction.

## Teaching workflow

Rijul is learning backend engineering while building Mohr.

- Explain why before syntax.
- Introduce one new concept at a time.
- Rijul types learning code and commands.
- After a guided pattern, give requirements only and make him rebuild it from memory.
- Auto-check files, Git state, tests, and live behavior after he says it is done.
- Keep technically accurate comments. Correct misleading comments instead of automatically deleting them.
- Do not treat successful execution as proof of understanding.
- If Rijul is stuck on one term or line, stop and explain that point before advancing.

## Design direction

- Minimal dark interface
- Flat backgrounds
- One accent color: `#5eead4`
- Tight spacing
- No gradients, neon effects, rainbow palettes, or generic AI-looking dashboards
- Prefer the restraint of Linear, Apple, and Stripe

## Non-goals for v0.1

Do not add these unless `PLAN.md` and a dedicated issue are updated first:

- Plaid or bank synchronization
- AI financial advice
- Receipt scanning
- Investment tracking
- Multiple currencies
- Shared household budgets
- Native mobile applications
- GraphQL
- Redis, Celery, or Kubernetes
