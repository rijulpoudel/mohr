// Shared month-key validator reused from the budget module.
import { isValidBudgetMonth } from '../format/month'
import { isDecimalString } from '../format/money'
import { apiFetch } from './client'
import { ApiError } from './types'

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'
const INVALID_MONTH_MESSAGE = 'Invalid month.'

export interface CashFlowCategory {
  category_id: number
  category_name: string
  amount: string
  transaction_count: number
}

export interface CashFlowSummary {
  month: string
  income: string
  expenses: string
  net: string
  transaction_count: number
  income_categories: CashFlowCategory[]
  expense_categories: CashFlowCategory[]
}

const SUMMARY_KEYS = [
  'month',
  'income',
  'expenses',
  'net',
  'transaction_count',
  'income_categories',
  'expense_categories',
] as const

// Mirrors dashboard/serializers.py CashFlowCategorySerializer.Meta fields.
const CATEGORY_KEYS = [
  'category_id',
  'category_name',
  'amount',
  'transaction_count',
] as const

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isMonthEcho(value: unknown): value is string {
  return typeof value === 'string' && MONTH_PATTERN.test(value)
}

function isNonNegativeDecimalString(value: unknown): value is string {
  return isDecimalString(value) && !value.startsWith('-')
}

function parseCategory(value: unknown): CashFlowCategory | null {
  if (!isRecord(value) || !hasExactKeys(value, CATEGORY_KEYS)) return null
  const { category_id, category_name, amount, transaction_count } = value
  if (!isPositiveInteger(category_id)) return null
  if (typeof category_name !== 'string' || category_name.length === 0) {
    return null
  }
  if (category_name.length > 100) return null
  if (category_name.trim().length === 0) return null
  if (!isNonNegativeDecimalString(amount)) return null
  if (!isNonNegativeInteger(transaction_count)) return null
  return {
    category_id,
    category_name,
    amount,
    transaction_count,
  }
}

function parseCategoryList(value: unknown): CashFlowCategory[] | null {
  if (!Array.isArray(value)) return null
  const categories: CashFlowCategory[] = []
  for (const item of value) {
    const category = parseCategory(item)
    if (category === null) return null
    categories.push(category)
  }
  return categories
}

export function parseCashFlowSummary(
  payload: unknown,
  status: number,
  requestedMonth: string,
): CashFlowSummary {
  const malformed = () =>
    new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  if (status !== 200) throw malformed()
  if (!isRecord(payload) || !hasExactKeys(payload, SUMMARY_KEYS)) {
    throw malformed()
  }
  const {
    month,
    income,
    expenses,
    net,
    transaction_count,
    income_categories,
    expense_categories,
  } = payload
  if (!isMonthEcho(month) || month !== requestedMonth) throw malformed()
  if (!isNonNegativeDecimalString(income)) throw malformed()
  if (!isNonNegativeDecimalString(expenses)) throw malformed()
  if (!isDecimalString(net)) throw malformed()
  if (!isNonNegativeInteger(transaction_count)) throw malformed()
  const parsedIncomeCategories = parseCategoryList(income_categories)
  if (parsedIncomeCategories === null) throw malformed()
  const parsedExpenseCategories = parseCategoryList(expense_categories)
  if (parsedExpenseCategories === null) throw malformed()
  return {
    month,
    income,
    expenses,
    net,
    transaction_count,
    income_categories: parsedIncomeCategories,
    expense_categories: parsedExpenseCategories,
  }
}

const inFlightCashFlow = new Map<string, Promise<CashFlowSummary>>()

function requestCashFlowSummary(month: string): Promise<CashFlowSummary> {
  return apiFetch(
    `/api/cash-flow/summary/?month=${month}`,
    {},
    (payload, status) => parseCashFlowSummary(payload, status, month),
  )
}

export async function fetchCashFlowSummary(
  month: string,
): Promise<CashFlowSummary> {
  if (!isValidBudgetMonth(month)) {
    throw new ApiError(INVALID_MONTH_MESSAGE, null, null, {})
  }
  const pending = inFlightCashFlow.get(month)
  if (pending !== undefined) return pending
  const created = requestCashFlowSummary(month).finally(() => {
    if (inFlightCashFlow.get(month) === created) {
      inFlightCashFlow.delete(month)
    }
  })
  inFlightCashFlow.set(month, created)
  return created
}

export function resetCashFlowRequest(): void {
  inFlightCashFlow.clear()
}