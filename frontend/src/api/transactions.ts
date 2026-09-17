import { getCsrfToken } from './auth'
import { apiFetch, decodeNoContent } from './client'
import { ApiError } from './types'

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'
const INVALID_TRANSACTION_ID_MESSAGE = 'Invalid transaction id.'
const INVALID_FILTER_MESSAGE = 'Invalid transaction filters.'

export type TransactionType = 'income' | 'expense'

export interface Transaction {
  id: number
  account: number
  category: number
  transaction_type: TransactionType
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

export interface TransactionFilters {
  account?: number
  category?: number
  transaction_type?: TransactionType
  start_date?: string
  end_date?: string
}

export interface TransactionInput {
  account: number
  category: number
  transaction_type: TransactionType
  amount: string
  date: string
  note: string
}

export interface TransactionPatch {
  account?: number
  category?: number
  transaction_type?: TransactionType
  amount?: string
  date?: string
  note?: string
}

// Mirrors backend/transactions/serializers.py TransactionSerializer.Meta.fields.
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

const TRANSACTION_TYPES: ReadonlySet<string> = new Set(['income', 'expense'])
const TRANSACTION_SOURCES: ReadonlySet<string> = new Set(['manual', 'plaid'])

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/
const POSITIVE_AMOUNT_PATTERN = /^\d+\.\d{2}$/
const ZERO_AMOUNT_PATTERN = /^0+\.00$/

const FILTER_KEYS = [
  'account',
  'category',
  'transaction_type',
  'start_date',
  'end_date',
] as const

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

function isStrictPositiveAmount(value: unknown): value is string {
  if (typeof value !== 'string' || !POSITIVE_AMOUNT_PATTERN.test(value)) {
    return false
  }
  if (ZERO_AMOUNT_PATTERN.test(value)) return false
  return value.length - 1 <= 12
}

function parseTransaction(value: unknown): Transaction | null {
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
  if (
    typeof transaction_type !== 'string' ||
    !TRANSACTION_TYPES.has(transaction_type)
  ) {
    return null
  }
  if (!isStrictPositiveAmount(amount)) return null
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
    transaction_type: transaction_type as TransactionType,
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

function parseTransactions(payload: unknown, status: number): Transaction[] {
  const malformed = () =>
    new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  if (status !== 200) throw malformed()
  if (!Array.isArray(payload)) throw malformed()
  const transactions: Transaction[] = []
  for (const item of payload) {
    const transaction = parseTransaction(item)
    if (transaction === null) throw malformed()
    transactions.push(transaction)
  }
  return transactions
}

function buildTransactionQuery(filters: TransactionFilters): string {
  const params = new URLSearchParams()
  const invalid = () =>
    new ApiError(INVALID_FILTER_MESSAGE, null, null, {})
  for (const key of FILTER_KEYS) {
    const value = filters[key]
    if (value === undefined || value === '') continue
    if (key === 'account' || key === 'category') {
      if (!isPositiveInteger(value)) throw invalid()
      params.append(key, String(value))
    } else if (key === 'transaction_type') {
      if (typeof value !== 'string' || !TRANSACTION_TYPES.has(value)) {
        throw invalid()
      }
      params.append(key, value)
    } else if (key === 'start_date' || key === 'end_date') {
      if (!isCalendarDate(value)) throw invalid()
      params.append(key, value)
    }
  }
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

const inFlightTransactions = new Map<string, Promise<Transaction[]>>()

function requestTransactions(query: string): Promise<Transaction[]> {
  const path = query === '' ? '/api/transactions/' : `/api/transactions/${query}`
  return apiFetch(path, {}, parseTransactions)
}

export async function fetchTransactions(
  filters: TransactionFilters = {},
): Promise<Transaction[]> {
  const query = buildTransactionQuery(filters)
  let request = inFlightTransactions.get(query)
  if (request === undefined) {
    request = requestTransactions(query).finally(() => {
      inFlightTransactions.delete(query)
    })
    inFlightTransactions.set(query, request)
  }
  return request
}

export function resetTransactionsRequest(): void {
  inFlightTransactions.clear()
}

function parseTransactionWithStatus(
  expectedStatus: number,
): (payload: unknown, status: number) => Transaction {
  return (payload, status) => {
    if (status !== expectedStatus) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const transaction = parseTransaction(payload)
    if (transaction === null) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return transaction
  }
}

function parseUpdatedTransaction(
  transactionId: number,
): (payload: unknown, status: number) => Transaction {
  return (payload, status) => {
    if (status !== 200) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const transaction = parseTransaction(payload)
    if (transaction === null || transaction.id !== transactionId) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return transaction
  }
}

function assertValidTransactionId(transactionId: number): void {
  if (!isPositiveInteger(transactionId)) {
    throw new ApiError(INVALID_TRANSACTION_ID_MESSAGE, null, null, {})
  }
}

export async function createTransaction(
  input: TransactionInput,
): Promise<Transaction> {
  const token = await getCsrfToken()
  const body = JSON.stringify({
    account: input.account,
    category: input.category,
    transaction_type: input.transaction_type,
    amount: input.amount,
    date: input.date,
    note: input.note,
  })
  return apiFetch(
    '/api/transactions/',
    { method: 'POST', headers: { 'X-CSRFToken': token }, body },
    parseTransactionWithStatus(201),
  )
}

export async function updateTransaction(
  transactionId: number,
  patch: TransactionPatch,
): Promise<Transaction> {
  assertValidTransactionId(transactionId)
  const body: Record<string, unknown> = {}
  if (patch.account !== undefined) body.account = patch.account
  if (patch.category !== undefined) body.category = patch.category
  if (patch.transaction_type !== undefined) {
    body.transaction_type = patch.transaction_type
  }
  if (patch.amount !== undefined) body.amount = patch.amount
  if (patch.date !== undefined) body.date = patch.date
  if (patch.note !== undefined) body.note = patch.note
  const token = await getCsrfToken()
  return apiFetch(
    `/api/transactions/${transactionId}/`,
    {
      method: 'PATCH',
      headers: { 'X-CSRFToken': token },
      body: JSON.stringify(body),
    },
    parseUpdatedTransaction(transactionId),
  )
}

export async function deleteTransaction(transactionId: number): Promise<void> {
  assertValidTransactionId(transactionId)
  const token = await getCsrfToken()
  await apiFetch(
    `/api/transactions/${transactionId}/`,
    { method: 'DELETE', headers: { 'X-CSRFToken': token } },
    decodeNoContent,
  )
}
