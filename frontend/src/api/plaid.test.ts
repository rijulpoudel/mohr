import { describe, expect, it, vi } from 'vitest'
import {
  completePlaidUpdate,
  createPlaidLinkToken,
  createPlaidUpdateLinkToken,
  disconnectPlaidConnection,
  exchangePlaidPublicToken,
  fetchPlaidConnections,
  resetPlaidConnectionsRequest,
  syncPlaidConnection,
} from './plaid'
import { ApiError } from './types'
import {
  calls,
  deferred,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  requestLog,
  setCsrfCookie,
} from '../test/testUtils'

const CSRF_RESPONSE = { detail: 'CSRF cookie set.' }
const CSRF_HEADER = 'plaid-csrf-token'

const PUBLIC_TOKEN = 'public-sandbox-abc123def456ghi789'
const EXCHANGE_HANDLE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const LINK_TOKEN = 'link-sandbox-abcdef1234567890'
const EXPIRATION = '2026-09-18T12:00:00Z'
const TIMESTAMP = '2026-09-11T14:52:48.008850Z'

function linkTokenFixture(overrides: Record<string, unknown> = {}) {
  return {
    link_token: LINK_TOKEN,
    expiration: EXPIRATION,
    exchange_handle: EXCHANGE_HANDLE,
    ...overrides,
  }
}

function updateLinkTokenFixture(overrides: Record<string, unknown> = {}) {
  return {
    link_token: LINK_TOKEN,
    expiration: EXPIRATION,
    ...overrides,
  }
}

function linkedAccountFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    name: 'Everyday Checking',
    account_type: 'checking',
    mask: '1234',
    sync_pending: false,
    ...overrides,
  }
}

function connectionSummaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    institution_name: 'First Plaid Bank',
    status: 'active',
    linked_accounts: [],
    ...overrides,
  }
}

function connectionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    institution_name: 'First Plaid Bank',
    status: 'active',
    sync_pending: false,
    last_synced_at: TIMESTAMP,
    linked_accounts: [linkedAccountFixture()],
    ...overrides,
  }
}

