export interface User {
  id: number
  email: string
}

export type FieldErrors = Record<string, readonly string[]>

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'

export function parseUser(payload: unknown, status: number): User {
  const record = payload as Record<string, unknown> | null
  if (
    record !== null &&
    typeof record === 'object' &&
    !Array.isArray(record) &&
    typeof record.id === 'number' &&
    Number.isInteger(record.id) &&
    typeof record.email === 'string'
  ) {
    return { id: record.id, email: record.email }
  }
  throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
}

export class ApiError extends Error {
  readonly status: number | null
  readonly detail: string | null
  readonly fieldErrors: FieldErrors

  constructor(
    message: string,
    status: number | null,
    detail: string | null,
    fieldErrors: FieldErrors,
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.fieldErrors = fieldErrors
  }
}

export function userMessage(error: ApiError): string {
  return error.detail ?? error.message
}
