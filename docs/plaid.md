# Plaid Sandbox synchronization architecture (v0.2)

This document freezes the product, security, ownership, persistence,
reconciliation, retention, webhook, and delivery contracts for Mohr's first
bank-synchronization milestone. It is documentation only: it proposes exact
routes and models but implements no endpoint and creates no migration.

- Product scope: Plaid **Transactions** product, **Sandbox** only.
- Full milestone plan: [`PLAN.md`](../PLAN.md) (v0.2 section).
- v0.1 ledger, ownership, and API contracts are unchanged.

## Official references

- Link flow: <https://plaid.com/docs/link/>
- Transactions product: <https://plaid.com/docs/transactions/>
- Transactions API (`/transactions/sync`): <https://plaid.com/docs/api/products/transactions/>
- Webhooks: <https://plaid.com/docs/api/webhooks/>
- Webhook verification: <https://plaid.com/docs/api/webhooks/webhook-verification/>
- Sandbox: <https://plaid.com/docs/sandbox/>

Where this document and Plaid's docs disagree, Plaid's docs win and this
document must be amended.

## 1. Product scope

### Included

- Plaid Transactions product in Sandbox.
- Account coverage: checking, savings, and credit cards only.
- Link, account import, 90-day initial history, incremental sync, verified
  webhooks, update mode, relink, disconnect, and a React connection UI.

### Explicitly excluded

- Auth (account/routing numbers), Transfer/money movement, investments,
  loans, liabilities, the recurring-transactions add-on, the Transactions
  Refresh add-on, multiple currencies, and Production bank access.

### Frozen product decisions

1. Plaid owns synced transaction amount, date, account, provider identity,
   and pending/posted lifecycle. The user may edit only Mohr category and
   note on a synced transaction; those overrides survive later syncs.
2. A Plaid-removed transaction, including a pending row superseded by its
   posted version, is hidden from lists, balances, budgets, and dashboard
   calculations but retained as an audit record, with a supersession link
   where one exists.
3. Disconnect tears down local state first and revokes Plaid access as best
   effort, archives linked accounts, and retains imported history.
4. Manual and synced records coexist and are visibly distinguished
   (`source: manual | plaid`, plus `pending` and "pending initial import"
   states).
5. Until the opening-balance anchor is applied, a linked account and its
   synced transactions stay visible but are excluded from every balance,
   budget, and dashboard aggregate (section 5).

## 2. Link flow and secrets

The browser never sees Plaid secrets. The one-time `public_token` is the
only Plaid credential that crosses the frontend, and it travels only from
Plaid Link to the authenticated Django exchange endpoint.

```text
Browser (session auth)                Django                      Plaid
  |                                     |                           |
  |-- POST /api/plaid/link-token/ ----->|                           |
  |<-- {link_token, expiration} --------|                           |
  |<-- {exchange_handle} ---------------|                           |
  |-- opens Plaid Link (link_token) ------------------------------->|
  |<-- one-time public_token ---------------------------------------|
  |-- POST /api/plaid/exchange/ ------->|                           |
  |   {public_token, exchange_handle}   |-- /item/public_token/     |
  |                                     |    /exchange ------------>|
  |                                     |<-- {access_token, item_id}|
  |<-- {connection} --------------------|  (token stored encrypted) |
```

Rules:

- `link_token` creation requires an authenticated Django session; the
  request sends `products: ["transactions"]`,
  `transactions: {days_requested: 90}` (the 90-day initial history window is
  fixed at Link time; see section 7), and `user.client_user_id` derived from
  `request.user` (a stable opaque identifier, never the email). The response
  contains only `link_token`, `expiration`, and a server-generated opaque
  `exchange_handle` bound to `request.user`, never secrets.
- `public_token` is single-use and short-lived; Django exchanges it
  server-side and never persists it. Exchange requires the matching
  `exchange_handle`, and the association with `request.user` is validated
  before anything is persisted; a missing, consumed, expired, or foreign
  handle is rejected without revealing which check failed.
- Permanent `access_token` values are encrypted at rest (section 4) and
  server-only. They must never enter API responses, frontend bundles,
  analytics, error payloads, or logs.
- Plaid `client_id`, `secret`, encryption keys, and webhook verification
  material are server-only environment configuration, subject to the same
  rule.
- Missing or invalid enabled-integration configuration fails closed: Link,
  exchange, sync, and webhook processing return errors and mutate nothing.

## 3. Proposed API routes and response boundaries

No endpoint is implemented in this milestone. Names below are frozen so
follow-up issues can implement them without renegotiation.

```text
POST   /api/plaid/link-token/        authenticated, CSRF protected
POST   /api/plaid/exchange/          authenticated, CSRF protected
GET    /api/plaid/connections/       authenticated list of user's connections
POST   /api/plaid/connections/<id>/sync/      authenticated manual sync trigger
POST   /api/plaid/connections/<id>/disconnect/ authenticated disconnect
POST   /api/plaid/webhooks/transactions/      public, signature-verified, CSRF-exempt
```

Response boundaries:

