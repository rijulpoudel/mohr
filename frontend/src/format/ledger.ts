import { sumMoney } from './money'

export interface LedgerRow {
  amount: string
  date: string
  transaction_type: 'income' | 'expense'
  is_pending: boolean
  is_pending_initial_import: boolean
}

// Pending rows have not settled, so counting their money would mislead.
// This mirrors the backend ledger rule for the two flags the list route
// exposes; provider-removed and superseded rows are already hidden upstream.
export function isSettledRow(row: LedgerRow): boolean {
  return !row.is_pending && !row.is_pending_initial_import
}

export interface TransactionSummary {
  shown: number
  settled: number
  moneyIn: string
  moneyOut: string
}

export function summarizeTransactions(rows: readonly LedgerRow[]): TransactionSummary {
  const settledRows = rows.filter(isSettledRow)
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