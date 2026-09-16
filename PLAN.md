# Mohr Product Plan

> A focused personal-finance app that tells users where their money went and what they can safely spend this month.

## Status

- v0.1 (manual tracking MVP) is complete and preserved unchanged below as
  the historical contract. The live preview runbook is in
  `docs/deployment.md`.
- Active work is the bounded v0.2 Plaid Sandbox milestone, defined in the
  v0.2 section below and frozen in `docs/plaid.md`.

## Product promise

Mohr helps students and young professionals manually track accounts, transactions, and monthly budgets from one clear dashboard.

## MVP user journey

A user can:

1. Create an account and log in.
2. Create financial accounts such as Checking, Savings, or Cash.
3. Create income and expense categories.
4. Record income and expense transactions.
5. Create monthly spending budgets for expense categories.
6. View total balance, monthly income, monthly spending, remaining budget, and recent transactions.
7. Edit or delete their own records.
8. Never access another user's financial data.

## Included in v0.1

### Authentication

- User registration
- User login and logout
- Secure password hashing
- Authenticated API requests
- Strict user-level data isolation

### Accounts

- Create, list, retrieve, update, and archive accounts
- Account types: checking, savings, cash, and credit card
- Opening balance
- Current balance calculated from the opening balance and transactions

### Categories

- Income and expense category types
- Create, list, update, and archive custom categories
- Category names unique per user and category type

### Transactions

- Create, list, retrieve, update, and delete transactions
- Positive decimal amount
- Income or expense type
- Date and optional note
- Connected account and category
- Filter by account, category, type, and date range

### Monthly budgets

- Set a spending limit for an expense category and month
- Show spent and remaining amounts
- Prevent duplicate budgets for the same user, category, and month

### Dashboard

- Total balance across active accounts
- Current-month income
- Current-month expenses
- Total budgeted amount
- Remaining budget
- Recent transactions

### Quality requirements

- Django REST Framework API
- PostgreSQL database
- Automated API tests for successful and invalid behavior
- Consistent JSON errors
- Environment-based secrets
- API documentation
- React and TypeScript web interface
- Responsive layout
- Deployed MVP

## Explicitly excluded from v0.1

- Bank synchronization and Plaid
- Transfers between accounts
- Recurring transaction automation
- Shared or household budgets
- Investment and cryptocurrency tracking
- Multiple currencies
- Receipt scanning
- AI financial advice
- Native mobile applications
- GraphQL
- Redis, Celery, and Kubernetes

These features remain out until the core ledger, ownership rules, tests, and deployment are reliable.

## Production stack

### Backend

- Python 3.11
- Django 5.2 LTS
- Django REST Framework
- PostgreSQL
- Django migrations
- Django test framework and DRF `APITestCase`

### Frontend

- React
- TypeScript
- Vite
- A minimal dark interface with one accent color: `#5eead4`

### Delivery

- GitHub issues and milestones
- One issue branch per change
- Conventional commits
- Pull requests with squash merges
- Stable `main`
- Docker for repeatable deployment
- CI for backend tests and frontend checks

## Core data model

```text
User
├── Account
│   └── Transaction
├── Category
│   ├── Transaction
│   └── MonthlyBudget
└── Dashboard summaries are calculated from owned records
```

### User

- `id`
- `email`, unique
- securely hashed password
- timestamps

### Account

- `id`
- `user`, foreign key
- `name`
- `account_type`
- `opening_balance`, decimal
- `is_archived`
- timestamps

### Category

- `id`
- `user`, foreign key
- `name`
- `category_type`: income or expense
- `is_archived`
- timestamps

### Transaction

- `id`
- `user`, foreign key for explicit ownership
- `account`, foreign key
- `category`, foreign key
- `transaction_type`: income or expense
- `amount`, positive decimal
- `date`
- optional `note`
- timestamps

### MonthlyBudget

- `id`
- `user`, foreign key
- `category`, foreign key to an expense category
- `month`, stored as the first date of the month
- `amount`, positive decimal
- timestamps
- unique constraint on user, category, and month

## Ownership rule

Every query for private financial data must be scoped to the authenticated user.

```text
Correct: Transaction.objects.filter(user=request.user)
Wrong:   Transaction.objects.all()
```

