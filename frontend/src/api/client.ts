import { ApiError, type FieldErrors } from './types'

const CSRF_COOKIE_NAME = 'csrftoken'
const NETWORK_ERROR_MESSAGE = 'Could not reach the server.'
const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const MALFORMED_ERROR_MESSAGE = 'Unexpected server response.'
const TIMEOUT_MS = 15_000
const TIMEOUT_ERROR_MESSAGE =
  'The server took too long to respond. Please try again.'

export function readCsrfToken(cookieString: string): string | null {
  let token: string | null = null
  for (const part of cookieString.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    const name = part.slice(0, separator).trim()
    if (name !== CSRF_COOKIE_NAME) continue
    const rawValue = part.slice(separator + 1).trim()
    try {
      token = decodeURIComponent(rawValue)
    } catch {
      token = null
    }
  }
  return token
}

function toFieldErrors(body: unknown): FieldErrors {
  if (typeof body !== 'object' || body === null) return {}
  const fieldErrors: FieldErrors = {}
  for (const [key, value] of Object.entries(body)) {
    if (key === 'detail') continue
    const messages: string[] = []
    if (typeof value === 'string') {
      messages.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') messages.push(item)
      }
    }
    if (messages.length > 0) fieldErrors[key] = messages
  }
  return fieldErrors
}

function toDetail(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const detail = (body as Record<string, unknown>).detail
  return typeof detail === 'string' ? detail : null
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function decodeNoContent(payload: unknown, status: number): undefined {
  if (status !== 204 || payload !== null) {
    throw new ApiError(MALFORMED_ERROR_MESSAGE, status, null, {})
  }
  return undefined
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
  decode?: (body: unknown, status: number) => T,
): Promise<T> {
  const { method = 'GET', body, headers } = options
  const requestHeaders = new Headers(headers)
  if (body !== undefined && body !== null) {
    requestHeaders.set('Content-Type', 'application/json')
  }

  const controller = new AbortController()
  const { signal } = options
  let rejectCancellation: (error: ApiError) => void = () => {}
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject
  })
  const forwardAbort = () => {
    controller.abort()
    rejectCancellation(new ApiError(NETWORK_ERROR_MESSAGE, null, null, {}))
  }
  if (signal != null) {
    if (signal.aborted) {
      forwardAbort()
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true })
    }
  }

  const request = (async (): Promise<T> => {
    let response: Response
    try {
      response = await fetch(path, {
        method,
        credentials: 'include',
        headers: requestHeaders,
        body,
        signal: controller.signal,
      })
    } catch {
      throw new ApiError(NETWORK_ERROR_MESSAGE, null, null, {})
    }

    let responseBody: unknown
    try {
      responseBody = await parseBody(response)
    } catch {
      throw new ApiError(NETWORK_ERROR_MESSAGE, null, null, {})
    }

    if (response.ok) {
      if (decode !== undefined) {
        return decode(responseBody, response.status)
      }
      if (responseBody === null) {
        if (response.status === 204) return undefined as T
        throw new ApiError(MALFORMED_ERROR_MESSAGE, response.status, null, {})
      }
      return responseBody as T
    }

    throw new ApiError(
      GENERIC_ERROR_MESSAGE,
      response.status,
      toDetail(responseBody),
      toFieldErrors(responseBody),
    )
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ApiError(TIMEOUT_ERROR_MESSAGE, null, null, {}))
    }, TIMEOUT_MS)
  })

  try {
    return await Promise.race([request, deadline, cancellation])
  } finally {
    clearTimeout(timer)
    if (signal != null) {
      signal.removeEventListener('abort', forwardAbort)
    }
  }
}
