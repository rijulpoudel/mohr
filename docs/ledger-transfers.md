# Ledger classification: transfers, card payments, and refunds (contract)

Status: roadmap Q02 proposed contract, documentation only. It changes no
schema, API response, UI, or money calculation. The first implementation
slice is Q03, a separate reviewed issue. Nothing here defines or implies a
safe-to-spend amount.

- Scope: the meaning Mohr assigns to financial activity it already records,
  for both manual and Plaid-synced rows.
- Not scope: Plaid's Transfer/money-movement product (already excluded in
  `docs/plaid.md`); Mohr initiates no real bank transfer in Q02 or Q03.
- References: `docs/plaid.md` sections 5 and 7; Plaid Transactions data
  <https://plaid.com/docs/transactions/transactions-data/> and the
  Transactions API <https://plaid.com/docs/api/products/transactions/>.

Plaid reports a signed amount where positive means money out and negative
means money in, delivered as a JSON number. Pending-to-posted delivers a
removed pending row and a newly added posted row that may land on a
different page; the posted row carries `pending_transaction_id` /
`plaid_pending_transaction_id`. That field links the pending and posted
versions of the SAME leg. It is supersession, not a transfer-leg pairing
key: Mohr does not store an authenticated cross-leg key, so both manual and
Plaid legs require an explicit user marking before Mohr excludes them from
income and spending. Q03 does not verify or link counterpart legs. Mohr
never infers a meaning from a provider display name.

## 1. Two orthogonal axes

Mohr separates two questions the current model conflates.

1. **Account direction** (ledger sign): does this row put money into or take
   money out of one owned account? This is the only input to an account
   balance. Today it is `transaction_type`: `income` = inflow, `expense` =
   outflow. Plaid normalization maps positive -> `expense` and negative ->
   `income` (`docs/plaid.md` section 7).
2. **Semantic classification** (reporting meaning): is this row earning,
   spending, an internal transfer, or a refund? This drives income,
   spending, budgets, and Cash Flow. It never changes an account balance.

The axes are independent. A transfer leg has a real direction (it moves one
account) but is neither earning nor spending. A classification that does not
change direction therefore cannot move a balance and cannot disturb the
section 5 opening-balance anchor (section 5).

## 2. What each lens counts

| Lens | Rows counted (classification-dependent, see note) |
| --- | --- |
| Account `current_balance`, total balance | every countable ledger row, by account direction (`+inflow -outflow`); never affected by classification |
| Dashboard `current_month_income`, Cash Flow `income` | rows classified earning |
| Dashboard `current_month_expenses`, Cash Flow `expenses` | rows classified spending, minus refund rows once refund subtraction ships (section 3) |
| Cash Flow `net` | `income - (spending - refunds)` |
| Budget `spent` | rows classified spending in the same category and month, minus refunds (later slice) |

Until classification ships, and for every unclassified row, the default
derives from account direction: an inflow is earning and an outflow is
spending. That reproduces today's totals exactly. Refund subtraction is
contract for a later slice, not Q03 (sections 3 and 8).

`ledger_transactions_q()` (`backend/transactions/selectors.py:7`) currently
gates both the balance path and every reporting path. Q03 must split the
reporting filter from the balance filter: classification enters the
reporting lenses only, never `account_ledger_annotations` or
`Account.current_balance` (section 5).

## 3. Classification rules

- **Owned-account transfer (user-confirmed).** Two same-user legs: an
  outflow on the source and an inflow on the destination, equal in amount
  and both classification `transfer`. Both move balances; neither is earning
  or spending; no budget or Cash Flow effect.
- **Credit-card payment (user-confirmed).** Payer account (checking or
  savings) outflow and card inflow toward zero, both classification
  `transfer`. It is neither spending nor earning and is not a merchant
  purchase.
- **Credit-card purchase.** Card outflow, classification `spending`; it is
  real expense and budget spend and makes the card liability more negative.
- **Refund.** Contract for a later slice, not Q03 (section 8). A
  user-confirmed posted inflow refund reduces spending in its expense
  category and never adds earned income. An unconfirmed inflow defaults to
  income from its direction and is NOT recognized as a refund on Mohr's
  behalf. The refund posts in its own calendar month; Mohr never rewrites
  the original purchase month, so negative monthly spend and negative budget
  spend may result. That is a provisional product choice that needs Q01
  validation. Manual refund representation stays open for the later slice;
  Q03 implements neither refund subtraction nor refund UI.
- **Single leg / unverified counterpart.** An unclassified row defaults from
  account direction (inflow earning, outflow spending), so it moves its account
  balance and keeps today's totals. A missing counterpart alone NEVER
  excludes a row. Only a user-confirmed transfer (an explicit user action)
  excludes it from earning and spending; a confirmed leg remains visibly
  unverified until a later pairing feature can establish its counterpart,
  while an ordinary purchase remains spending. Mohr never guesses a
  classification from a display name or amount, and does no heuristic
  name/amount pairing.
