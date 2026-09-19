import { isDecimalString } from '../format/money'
import { apiFetch } from './client'
import { ApiError } from './types'

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'

export type DashboardTransactionType = 'income' | 'expense'

export interface DashboardTransaction {
  id: number
  account: number
  category: number
  transaction_type: DashboardTransactionType
  amount: string
  date: string
  note: string
  source: 'manual' | 'plaid'
  provider_name: string
  is_pending: boolean
  is_pending_initial_import: boolean
  created_at: string
  updated_at: string
}

export interface DashboardSummary {
  total_balance: string
  current_month_income: string
  current_month_expenses: string
  total_budgeted: string
  remaining_budget: string
  recent_transactions: DashboardTransaction[]
}

const SUMMARY_KEYS = [
  'total_balance',
  'current_month_income',
  'current_month_expenses',
  'total_budgeted',
  'remaining_budget',
  'recent_transactions',
] as const

// Mirrors backend/transactions/serializers.py TransactionSerializer.Meta.fields,
// which dashboard/serializers.py reuses for recent_transactions.
const TRANSACTION_KEYS = [
  'id',
  'account',
  'category',
  'transaction_type',
  'amount',
  'date',
  'note',
  'source',
  'provider_name',
  'is_pending',
  'is_pending_initial_import',
  'created_at',
  'updated_at',
] as const

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const POSITIVE_DECIMAL_PATTERN = /^(?!0+\.0+$)\d+\.\d{2}$/
const TRANSACTION_SOURCES: ReadonlySet<string> = new Set(['manual', 'plaid'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const present = Object.keys(record)
  if (present.length !== keys.length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false
  if (!isCalendarDate(value.slice(0, 10))) return false
  return !isNaN(new Date(value).getTime())
}

function parseTransaction(value: unknown): DashboardTransaction | null {
  if (!isRecord(value) || !hasExactKeys(value, TRANSACTION_KEYS)) return null
  const {
    id,
    account,
    category,
    transaction_type,
    amount,
    date,
    note,
    source,
    provider_name,
    is_pending,
    is_pending_initial_import,
    created_at,
    updated_at,
  } = value
  if (!isPositiveInteger(id)) return null
  if (!isPositiveInteger(account)) return null
  if (!isPositiveInteger(category)) return null
  if (transaction_type !== 'income' && transaction_type !== 'expense') {
    return null
  }
  if (!isDecimalString(amount) || !POSITIVE_DECIMAL_PATTERN.test(amount)) {
    return null
  }
  if (!isCalendarDate(date)) return null
  if (typeof note !== 'string') return null
  if (typeof source !== 'string' || !TRANSACTION_SOURCES.has(source)) return null
  if (typeof provider_name !== 'string' || provider_name.length > 200) {
    return null
  }
  if (typeof is_pending !== 'boolean') return null
  if (typeof is_pending_initial_import !== 'boolean') return null
  if (source === 'manual' && (provider_name !== '' || is_pending !== false)) {
    return null
  }
  if (is_pending_initial_import && source !== 'plaid') return null
  if (!isTimestamp(created_at) || !isTimestamp(updated_at)) return null
  return {
    id,
    account,
    category,
    transaction_type,
    amount,
    date,
    note,
    source: source as 'manual' | 'plaid',
    provider_name,
    is_pending,
    is_pending_initial_import,
    created_at,
    updated_at,
  }
}

export function parseDashboardSummary(
  payload: unknown,
  status: number,
): DashboardSummary {
  const malformed = () =>
    new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  if (status !== 200) throw malformed()
  if (!isRecord(payload) || !hasExactKeys(payload, SUMMARY_KEYS)) {
    throw malformed()
  }
  const {
    total_balance,
    current_month_income,
    current_month_expenses,
    total_budgeted,
    remaining_budget,
    recent_transactions,
  } = payload
  if (
    !isDecimalString(total_balance) ||
    !isDecimalString(current_month_income) ||
    !isDecimalString(current_month_expenses) ||
    !isDecimalString(total_budgeted) ||
    !isDecimalString(remaining_budget)
  ) {
    throw malformed()
  }
  if (!Array.isArray(recent_transactions)) throw malformed()
  if (recent_transactions.length > 5) throw malformed()
  const transactions: DashboardTransaction[] = []
  for (const item of recent_transactions) {
    const transaction = parseTransaction(item)
    if (transaction === null) throw malformed()
    transactions.push(transaction)
  }
  return {
    total_balance,
    current_month_income,
    current_month_expenses,
    total_budgeted,
    remaining_budget,
    recent_transactions: transactions,
  }
}

let inFlightDashboard: Promise<DashboardSummary> | null = null

function requestDashboardSummary(): Promise<DashboardSummary> {
  return apiFetch('/api/dashboard/summary/', {}, parseDashboardSummary)
}

export function fetchDashboardSummary(): Promise<DashboardSummary> {
  if (inFlightDashboard === null) {
    const request = requestDashboardSummary().finally(() => {
      if (inFlightDashboard === request) {
        inFlightDashboard = null
      }
    })
    inFlightDashboard = request
  }
  return inFlightDashboard
}

export function resetDashboardRequest(): void {
  inFlightDashboard = null
}