- `POST /api/plaid/link-token/` -> `200 {link_token, expiration,
  exchange_handle}`. Never includes secrets, access tokens, or item state.
- `POST /api/plaid/exchange/` accepts `{public_token, exchange_handle}` ->
  `201 {connection: {id, institution_name, status, linked_accounts}}`.
  Never returns `access_token`, `public_token`, or Plaid credentials. A
  handle that is missing, consumed, expired, or not bound to
  `request.user` returns a generic `400` and persists nothing.
- `GET /api/plaid/connections/` -> `200 [{id, institution_name, status,
  sync_pending, last_synced_at, linked_accounts: [{id, name, account_type,
  mask, sync_pending}]}]`, where `sync_pending` derives from
  `transactions_update_status != HISTORICAL_UPDATE_COMPLETE`. No tokens,
  cursors, raw provider payloads, or other users' data.
- `POST .../sync/` -> `200 {connection_id, status, added, modified,
  removed}` only once the opening-balance anchor is set (section 5), or
  `202 {connection_id, status: "processing"}` while the requested history
  window is still incomplete. Manual trigger only; see section 7.
- `POST .../disconnect/` -> `200 {connection_id, status: "disconnected"}`.
- Webhook endpoint returns `200` on verified receipt (even if processing is
  deferred) and `4xx` without mutation on verification failure. It returns
  no financial data.
- Cross-user or missing connection IDs return indistinguishable `404`
  responses, per the v0.1 ownership rule. Error shape follows the existing
  consistent JSON error convention.

PATCH and DELETE semantics for synced transactions stay on the existing
`PATCH /api/transactions/<id>/` and `DELETE /api/transactions/<id>/`
routes: only `category` and `note` are accepted for `source=plaid` rows;
amount, date, account, and type are rejected with `400`. `DELETE` on a
`source=plaid` row is rejected with `400`: v0.1 deletes are hard deletes,
and a synced row is a provider-owned audit record that must be retained
(frozen decision 2), so the soft-hide path stays reserved for
provider-reported removals (`is_provider_removed`) and supersession
(`is_superseded`). Manual rows keep full v0.1 delete behavior.

## 4. Persistence model proposal (no migration in this issue)

### New tables

`PlaidConnection` (one row per Plaid Item, owned by one Mohr user):

- `id`, `user` FK (`on_delete=CASCADE`), `item_id` (Plaid `item_id`).
- `access_token_encrypted` (binary/text), `encryption_key_id` (text; the
  same opaque label carried as the prefix of `access_token_encrypted`,
  indexed so rotation sweeps can find rows by key without parsing
  ciphertext; never a positional index).
- `institution_name`, `status`
  (`active | updating | error | revoked | disconnected`).
- `sync_cursor` (opaque Plaid cursor, text, nullable before first sync).
- `transactions_update_status` (`not_ready | initial_update_complete |
  historical_update_complete`, nullable), persisted from the in-band
  `/transactions/sync` signal and driving the sync-pending state.
- `sync_due` (bool, set by verified webhooks), `last_synced_at`,
  `last_sync_error`, timestamps.

`PlaidAccountLink` (maps one Plaid account to one Mohr account):

- `id`, `connection` FK, `user` FK (explicit ownership, matching v0.1
  transaction convention), `account` FK to `accounts.Account`
  (`on_delete=RESTRICT`, so history survives).
- `plaid_account_id` (provider identity), `plaid_type`, `plaid_subtype`,
  `mask` (last 4 only).
- `anchor_provider_current_balance` (`Decimal` quantized to two places,
  never float): immutable, captured from the first `/transactions/sync`
  response for this account, written only while the column is null, and
  never refreshed. It is the only balance input to the section 5 anchor,
  and a resumed multi-request initial import must reproduce the same value.
- `anchor_applied_at` (nullable timestamp): set exactly once in the same
  transaction that sets `opening_balance`; while it is null, the account
  and its synced rows are excluded from every aggregate (section 5).
- `provider_current_balance` and `provider_available_balance` (`Decimal`
  quantized to two places, never float): refreshable display-only
  snapshots, refreshed on later syncs for drift diagnosis, never ledger
  inputs.
- Archived state is derived from the linked `accounts.Account.is_archived`;
  the link row does not duplicate it.

`PlaidWebhookEvent` (durable inbox for verified webhooks):

- `id`, `connection` FK (nullable only for the bounded quarantine below),
  `user` FK (nullable likewise), `webhook_type`, `webhook_code`, provider
  `item_id`, `idempotency_key` (SHA-256 of the verified raw body, never the
  body itself), `initial_update_complete`, `historical_update_complete`,
  `received_at`, `processed_at` (nullable). The raw payload is excluded;
  parsed fields only, never secrets.
- A verified webhook whose `item_id` matches no `PlaidConnection` is not
  stored as a normal inbox row: the endpoint returns `200` without
  persisting, or quarantines it only within the bounded cap below.
- Retention and purge: processed inbox rows are purged after 30 days by a
  bounded management sweep, and the table is capped (oldest processed rows
  evicted first) so a flood cannot grow it without limit.

### Extensions to existing tables (future migration, not this issue)

