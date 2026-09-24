import { describe, expect, it } from 'vitest'
import {
  groupByMonth,
  isSettledRow,
  summarizeTransactions,
  type LedgerRow,
} from './ledger'
import { formatMonthLabel } from './month'

function row(overrides: Partial<LedgerRow>): LedgerRow {
  return {
    account: 1,
    amount: '0.00',
    date: '2026-09-15',
    transaction_type: 'expense',
    is_pending: false,
    is_pending_initial_import: false,
    ...overrides,
  }
}

describe('isSettledRow', () => {
  it('is settled only when both pending flags are false', () => {
    expect(
      isSettledRow(
        row({ is_pending: false, is_pending_initial_import: false }),
        new Set(),
      ),
    ).toBe(true)
    expect(
      isSettledRow(row({ is_pending: true, is_pending_initial_import: false }), new Set()),
    ).toBe(false)
    expect(
      isSettledRow(row({ is_pending: false, is_pending_initial_import: true }), new Set()),
    ).toBe(false)
    expect(
      isSettledRow(row({ is_pending: true, is_pending_initial_import: true }), new Set()),
    ).toBe(false)
  })

  it('is unsettled when its account is still importing history even with clear row flags', () => {
    expect(isSettledRow(row({ account: 2 }), new Set([2]))).toBe(false)
    expect(isSettledRow(row({ account: 1 }), new Set([2]))).toBe(true)
  })
})

describe('summarizeTransactions', () => {
  it('returns an empty summary for an empty array', () => {
    expect(summarizeTransactions([], new Set())).toEqual({
      shown: 0,
      settled: 0,
      moneyIn: '0.00',
      moneyOut: '0.00',
    })
  })

  it('counts shown for every row but settled only for settled rows', () => {
    const rows = [
      row({ is_pending: true }),
      row({ is_pending_initial_import: true }),
      row({}),
      row({}),
    ]
    const summary = summarizeTransactions(rows, new Set())
    expect(summary.shown).toBe(4)
    expect(summary.settled).toBe(2)
  })

  it('excludes a pending row from money figures but includes it in shown', () => {
    const rows = [
      row({ amount: '10.00', transaction_type: 'income', is_pending: true }),
      row({ amount: '20.00', transaction_type: 'income' }),
    ]
    const summary = summarizeTransactions(rows, new Set())
    expect(summary.shown).toBe(2)
    expect(summary.settled).toBe(1)
    expect(summary.moneyIn).toBe('20.00')
    expect(summary.moneyOut).toBe('0.00')
  })

  it('excludes a still-importing row from money figures the same way', () => {
    const rows = [
      row({ amount: '30.00', transaction_type: 'expense', is_pending_initial_import: true }),
      row({ amount: '40.00', transaction_type: 'expense' }),
    ]
    const summary = summarizeTransactions(rows, new Set())
    expect(summary.shown).toBe(2)
    expect(summary.settled).toBe(1)
    expect(summary.moneyIn).toBe('0.00')
    expect(summary.moneyOut).toBe('40.00')
  })

  it('excludes rows on sync-pending accounts from money figures while keeping them in shown', () => {
    const rows = [
      row({ account: 1, amount: '100.00', transaction_type: 'income' }),
      row({ account: 2, amount: '50.00', transaction_type: 'expense' }),
      row({ account: 2, amount: '25.00', transaction_type: 'income' }),
    ]
    const summary = summarizeTransactions(rows, new Set([2]))
    expect(summary.shown).toBe(3)
    expect(summary.settled).toBe(1)
    expect(summary.moneyIn).toBe('100.00')
    expect(summary.moneyOut).toBe('0.00')
  })

  it('splits income and expense by transaction type with exact strings', () => {
    const rows = [
      row({ amount: '1234.56', transaction_type: 'income' }),
      row({ amount: '77.70', transaction_type: 'expense' }),
      row({ amount: '0.01', transaction_type: 'income' }),
      row({ amount: '8.00', transaction_type: 'expense' }),
    ]
    const summary = summarizeTransactions(rows, new Set())
    expect(summary.moneyIn).toBe('1234.57')
    expect(summary.moneyOut).toBe('85.70')
  })

  it('sums exact cents without floating-point drift, including very large values', () => {
    const rows = [
      row({ amount: '0.01', transaction_type: 'expense' }),
      row({ amount: '0.01', transaction_type: 'expense' }),
      row({ amount: '0.01', transaction_type: 'expense' }),
    ]
    expect(summarizeTransactions(rows, new Set()).moneyOut).toBe('0.03')

    const large = [
      row({ amount: '19999876543.20', transaction_type: 'income' }),
      row({ amount: '0.10', transaction_type: 'income' }),
      row({ amount: '0.20', transaction_type: 'income' }),
    ]
    expect(summarizeTransactions(large, new Set()).moneyIn).toBe('19999876543.50')
  })

  it('returns 0.00 money figures when every row is unsettled', () => {
    const rows = [
      row({ amount: '50.00', transaction_type: 'income', is_pending: true }),
      row({ amount: '60.00', transaction_type: 'expense', is_pending_initial_import: true }),
    ]
    expect(summarizeTransactions(rows, new Set())).toEqual({
      shown: 2,
      settled: 0,
      moneyIn: '0.00',
      moneyOut: '0.00',
    })
  })

  it('does not mutate a frozen input array', () => {
    const rows = Object.freeze([
      row({ amount: '5.00', transaction_type: 'income' }),
      row({ amount: '3.00', transaction_type: 'expense', is_pending: true }),
    ])
    expect(() => summarizeTransactions(rows, new Set())).not.toThrow()
    expect(summarizeTransactions(rows, new Set()).moneyIn).toBe('5.00')
  })
})

describe('groupByMonth', () => {
  it('returns an empty array for an empty input', () => {
    expect(groupByMonth([])).toEqual([])
  })

  it('splits consecutive runs into groups in input order', () => {
    const rows = [
      row({ date: '2026-09-15' }),
      row({ date: '2026-09-02' }),
      row({ date: '2026-08-30' }),
    ]
    const groups = groupByMonth(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0].month).toBe('2026-09')
    expect(groups[0].rows).toEqual([rows[0], rows[1]])
    expect(groups[1].month).toBe('2026-08')
    expect(groups[1].rows).toEqual([rows[2]])
  })

  it('never merges non-adjacent runs of the same month', () => {
    const rows = [
      row({ date: '2026-09-15' }),
      row({ date: '2026-08-30' }),
      row({ date: '2026-09-01' }),
    ]
    const groups = groupByMonth(rows)
    expect(groups).toHaveLength(3)
    expect(groups.map((group) => group.month)).toEqual(['2026-09', '2026-08', '2026-09'])
    expect(groups[0].rows).toEqual([rows[0]])
    expect(groups[1].rows).toEqual([rows[1]])
    expect(groups[2].rows).toEqual([rows[2]])
  })

  it('keeps the raw YYYY-MM key and stays label-compatible with formatMonthLabel', () => {
    const rows = [row({ date: '2026-09-15' })]
    const groups = groupByMonth(rows)
    expect(groups[0].month).toBe('2026-09')
    expect(formatMonthLabel(groups[0].month)).toBe('September 2026')
  })

  it('does not mutate a frozen input array', () => {
    const rows = Object.freeze([
      row({ date: '2026-09-15' }),
      row({ date: '2026-08-30' }),
    ])
    expect(() => groupByMonth(rows)).not.toThrow()
    expect(groupByMonth(rows)).toHaveLength(2)
  })
})
