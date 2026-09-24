import { sumMoney } from './money'

export interface LedgerRow {
  account: number
  amount: string
  date: string
  transaction_type: 'income' | 'expense'
  is_pending: boolean
  is_pending_initial_import: boolean
}

// Pending rows have not settled, and neither have rows on an account whose
// Plaid anchor is still pending, so counting their money would mislead.
// This mirrors the backend ledger rule: provider-removed and superseded rows
// are already hidden upstream, and the backend ledger query excludes every
// row on an account with anchor_applied_at IS NULL (exposed to the frontend
// as Account.sync_pending), even when the row's own flags are clear.
export function isSettledRow(
  row: LedgerRow,
  syncPendingAccountIds: ReadonlySet<number>,
): boolean {
  if (row.is_pending || row.is_pending_initial_import) return false
  return !syncPendingAccountIds.has(row.account)
}

export interface TransactionSummary {
  shown: number
  settled: number
  moneyIn: string
  moneyOut: string
}

export function summarizeTransactions(
  rows: readonly LedgerRow[],
  syncPendingAccountIds: ReadonlySet<number>,
): TransactionSummary {
  const settledRows = rows.filter((row) => isSettledRow(row, syncPendingAccountIds))
  return {
    shown: rows.length,
    settled: settledRows.length,
    moneyIn: sumMoney(
      settledRows
        .filter((row) => row.transaction_type === 'income')
        .map((row) => row.amount),
    ),
    moneyOut: sumMoney(
      settledRows
        .filter((row) => row.transaction_type === 'expense')
        .map((row) => row.amount),
    ),
  }
}

export interface MonthGroup<T extends LedgerRow = LedgerRow> {
  month: string
  rows: T[]
}

// The API parser guarantees `date` is a strict YYYY-MM-DD calendar date,
// so the first seven characters are always a valid YYYY-MM key. Trust the
// field rather than re-validating what the API layer already checked.
export function groupByMonth<T extends LedgerRow>(rows: readonly T[]): MonthGroup<T>[] {
  const groups: MonthGroup<T>[] = []
  for (const row of rows) {
    const month = row.date.slice(0, 7)
    const last = groups[groups.length - 1]
    // Consecutive runs only: the rows keep input order, and splitting a run
    // apart to merge the same month elsewhere would reorder them.
    if (last !== undefined && last.month === month) {
      last.rows.push(row)
    } else {
      groups.push({ month, rows: [row] })
    }
  }
  return groups
}