function mutationHandler(
  onPost: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/csrf/') {
      setCsrfCookie(CSRF_HEADER)
      return jsonResponse(CSRF_RESPONSE)
    }
    if ((init?.method ?? 'GET') === 'POST') {
      return onPost(url, init)
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

describe('createPlaidLinkToken', () => {
  it('bootstraps CSRF then POSTs the link-token path and parses the 200 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse(linkTokenFixture(), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await createPlaidLinkToken()

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/plaid/link-token/',
    ])
    const posts = calls(mock, '/api/plaid/link-token/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/plaid/link-token/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_HEADER)
    expect(headers.get('Content-Type')).toBeNull()
    expect(init?.body).toBeUndefined()
    expect(result.link_token).toBe(LINK_TOKEN)
    expect(result.expiration).toBe(EXPIRATION)
    expect(result.exchange_handle).toBe(EXCHANGE_HANDLE)
  })

  it('rejects a 200 response with an unknown extra field', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse(linkTokenFixture({ surprise: true }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response missing the exchange_handle', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse({ link_token: LINK_TOKEN, expiration: EXPIRATION }, 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response whose exchange_handle does not match the 43-char pattern', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse(linkTokenFixture({ exchange_handle: 'short' }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response with a bad expiration timestamp', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse(linkTokenFixture({ expiration: 'not-a-timestamp' }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it.each([
    ['an empty link_token', { link_token: '' }],
    ['an overlong link_token', { link_token: 'x'.repeat(8193) }],
  ])('rejects a 200 response with %s', async (_label, override) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse(linkTokenFixture(override), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response even with a valid payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse(linkTokenFixture(), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(201)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it('aborts before POST when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/plaid/link-token/') return jsonResponse(linkTokenFixture(), 200)
      return jsonResponse({}, 404)
    })

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(0)
  })

  it('preserves a 401 status from the POST', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(401)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it('preserves a 503 status from the POST', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') {
          return jsonResponse({ detail: 'Plaid is unavailable.' }, 503)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(503)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
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

    const error = await rejection(createPlaidLinkToken())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(401)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(0)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/link-token/') return jsonResponse(linkTokenFixture(), 200)
        return jsonResponse({}, 404)
      }),
    )

    await createPlaidLinkToken()

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('exchangePlaidPublicToken', () => {
  it('bootstraps CSRF then POSTs exactly the public token and handle and parses a 201 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse({ connection: connectionSummaryFixture() }, 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE)

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/plaid/exchange/',
    ])
    const posts = calls(mock, '/api/plaid/exchange/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/plaid/exchange/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe(CSRF_HEADER)
    expect(init?.body).toBe(
      JSON.stringify({ public_token: PUBLIC_TOKEN, exchange_handle: EXCHANGE_HANDLE }),
    )
    expect(result.connection.id).toBe(5)
    expect(result.connection.institution_name).toBe('First Plaid Bank')
    expect(result.connection.status).toBe('active')
    expect(result.connection.linked_accounts).toEqual([])
  })

  it('accepts a 200 heal response for an existing Item', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse({ connection: connectionSummaryFixture() }, 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE)

    expect(result.connection.id).toBe(5)
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it('rejects a 202 response even with a valid connection payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse({ connection: connectionSummaryFixture() }, 202)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(202)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response with an unknown connection field', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse(
            { connection: connectionSummaryFixture({ sync_pending: false }) },
            201,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(201)
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response with an invalid connection status', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse(
            { connection: connectionSummaryFixture({ status: 'bogus' }) },
            201,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(201)
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response with a malformed nested linked account', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse(
            {
              connection: connectionSummaryFixture({
                linked_accounts: [{ id: 2, name: 'X', account_type: 'checking' }],
              }),
            },
            201,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(201)
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response with non-array linked_accounts', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse(
            { connection: connectionSummaryFixture({ linked_accounts: 'none' }) },
            201,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(201)
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response with a structurally valid non-empty linked-account array', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse(
            {
              connection: connectionSummaryFixture({
                linked_accounts: [linkedAccountFixture()],
              }),
            },
            201,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it.each([
    ['an empty public token', ''],
    ['an overlong public token', 'p'.repeat(201)],
    ['a whitespace-only public token', '   '],
  ])('rejects %s before any network request', async (_label, publicToken) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(
      exchangePlaidPublicToken(publicToken, EXCHANGE_HANDLE),
    )
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid public token.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('sends a valid public token verbatim without trimming or normalizing', async () => {
    const tokenWithWhitespace = ` ${PUBLIC_TOKEN} `
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse({ connection: connectionSummaryFixture() }, 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await exchangePlaidPublicToken(tokenWithWhitespace, EXCHANGE_HANDLE)

    expect(result.connection.id).toBe(5)
    const posts = calls(mock, '/api/plaid/exchange/', 'POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
      public_token: tokenWithWhitespace,
      exchange_handle: EXCHANGE_HANDLE,
    })
  })

  it.each([
    ['a short handle', 'short'],
    ['a 44-char handle', 'a'.repeat(44)],
    ['a handle with an invalid character', `${'a'.repeat(42)}!`],
  ])('rejects %s before any network request', async (_label, exchangeHandle) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, exchangeHandle))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid exchange handle.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('preserves the generic 400 from the backend for an invalid exchange', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse({ detail: 'Invalid exchange request.' }, 400)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.detail).toBe('Invalid exchange request.')
    }
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it('preserves a 503 status from the POST', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse({ detail: 'Plaid is unavailable.' }, 503)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(503)
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
  })

  it('aborts before POST when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/plaid/exchange/') {
        return jsonResponse({ connection: connectionSummaryFixture() }, 201)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(0)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/exchange/') {
          return jsonResponse({ connection: connectionSummaryFixture() }, 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    await exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('fetchPlaidConnections', () => {
  it('GETs the connections list with no CSRF bootstrap and parses safe connections', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse([connectionFixture()], 200)
      }
      return jsonResponse({}, 404)
    })

    const connections = await fetchPlaidConnections()

    expect(requestLog(mock)).toEqual(['GET /api/plaid/connections/'])
    expect(connections).toHaveLength(1)
    const connection = connections[0]
    expect(connection.id).toBe(5)
    expect(connection.institution_name).toBe('First Plaid Bank')
    expect(connection.status).toBe('active')
    expect(connection.sync_pending).toBe(false)
    expect(connection.last_synced_at).toBe(TIMESTAMP)
    expect(connection.linked_accounts).toEqual([
      {
        id: 2,
        name: 'Everyday Checking',
        account_type: 'checking',
        mask: '1234',
        sync_pending: false,
      },
    ])
  })

  it('accepts a null last_synced_at', async () => {
    installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse([connectionFixture({ last_synced_at: null })], 200)
      }
      return jsonResponse({}, 404)
    })

    const connections = await fetchPlaidConnections()
    expect(connections[0].last_synced_at).toBeNull()
  })

  it('rejects a 201 response even with a valid list', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse([connectionFixture()], 201)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('rejects a 204 response safely', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('rejects a non-array payload', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') return jsonResponse({}, 200)
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('rejects a connection with an extra field', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse([connectionFixture({ secret: 'leak' })], 200)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('rejects a connection with an invalid status value', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse([connectionFixture({ status: 'connected' })], 200)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('rejects a linked account with an invalid account_type', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse(
          [
            connectionFixture({
              linked_accounts: [linkedAccountFixture({ account_type: 'investment' })],
            }),
          ],
          200,
        )
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('rejects a linked account with an overlong mask', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse(
          [
            connectionFixture({
              linked_accounts: [linkedAccountFixture({ mask: '12345' })],
            }),
          ],
          200,
        )
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('rejects a connection with a malformed timestamp', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse(
          [connectionFixture({ last_synced_at: '2026-99-99T99:99:99Z' })],
          200,
        )
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('rejects a connection with a non-boolean sync_pending', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse([connectionFixture({ sync_pending: 'yes' })], 200)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('preserves a 401 status', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(401)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('preserves a 503 status', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        return jsonResponse({ detail: 'Plaid is unavailable.' }, 503)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchPlaidConnections())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(503)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock((url) => {
      if (url === '/api/plaid/connections/') return jsonResponse([connectionFixture()], 200)
      return jsonResponse({}, 404)
    })

    await fetchPlaidConnections()

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('shares one in-flight GET across concurrent calls and resolves both identically', async () => {
    const gate = deferred<Response>()
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') return gate.promise
      return jsonResponse({}, 404)
    })

    const first = fetchPlaidConnections()
    const second = fetchPlaidConnections()

    gate.resolve(jsonResponse([connectionFixture()], 200))

    const [a, b] = await Promise.all([first, second])
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a).toEqual(b)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('does not let a stale settled request clear a newer in-flight request', async () => {
    const firstGate = deferred<Response>()
    const secondGate = deferred<Response>()
    let requestCount = 0
    const mock = installFetchMock((url) => {
      if (url === '/api/plaid/connections/') {
        requestCount += 1
        if (requestCount === 1) return firstGate.promise
        return secondGate.promise
      }
      return jsonResponse({}, 404)
    })

    const requestA = fetchPlaidConnections()
    resetPlaidConnectionsRequest()
    const requestB = fetchPlaidConnections()
    firstGate.resolve(jsonResponse([connectionFixture()], 200))
    await requestA
    const requestC = fetchPlaidConnections()
    secondGate.resolve(jsonResponse([connectionFixture()], 200))
    await Promise.all([requestB, requestC])

    expect(requestCount).toBe(2)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(2)
    expect(requestC).toBe(requestB)
  })
})

describe('createPlaidUpdateLinkToken', () => {
  it('bootstraps CSRF then POSTs the update link-token path and parses the 200 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/link-token/') {
          return jsonResponse(updateLinkTokenFixture(), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await createPlaidUpdateLinkToken(5)

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/plaid/connections/5/link-token/',
    ])
    const posts = calls(mock, '/api/plaid/connections/5/link-token/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/plaid/connections/5/link-token/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_HEADER)
    expect(init?.body).toBeUndefined()
    expect(result.link_token).toBe(LINK_TOKEN)
    expect(result.expiration).toBe(EXPIRATION)
  })

  it('rejects a 200 response with an extra field', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/link-token/') {
          return jsonResponse(updateLinkTokenFixture({ surprise: true }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidUpdateLinkToken(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/plaid/connections/5/link-token/', 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response missing expiration', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/link-token/') {
          return jsonResponse({ link_token: LINK_TOKEN }, 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidUpdateLinkToken(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/5/link-token/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response even with a valid payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/link-token/') {
          return jsonResponse(updateLinkTokenFixture(), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createPlaidUpdateLinkToken(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(201)
    expect(calls(mock, '/api/plaid/connections/5/link-token/', 'POST')).toHaveLength(1)
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, connectionId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(
      createPlaidUpdateLinkToken(connectionId as number),
    )
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid connection id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('aborts before POST when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/plaid/connections/5/link-token/') {
        return jsonResponse(updateLinkTokenFixture(), 200)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(createPlaidUpdateLinkToken(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/plaid/connections/5/link-token/', 'POST')).toHaveLength(0)
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
      'a 404 response',
      () => jsonResponse({ detail: 'No PlaidConnection matches the given query.' }, 404),
      404,
    ],
    [
      'a 503 response',
      () => jsonResponse({ detail: 'Plaid is unavailable.' }, 503),
      503,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/plaid/connections/5/link-token/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(createPlaidUpdateLinkToken(5))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/plaid/connections/5/link-token/', 'POST')).toHaveLength(1)
    },
  )

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/link-token/') {
          return jsonResponse(updateLinkTokenFixture(), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    await createPlaidUpdateLinkToken(5)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('syncPlaidConnection', () => {
  it('bootstraps CSRF then POSTs the sync path and parses a 200 sync result', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse(
            { connection_id: 5, status: 'active', added: 2, modified: 1, removed: 0 },
            200,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await syncPlaidConnection(5)

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/plaid/connections/5/sync/',
    ])
    const posts = calls(mock, '/api/plaid/connections/5/sync/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/plaid/connections/5/sync/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_HEADER)
    expect(init?.body).toBeUndefined()
    expect(result.connection_id).toBe(5)
    expect(result.status).toBe('active')
    if ('added' in result) {
      expect(result.added).toBe(2)
      expect(result.modified).toBe(1)
      expect(result.removed).toBe(0)
    }
  })

  it('accepts a 202 processing response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse({ connection_id: 5, status: 'processing' }, 202)
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await syncPlaidConnection(5)

    expect(result.connection_id).toBe(5)
    expect(result.status).toBe('processing')
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response whose connection_id does not match', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse(
            { connection_id: 6, status: 'active', added: 0, modified: 0, removed: 0 },
            200,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('rejects a 202 response whose connection_id does not match', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse({ connection_id: 6, status: 'processing' }, 202)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(202)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('rejects a 202 response with a non-processing status', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse({ connection_id: 5, status: 'active' }, 202)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(202)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('rejects a 202 response with extra fields', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse(
            { connection_id: 5, status: 'processing', added: 0 },
            202,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(202)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it.each([
    ['a negative count', { added: -1, modified: 0, removed: 0 }],
    ['a fractional count', { added: 0, modified: 1.5, removed: 0 }],
    ['a string count', { added: 0, modified: 0, removed: '2' }],
  ])('rejects a 200 response with %s', async (_label, overrides) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse({ connection_id: 5, status: 'active', ...overrides }, 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response with an invalid status value', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse(
            { connection_id: 5, status: 'processing', added: 0, modified: 0, removed: 0 },
            200,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response even with a valid 200 payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse(
            { connection_id: 5, status: 'active', added: 0, modified: 0, removed: 0 },
            201,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(201)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, connectionId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(syncPlaidConnection(connectionId as number))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid connection id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('preserves a 401 status', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(401)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('preserves a 404 status', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse({ detail: 'No PlaidConnection matches the given query.' }, 404)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(404)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('preserves a 503 status', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse({ detail: 'Plaid is unavailable.' }, 503)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(syncPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(503)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/sync/') {
          return jsonResponse(
            { connection_id: 5, status: 'active', added: 0, modified: 0, removed: 0 },
            200,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    await syncPlaidConnection(5)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('disconnectPlaidConnection', () => {
  it('bootstraps CSRF then POSTs the disconnect path and parses the 200 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/disconnect/') {
          return jsonResponse({ connection_id: 5, status: 'disconnected' }, 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await disconnectPlaidConnection(5)

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/plaid/connections/5/disconnect/',
    ])
    const posts = calls(mock, '/api/plaid/connections/5/disconnect/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/plaid/connections/5/disconnect/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_HEADER)
    expect(init?.body).toBeUndefined()
    expect(result.connection_id).toBe(5)
    expect(result.status).toBe('disconnected')
  })

  it('rejects a 200 response whose connection_id does not match', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/disconnect/') {
          return jsonResponse({ connection_id: 6, status: 'disconnected' }, 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(disconnectPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/plaid/connections/5/disconnect/', 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response whose status is not disconnected', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/disconnect/') {
          return jsonResponse({ connection_id: 5, status: 'active' }, 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(disconnectPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, '/api/plaid/connections/5/disconnect/', 'POST')).toHaveLength(1)
  })

  it('rejects a 201 response even with a valid payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/disconnect/') {
          return jsonResponse({ connection_id: 5, status: 'disconnected' }, 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(disconnectPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(201)
    expect(calls(mock, '/api/plaid/connections/5/disconnect/', 'POST')).toHaveLength(1)
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, connectionId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(disconnectPlaidConnection(connectionId as number))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid connection id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('preserves a 401 status', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/disconnect/') {
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(disconnectPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(401)
    expect(calls(mock, '/api/plaid/connections/5/disconnect/', 'POST')).toHaveLength(1)
  })

  it('preserves a 404 status', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/disconnect/') {
          return jsonResponse({ detail: 'No PlaidConnection matches the given query.' }, 404)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(disconnectPlaidConnection(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(404)
    expect(calls(mock, '/api/plaid/connections/5/disconnect/', 'POST')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/plaid/connections/5/disconnect/') {
          return jsonResponse({ connection_id: 5, status: 'disconnected' }, 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    await disconnectPlaidConnection(5)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('completePlaidUpdate', () => {
  const UPDATE_COMPLETE_URL = '/api/plaid/connections/5/update-complete/'

  function updateCompleteFixture(overrides: Record<string, unknown> = {}) {
    return {
      connection_id: 5,
      status: 'active',
      sync_pending: true,
      ...overrides,
    }
  }

  it('bootstraps CSRF then POSTs the update-complete path and parses the 200 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === UPDATE_COMPLETE_URL) {
          return jsonResponse(updateCompleteFixture(), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const result = await completePlaidUpdate(5)

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      `POST ${UPDATE_COMPLETE_URL}`,
    ])
    const posts = calls(mock, UPDATE_COMPLETE_URL, 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe(UPDATE_COMPLETE_URL)
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_HEADER)
    expect(init?.body).toBeUndefined()
    expect(result.connection_id).toBe(5)
    expect(result.status).toBe('active')
    expect(result.sync_pending).toBe(true)
  })

  it('rejects a 200 response with an extra field', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === UPDATE_COMPLETE_URL) {
          return jsonResponse(updateCompleteFixture({ surprise: true }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(completePlaidUpdate(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
  })

  it.each([
    ['connection_id', { status: 'active', sync_pending: true }],
    ['status', { connection_id: 5, sync_pending: true }],
    ['sync_pending', { connection_id: 5, status: 'active' }],
  ])('rejects a 200 response missing %s', async (_label, payload) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === UPDATE_COMPLETE_URL) return jsonResponse(payload, 200)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(completePlaidUpdate(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response whose connection_id does not match', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === UPDATE_COMPLETE_URL) {
          return jsonResponse(updateCompleteFixture({ connection_id: 6 }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(completePlaidUpdate(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
  })

  it('rejects a 200 response whose status is not active', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === UPDATE_COMPLETE_URL) {
          return jsonResponse(updateCompleteFixture({ status: 'updating' }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(completePlaidUpdate(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
  })

  it.each([
    ['false', false],
    ['the string "true"', 'true'],
  ])('rejects a 200 response whose sync_pending is %s', async (_label, value) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === UPDATE_COMPLETE_URL) {
          return jsonResponse(updateCompleteFixture({ sync_pending: value }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(completePlaidUpdate(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(200)
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
  })

  it.each([
    ['a 201 response', () => jsonResponse(updateCompleteFixture(), 201), 201],
    ['a 202 response', () => jsonResponse(updateCompleteFixture(), 202), 202],
  ])('rejects %s even with a valid payload', async (_label, respond, status) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === UPDATE_COMPLETE_URL) return respond()
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(completePlaidUpdate(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.status).toBe(status)
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, connectionId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(completePlaidUpdate(connectionId as number))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid connection id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('aborts before POST when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === UPDATE_COMPLETE_URL) return jsonResponse(updateCompleteFixture(), 200)
      return jsonResponse({}, 404)
    })

    const error = await rejection(completePlaidUpdate(5))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(0)
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
      'a 404 response',
      () => jsonResponse({ detail: 'No PlaidConnection matches the given query.' }, 404),
      404,
    ],
    [
      'a 503 response',
      () => jsonResponse({ detail: 'Plaid is unavailable.' }, 503),
      503,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === UPDATE_COMPLETE_URL) return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(completePlaidUpdate(5))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
    },
  )

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === UPDATE_COMPLETE_URL) {
          return jsonResponse(updateCompleteFixture(), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    await completePlaidUpdate(5)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('plaid helper safety', () => {
  it('never logs token-bearing values and never writes storage across every endpoint', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installFetchMock((url, init) => {
      if (url === '/api/auth/csrf/') {
        setCsrfCookie(CSRF_HEADER)
        return jsonResponse(CSRF_RESPONSE)
      }
      if (url === '/api/plaid/link-token/' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse(linkTokenFixture(), 200)
      }
      if (url === '/api/plaid/exchange/' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse({ connection: connectionSummaryFixture() }, 201)
      }
      if (url === '/api/plaid/connections/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse([connectionFixture()], 200)
      }
      if (url === '/api/plaid/connections/5/link-token/' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse(updateLinkTokenFixture(), 200)
      }
      if (url === '/api/plaid/connections/5/sync/' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse(
          { connection_id: 5, status: 'active', added: 0, modified: 0, removed: 0 },
          200,
        )
      }
      if (url === '/api/plaid/connections/5/disconnect/' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse({ connection_id: 5, status: 'disconnected' }, 200)
      }
      return jsonResponse({}, 404)
    })

    try {
      await createPlaidLinkToken()
      await exchangePlaidPublicToken(PUBLIC_TOKEN, EXCHANGE_HANDLE)
      await fetchPlaidConnections()
      await createPlaidUpdateLinkToken(5)
      await syncPlaidConnection(5)
      await disconnectPlaidConnection(5)

      const tokenValues = [PUBLIC_TOKEN, EXCHANGE_HANDLE, LINK_TOKEN]
      for (const spy of [logSpy, infoSpy, warnSpy, errorSpy]) {
        for (const args of spy.mock.calls) {
          const serialized = args.map((arg) => String(arg)).join(' ')
          for (const value of tokenValues) {
            expect(serialized).not.toContain(value)
          }
        }
      }
      expect(localStorage.length).toBe(0)
      expect(sessionStorage.length).toBe(0)
    } finally {
      logSpy.mockRestore()
      infoSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})