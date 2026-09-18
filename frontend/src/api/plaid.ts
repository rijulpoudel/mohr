import { type AccountType } from './accounts'
import { getCsrfToken } from './auth'
import { apiFetch } from './client'
import { ApiError } from './types'

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'
const INVALID_PUBLIC_TOKEN_MESSAGE = 'Invalid public token.'
const INVALID_EXCHANGE_HANDLE_MESSAGE = 'Invalid exchange handle.'
const INVALID_CONNECTION_ID_MESSAGE = 'Invalid connection id.'

const PUBLIC_TOKEN_MAX_LENGTH = 200
const LINK_TOKEN_MAX_LENGTH = 8192
const INSTITUTION_NAME_MAX_LENGTH = 200
const ACCOUNT_NAME_MAX_LENGTH = 100
const MASK_MAX_LENGTH = 4
const EXCHANGE_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/

export type PlaidConnectionStatus =
  | 'active'
  | 'updating'
  | 'error'
  | 'revoked'
  | 'disconnected'

export interface PlaidLinkedAccount {
  id: number
  name: string
  account_type: AccountType
  mask: string
  sync_pending: boolean
}

export interface PlaidConnection {
  id: number
  institution_name: string
  status: PlaidConnectionStatus
  sync_pending: boolean
  last_synced_at: string | null
  linked_accounts: PlaidLinkedAccount[]
}

export interface PlaidConnectionSummary {
  id: number
  institution_name: string
  status: PlaidConnectionStatus
  linked_accounts: PlaidLinkedAccount[]
}

export interface PlaidLinkToken {
  link_token: string
  expiration: string
  exchange_handle: string
}

export interface PlaidUpdateLinkToken {
  link_token: string
  expiration: string
}

export interface PlaidExchangeResult {
  connection: PlaidConnectionSummary
}

export interface PlaidSyncResult {
  connection_id: number
  status: PlaidConnectionStatus
  added: number
  modified: number
  removed: number
}

export interface PlaidSyncProcessing {
  connection_id: number
  status: 'processing'
}

export interface PlaidDisconnectResult {
  connection_id: number
  status: 'disconnected'
}

export interface PlaidUpdateCompleteResult {
  connection_id: number
  status: 'active'
  sync_pending: true
}

const CONNECTION_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'updating',
  'error',
  'revoked',
  'disconnected',
])

const ACCOUNT_TYPES: ReadonlySet<string> = new Set([
  'checking',
  'savings',
  'cash',
  'credit_card',
])

const LINK_TOKEN_KEYS = ['link_token', 'expiration', 'exchange_handle'] as const
const UPDATE_LINK_TOKEN_KEYS = ['link_token', 'expiration'] as const
const EXCHANGE_KEYS = ['connection'] as const
const CONNECTION_KEYS = [
  'id',
  'institution_name',
  'status',
  'sync_pending',
  'last_synced_at',
  'linked_accounts',
] as const
const CONNECTION_SUMMARY_KEYS = [
  'id',
  'institution_name',
  'status',
  'linked_accounts',
] as const
const LINKED_ACCOUNT_KEYS = [
  'id',
  'name',
  'account_type',
  'mask',
  'sync_pending',
] as const
const SYNC_RESULT_KEYS = [
  'connection_id',
  'status',
  'added',
  'modified',
  'removed',
] as const
const SYNC_PROCESSING_KEYS = ['connection_id', 'status'] as const
const DISCONNECT_KEYS = ['connection_id', 'status'] as const
const UPDATE_COMPLETE_KEYS = ['connection_id', 'status', 'sync_pending'] as const

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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedNonemptyString(
  value: unknown,
  maxLength: number,
): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
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

function parseLinkedAccount(value: unknown): PlaidLinkedAccount | null {
  if (!isRecord(value) || !hasExactKeys(value, LINKED_ACCOUNT_KEYS)) return null
  const { id, name, account_type, mask, sync_pending } = value
  if (!isPositiveInteger(id)) return null
  if (!isBoundedNonemptyString(name, ACCOUNT_NAME_MAX_LENGTH)) return null
  if (name.trim().length === 0) return null
  if (typeof account_type !== 'string' || !ACCOUNT_TYPES.has(account_type)) {
    return null
  }
  if (typeof mask !== 'string' || mask.length > MASK_MAX_LENGTH) return null
  if (typeof sync_pending !== 'boolean') return null
  return {
    id,
    name,
    account_type: account_type as AccountType,
    mask,
    sync_pending,
  }
}

function parseLinkedAccounts(value: unknown): PlaidLinkedAccount[] | null {
  if (!Array.isArray(value)) return null
  const accounts: PlaidLinkedAccount[] = []
  for (const item of value) {
    const account = parseLinkedAccount(item)
    if (account === null) return null
    accounts.push(account)
  }
  return accounts
}

