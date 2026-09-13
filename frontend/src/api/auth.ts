import { apiFetch, decodeNoContent, readCsrfToken } from './client'
import { ApiError, parseUser, type User } from './types'

const MISSING_CSRF_MESSAGE = 'Missing CSRF token.'

let inFlightRestore: Promise<User> | null = null

function requestRestore(): Promise<User> {
  return apiFetch('/api/auth/me/', {}, parseUser)
}

export function restoreSession(): Promise<User> {
  if (inFlightRestore === null) {
    const request = requestRestore()
    inFlightRestore = request.finally(() => {
      inFlightRestore = null
    })
  }
  return inFlightRestore
}

export function resetRestoreRequest(): void {
  inFlightRestore = null
}

export async function getCsrfToken(): Promise<string> {
  await apiFetch('/api/auth/csrf/', { method: 'GET' })
  const token = readCsrfToken(document.cookie)
  if (token === null || token === '') {
    throw new ApiError(MISSING_CSRF_MESSAGE, null, null, {})
  }
  return token
}

async function postWithCsrf<T>(
  path: string,
  body: string | undefined,
  decode: (payload: unknown, status: number) => T,
): Promise<T> {
  const token = await getCsrfToken()
  return apiFetch(
    path,
    { method: 'POST', headers: { 'X-CSRFToken': token }, body },
    decode,
  )
}

export async function loginRequest(
  email: string,
  password: string,
): Promise<User> {
  const body = JSON.stringify({ email, password })
  return postWithCsrf('/api/auth/login/', body, parseUser)
}

export async function registerRequest(
  email: string,
  password: string,
): Promise<User> {
  const body = JSON.stringify({ email, password })
  return postWithCsrf('/api/auth/register/', body, parseUser)
}

export async function logoutRequest(): Promise<void> {
  const token = await getCsrfToken()
  await apiFetch(
    '/api/auth/logout/',
    {
      method: 'POST',
      headers: { 'X-CSRFToken': token },
    },
    decodeNoContent,
  )
}
