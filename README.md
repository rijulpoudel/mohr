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
- Pull requests with regular merge commits
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
2. Read the cookie value and send it as the `X-CSRFToken` header on `POST /api/auth/register/`, `POST /api/auth/login/`, and later authenticated unsafe requests.
3. On successful login, Django sends the session cookie. The browser sends it automatically on later requests.
4. `GET /api/auth/me/` restores the current user after a page reload.
5. `POST /api/auth/logout/` with the CSRF header ends the session and clears the session cookie.

Safe `GET` requests such as `/api/auth/csrf/` and `/api/auth/me/` do not require a CSRF token. Registration, login, and logout are CSRF protected. Same-origin requests include cookies automatically. If the frontend and backend run on different origins, three separate requirements apply, and none is configured yet:

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

## Accounts API

Accounts routes live under `/api/accounts/`. Every request must come from an authenticated session, and ownership always comes from that session, never from client input. An object ID never grants access: requesting another user's account returns `404`, the same as a missing ID, so the response never reveals whether another user owns that ID.

Every account response uses exactly this public shape:

```json
{
  "id": 1,
  "name": "Everyday Checking",
  "account_type": "checking",
  "opening_balance": "100.00",
  "current_balance": "100.00",
  "is_archived": false,
  "created_at": "2026-09-11T14:52:48.008850Z",
  "updated_at": "2026-09-11T14:52:48.008850Z"
}
```

`opening_balance` is always a JSON string with exactly two decimal places, so money values never lose precision. It may be positive, zero, or negative; a negative opening balance means the account started in debt, such as a credit card balance owed. `account_type` is one of `checking`, `savings`, `cash`, or `credit_card`.

`current_balance` is a read-only JSON string with exactly two decimal places, derived live as `opening_balance` plus owned income transactions minus owned expense transactions for that account. It is not stored. Historical transactions continue to count after their linked account or category is archived, and balance-affecting transaction changes appear in the next account response automatically.

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/api/accounts/` | List the authenticated user's accounts in creation order, including archived ones | `200` with a JSON array |
| `POST` | `/api/accounts/` | Create an account owned by the authenticated user | `201` with the account |
| `GET` | `/api/accounts/<id>/` | Retrieve one owned account, archived or not | `200` with the account |
| `PATCH` | `/api/accounts/<id>/` | Partially update an owned account | `200` with the account |
| `DELETE` | `/api/accounts/<id>/` | Archive an owned account | `204` with no body |

Only `name`, `account_type`, and `opening_balance` are writable. `id`, `current_balance`, `is_archived`, `created_at`, and `updated_at` are read-only: values sent for them are ignored. `PATCH` changes only the fields included in the request and leaves omitted fields unchanged. There is no full `PUT` update.

`DELETE` never removes a row. It sets `is_archived` to `true` and preserves the account, its owner, and its data so historical transactions can still reference it. Archived accounts remain visible in list and retrieve responses. Repeated `DELETE` is idempotent and returns `204` again.

Every endpoint requires an authenticated session, and unauthenticated requests return `401` before method dispatch. Authenticated clients may use only the methods listed above; unsupported methods return `405`. `POST`, `PATCH`, and `DELETE` additionally require the CSRF token from `/api/auth/csrf/`, sent as the `X-CSRFToken` header, and a failed CSRF check returns `403`.

## Categories API

Categories routes live under `/api/categories/`. Every request must come from an authenticated session, and ownership always comes from that session, never from client input. An object ID never grants access: requesting another user's category returns `404`, the same as a missing ID, so the response never reveals whether another user owns that ID.

Every category response uses exactly this public shape:

```json
{
  "id": 1,
  "name": "Salary",
  "category_type": "income",
  "is_archived": false,
  "created_at": "2026-09-11T16:08:00.000000Z",
  "updated_at": "2026-09-11T16:08:00.000000Z"
}
```

`category_type` is exactly one of `income` or `expense`. A category name is unique for the authenticated user within its type after surrounding whitespace is trimmed and letter case is ignored, so `Food` and ` food ` are the same name. The same name may be used for an income category and an expense category, different users may use the same name freely, and archived categories continue to reserve their names.

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/api/categories/` | List the authenticated user's categories in creation order, including archived ones | `200` with a JSON array |
| `POST` | `/api/categories/` | Create a category owned by the authenticated user | `201` with the category |
| `GET` | `/api/categories/<id>/` | Retrieve one owned category, archived or not | `200` with the category |
| `PATCH` | `/api/categories/<id>/` | Rename an owned category | `200` with the category |
| `DELETE` | `/api/categories/<id>/` | Archive an owned category | `204` with no body |

