import { isDecimalString } from '../format/money'
import { getCsrfToken } from './auth'
import { apiFetch, decodeNoContent } from './client'
import { ApiError } from './types'

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'
const INVALID_ACCOUNT_ID_MESSAGE = 'Invalid account id.'

export type AccountType = 'checking' | 'savings' | 'cash' | 'credit_card'

export interface Account {
  id: number
  name: string
  account_type: AccountType
  opening_balance: string
  current_balance: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

export interface AccountPatch {
  name?: string
  account_type?: AccountType
  opening_balance?: string
}

const ACCOUNT_KEYS = [
  'id',
  'name',
  'account_type',
  'opening_balance',
  'current_balance',
  'is_archived',
  'created_at',
  'updated_at',
] as const

const ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  'checking',
  'savings',
  'cash',
  'credit_card',
])

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

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

export function parseAccount(value: unknown): Account | null {
  if (!isRecord(value) || !hasExactKeys(value, ACCOUNT_KEYS)) return null
  const {
    id,
    name,
    account_type,
    opening_balance,
    current_balance,
    is_archived,
    created_at,
    updated_at,
  } = value
  if (!isPositiveInteger(id)) return null
  if (typeof name !== 'string' || name.length === 0 || name.length > 100) {
    return null
  }
  if (name.trim().length === 0) return null
  if (typeof account_type !== 'string' || !ACCOUNT_TYPES.has(account_type)) {
    return null
  }
  if (!isDecimalString(opening_balance)) return null
  if (!isDecimalString(current_balance)) return null
  if (typeof is_archived !== 'boolean') return null
  if (!isTimestamp(created_at) || !isTimestamp(updated_at)) return null
  return {
    id,
    name,
    account_type: account_type as AccountType,
    opening_balance,
    current_balance,
    is_archived,
    created_at,
    updated_at,
  }
}

export function parseAccounts(payload: unknown, status: number): Account[] {
  const malformed = () =>
    new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  if (status !== 200) throw malformed()
  if (!Array.isArray(payload)) throw malformed()
  const accounts: Account[] = []
  for (const item of payload) {
    const account = parseAccount(item)
    if (account === null) throw malformed()
    accounts.push(account)
  }
  return accounts
}

let inFlightAccounts: Promise<Account[]> | null = null

function requestAccounts(): Promise<Account[]> {
  return apiFetch('/api/accounts/', {}, parseAccounts)
}

export function fetchAccounts(): Promise<Account[]> {
  if (inFlightAccounts === null) {
    inFlightAccounts = requestAccounts().finally(() => {
      inFlightAccounts = null
    })
  }
  return inFlightAccounts
}

function parseAccountWithStatus(
  expectedStatus: number,
): (payload: unknown, status: number) => Account {
  return (payload, status) => {
    if (status !== expectedStatus) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const account = parseAccount(payload)
    if (account === null) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return account
  }
}

function parseUpdatedAccount(
  accountId: number,
): (payload: unknown, status: number) => Account {
  return (payload, status) => {
    if (status !== 200) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const account = parseAccount(payload)
    if (account === null || account.id !== accountId) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return account
  }
}

function assertValidAccountId(accountId: number): void {
  if (!isPositiveInteger(accountId)) {
    throw new ApiError(INVALID_ACCOUNT_ID_MESSAGE, null, null, {})
  }
}

export async function createAccount(
  name: string,
  accountType: AccountType,
  openingBalance: string,
): Promise<Account> {
  const token = await getCsrfToken()
  const body = JSON.stringify({
    name,
    account_type: accountType,
    opening_balance: openingBalance,
  })
  return apiFetch(
    '/api/accounts/',
    { method: 'POST', headers: { 'X-CSRFToken': token }, body },
    parseAccountWithStatus(201),
  )
}

export async function updateAccount(
  accountId: number,
  patch: AccountPatch,
): Promise<Account> {
  assertValidAccountId(accountId)
  const body: Record<string, string> = {}
  if (patch.name !== undefined) body.name = patch.name
  if (patch.account_type !== undefined) body.account_type = patch.account_type
  if (patch.opening_balance !== undefined) {
    body.opening_balance = patch.opening_balance
  }
  const token = await getCsrfToken()
  return apiFetch(
    `/api/accounts/${accountId}/`,
    {
      method: 'PATCH',
      headers: { 'X-CSRFToken': token },
      body: JSON.stringify(body),
    },
    parseUpdatedAccount(accountId),
  )
}

export async function archiveAccount(accountId: number): Promise<void> {
  assertValidAccountId(accountId)
  const token = await getCsrfToken()
  await apiFetch(
    `/api/accounts/${accountId}/`,
    { method: 'DELETE', headers: { 'X-CSRFToken': token } },
    decodeNoContent,
  )
}

export function resetAccountsRequest(): void {
  inFlightAccounts = null
}
