import { getCsrfToken } from './auth'
import { apiFetch, decodeNoContent } from './client'
import { ApiError } from './types'

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'
const INVALID_BUDGET_ID_MESSAGE = 'Invalid budget id.'

export interface Budget {
  id: number
  category: number
  month: string
  budgeted: string
  spent: string
  remaining: string
  created_at: string
  updated_at: string
}

export interface BudgetInput {
  category: number
  month: string
  budgeted: string
}

export interface BudgetPatch {
  category?: number
  month?: string
  budgeted?: string
}

const BUDGET_KEYS = [
  'id',
  'category',
  'month',
  'budgeted',
  'spent',
  'remaining',
  'created_at',
  'updated_at',
] as const

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const POSITIVE_AMOUNT_PATTERN = /^\d+\.\d{2}$/
const SIGNED_AMOUNT_PATTERN = /^-?\d+\.\d{2}$/
const ZERO_AMOUNT_PATTERN = /^0+\.00$/

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

function isFirstDayOfMonth(value: unknown): value is string {
  if (!isCalendarDate(value)) return false
  return value.slice(8, 10) === '01'
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false
  if (!isCalendarDate(value.slice(0, 10))) return false
  return !isNaN(new Date(value).getTime())
}

function isStrictPositiveAmount(value: unknown): value is string {
  if (typeof value !== 'string' || !POSITIVE_AMOUNT_PATTERN.test(value)) {
    return false
  }
  if (ZERO_AMOUNT_PATTERN.test(value)) return false
  return value.length - 1 <= 12
}

function isComputedAmount(value: unknown): value is string {
  if (typeof value !== 'string' || !SIGNED_AMOUNT_PATTERN.test(value)) {
    return false
  }
  return true
}

function parseBudget(value: unknown): Budget | null {
  if (!isRecord(value) || !hasExactKeys(value, BUDGET_KEYS)) return null
  const {
    id,
    category,
    month,
    budgeted,
    spent,
    remaining,
    created_at,
    updated_at,
  } = value
  if (!isPositiveInteger(id)) return null
  if (!isPositiveInteger(category)) return null
  if (!isFirstDayOfMonth(month)) return null
  if (!isStrictPositiveAmount(budgeted)) return null
  if (!isComputedAmount(spent)) return null
  if (!isComputedAmount(remaining)) return null
  if (!isTimestamp(created_at) || !isTimestamp(updated_at)) return null
  return {
    id,
    category,
    month,
    budgeted,
    spent,
    remaining,
    created_at,
    updated_at,
  }
}

function parseBudgets(payload: unknown, status: number): Budget[] {
  const malformed = () =>
    new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  if (status !== 200) throw malformed()
  if (!Array.isArray(payload)) throw malformed()
  const budgets: Budget[] = []
  for (const item of payload) {
    const budget = parseBudget(item)
    if (budget === null) throw malformed()
    budgets.push(budget)
  }
  return budgets
}

const inFlightBudgets = new Map<string, Promise<Budget[]>>()

function requestBudgets(): Promise<Budget[]> {
  return apiFetch('/api/budgets/', {}, parseBudgets)
}

export function fetchBudgets(): Promise<Budget[]> {
  const key = '/api/budgets/'
  let request = inFlightBudgets.get(key)
  if (request === undefined) {
    request = requestBudgets().finally(() => {
      if (inFlightBudgets.get(key) === request) {
        inFlightBudgets.delete(key)
      }
    })
    inFlightBudgets.set(key, request)
  }
  return request
}

export function resetBudgetsRequest(): void {
  inFlightBudgets.clear()
}

function parseBudgetWithStatus(
  expectedStatus: number,
): (payload: unknown, status: number) => Budget {
  return (payload, status) => {
    if (status !== expectedStatus) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const budget = parseBudget(payload)
    if (budget === null) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return budget
  }
}

function parseUpdatedBudget(
  budgetId: number,
): (payload: unknown, status: number) => Budget {
  return (payload, status) => {
    if (status !== 200) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const budget = parseBudget(payload)
    if (budget === null || budget.id !== budgetId) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return budget
  }
}

function assertValidBudgetId(budgetId: number): void {
  if (!isPositiveInteger(budgetId)) {
    throw new ApiError(INVALID_BUDGET_ID_MESSAGE, null, null, {})
  }
}

export async function createBudget(input: BudgetInput): Promise<Budget> {
  const token = await getCsrfToken()
  const body = JSON.stringify({
    category: input.category,
    month: input.month,
    budgeted: input.budgeted,
  })
  return apiFetch(
    '/api/budgets/',
    { method: 'POST', headers: { 'X-CSRFToken': token }, body },
    parseBudgetWithStatus(201),
  )
}

export async function updateBudget(
  budgetId: number,
  patch: BudgetPatch,
): Promise<Budget> {
  assertValidBudgetId(budgetId)
  const body: Record<string, unknown> = {}
  if (patch.category !== undefined) body.category = patch.category
  if (patch.month !== undefined) body.month = patch.month
  if (patch.budgeted !== undefined) body.budgeted = patch.budgeted
  const token = await getCsrfToken()
  return apiFetch(
    `/api/budgets/${budgetId}/`,
    {
      method: 'PATCH',
      headers: { 'X-CSRFToken': token },
      body: JSON.stringify(body),
    },
    parseUpdatedBudget(budgetId),
  )
}

export async function deleteBudget(budgetId: number): Promise<void> {
  assertValidBudgetId(budgetId)
  const token = await getCsrfToken()
  await apiFetch(
    `/api/budgets/${budgetId}/`,
    { method: 'DELETE', headers: { 'X-CSRFToken': token } },
    decodeNoContent,
  )
}