`name` and `category_type` are writable when creating a category. After creation only `name` is writable; `category_type`, `id`, `is_archived`, `created_at`, and `updated_at` are read-only, and values sent for them are ignored. `PATCH` changes only the fields included in the request and leaves omitted fields unchanged. There is no full `PUT` update.

`DELETE` never removes a row. It sets `is_archived` to `true` and preserves the row, its owner, its name, its type, and its `created_at` so historical transactions can still reference it; `updated_at` records the archive operation. Archived categories remain visible in list and retrieve responses. Repeated `DELETE` is idempotent and returns `204` again.

Every endpoint requires an authenticated session, and unauthenticated requests return `401` before method dispatch. Authenticated clients may use only the methods listed above; unsupported methods return `405`. `POST`, `PATCH`, and `DELETE` additionally require the CSRF token from `/api/auth/csrf/`, sent as the `X-CSRFToken` header, and a failed CSRF check returns `403`.

## Transactions API

Transactions routes live under `/api/transactions/`. Every request must come from an authenticated session, and ownership always comes from that session, never from client input. An object ID never grants access: requesting another user's transaction returns `404`, the same as a missing ID, so the response never reveals whether another user owns that ID.

Every transaction response uses exactly this public shape:

```json
{
  "id": 1,
  "account": 1,
  "category": 1,
  "transaction_type": "expense",
  "amount": "12.50",
  "date": "2026-09-11",
  "note": "Groceries",
  "created_at": "2026-09-11T14:52:48.008850Z",
  "updated_at": "2026-09-11T14:52:48.008850Z"
}
```