`Transaction` gains nullable provider columns; manual rows keep them null:

- `source` (`manual | plaid`, default `manual`).
- `provider_name` (Plaid `name`/`merchant_name`, provider-owned, used as the
  display label because v0.1 transactions carry no name field; never
  user-editable).
- `plaid_transaction_id` (provider identity, nullable).
- `plaid_pending_transaction_id` (for pending-to-posted matching, nullable).
- `is_pending` (bool), `is_provider_removed` (bool, default false),
  `is_superseded` (bool, default false), `superseded_by` (nullable self-FK
  to the posted replacement).
- `category_customized`, `note_customized` (bools preserving overrides).
- `connection` FK (nullable, `on_delete=RESTRICT` for audit retention).

Deletion graph: `PlaidConnection.user` is proposed as `CASCADE` while
`Transaction.connection` is `RESTRICT`, so deleting a user would cascade
to connections and collide with transactions that restrict them. The full
deletion graph must be decided and verified with the repository migration
workflow before the migration is written; do not change v0.1 user-deletion
behavior by accident.

### Database constraints

- `UniqueConstraint(PlaidConnection.item_id)` (provider identity is
  globally unique). A Plaid Item belongs to exactly one Mohr user, so the
  same provider Item can never be linked to two users and cross-user
  sharing is intentionally impossible; the owner-scoped
  `UniqueConstraint(user, item_id)` is redundant and is not added.
- `UniqueConstraint(PlaidAccountLink.connection,
  PlaidAccountLink.plaid_account_id)` and `UniqueConstraint(user, account)`
  so one provider account maps to exactly one Mohr account.
- `UniqueConstraint(user, plaid_transaction_id)` where
  `plaid_transaction_id IS NOT NULL`, so reconciliation is stable and
  cross-user provider IDs cannot collide.
- `UniqueConstraint(PlaidWebhookEvent.idempotency_key)` for
  duplicate-webhook safety. Plaid does not document a webhook event ID, so
  the key derives from the verified body hash; webhooks only set
  `sync_due`. A re-delivered webhook violates the constraint on insert, so
  the handler catches only that specific named constraint violation,
  treats it as an already-processed event, and returns `200` without
  mutating anything; every other exception is re-raised, mirroring the
  v0.1 rule of translating only the exact named constraint.
- `CheckConstraint`s: synced rows must carry a connection and provider ID;
  manual rows must not; `is_superseded=true` requires `superseded_by` (a
  superseded row may also be `is_provider_removed`, because Plaid reports
  the pending row in `removed`); `amount > 0` kept from v0.1.
- Every private query stays scoped to `request.user`; foreign or missing
  objects return indistinguishable `404`.

### Account-type mapping

Only checking, savings, and credit cards are imported. All other Plaid
types are skipped and logged in redacted form (section 10).

| Plaid `type` | Plaid `subtype` examples | Mohr `account_type` | Notes |
| --- | --- | --- | --- |
| `depository` | `checking` | `checking` | Import. |
| `depository` | `savings` | `savings` | Import. |
| `credit` | `credit card` | `credit_card` | Import; balance semantics below. |
| anything else | any | n/a | Skip; never create `cash` from Plaid. |

Mohr `cash` accounts remain manual-only. Unknown or new Plaid subtypes
fail closed (skipped, flagged on the connection) rather than guessed.

### Transaction-state mapping

| Plaid state | Mohr representation |
| --- | --- |
| posted, not removed | `source=plaid`, `is_pending=false`, `is_provider_removed=false`, `is_superseded=false`; counted in balances, budgets, and dashboard **once the account is anchored** (section 5). |
| pending | `source=plaid`, `is_pending=true`; visible in lists with a pending flag, **excluded** from balances, budgets, and dashboard until posted. |
| removed by Plaid | `is_provider_removed=true`; hidden from normal lists and all calculations, retained for audit. |
| pending superseded by posted version | `is_superseded=true` with `superseded_by` pointing at the posted row; Plaid also reports the pending row in `removed`, so `is_provider_removed=true` normally accompanies it and either event order converges. Hidden from normal lists and all calculations, retained for audit; `superseded_by` distinguishes a pending-to-posted replacement from a genuine provider removal; the posted row is the single counted record (section 7). |
| account not yet anchored | linked account and its synced rows **excluded** from every balance, budget, and dashboard aggregate; rows remain visible in lists marked "pending initial import" and the account and connection show "sync pending" (section 5). |

### Token encryption and key rotation

Concrete strategy using Django and `cryptography.fernet.MultiFernet`:

- Settings read an ordered key ring from the environment, e.g.
  `PLAID_TOKEN_KEYS` as comma-separated base64 urlsafe 32-byte keys, first
  entry primary. Key material lives only in env, never in the database,
  responses, or logs.
- `access_token_encrypted` stores `key_id || fernet_ciphertext`, where
  `key_id` is an opaque random label assigned to each key and configured
  alongside it in the environment, never derived from the key material or
  any fingerprint of it. A positional index is never stored: reordering
  the ring, inserting a key, or removing a superseded key would silently
  change which key an index resolves to and make existing ciphertext
  undecryptable.