Object IDs alone never grant access. A user requesting another user's object receives HTTP 404.

## API outline

```text
GET    /api/auth/csrf/
POST   /api/auth/register/
POST   /api/auth/login/
POST   /api/auth/logout/
GET    /api/auth/me/

GET    /api/accounts/
POST   /api/accounts/
GET    /api/accounts/<id>/
PATCH  /api/accounts/<id>/
DELETE /api/accounts/<id>/

GET    /api/categories/
POST   /api/categories/
GET    /api/categories/<id>/
PATCH  /api/categories/<id>/
DELETE /api/categories/<id>/

GET    /api/transactions/
POST   /api/transactions/
GET    /api/transactions/<id>/
PATCH  /api/transactions/<id>/
DELETE /api/transactions/<id>/

GET    /api/budgets/
POST   /api/budgets/
GET    /api/budgets/<id>/
PATCH  /api/budgets/<id>/
DELETE /api/budgets/<id>/

GET    /api/dashboard/summary/
```

Mohr uses Django server-side session authentication for its first-party browser frontend, not JWT. The session cookie is HttpOnly and server-revocable, and no token is stored in JavaScript, which limits XSS exposure. Registration, login, logout, and later authenticated unsafe requests are CSRF protected: the frontend fetches the CSRF cookie and sends the matching `X-CSRFToken` header. Cross-origin deployments require three separate settings: credentials included on requests, credentialed CORS for the exact frontend origin, and that origin in `CSRF_TRUSTED_ORIGINS` for unsafe requests. CORS alone does not satisfy CSRF checks, and none of these settings is configured yet.

## Implementation order

1. Replace stale project documentation.
2. Scaffold Django, DRF, PostgreSQL configuration, and health check.
3. Add CI and the first automated test.
4. Build authentication and ownership test helpers.
5. Build accounts.
6. Build categories.
7. Build transactions.
8. Build monthly budgets.
9. Build dashboard summaries.
10. Build the React and TypeScript frontend.
11. Run security, accessibility, and end-to-end checks.
12. Deploy the MVP.

## Definition of done for every backend feature

- GitHub issue with acceptance criteria
- Issue branch created from current `main`
- Tests written for success, validation failure, authentication, and ownership
- Implementation passes focused tests
- Full backend suite passes
- API response shape documented
- No secrets committed
- Pull request reviewed and squash-merged

## Git workflow

```text
Issue → issue-N branch → logical commits → PR → checks → squash merge → stable main
```

Never develop directly on `main`.

## v0.2 Plaid Sandbox milestone (planned)

Goal: read-only bank synchronization through Plaid Sandbox using the
Transactions product only, without weakening any v0.1 ownership, ledger, or
testing rule. The full architecture contract is frozen in `docs/plaid.md`;
this section bounds the milestone.

Included:

- Sandbox-only Link flow (authenticated link token, React Link, one-time
  public token, server-side exchange into an encrypted access token).
- Checking, savings, and credit-card import with an explicit Plaid to Mohr
  type map.
- Ninety-day initial history plus idempotent `/transactions/sync` updates
  (added, modified, removed; pending-to-posted replacement; atomic cursor
  commits; per-Item serialization).
- One-time opening-balance seeding that subtracts imported history from the
  provider current balance, so history is never double-counted, with linked
  accounts and their synced rows excluded from balances, budgets, and the
  dashboard until the anchor is applied.
- Automatic Uncategorized income/expense categories with user category and
  note overrides that survive sync.
- Verified public server-to-server HTTPS webhooks (ES256
  `Plaid-Verification`, two-sided five-minute age bound, raw-body hash)
  driving a durable inbox plus cursor polling,
  with no Celery, Redis, or Kubernetes on the single-process Render Free
  service.
- Update mode, relink, consent-revoked handling, and disconnect that
  revokes access, archives linked accounts, and preserves history.

Excluded (unchanged non-goals for this milestone): Auth/account numbers,
Transfer/money movement, investments, loans, liabilities,
recurring-transactions and Refresh add-ons, multiple currencies, and
Production bank access.

Delivery: five focused follow-up issues (configuration and persistence;
Link and exchange; account import and sync; webhook and lifecycle; React
UI and Sandbox end-to-end), each on one issue branch with one reviewed PR.
