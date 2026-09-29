# Owner data export

This document freezes the contract for `GET /api/auth/export/`, the read-only
owner-data download added for the Q08 privacy gate. It is not account
deletion, not a CSV import/export, and not a general settings system.

## Request contract

- Method: `GET` only. Any other method returns `405`.
- Authentication: Django session authentication. No session returns `401`
  with `{"detail": "Authentication credentials were not provided."}`.
- CSRF: not required because `GET` is a safe method under the project's
  existing session/CSRF conventions.
- No database writes: the endpoint only reads owner-scoped querysets.

## Response contract

The response body is a single JSON object. Headers:

- `Content-Type: application/json`
- `Content-Disposition: attachment; filename="mohr-export-v1.json"`
- `Cache-Control: no-store`

Body shape:

```json
{
  "schema_version": 1,
  "accounts": [],
  "categories": [],
  "transactions": [],
  "monthly_budgets": []
}
```

`schema_version` is a fixed integer (`1` for this contract). Collections are
ordered by ascending `id` for a stable, repeatable download. Money fields are
exact decimal strings (for example `"100.00"`). Dates are ISO strings.

## Field allowlists

Every collection uses an explicit allowlist. New model fields are never
exported until this document and the allowlist are deliberately updated.

### `accounts`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | |
| `name` | string | |
| `account_type` | string | `checking`, `savings`, `cash`, `credit_card` |
| `opening_balance` | decimal string | exact, never a float |
| `is_archived` | boolean | archived rows are included |
| `created_at` | ISO datetime | |
| `updated_at` | ISO datetime | |

### `categories`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | |
| `name` | string | |
| `category_type` | string | `income` or `expense` |
| `is_archived` | boolean | archived rows are included |
| `created_at` | ISO datetime | |
| `updated_at` | ISO datetime | |

### `transactions`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | |
| `account_id` | integer or null | null when the related account is not owned by the exporter |
| `category_id` | integer or null | null when the related category is not owned by the exporter |
| `transaction_type` | string | `income` or `expense` |
| `amount` | decimal string | exact, never a float |
| `date` | ISO date | |
| `note` | string | may be empty |
| `source` | string | `manual` or `plaid` |
| `is_pending` | boolean | audit state, included |
| `is_provider_removed` | boolean | audit state, included |
| `is_superseded` | boolean | audit state, included |
| `superseded_by_id` | integer or null | null when the superseding row is not owned by the exporter |
| `category_customized` | boolean | |
| `note_customized` | boolean | |
| `is_transfer` | boolean | |
| `created_at` | ISO datetime | |
| `updated_at` | ISO datetime | |

### `monthly_budgets`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | integer | |
| `category_id` | integer or null | null when the related category is not owned by the exporter |
| `month` | ISO date | stored as the first day of the month |
| `amount` | decimal string | exact, never a float |
| `created_at` | ISO datetime | |
| `updated_at` | ISO datetime | |

## Exclusions

The export deliberately omits:

- Password hashes and every Django authentication field.
- Session cookies, session keys, and CSRF material.
- Plaid access tokens, token ciphertext, and encryption key IDs.
- Plaid `item_id`, `plaid_account_id`, `plaid_transaction_id`, and
  `plaid_pending_transaction_id`.
- The Plaid `connection` relation.
- Provider merchant/description text (`provider_name`) and other raw provider
  payload fields.
- Any row, ID, name, email, or note belonging to another user.

## Owner isolation and malformed relations

Each queryset is filtered independently by `user=request.user`; the endpoint
never trusts an object ID for access. A transaction or budget row owned by the
exporter is retained even when its foreign key points at another user's
account or category (a relation the database cannot enforce). In that case the
relationship ID is exported as `null` rather than disclosing the other user's
ID. This applies to both directions: a foreign `account_id` and a foreign
`category_id`. `superseded_by_id` is sanitized the same way.

## Limitations and scale

- The whole dataset is loaded and serialized **in memory** into one response.
  There is no streaming, pagination, or compression, and the download is not
  size-bounded.
- The current single-process Render Free preview runs one Gunicorn worker, so
  a large export occupies that worker for the length of the request and
  competes with normal traffic.
- This is adequate only for the current small preview dataset. It is not a
  claim of production readiness or beta-scale safety. Before a real-user beta,
  bound the export (streaming or chunking), measure response size and
  generation time, and add throttling if needed.
- No new dependency, migration, or financial-calculation change is part of
  this contract.