- Decryption order is precise: first resolve the single key by the stored
  `key_id` and decrypt with it; only when the `key_id` cannot be resolved
  (for example a superseded key already removed from the ring) fall back
  to `MultiFernet` trial decryption across the ring, and re-encrypt with
  the primary key on success. Keys are never selected by position.
- `MultiFernet` encrypts with the primary key; the stored `key_id` is
  authoritative metadata for rotation and audit.
- Rotation: deploy the new key as primary (old keys retained in the ring),
  then lazily re-encrypt each token on next legitimate use, plus a bounded
  management sweep. Removing a key from the ring is allowed only
  after every row has been re-encrypted off it.
- Encryption/decryption happens in one small server-side helper used only
  by exchange, sync, and disconnect paths; tokens are held in memory only
  for the outgoing Plaid call.

## 5. Opening-balance strategy (the double-counting trap)

Mohr derives balance as `opening_balance + income - expense`. Plaid
provides a **current** balance snapshot plus ~90 days of history. Setting
`opening_balance = plaid_current_balance` **and** importing history counts
that history twice.

Frozen rule: seed the opening balance once, atomically with the commit of
the complete requested history window, using exactly one formula per
account class, and never re-seed it on later syncs.

```text
deposit (checking, savings):
  opening_balance = anchor_provider_current_balance
                  - (imported_posted_income - imported_posted_expense)

credit card (a negative liability in Mohr):
  opening_balance = -anchor_provider_current_balance
                  - (imported_posted_income - imported_posted_expense)
```

Procedure:

1. At link time, capture `anchor_provider_current_balance` from the
   `accounts` array returned by the first `/transactions/sync` response for
   that account (each account carries `balances.current`), write it once
   into the immutable column, and never refresh it; this avoids a separate
   `/accounts/get` call in the single-process service. A resumed
   multi-request initial import must reproduce the same anchor value.
2. Run the initial `/transactions/sync` pages (90-day request) and insert
   posted rows, plus any pending rows imported with `is_pending=true`
   (visible but excluded from balance math, section 4). Compute the anchor
   from posted rows only.
3. In the same database transaction that commits the complete history
   window (step 6), set the linked Mohr account's `opening_balance` per
   the formula above.
4. Later incremental syncs only append deltas; they never touch
   `opening_balance` or `anchor_provider_current_balance`. Only the
   display-only `provider_current_balance` and
   `provider_available_balance` snapshots refresh, for drift diagnosis,
   never the ledger.
5. The anchor is defined per account class. Deposit accounts (checking,
   savings) use the deposit formula above. For credit cards, Plaid's
   `balances.current` is the positive amount owed, while a Mohr
   credit-card balance is a negative liability, so the anchor is
   `-anchor_provider_current_balance` minus net imported income. A credit-card
   charge stays `transaction_type=expense` (budgets and monthly spending
   sum expenses) and makes the balance more negative; a payment is income
   and moves it toward zero. Credit cards use Plaid `current` (what is
   owed) for both the anchor and the display snapshot; `available` is
   display-only.
