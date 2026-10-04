import { getCsrfToken } from './auth'
import { apiFetch } from './client'
import { ApiError } from './types'

export type GoogleIntent = 'sign-in' | 'link'

export interface GoogleConfig {
  enabled: boolean
  linked: boolean
}

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'
const GOOGLE_AUTHORIZATION_ORIGIN = 'https://accounts.google.com'
const GOOGLE_AUTHORIZATION_PATH = '/o/oauth2/v2/auth'

const GOOGLE_CONFIG_KEYS = ['enabled', 'linked'] as const
const AUTHORIZATION_URL_KEYS = ['authorization_url'] as const

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

export function parseGoogleConfig(
  payload: unknown,
  status: number,
): GoogleConfig {
  const malformed = () =>
    new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  if (status !== 200) throw malformed()
  if (!isRecord(payload) || !hasExactKeys(payload, GOOGLE_CONFIG_KEYS)) {
    throw malformed()
  }
  if (
    typeof payload.enabled !== 'boolean' ||
    typeof payload.linked !== 'boolean'
  ) {
    throw malformed()
  }
  return { enabled: payload.enabled, linked: payload.linked }
}

export function isTrustedGoogleAuthorizationUrl(
  value: unknown,
): value is string {
  if (typeof value !== 'string') return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.origin === GOOGLE_AUTHORIZATION_ORIGIN &&
    parsed.pathname === GOOGLE_AUTHORIZATION_PATH &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.hash === ''
  )
}

export function fetchGoogleConfig(): Promise<GoogleConfig> {
  return apiFetch('/api/auth/google/config/', {}, parseGoogleConfig)
}

function parseAuthorizationUrl(payload: unknown, status: number): string {
  const malformed = () =>
    new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  if (status !== 200) throw malformed()
  if (!isRecord(payload) || !hasExactKeys(payload, AUTHORIZATION_URL_KEYS)) {
    throw malformed()
  }
  const value = payload.authorization_url
  if (!isTrustedGoogleAuthorizationUrl(value)) throw malformed()
  return value
}

export async function startGoogleAuthorization(
  intent: GoogleIntent,
  next: string,
): Promise<string> {
  const token = await getCsrfToken()
  return apiFetch(
    '/api/auth/google/start/',
    {
      method: 'POST',
      headers: { 'X-CSRFToken': token },
      body: JSON.stringify({ intent, next }),
    },
    parseAuthorizationUrl,
  )
}