- **Pending, posted, and duplicates.** In Q03 a classification edit is
  allowed only on a settled posted row; pending classification edits are
  rejected, so an edit is not lost when the posted row replaces the pending
  one. Duplicate sync and provider modification must preserve a confirmed
  classification, keyed by the existing provider id and ownership.
  Provider-removed and superseded rows are already excluded and stay
  audit-only; a classification replayed by sync is idempotent and counts
  once.

## 4. Cents-exact worked examples

All values are exact two-place decimals.

### A. Both legs: checking -> savings 250.00

- Checking outflow 250.00 (`expense`, `transfer`); savings inflow 250.00
  (`income`, `transfer`).
- Balances: checking -250.00, savings +250.00; combined unchanged.
- Dashboard income 0.00, expenses 0.00; Cash Flow net 0.00; budget spend
  0.00.
- Without classification the same two rows report income 250.00 and
  expenses 250.00 — both inflated, net still 0.

### B. Card purchase then payment

Checking opening 1000.00; credit card opening -400.00.

- 2026-09-05 purchase 25.00 on the card (`expense`, `spending`): card
  -425.00, September expenses 25.00, budget spend 25.00.
- 2026-09-20 payment 425.00 from checking (`expense` checking, `income`
  card, both `transfer`): checking 575.00, card 0.00.
- September income 0.00, expenses 25.00, Cash Flow net -25.00. The payment
  adds neither income nor expense.

### C. One leg only / unmatched

Plaid delivers only the checking outflow of 100.00 and no owned counterpart.
Unclassified, it defaults from direction to spending: checking moves
-100.00 and September expenses and budget spend are 100.00, matching today's
totals. The missing counterpart alone does not exclude it. Only when the user
explicitly confirms it as a transfer leg is it excluded from spending and
labeled as a user-confirmed transfer with an unverified counterpart; the
balance is unchanged. If a counterpart later arrives and the user marks that
leg too, both account balances still move, while neither leg counts as
income or spending. Q03 does not claim the legs have been verified as a pair.

### D. Crossing a month boundary

Payment initiated 2026-09-30 from checking; the card credit posts
2026-10-01.

- September: checking outflow 425.00 `transfer`; September income and
  expense 0.00.
- October: card inflow 425.00 `transfer`; October income and expense 0.00.
- Transfers may cross month boundaries. Each month reports only its own
  leg's date. Between the legs the combined balance is temporarily
  understated by 425.00 until the second leg lands;
  that window is inherent to two-leg settlement, is surfaced for review, and
  is never double counted.

### E. Duplicate sync / replay

The posted card payment is delivered twice, or a page is replayed after
`TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`. The provider-id unique
constraint and the shared ledger predicate yield one countable row, so
balances and reports match a single delivery. Classification is idempotent.

### F. Pending then posted

A pending card purchase 25.00 is `is_pending` and excluded, so the card stays
-400.00. When it posts, the pending row is `is_superseded` and the posted row
enters once, giving card -425.00. A pending row cannot be classified, so no
user edit is lost when the posted row replaces it. A confirmed classification
on a posted row must survive later sync modifications and replays.
`pending_transaction_id` links the
posted row to the superseded pending row of the SAME leg even when the two
rows arrive on different pages; it is supersession, not transfer-leg
pairing.

### G. Cross-user isolation

Provider sync operates on the connection owner, not on `request.user`. Both
legs of a confirmed transfer must belong to the same user. A counterpart on
another user's account is never matched. Per repo rules, a foreign detail id
returns `404` and a foreign writable relation returns `400`. Existing
baseline totals are unaffected by a failed pairing, not literally zero.
Matching queries stay scoped to the owner; the correlated `Exists` in
`ledger_transactions_q()` is the anchor/readiness gate, not a pairing
mechanism.

### H. Mixed manual and Plaid accounts

Checking is Plaid-linked; the destination is a manual cash account. The
Plaid leg imports as a 250.00 outflow and the user records the manual
250.00 inflow as `transfer`.

- Balances: -250.00 / +250.00; reports 0.00 / 0.00.
- The Plaid account's section 5 anchor is unchanged because it sums that
  account's own direction rows, not classification (section 5).
- If the user instead records an expense to "balance" the transfer, spending
  inflates by 250.00; the contract requires that manual row be `transfer`,
  not `spending`.

## 5. Anchor interaction (do not silently change balance math)

`docs/plaid.md` section 5 seeds each linked account's `opening_balance` once
from `anchor_provider_current_balance` and that account's own posted
`income - expense` (`backend/plaid_integration/services.py:1321`). The
formula reads account direction, not classification.

Consequences:

- Classification must be additive and reporting-only. The stored direction
  (Plaid positive -> `expense`, negative -> `income`) and the anchor formula
  stay exactly as they are, so a classified transfer still reconciles to the
  provider's settled balance.
- Q03 must not rewrite a historical row's stored direction, and no data
  migration may reclassify history. Doing so would silently shift
  `opening_balance` away from the immutable anchor. If Mohr ever wants
  classification to change balance math, that is a separate issue with a
  migration that first re-derives and preserves every
  `anchor_provider_current_balance` and `anchor_applied_at` invariant in the
  same atomic commit. No silent migration.
