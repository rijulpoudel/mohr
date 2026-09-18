import { describe, expect, it } from 'vitest'
import {
  archiveAccount,
  createAccount,
  fetchAccounts,
  updateAccount,
} from './accounts'
import { ApiError } from './types'
import {
  calls,
  emptyResponse,
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
    sync_pending: false,
    is_archived: false,
    created_at: '2026-09-11T14:52:48.008850Z',
    updated_at: '2026-09-11T14:52:48.008850Z',
    ...overrides,
  }
}

function withoutKey(record: Record<string, unknown>, key: string) {
  const copy = { ...record }
  delete copy[key]
  return copy
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

function mutationHandler(
  onMutation: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/csrf/') {
      setCsrfCookie('create-csrf-token')
      return jsonResponse(CSRF_RESPONSE)
    }
    return onMutation(url, init)
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

describe('fetchAccounts', () => {
  it('parses the exact backend account payload shape', async () => {
    installFetchMock((url) => {
      if (url === '/api/accounts/') {
        return jsonResponse([
          {
            id: 1,
            name: 'Everyday Checking',
            account_type: 'checking',
            opening_balance: '100.00',
            current_balance: '100.00',
            sync_pending: false,
            is_archived: false,
            created_at: '2026-09-11T14:52:48.008850Z',
            updated_at: '2026-09-11T14:52:48.008850Z',
          },
        ])
      }
      return jsonResponse({}, 404)
    })

    const accounts = await fetchAccounts()

    expect(accounts).toEqual([
      {
        id: 1,
        name: 'Everyday Checking',
        account_type: 'checking',
        opening_balance: '100.00',
        current_balance: '100.00',
        sync_pending: false,
        is_archived: false,
        created_at: '2026-09-11T14:52:48.008850Z',
        updated_at: '2026-09-11T14:52:48.008850Z',
      },
    ])
  })

  it('rejects a 204 response safely with the real status', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/accounts/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchAccounts())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
  })

  it('rejects a structurally valid list at 201 safely', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/accounts/') {
        return jsonResponse([accountFixture({ id: 1 })], 201)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchAccounts())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
  })
})

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
    expect(account.sync_pending).toBe(false)
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
    ['a missing sync_pending', withoutKey(accountFixture(), 'sync_pending')],
    ['a string sync_pending', { ...accountFixture(), sync_pending: 'false' }],
    ['a numeric sync_pending', { ...accountFixture(), sync_pending: 1 }],
    ['a null sync_pending', { ...accountFixture(), sync_pending: null }],
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

  it('rejects a 200 response even with a valid Account payload', async () => {
    const mock = installFetchMock(
      createHandler(() => jsonResponse(accountFixture({ id: 7 }), 200)),
    )

    const error = await rejection(createAccount('X', 'checking', '0.00'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('rejects a 204 response even for an exact create', async () => {
    const mock = installFetchMock(createHandler(() => emptyResponse(204)))

    const error = await rejection(createAccount('X', 'checking', '0.00'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
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

describe('updateAccount', () => {
  it('CSRF-bootstraps then PATCHes only the provided name and parses the 200 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') {
          return jsonResponse(accountFixture({ id: 7, name: 'Renamed' }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const account = await updateAccount(7, { name: 'Renamed' })

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'PATCH /api/accounts/7/',
    ])
    const patches = calls(mock, '/api/accounts/7/', 'PATCH')
    expect(patches).toHaveLength(1)
    const [input, init] = patches[0]
    expect(String(input)).toBe('/api/accounts/7/')
    expect(init?.method).toBe('PATCH')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBe(JSON.stringify({ name: 'Renamed' }))
    expect(account.id).toBe(7)
    expect(account.name).toBe('Renamed')
    expect(account.account_type).toBe('checking')
    expect(account.opening_balance).toBe('100.00')
    expect(account.current_balance).toBe('100.00')
    expect(account.is_archived).toBe(false)
  })

  it('PATCHes an opening-balance-only change preserving the exact decimal string', async () => {
    const mock = installFetchMock(
      mutationHandler((url, init) => {
        if (url === '/api/accounts/3/') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse(
            accountFixture({
              id: 3,
              opening_balance: body.opening_balance,
              current_balance: body.opening_balance,
            }),
            200,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const account = await updateAccount(3, { opening_balance: '-987654321.01' })

    const patches = calls(mock, '/api/accounts/3/', 'PATCH')
    expect(patches).toHaveLength(1)
    expect(JSON.parse(String(patches[0][1]?.body))).toEqual({
      opening_balance: '-987654321.01',
    })
    expect(account.opening_balance).toBe('-987654321.01')
    expect(account.current_balance).toBe('-987654321.01')
  })

  it('PATCHes all writable fields with exact large decimals and never server fields', async () => {
    const mock = installFetchMock(
      mutationHandler((url, init) => {
        if (url === '/api/accounts/11/') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse(
            accountFixture({ id: 11, ...body, current_balance: '9.99' }),
            200,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const account = await updateAccount(11, {
      name: 'Max Saver',
      account_type: 'savings',
      opening_balance: '1234567890.12',
    })

    const patches = calls(mock, '/api/accounts/11/', 'PATCH')
    expect(patches).toHaveLength(1)
    expect(JSON.parse(String(patches[0][1]?.body))).toEqual({
      name: 'Max Saver',
      account_type: 'savings',
      opening_balance: '1234567890.12',
    })
    expect(account.name).toBe('Max Saver')
    expect(account.account_type).toBe('savings')
    expect(account.opening_balance).toBe('1234567890.12')
    expect(account.current_balance).toBe('9.99')
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, accountId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(
      updateAccount(accountId as number, { name: 'X' }),
    )
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid account id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('rejects a 201 response even with a valid matching Account payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') {
          return jsonResponse(accountFixture({ id: 7, name: 'Intruder' }), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateAccount(7, { name: 'Intruder' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a 204 response even for an exact update', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateAccount(7, { name: 'X' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a 200 response whose id does not match the requested account id', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') {
          return jsonResponse(accountFixture({ id: 8, name: 'Intruder' }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateAccount(7, { name: 'Intruder' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a malformed 200 response safely', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') return jsonResponse({}, 200)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateAccount(7, { name: 'X' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('aborts before PATCH when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/accounts/7/') return jsonResponse(accountFixture(), 200)
      return jsonResponse({}, 404)
    })

    const error = await rejection(updateAccount(7, { name: 'X' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(0)
  })

  it('preserves backend field errors from a 400 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') {
          return jsonResponse(
            {
              name: ['This field is required.'],
              opening_balance: [
                'Ensure that there are no more than 10 digits before the decimal point.',
              ],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateAccount(7, { name: '' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.name).toEqual(['This field is required.'])
      expect(error.fieldErrors.opening_balance).toEqual([
        'Ensure that there are no more than 10 digits before the decimal point.',
      ])
    }
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
  })

  const failureStatusCases: Array<[string, () => Response, number]> = [
    [
      'a 401 response',
      () =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      401,
    ],
    [
      'a 403 response',
      () => jsonResponse({ detail: 'CSRF Failed: CSRF token missing.' }, 403),
      403,
    ],
    [
      'a 404 response',
      () => jsonResponse({ detail: 'No Account matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/accounts/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(updateAccount(7, { name: 'X' }))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
    },
  )

  it('throws a safe network error when the server cannot be reached', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse(CSRF_RESPONSE)
      }
      throw new TypeError('Failed to fetch')
    })

    const error = await rejection(updateAccount(7, { name: 'X' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') {
          return jsonResponse(accountFixture({ id: 7 }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    await updateAccount(7, { name: 'X' })

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('archiveAccount', () => {
  it('CSRF-bootstraps then DELETEs the account path and resolves on an empty 204', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    await expect(archiveAccount(7)).resolves.toBeUndefined()

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'DELETE /api/accounts/7/',
    ])
    const deletes = calls(mock, '/api/accounts/7/', 'DELETE')
    expect(deletes).toHaveLength(1)
    const [input, init] = deletes[0]
    expect(String(input)).toBe('/api/accounts/7/')
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBeUndefined()
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, accountId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(archiveAccount(accountId as number))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid account id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('aborts before DELETE when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/accounts/7/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(archiveAccount(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(0)
  })

  it.each([
    ['a 200 response with a JSON body', () => jsonResponse(accountFixture(), 200)],
    ['a 200 response with an empty body', () => new Response(null, { status: 200 })],
  ])('rejects unexpected success on %s safely', async (_label, respond) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') return respond()
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(archiveAccount(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1)
  })

  const failureStatusCases: Array<[string, () => Response, number]> = [
    [
      'a 401 response',
      () =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      401,
    ],
    [
      'a 403 response',
      () => jsonResponse({ detail: 'CSRF Failed: CSRF token missing.' }, 403),
      403,
    ],
    [
      'a 404 response',
      () => jsonResponse({ detail: 'No Account matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/accounts/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(archiveAccount(7))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1)
    },
  )

  it('throws a safe network error when the server cannot be reached', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse(CSRF_RESPONSE)
      }
      throw new TypeError('Failed to fetch')
    })

    const error = await rejection(archiveAccount(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/accounts/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    await archiveAccount(7)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