function parseConnectionSummary(value: unknown): PlaidConnectionSummary | null {
  if (!isRecord(value) || !hasExactKeys(value, CONNECTION_SUMMARY_KEYS)) {
    return null
  }
  const { id, institution_name, status, linked_accounts } = value
  if (!isPositiveInteger(id)) return null
  if (!isBoundedNonemptyString(institution_name, INSTITUTION_NAME_MAX_LENGTH)) {
    return null
  }
  if (institution_name.trim().length === 0) return null
  if (typeof status !== 'string' || !CONNECTION_STATUSES.has(status)) return null
  const parsedAccounts = parseLinkedAccounts(linked_accounts)
  if (parsedAccounts === null) return null
  return {
    id,
    institution_name,
    status: status as PlaidConnectionStatus,
    linked_accounts: parsedAccounts,
  }
}

function parseConnection(value: unknown): PlaidConnection | null {
  if (!isRecord(value) || !hasExactKeys(value, CONNECTION_KEYS)) return null
  const {
    id,
    institution_name,
    status,
    sync_pending,
    last_synced_at,
    linked_accounts,
  } = value
  if (!isPositiveInteger(id)) return null
  if (!isBoundedNonemptyString(institution_name, INSTITUTION_NAME_MAX_LENGTH)) {
    return null
  }
  if (institution_name.trim().length === 0) return null
  if (typeof status !== 'string' || !CONNECTION_STATUSES.has(status)) return null
  if (typeof sync_pending !== 'boolean') return null
  if (last_synced_at !== null && !isTimestamp(last_synced_at)) return null
  const parsedAccounts = parseLinkedAccounts(linked_accounts)
  if (parsedAccounts === null) return null
  return {
    id,
    institution_name,
    status: status as PlaidConnectionStatus,
    sync_pending,
    last_synced_at: last_synced_at as string | null,
    linked_accounts: parsedAccounts,
  }
}

function parseLinkToken(payload: unknown, status: number): PlaidLinkToken {
  if (status !== 200) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  if (!isRecord(payload) || !hasExactKeys(payload, LINK_TOKEN_KEYS)) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  const { link_token, expiration, exchange_handle } = payload
  if (!isBoundedNonemptyString(link_token, LINK_TOKEN_MAX_LENGTH)) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  if (!isTimestamp(expiration)) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  if (
    typeof exchange_handle !== 'string' ||
    !EXCHANGE_HANDLE_PATTERN.test(exchange_handle)
  ) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  return { link_token, expiration, exchange_handle }
}

function parseUpdateLinkToken(
  payload: unknown,
  status: number,
): PlaidUpdateLinkToken {
  if (status !== 200) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  if (!isRecord(payload) || !hasExactKeys(payload, UPDATE_LINK_TOKEN_KEYS)) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  const { link_token, expiration } = payload
  if (!isBoundedNonemptyString(link_token, LINK_TOKEN_MAX_LENGTH)) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  if (!isTimestamp(expiration)) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  return { link_token, expiration }
}

function parseExchangeResult(payload: unknown, status: number): PlaidExchangeResult {
  if (status !== 201 && status !== 200) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  if (!isRecord(payload) || !hasExactKeys(payload, EXCHANGE_KEYS)) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  const summary = parseConnectionSummary(payload.connection)
  if (summary === null || summary.linked_accounts.length !== 0) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  return { connection: summary }
}

function parseConnections(payload: unknown, status: number): PlaidConnection[] {
  if (status !== 200) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  if (!Array.isArray(payload)) {
    throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  }
  const connections: PlaidConnection[] = []
  for (const item of payload) {
    const connection = parseConnection(item)
    if (connection === null) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    connections.push(connection)
  }
  return connections
}

function parseSyncResult(
  expectedConnectionId: number,
): (payload: unknown, status: number) => PlaidSyncResult | PlaidSyncProcessing {
  return (payload, status) => {
    if (status !== 200 && status !== 202) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (!isRecord(payload)) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const keys = status === 200 ? SYNC_RESULT_KEYS : SYNC_PROCESSING_KEYS
    if (!hasExactKeys(payload, keys)) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (
      !isPositiveInteger(payload.connection_id) ||
      payload.connection_id !== expectedConnectionId
    ) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (status === 202) {
      if (payload.status !== 'processing') {
        throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
      }
      return { connection_id: payload.connection_id, status: 'processing' }
    }
    const { status: connectionStatus, added, modified, removed } = payload
    if (
      typeof connectionStatus !== 'string' ||
      !CONNECTION_STATUSES.has(connectionStatus)
    ) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (
      !isNonNegativeInteger(added) ||
      !isNonNegativeInteger(modified) ||
      !isNonNegativeInteger(removed)
    ) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return {
      connection_id: payload.connection_id,
      status: connectionStatus as PlaidConnectionStatus,
      added,
      modified,
      removed,
    }
  }
}