6. The anchor is applied **only when the requested history window is
   complete**. Plaid's first delivery covers only the most recent 30 days
   (`initial_update_complete=true`); a cursor that reports complete can
   still represent only that window, and calling sync again before the
   full window arrives still returns only the last 30 days. Completion is
   signaled out-of-band by the webhook flag `historical_update_complete
   =true` or, in-band and authoritative when available,
   `transactions_update_status == HISTORICAL_UPDATE_COMPLETE` on the
   `/transactions/sync` response. Until completion, `opening_balance`
   stays untouched (linked account created with `0` and a visible "sync
   pending" state), and `POST .../sync/` returns `202`.
7. Until the anchor has been applied, the linked account and its synced
   transactions are **excluded from every balance, budget, and dashboard
   aggregate**, expressed as `anchor_applied_at IS NULL` per account and
   `transactions_update_status != HISTORICAL_UPDATE_COMPLETE` on the
   connection. The user still sees the imported rows in the transaction
   list, each marked "pending initial import", and the account and
   connection show "sync pending" (section 3); nothing about them is
   counted or spendable yet. The formula is applied exactly once,
   atomically with the final history commit, and never afterwards, even
   when a mutation-during-pagination replay re-applies pages of the same
   update (section 7).

Worked example, ongoing (not just link time): a credit card anchors with
`anchor_provider_current_balance` = 400 and imported posted history of 300
in expense and 50 in income, so `opening_balance = -400 - (50 - 300) =
-150`. Applying the history, the derived balance is `-150 + 50 - 300 =
-400`, matching the provider's owed amount of 400 in magnitude and
opposite in sign. A new charge of 25 then lands; the derived balance
becomes `-150 + 50 - 325 = -425`, matching the provider's new owed amount
of 425 in magnitude and opposite in sign. With the deposit-class formula
instead, that charge would move the balance the wrong way and diverge
permanently.

The anchor is exact for settled history. Because pending rows are excluded
from the anchor and from balance math, a pending transaction that later
posts enters the ledger exactly once when it posts, matching the provider's
settled balance without ever being counted twice.

## 6. Uncategorized categories and override survival

- On first successful sync per user, ensure two provider-owned categories
  exist: `Uncategorized` (income) and `Uncategorized` (expense), reusing
  existing rows with those names/types when present. Provider-owned
  `Uncategorized` rows are not archivable: archive requests for them are
  rejected with `400` validation, and they are never auto-deleted.
  Bringing one back from archived requires an explicit user action, never
  an automatic one.
- Every newly imported transaction defaults to the matching
  `Uncategorized` row.
- `category_customized` flips true whenever the user changes a synced
  row's category through `PATCH /api/transactions/<id>/`; `note_customized`
  flips true on user note edits. These flags are write-once per row from
  the API path (sync never clears them).
- Sync and provider `modified` events update Plaid-owned fields only. They
  must never overwrite `category` when `category_customized` is true, nor
  `note` when `note_customized` is true.
- No sync path ever un-archives a category, and no sync path may ever
  insert a second `Uncategorized` row with the same name and type (v0.1's
  `UniqueConstraint(user, Lower(Trim(name)), category_type)` forbids it).
  If the only same-name/type row is already archived (for example a
  category the user archived before the provider rows existed), the sync
  fails closed with `last_sync_error` and requires an explicit user action
  — un-archive it or rename it — before imports continue; it is never
  silently re-activated. Rows keep pointing at archived categories per
  v0.1 history rules.

## 7. Decimal normalization and `/transactions/sync` protocol

### Normalization

Plaid uses signed amounts where **positive = outflow** and **negative =
inflow**, delivered as JSON floats. Mohr uses positive `Decimal` plus an
`income`/`expense` type. Conversion must never pass through binary float:

1. Serialize the raw Plaid numeric value to its shortest string form
   immediately (`str(value)`), then construct `Decimal` from that string.
2. `plaid_amount > 0` -> `transaction_type=expense`,
   `amount=abs(plaid_amount)`; `plaid_amount < 0` ->
   `transaction_type=income`, `amount=abs(plaid_amount)`.
3. Zero amounts are quarantined by the same rule as step 4 (v0.1
   `amount > 0` holds for synced rows).
4. Quantize to two decimal places (`ROUND_HALF_UP`) and compare against
   the unquantized value; a difference beyond cent precision quarantines
   that single row: record its provider identity and reason in a bounded
   server-side quarantine and log it in redacted form, set
   `last_sync_error`, and continue the sync, advancing the cursor. A
   single unconvertible row never deadlocks a connection, and bank data is
   never silently changed.
5. Dates map from Plaid `date` (posted date; `authorized_date` ignored for
   the ledger date) to Mohr `date`.

### Sync loop

- Use `/transactions/sync` exclusively (cursor-based incremental sync).
  `/transactions/get` (legacy date-range fetch) is forbidden. Initial
  history is fixed at Link time to 90 days (`transactions: {days_requested:
  90}` on `/link/token/create`); the first sync call sends no cursor and
  returns that window.
- No enrichment options are requested (`include_original_description` and
  `include_personal_finance_category` stay off). This is a milestone scope
  decision: every imported transaction maps to `Uncategorized` in this
  milestone, so the provider taxonomy is not consumed yet; it can be
  revisited deliberately in a later slice.
- The in-band completeness signal is `transactions_update_status` with
  values `NOT_READY`, `INITIAL_UPDATE_COMPLETE`, and
  `HISTORICAL_UPDATE_COMPLETE`; it is persisted (section 4) and drives the
  sync-pending state. The first delivered data covers only the most recent
  30 days (`INITIAL_UPDATE_COMPLETE`); the full 90-day window is signaled
  only by `HISTORICAL_UPDATE_COMPLETE`, which also gates the
  opening-balance anchor (section 5). The webhook flag
  `historical_update_complete=true` is the equivalent out-of-band signal.
- While the requested history window is incomplete, or Plaid returns empty
  `added`/`modified` arrays with no data yet, or the initial cursor is
  uncommitted, the connection shows "sync pending" and `POST .../sync/`
  returns `202`.
- Fetch every page (`has_more=true` -> request with returned `next_cursor`).
- Apply `added`, `modified`, and `removed` idempotently per page:
  - `added`: insert unless `plaid_transaction_id` already exists for this
    user (duplicate delivery safe).
  - `modified`: update Plaid-owned fields of the matching row; preserve
    customized category/note; clear or set `is_pending` per provider state.
  - `removed`: set `is_provider_removed=true` on matching rows (idempotent
    when the row is already superseded, and the supersession annotation is
    preserved); never hard delete.
- Pending-to-posted replacement: when an `added` posted transaction
  carries `pending_transaction_id` matching an existing pending row,
  insert the posted row and mark the pending row `is_superseded=true` with
  `superseded_by` set to the posted row in the same transaction, so spend
  is counted exactly once. Plaid separately reports the pending row in
  `removed` (not guaranteed on the same page, but within the same update),
  so the row normally also carries `is_provider_removed=true`; both event
  orders converge to the same final state, and the
  `is_superseded`/`superseded_by` annotation keeps the replacement
  distinguishable from a genuine provider removal.
- `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`: Plaid requires
  restarting the pagination sequence from the cursor held at the start of
  that update, not retrying only the failed request. Restart from that
  cursor; pages already committed during the same update are simply
  re-applied and are idempotent by construction (added is duplicate-safe,
  modified preserves overrides, removed re-sets the same flag). The cursor
  never moves backward past a committed value except by replaying the same
  update, and the section 5 anchor is guarded by `anchor_applied_at IS
  NULL` so it applies at most once even when the update sequence is
  replayed.
- Cursor advance and record changes commit atomically: one
  `transaction.atomic()` block per page writes rows **and** the new cursor
  together. A committed cursor always describes exactly the data in the
  database; a failed page changes nothing.
- Serialize concurrent syncs per Item with `select_for_update()` on the
  `PlaidConnection` row; a second sync attempt sees the lock and returns
  the current status instead of double-applying.
- Cursors are opaque: never synthesize, truncate, or reuse another Item's
  cursor. A lost or inconsistent cursor (for example the row shows null
  after a prior commit, or the cursor cannot be resumed) is an error
  state: sync is blocked, `last_sync_error` is set, and the connection
  requires an explicit repair or relink action. It never silently
  re-requests the 90-day window and never silently re-seeds the anchor,
  because that would lose older provider modifications and removals and
  let balances diverge.

### Render Free single-process constraint

No Celery, Redis, or Kubernetes in this milestone. The design therefore is:

- First sync is synchronous and manual (`POST .../sync/` from the React
  UI), bounded per request (page cap + statement timeout); large initial
  imports return `202` and resume on the next manual trigger via the
  committed cursor.
- Webhooks only flip `sync_due` and append the durable inbox row, then
  attempt a bounded inline sync; anything unfinished converges only
  through a later verified webhook or an explicit manual `POST .../sync/`.
  A GET route may report state (for example a stale-`sync_due`/age
  indicator in `GET /api/plaid/connections/`) but never performs Plaid
  calls, cursor writes, or any mutation. Read-path reconciliation is out
  of scope; if it is ever wanted, it needs a separately specified endpoint
  with its own route, lock, and timeout.

## 8. Webhook verification and endpoint contract

- Endpoint: `POST /api/plaid/webhooks/transactions/`, public
  server-to-server HTTPS (a Plaid callback, not a same-origin browser
  request), **no Django session authentication**, `csrf_exempt` **only**
  because ES256 signature verification replaces browser CSRF protection.
- Handle `TRANSACTIONS` `SYNC_UPDATES_AVAILABLE` (the cursor-poll signal
  for `/transactions/sync`) and `DEFAULT_UPDATE` (a legacy
  `/transactions/get` signal Plaid still delivers for compatibility); both
  only flip `sync_due`. Persist the `initial_update_complete` and
  `historical_update_complete` flags when present to drive the
  sync-pending state of section 7. Ignore unknown codes after logging
  their redacted shape.
- Verification runs **before any mutation**, in this exact order, failing
  closed on the first failure:

  1. Read the exact raw body bytes (`request.body`). Never parse JSON or
     touch `request.POST` first; parsing can normalize whitespace and
     break the hash.
  2. Read the `Plaid-Verification` header as a JWT. Reject when missing,
     malformed, or `alg != ES256` in the header.
  3. Fetch the verification public key by the JWT `kid` via
     `/webhook_verification_key/get`; cache fetched keys by `kid`, fetch
     on an unknown `kid`, and fail closed if the key cannot be retrieved.
  4. Verify the ES256 signature against the raw header/payload.
  5. Check `iat` in both directions: reject when older than 5 minutes
     (small clock-skew allowance only) **and** when `iat` is in the future
     beyond a small allowance of about 60 seconds; enforce `exp` when
     present. This bounds replay windows.
  6. Compute SHA-256 over the exact raw body bytes and compare (constant
     time, e.g. `hmac.compare_digest`) against the
     `request_body_sha256` claim. Mismatch fails closed.
  7. Only then parse the JSON and match `item_id` to a `PlaidConnection`.
     A verified webhook whose `item_id` matches no connection returns
     `200` without persisting an inbox row (or is quarantined only within
     the bounded cap of section 4). A matched event appends the idempotent
     inbox row, flips `sync_due`, and returns `200` within Plaid's
     10-second receiver deadline.

- The endpoint is rate limited (for example 60 requests per minute per
  source IP), and the inbox is bounded per section 4.
- CSRF exemption, source IPs, and secret URL paths are **not**
  authentication. Unverifiable requests mutate nothing, store nothing, and
  return `4xx`.
- After verification, reconcile by cursor (`/transactions/sync`), never by
  trusting webhook payload fields as ledger writes.

## 9. Recovery, lifecycle, and outage states

- Duplicate webhooks: a re-delivered webhook violates the idempotency-key
  `UniqueConstraint` on insert; the handler catches only that exact named
  constraint violation, treats it as an already-processed event, and
  returns `200` without mutating anything. It never surfaces a `500` to
  Plaid.
- Out-of-order/delayed/retried webhooks: harmless, because webhooks only
  set `sync_due`; the cursor is the single source of truth and only moves
  forward inside the atomic page commit. A mutation-during-pagination
  replay re-applies already-committed pages of the same update and never
  moves the cursor backward past a committed value.
- Missing webhooks: covered by manual `POST .../sync/` and by surfacing a
  stale-`sync_due`/age indicator in `GET /api/plaid/connections/`; the next
  verified webhook or manual trigger converges state.
- Slow receiver path: verify first (fast), persist inbox + `sync_due`,
  return `200`, and finish the bounded inline sync if time remains;
  leftovers converge on the next trigger.
- Update mode: provider `ITEM_LOGIN_REQUIRED` (or equivalent Item error)
  flips the connection to `updating`, surfaces "reconnect needed" in the
  connection list, and pauses sync writes; Link update mode reuses the
  existing connection row (same `item_id`, token re-encrypted, cursor
  preserved), then resumes.
- Revoked consent / `ITEM_ERROR` unrecoverable: connection -> `revoked`;
  sync stops; history stays; relink creates or heals per `item_id` match.
- Relink: same `item_id` heals the existing connection (new token,
  preserved cursor and links); new `item_id` is a new connection.
- Disconnect (`POST .../disconnect/`) is local-first: in one transaction,
  null `access_token_encrypted`, mark the connection `disconnected`, and
  set linked Mohr accounts `is_archived=true`; every imported transaction
  is preserved for history. Only after the local teardown succeeds, attempt
  Plaid `/item/remove` as best effort; a failed remote revocation is
  recorded in `last_sync_error` and retried later, but it never traps the
  user in a connected state. Disconnect never hard-deletes financial rows.
- Provider outage: Plaid API errors map to `last_sync_error` + `error`
  status with exponential-backoff manual retry; no cursor is advanced on
  failure, so retry is always safe.

## 10. Data minimization and logging redactions

Store and log the minimum needed to reconcile:

- Store: `item_id`, `plaid_account_id`, `plaid_transaction_id`, type
  mapping, last-4 mask, the immutable anchor balance, display balance
  snapshots, cursor, status fields.
  Never store full account numbers, routing numbers, raw credential
  material, or full provider payloads.
- Never write to logs, analytics, error trackers, or responses: access
  tokens, public tokens, link tokens, Plaid secrets, encryption keys,
  cursors (treat as sensitive), full account numbers, or raw webhook bodies
  containing hashes used for verification.
- Allowed in logs: connection id, `item_id` prefix (first 8 chars max),
  webhook type/code, counts of added/modified/removed, sync duration, and
  error codes without payloads. Verification failures log reason + key id,
  never the body or token.

## 11. Threat table

| Threat | Attack / failure | Contract that stops it |
| --- | --- | --- |
| Cross-user access | Requesting another user's connection, account, or transaction by ID. | Owner-scoped queries + DB uniqueness/constraints; indistinguishable `404` for foreign or missing objects. |
| Token disclosure | Access token leaking via API, bundle, analytics, logs, or error payload. | Server-only encrypted storage; tokens excluded from serializers, responses, bundles, and logs by construction. |
| Webhook forgery | Attacker POSTs fake sync signals to mutate the ledger. | ES256 `Plaid-Verification` check (kid lookup, signature, two-sided `iat`/`exp` bound, constant-time body hash) before any mutation; unverified requests change nothing. |
| Webhook replay | Captured valid webhook re-POSTed later, or a future-dated JWT. | Two-sided `iat`/`exp` bound plus inbox idempotency keys; replayed signals converge to the same cursor with no double-apply. |
| Duplicate/reordered events | Double delivery or out-of-order arrival double-counts spend. | Idempotent `added`/`modified`/`removed` handling; cursor-only forward motion in atomic page commits; per-Item serialization. |
| Cursor loss | Committed cursor diverges from stored rows after a crash. | Cursor and rows commit in one DB transaction; never advance on failure; a lost or inconsistent cursor blocks sync into an explicit repair/relink error state, never a silent 90-day re-request or anchor re-seed. |
| Pending-to-posted duplication | Pending row plus its posted replacement both counted. | `pending_transaction_id` matching marks the pending row `is_superseded` with `superseded_by`; pending, superseded, and provider-removed rows are excluded from balances/budgets/dashboards; both Plaid event orders converge. |
| Double-counted opening balance | Current-balance seed plus imported history counted twice. | Section 5 formula applied exactly once with the complete-history commit; never before history completion, and never re-seeded on later syncs. |
| Provider outage / Item errors | Plaid down, consent revoked, login required. | `error`/`revoked`/`updating` states, `last_sync_error`, safe retry without cursor motion, update-mode relink, disconnect preserving history. |
| Public-token replay / Link abuse | Stolen or replayed `public_token`; unauthenticated Link creation. | Authenticated link-token and exchange endpoints; `client_user_id` plus a user-bound single-use `exchange_handle`; single-use short-lived `public_token` exchanged server-side immediately. |
| Secret leakage via config | Missing/weak encryption or Plaid config silently degrades. | Fail-closed startup and request checks; key-id-tagged key ring; no silent plaintext fallback. |

## 12. Follow-up delivery slices (drafts for GitHub issues)

### Slice 1: Secure configuration, encryption, and persistence foundation

- Add `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`,
  `PLAID_TOKEN_KEYS` settings with fail-closed validation (no plaintext
  fallback).
- Add the Fernet key-ring helper with key-id-tagged encrypt/decrypt and
  rotation support; unit-test rotation (old key decrypts, new key
  encrypts) covering both the key-id-resolved path and the
  trial-decryption fallback for an unresolvable key id.
- Decide and record the full deletion graph (`PlaidConnection.user` versus
  `Transaction.connection` RESTRICT) before writing the migration, and
  verify it with the repository migration workflow so v0.1 user deletion
  behavior does not change by accident.
- Create migrations for `PlaidConnection`, `PlaidAccountLink`, and
  `PlaidWebhookEvent` plus Transaction provider columns, the immutable
  `anchor_provider_current_balance` column, the `anchor_applied_at` gate,
  the `is_superseded` / `superseded_by` audit state, and constraints.
- Acceptance: migrations apply cleanly; token round-trip and rotation
  tests pass on both decryption paths; the deletion-graph decision is
  recorded and verified; no secret appears in any response, log, or bundle
  fixture.

### Slice 2: Authenticated Link token creation and public-token exchange

- Implement `POST /api/plaid/link-token/` and `POST
  /api/plaid/exchange/` per section 3, session-authenticated and CSRF
  protected.
- Exchange persists the encrypted token + `item_id` and returns only the
  safe connection shape.
- Acceptance: unauthenticated requests get `401`; cross-user connection
  IDs get `404`; exchange never returns tokens; exchange rejects a
  missing, consumed, expired, or foreign `exchange_handle` without leaking
  which check failed; Sandbox Link completes end-to-end manually.

### Slice 3: Account import and idempotent transaction synchronization

- Implement type mapping (section 4), the section 5 opening-balance
  formula per account class, the immutable anchor capture
  (`anchor_provider_current_balance`), the in-band history-completeness
  gate on the anchor (`transactions_update_status ==
  HISTORICAL_UPDATE_COMPLETE`; the webhook `historical_update_complete`
  flag belongs to slice 4 only), Decimal normalization with
  quarantine-and-continue for unconvertible rows, and the section 7 sync
  loop against `/transactions/sync` with mocked Plaid responses.
- Enforce the synced-row API rules: `PATCH` limited to category and note
  for `source=plaid`, and `DELETE` on a `source=plaid` row rejected with
  `400` (section 3).
- Exclude not-yet-anchored linked accounts and their synced rows from
  balances, budgets, and dashboard aggregates while keeping the rows
  visible in transaction lists marked "pending initial import"
  (sections 4 and 5).
- Cover added/modified/removed, `is_superseded` replacement,
  mutation-during-pagination restart with at-most-once anchor application,
  atomic cursor commit, per-Item serialization, and override-preserving
  updates.
- Acceptance: full mocked suite green (success, invalid input, auth,
  cross-user, missing objects, DB side effects); double-run sync applies
  zero net change; pending and superseded rows never affect balances; the
  anchor is never applied before history completion and is applied at most
  once when an update is replayed; a resumed multi-request initial import
  produces the same anchor; a `DELETE` on a synced row returns `400` and
  deletes nothing; unanchored accounts contribute nothing to balances,
  budgets, or the dashboard while their rows still list as "pending
  initial import"; a single unconvertible row quarantines without
  deadlocking the sync; a credit-card worked test proves a new charge
  makes the derived balance more negative and matches the provider's owed
  amount in magnitude and opposite in sign.

### Slice 4: Verified webhook, update-mode, relink, and disconnect lifecycle

- Implement the public webhook endpoint with the exact section 8
  verification order, the durable inbox with bounded retention, `sync_due`
  handling, the webhook `historical_update_complete` flag (the in-band
  `transactions_update_status` gate belongs to slice 3 only),
  duplicate-insert constraint translation, update mode, relink,
  local-first disconnect with best-effort `/item/remove` and account
  archiving, and outage/error states.
- Acceptance: forged, future-dated, replayed, duplicated, reordered, and
  missing webhook cases covered by tests; duplicate deliveries raise the
  exact idempotency-key constraint violation, are treated as already
  processed, and still return `200`; unverifiable requests mutate nothing;
  verified events with no matching connection store no unbounded row;
  disconnect archives accounts, clears the stored token locally even when
  `/item/remove` fails, and preserves history.

### Slice 5: React connection-management UI and Sandbox end-to-end verification

- Build connect/reconnect/disconnect UI with Plaid Link, connection list
  with status and sync-pending state, manual sync trigger, pending,
  "pending initial import", synced, and manual visual distinction, and
  stale-sync indicators.
- Acceptance: Sandbox end-to-end (connect -> import -> webhook/manual sync
  -> disconnect) verified; no token material in bundles or browser
  storage; responsive and consistent with the one-accent minimal design.