- A new classification field may be nullable or fall back to a
  direction-derived value for legacy rows, so no money is reinterpreted and
  no historical meaning is backfilled. If implementation adopts the field,
  it is a new schema migration.
- Disconnect, archiving, and retained history keep working because they
  already preserve the anchor and the rows.

## 6. Q03: smallest validated implementation slice

Goal: the section 2 reporting lenses are correct for user-confirmed
transfers and card payments with no balance, anchor, ownership, or
provider-normalization change. Refund subtraction and automatic pairing are
deferred to a later slice.

- Add a row-level semantic classification whose default derives from
  `transaction_type` (`income` -> earning, `expense` -> spending), so every
  existing row and all v0.1/v0.2 behavior is unchanged. The field may be
  nullable or fall back to the direction-derived value for legacy rows, so
  no money is reinterpreted and no historical meaning is backfilled; if
  adopted, it is a new schema migration (section 5).
- Add the classification filter to the reporting queries only:
  `backend/dashboard/selectors.py`, `backend/budgets/selectors.py`, and the
  Cash Flow path. Leave `backend/accounts/selectors.py` and
  `Account.current_balance` untouched. Refund subtraction is not part of
  Q03.
- Classify only user-confirmed transfers and card payments. Both manual and
  Plaid legs require an explicit user marking; `pending_transaction_id`
  handles supersession, not pairing, and Mohr stores no authenticated
  cross-leg key. Never infer from provider display names or amounts.
- Accept classification edits only on settled posted rows and reject pending
  classification edits, so an edit is not lost when posted replaces pending.
  Duplicate sync and provider modification preserve a confirmed
  classification, keyed by the existing provider id and ownership.
- Include classification in reads and let the user mark or confirm a settled
  transfer via the existing PATCH route and a simple UI affordance; no new
  endpoint family, no Plaid Transfer product, and no refund UI.
- Write the RED tests first, implement, then run the full suite
  (`uv run python manage.py test`) and confirm the discovered test count.

Discriminating tests (each must fail if classification is ignored):

1. Two-leg transfer: both balances move; Dashboard income, expenses, Cash
   Flow net, and budget spend are all 0.00.
2. Card purchase plus payment: expenses equal the purchase only; the payment
   is neither income nor expense; the card ends at 0.00.
3. Single leg: the balance moves and the row still defaults to spending or
   earning by direction; only a user-confirmed transfer excludes it, with a
   visible warning that its counterpart has not been verified.
4. Month-boundary split legs: no double count; each month reflects only its
   own leg.
5. Duplicate provider delivery and mutation-during-pagination replay: counts
   identical to one delivery, and a confirmed classification is preserved.
6. Pending classification edit rejected; posted counted exactly once through
   supersession; a confirmed posted classification survives later sync updates.
7. Cross-user counterpart: `404` / `400` per repo rules; no pairing; neither
   user's totals move.
8. Mixed manual/Plaid two-leg transfer: two explicitly marked legs; reports 0.00.
9. Anchor preserved: the credit-card worked example still matches provider
   owed in magnitude and opposite sign after classification.
10. Regression: existing manual income/expense, Dashboard, Cash Flow, and
    budget numbers are unchanged.

Refund-specific tests, and any automatic pairing, belong to the later refund
slice, not Q03.

## 7. Existing parser and UI ramifications

- `transaction_type` stays exactly `income | expense`; classification is a
  separate field. The frontend parsers enforce exact response key sets
  (`frontend/src/api/transactions.ts` `TRANSACTION_KEYS`,
  `frontend/src/api/dashboard.ts` `TRANSACTION_KEYS`) and reject unknown
  keys, so adding a backend response field requires a coordinated parser
  update inside Q03.
- `frontend/src/api/dashboard.ts` rejects any `transaction_type` other than
  income/expense (`dashboard.test.ts` expects a `transfer` type to be
  rejected), and `frontend/src/format/ledger.ts` splits income and expense
  by that field. A new `transaction_type` value would break both; a
  separate classification field does not.
- Cash Flow and budget screens render API totals, so once the backend
  reporting filters change they reflect classification with no new UI
  arithmetic.

## 8. Non-goals and unresolved choices

- No safe-to-spend amount is defined, stored, or implied in this contract or
  in Q03.
- Classification is not Plaid's money-movement Transfer product; no transfer
  is initiated with a bank.
- Q03 does not implement refund subtraction or refund UI. The refund
  semantics in section 3 are contract for a later slice and depend on Q01
  validating the provisional choice to post a confirmed refund in its own
  calendar month rather than rewriting the original purchase month.
- Q03 defers automatic pairing. A user-confirmed transfer or card payment is
  the only thing that excludes a row from earning and spending.
- Unresolved, for the later refund slice or a follow-up: how a manual refund
  is represented under the positive-amount constraint; the exact transfer
  confirmation control in the UI; the minimal storage shape (row flag versus
  explicit link); and whether provider transfer/category data will ever be
  consumed (currently off).