`account` and `category` are account and category IDs. `amount` is always a JSON string with exactly two decimal places, so money values never lose precision.

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/api/transactions/` | List the authenticated user's transactions | `200` with a JSON array |
| `POST` | `/api/transactions/` | Create a transaction owned by the authenticated user | `201` with the transaction |
| `GET` | `/api/transactions/<id>/` | Retrieve one owned transaction | `200` with the transaction |
| `PATCH` | `/api/transactions/<id>/` | Partially update an owned transaction | `200` with the transaction |
| `DELETE` | `/api/transactions/<id>/` | Permanently delete an owned transaction | `204` with no body |

Only `account`, `category`, `transaction_type`, `amount`, `date`, and `note` are writable. `id`, `user`, `created_at`, and `updated_at` are server-controlled, and `user` is never returned. `PATCH` changes only the fields included in the request and leaves omitted fields unchanged. There is no full `PUT` update.

`amount` is a strictly positive decimal with a maximum of 12 digits in total and 2 decimal places. `transaction_type` is exactly one of `income` or `expense`, and it must match the linked category's type. `date` is required when creating a transaction and uses strict `YYYY-MM-DD` format. `note` is optional, surrounding whitespace is trimmed, an omitted or whitespace-only note becomes an empty string, and `null` is rejected.

`account` and `category` IDs are owner-scoped: a foreign ID and a missing ID return the same field-level `400`, so the response never reveals whether another user owns that relation. New assignments to an archived account or archived category are rejected. Existing historical transactions remain readable after their account or category is archived, and unrelated scalar edits remain allowed; explicitly reassigning the archived relation is rejected.

Detail transaction lookups are owner-scoped: a foreign transaction ID and a missing transaction ID both return a generic `404`.

`DELETE` permanently removes only the transaction row and returns an empty `204`, leaving the linked account and category rows unchanged. A repeated delete returns `404`. This differs from account and category archive behavior, which preserve the row.

The collection is ordered by newest `date`, then newest `created_at`, then newest `id`. It returns a plain JSON array with no pagination.

The collection accepts the optional filters `account`, `category`, `transaction_type`, `start_date`, and `end_date`. Filters combine with `AND`. Dates are strict `YYYY-MM-DD` values and are inclusive. Equal dates are allowed; a reversed range returns `400` under `end_date`. Archived owned account and category values may be used to find historical transactions. Invalid, foreign, or missing relation filter IDs return a privacy-safe field-level `400`. A valid filter with no matches returns `[]`. Unknown query params are ignored.

Every endpoint requires an authenticated session, and unauthenticated requests return `401` before method dispatch. Authenticated clients may use only the methods listed above; unsupported methods return `405`. `POST`, `PATCH`, and `DELETE` additionally require the CSRF token from `/api/auth/csrf/`, sent as the `X-CSRFToken` header, and a failed CSRF check returns `403`.

## Monthly Budgets API

Budgets routes live under `/api/budgets/`. Every request must come from an authenticated session, and ownership always comes from that session, never from client input. An object ID never grants access: requesting another user's budget returns `404`, the same as a missing ID, so the response never reveals whether another user owns that ID.

Every budget response uses exactly this public shape:

```json
{
  "id": 1,
  "category": 1,
  "month": "2026-09-01",
  "budgeted": "500.00",
  "spent": "25.50",
  "remaining": "474.50",
  "created_at": "2026-09-11T14:52:48.008850Z",
  "updated_at": "2026-09-11T14:52:48.008850Z"
}
```

`category` is a category ID. `month` uses strict `YYYY-MM-DD` format and must be the first day of the month. `budgeted` is always a JSON string with exactly two decimal places, so money values never lose precision. It is a strictly positive decimal with a maximum of 12 digits in total and 2 decimal places. The internal storage name `amount` is never exposed.

`spent` and `remaining` are read-only JSON strings with exactly two decimal places, calculated live and never stored. `spent` sums the authenticated user's expense transactions matching the budget category and the same calendar year and month. `remaining` is `budgeted` minus `spent` and can be negative when spending exceeds the budget. Transaction creates, updates, moves, and deletes appear in the next budget response automatically.

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/api/budgets/` | List the authenticated user's budgets | `200` with a JSON array |
| `POST` | `/api/budgets/` | Create a budget owned by the authenticated user | `201` with the budget |
| `GET` | `/api/budgets/<id>/` | Retrieve one owned budget | `200` with the budget |
| `PATCH` | `/api/budgets/<id>/` | Partially update an owned budget | `200` with the budget |
| `DELETE` | `/api/budgets/<id>/` | Permanently delete an owned budget | `204` with no body |

Only `category`, `month`, and `budgeted` are writable. `id`, the owner, the internal `amount` alias, `spent`, `remaining`, `created_at`, and `updated_at` are server-controlled, and the owner is never returned. `PATCH` changes only the fields included in the request and leaves omitted fields unchanged. There is no full `PUT` update.

`category` IDs are owner-scoped: a foreign ID and a missing ID return the same field-level `400`, so the response never reveals whether another user owns that relation. New budgets require the authenticated user's own active expense category. The user's own income category and archived category are rejected. The owner is always derived from the session.

Only one budget exists per user, category, and month. A duplicate returns a controlled `400` under `non_field_errors`.

`PATCH` validates the effective final category and month after applying the partial change, so changing either field alone or both together can collide with an existing budget. Explicitly assigning an archived category, including resubmitting the budget's own archived category, is rejected. Edits that omit `category` remain allowed on an existing historical budget whose category was later archived. `PATCH` responses refetch `spent` and `remaining` so the returned calculations reflect the update.

