import { describe, expect, it } from 'vitest'
import { createAccount } from './accounts'
import { ApiError } from './types'
import {
  calls,
  installFetchMock,
  jsonResponse,
  requestLog,
  setCsrfCookie,
} from '../test/testUtils'

const CSRF_RESPONSE = { detail: 'CSRF cookie set.' }

function accountFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Everyday Checking',
    account_type: 'checking',
    opening_balance: '100.00',
    current_balance: '100.00',
    is_archived: false,
    created_at: '2026-09-11T14:52:48.008850Z',
    updated_at: '2026-09-11T14:52:48.008850Z',
    ...overrides,
  }
}

function createHandler(
  onPost: (body: Record<string, unknown>) => Response,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/csrf/') {
      setCsrfCookie('create-csrf-token')
      return jsonResponse(CSRF_RESPONSE)
    }
    if (url === '/api/accounts/' && (init?.method ?? 'GET') === 'POST') {
      return onPost(JSON.parse(String(init?.body)) as Record<string, unknown>)
    }
    return jsonResponse({}, 404)
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (caught) {
    return caught
  }
  throw new Error('Expected the promise to reject.')
}

describe('createAccount', () => {
  it('bootstraps CSRF then POSTs exactly three fields and parses the 201 response', async () => {
    const mock = installFetchMock(
      createHandler(() =>
        jsonResponse(
          accountFixture({
            id: 7,
            name: 'Travel Fund',
            account_type: 'savings',
            opening_balance: '250.00',
            current_balance: '250.00',
          }),
          201,
        ),
      ),
    )

    const account = await createAccount('Travel Fund', 'savings', '250.00')

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/accounts/',
    ])
    const posts = calls(mock, '/api/accounts/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/accounts/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBe(
      JSON.stringify({
        name: 'Travel Fund',
        account_type: 'savings',
        opening_balance: '250.00',
      }),
    )
    expect(account.id).toBe(7)
    expect(account.name).toBe('Travel Fund')
    expect(account.account_type).toBe('savings')
    expect(account.opening_balance).toBe('250.00')
    expect(account.current_balance).toBe('250.00')
    expect(account.is_archived).toBe(false)
    expect(account.created_at).toBe('2026-09-11T14:52:48.008850Z')
    expect(account.updated_at).toBe('2026-09-11T14:52:48.008850Z')
  })

  it('preserves exact large and negative decimal strings in request and response', async () => {
    const mock = installFetchMock(
      createHandler((body) =>
        jsonResponse(
          accountFixture({
            id: 3,
            name: body.name,
            account_type: body.account_type,
            opening_balance: body.opening_balance,
            current_balance: body.opening_balance,
          }),
          201,
        ),
      ),
    )

    const large = await createAccount('Big Saver', 'savings', '1234567890.12')
    expect(large.opening_balance).toBe('1234567890.12')
    expect(large.current_balance).toBe('1234567890.12')

    const negative = await createAccount('Old Card', 'credit_card', '-987654321.01')
    expect(negative.opening_balance).toBe('-987654321.01')
    expect(negative.current_balance).toBe('-987654321.01')

    const posts = calls(mock, '/api/accounts/', 'POST')
    expect(posts).toHaveLength(2)
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
      name: 'Big Saver',
      account_type: 'savings',
      opening_balance: '1234567890.12',
    })
    expect(JSON.parse(String(posts[1][1]?.body))).toEqual({
      name: 'Old Card',
      account_type: 'credit_card',
      opening_balance: '-987654321.01',
    })
  })

  it.each([
    ['an empty object', {}],
    ['a missing current_balance', { id: 1, name: 'X', account_type: 'checking' }],
  ])('rejects a malformed 201 response safely', async (_label, payload) => {
    const mock = installFetchMock(createHandler(() => jsonResponse(payload, 201)))
    const error = await rejection(createAccount('X', 'checking', '0.00'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('aborts before POST when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/accounts/') return jsonResponse(accountFixture(), 201)
      return jsonResponse({}, 404)
    })

    const error = await rejection(createAccount('X', 'checking', '0.00'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(0)
  })

  it('preserves backend field errors from a 400 response', async () => {
    const mock = installFetchMock(
      createHandler(() =>
        jsonResponse(
          {
            name: ['This field is required.'],
            opening_balance: [
              'Ensure that there are no more than 10 digits before the decimal point.',
            ],
          },
          400,
        ),
      ),
    )

    const error = await rejection(createAccount('', 'checking', '0.00'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.name).toEqual(['This field is required.'])
      expect(error.fieldErrors.opening_balance).toEqual([
        'Ensure that there are no more than 10 digits before the decimal point.',
      ])
    }
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('preserves a 401 status from the create request', async () => {
    const mock = installFetchMock(
      createHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )

    const error = await rejection(createAccount('X', 'checking', '0.00'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(401)
      expect(error.detail).toBe('Authentication credentials were not provided.')
    }
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('preserves a 401 status from the CSRF request', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(createAccount('X', 'checking', '0.00'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(401)
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(0)
  })

  it('throws a safe network error when the server cannot be reached', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse(CSRF_RESPONSE)
      }
      throw new TypeError('Failed to fetch')
    })

    const error = await rejection(createAccount('X', 'checking', '0.00'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(createHandler(() => jsonResponse(accountFixture(), 201)))

    await createAccount('X', 'checking', '0.00')

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})