function parseDisconnectResult(
  expectedConnectionId: number,
): (payload: unknown, status: number) => PlaidDisconnectResult {
  return (payload, status) => {
    if (status !== 200) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (!isRecord(payload) || !hasExactKeys(payload, DISCONNECT_KEYS)) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (
      !isPositiveInteger(payload.connection_id) ||
      payload.connection_id !== expectedConnectionId
    ) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (payload.status !== 'disconnected') {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return { connection_id: payload.connection_id, status: 'disconnected' }
  }
}

function parseUpdateCompleteResult(
  expectedConnectionId: number,
): (payload: unknown, status: number) => PlaidUpdateCompleteResult {
  return (payload, status) => {
    if (status !== 200) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (!isRecord(payload) || !hasExactKeys(payload, UPDATE_COMPLETE_KEYS)) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (
      !isPositiveInteger(payload.connection_id) ||
      payload.connection_id !== expectedConnectionId
    ) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (payload.status !== 'active') {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    if (payload.sync_pending !== true) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return {
      connection_id: payload.connection_id,
      status: 'active',
      sync_pending: true,
    }
  }
}

function assertValidConnectionId(connectionId: number): void {
  if (!isPositiveInteger(connectionId)) {
    throw new ApiError(INVALID_CONNECTION_ID_MESSAGE, null, null, {})
  }
}

export async function createPlaidLinkToken(): Promise<PlaidLinkToken> {
  const token = await getCsrfToken()
  return apiFetch(
    '/api/plaid/link-token/',
    { method: 'POST', headers: { 'X-CSRFToken': token } },
    parseLinkToken,
  )
}

export async function exchangePlaidPublicToken(
  publicToken: string,
  exchangeHandle: string,
): Promise<PlaidExchangeResult> {
  if (
    !isBoundedNonemptyString(publicToken, PUBLIC_TOKEN_MAX_LENGTH) ||
    publicToken.trim().length === 0
  ) {
    throw new ApiError(INVALID_PUBLIC_TOKEN_MESSAGE, null, null, {})
  }
  if (
    typeof exchangeHandle !== 'string' ||
    !EXCHANGE_HANDLE_PATTERN.test(exchangeHandle)
  ) {
    throw new ApiError(INVALID_EXCHANGE_HANDLE_MESSAGE, null, null, {})
  }
  const token = await getCsrfToken()
  const body = JSON.stringify({
    public_token: publicToken,
    exchange_handle: exchangeHandle,
  })
  return apiFetch(
    '/api/plaid/exchange/',
    { method: 'POST', headers: { 'X-CSRFToken': token }, body },
    parseExchangeResult,
  )
}

let inFlightConnections: Promise<PlaidConnection[]> | null = null

function requestConnections(): Promise<PlaidConnection[]> {
  return apiFetch('/api/plaid/connections/', {}, parseConnections)
}

export function fetchPlaidConnections(): Promise<PlaidConnection[]> {
  if (inFlightConnections === null) {
    const request = requestConnections().finally(() => {
      if (inFlightConnections === request) {
        inFlightConnections = null
      }
    })
    inFlightConnections = request
  }
  return inFlightConnections
}

export function resetPlaidConnectionsRequest(): void {
  inFlightConnections = null
}

export async function createPlaidUpdateLinkToken(
  connectionId: number,
): Promise<PlaidUpdateLinkToken> {
  assertValidConnectionId(connectionId)
  const token = await getCsrfToken()
  return apiFetch(
    `/api/plaid/connections/${connectionId}/link-token/`,
    { method: 'POST', headers: { 'X-CSRFToken': token } },
    parseUpdateLinkToken,
  )
}

export async function syncPlaidConnection(
  connectionId: number,
): Promise<PlaidSyncResult | PlaidSyncProcessing> {
  assertValidConnectionId(connectionId)
  const token = await getCsrfToken()
  return apiFetch(
    `/api/plaid/connections/${connectionId}/sync/`,
    { method: 'POST', headers: { 'X-CSRFToken': token } },
    parseSyncResult(connectionId),
  )
}

export async function disconnectPlaidConnection(
  connectionId: number,
): Promise<PlaidDisconnectResult> {
  assertValidConnectionId(connectionId)
  const token = await getCsrfToken()
  return apiFetch(
    `/api/plaid/connections/${connectionId}/disconnect/`,
    { method: 'POST', headers: { 'X-CSRFToken': token } },
    parseDisconnectResult(connectionId),
  )
}

export async function completePlaidUpdate(
  connectionId: number,
): Promise<PlaidUpdateCompleteResult> {
  assertValidConnectionId(connectionId)
  const token = await getCsrfToken()
  return apiFetch(
    `/api/plaid/connections/${connectionId}/update-complete/`,
    { method: 'POST', headers: { 'X-CSRFToken': token } },
    parseUpdateCompleteResult(connectionId),
  )
}