Detail budget lookups are owner-scoped: a foreign budget ID and a missing budget ID both return a generic `404`.

`DELETE` permanently removes only the budget row and returns an empty `204`, leaving the user, category, and transactions unchanged. A repeated delete returns `404`. This differs from account and category archive behavior, which preserve the row.

The collection returns a plain JSON array with no pagination. It is ordered by newest `month` first, with deterministic ties, and includes historical budgets whose category was later archived.

Every endpoint requires an authenticated session, and unauthenticated requests return `401` before method dispatch. Authenticated clients may use only the methods listed above; unsupported methods return `405`. `POST`, `PATCH`, and `DELETE` additionally require the CSRF token from `/api/auth/csrf/`, sent as the `X-CSRFToken` header, and a failed CSRF check returns `403`.

## Dashboard Summary API

The dashboard summary route is `GET /api/dashboard/summary/`. Every request must come from an authenticated session, and all values are calculated live from the authenticated user's own records; another user's data never affects the response.

The response uses exactly this shape:

```json
{
  "total_balance": "1420.50",
  "current_month_income": "2500.00",
  "current_month_expenses": "1579.50",
  "total_budgeted": "500.00",
  "remaining_budget": "424.75",
  "recent_transactions": []
}
```

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| `GET` | `/api/dashboard/summary/` | Read the authenticated user's dashboard summary | `200` with the summary object |

`total_balance` is the sum of current balances across the authenticated user's active accounts only. Each account balance is its opening balance plus owned income minus owned expense across all dates; archived accounts contribute nothing. `current_month_income` and `current_month_expenses` are the user's income and expense transaction sums from the first day of the current month up to, but excluding, the first day of the next month, using Django's active timezone (currently UTC). History linked to archived accounts and categories still counts.

`total_budgeted` is the sum of the user's budget amounts for the current month, including budgets whose categories were later archived. `remaining_budget` is the sum of each current-month budget's live remaining amount, following the same formula as the budgets API: budgeted minus owned expense transactions in the same category and calendar year and month. Overspending makes it negative.

`recent_transactions` contains at most the five newest owned transactions in the exact transaction shape and order described above, including transactions outside the current month and those linked to archived accounts or categories. The owner is never exposed.

All five money fields are JSON strings with exactly two decimal places, so money values never lose precision. They are calculated with the same 30-digit derived capacity used by account balances and budget spent/remaining totals, safely exceeding a single stored 12-digit amount. A user with no financial data receives `"0.00"` for every money field and `[]` for `recent_transactions`.

The endpoint is read-only and never modifies data. Every request requires an authenticated session, and unauthenticated requests return `401` before method dispatch. Normal session authentication and CSRF checks happen before method dispatch: an authenticated unsafe request without a valid CSRF token returns the generic `403` JSON failure, and only after authentication and CSRF checks pass does an unsupported unsafe method reach dispatch and return `405`. After successful authentication and any required CSRF validation, unsupported methods return `405`. There are no query parameters.

Query efficiency is fixed and independent of data size: after authentication, the financial summary itself is produced by exactly four SQL queries regardless of how many accounts, budgets, or transactions the user owns. One annotated query derives active-account balances, one aggregate query sums current-month income and expenses, one annotated query computes current-month budget spent and remaining totals, and one query fetches the five recent transactions. The normal session and user authentication lookups that DRF performs for any authenticated request are separate and not part of that count.

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

## Deployment

A public preview is live at <https://mohr-mnws.onrender.com>. It runs a
Render Free Docker web service in Ohio with an external Neon PostgreSQL
database over TLS. See [`docs/deployment.md`](docs/deployment.md) for the
full runbook, including the Blueprint flow, verification, and rollback.

## Contributing

Mohr currently follows a solo-founder workflow:

```text
Issue → issue-N branch → logical commits → pull request → checks → merge commit
```

Each feature must include tests for successful behavior, invalid input, authentication, ownership isolation, and database side effects where relevant.

## License

This project is available under the repository's MIT License.
