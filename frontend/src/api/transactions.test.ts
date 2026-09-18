import { afterEach, describe, expect, it } from 'vitest'
import {
  createTransaction,
  deleteTransaction,
  fetchTransactions,
  resetTransactionsRequest,
  updateTransaction,
} from './transactions'
import type { TransactionFilters, TransactionInput } from './transactions'
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

function transactionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    account: 1,
    category: 2,
    transaction_type: 'expense',
    amount: '12.50',
    date: '2026-09-11',
    note: 'Groceries',
    source: 'manual',
    provider_name: '',
    is_pending: false,
    is_pending_initial_import: false,
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

function createInput(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    account: 1,
    category: 2,
    transaction_type: 'expense',
    amount: '12.50',
    date: '2026-09-11',
    note: 'Groceries',
    ...overrides,
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

afterEach(() => {
  resetTransactionsRequest()
})

describe('fetchTransactions', () => {
  it('parses the transaction list in server order with all thirteen fields', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/transactions/') {
        return jsonResponse([
          transactionFixture({
            id: 1,
            account: 10,
            category: 20,
            transaction_type: 'expense',
            amount: '12.50',
            date: '2026-09-10',
            note: 'Groceries',
            created_at: '2026-09-10T10:00:00Z',
            updated_at: '2026-09-10T10:00:00Z',
          }),
          transactionFixture({
            id: 2,
            account: 11,
            category: 21,
            transaction_type: 'income',
            amount: '2500.00',
            date: '2026-09-11',
            note: '',
            created_at: '2026-09-11T16:08:00.000000Z',
            updated_at: '2026-09-11T16:08:00.000000Z',
          }),
        ])
      }
      return jsonResponse({}, 404)
    })

    const transactions = await fetchTransactions()

    expect(requestLog(mock)).toEqual(['GET /api/transactions/'])
    expect(transactions).toHaveLength(2)
    expect(transactions[0]).toEqual({
      id: 1,
      account: 10,
      category: 20,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
      source: 'manual',
      provider_name: '',
      is_pending: false,
      is_pending_initial_import: false,
      created_at: '2026-09-10T10:00:00Z',
      updated_at: '2026-09-10T10:00:00Z',
    })
    expect(transactions[1]).toEqual({
      id: 2,
      account: 11,
      category: 21,
      transaction_type: 'income',
      amount: '2500.00',
      date: '2026-09-11',
      note: '',
      source: 'manual',
      provider_name: '',
      is_pending: false,
      is_pending_initial_import: false,
      created_at: '2026-09-11T16:08:00.000000Z',
      updated_at: '2026-09-11T16:08:00.000000Z',
    })
  })

  it('parses the exact backend transaction payload shape', async () => {
    installFetchMock((url) => {
      if (url === '/api/transactions/') {
        return jsonResponse([
          {
            id: 1,
            account: 10,
            category: 20,
            transaction_type: 'expense',
            amount: '12.50',
            date: '2026-09-10',
            note: 'Groceries',
            source: 'manual',
            provider_name: '',
            is_pending: false,
            is_pending_initial_import: false,
            created_at: '2026-09-10T10:00:00Z',
            updated_at: '2026-09-10T10:00:00Z',
          },
        ])
      }
      return jsonResponse({}, 404)
    })

    const transactions = await fetchTransactions()

    expect(transactions).toEqual([
      {
        id: 1,
        account: 10,
        category: 20,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
        source: 'manual',
        provider_name: '',
        is_pending: false,
        is_pending_initial_import: false,
        created_at: '2026-09-10T10:00:00Z',
        updated_at: '2026-09-10T10:00:00Z',
      },
    ])
  })

  it('parses a plaid row with provider state and an empty provider_name', async () => {
    installFetchMock((url) => {
      if (url === '/api/transactions/') {
        return jsonResponse([
          transactionFixture({
            id: 3,
            source: 'plaid',
            provider_name: '',
            is_pending: true,
            is_pending_initial_import: true,
          }),
        ])
      }
      return jsonResponse({}, 404)
    })

    const transactions = await fetchTransactions()

    expect(transactions[0]).toEqual({
      id: 3,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-11',
      note: 'Groceries',
      source: 'plaid',
      provider_name: '',
      is_pending: true,
      is_pending_initial_import: true,
      created_at: '2026-09-11T14:52:48.008850Z',
      updated_at: '2026-09-11T14:52:48.008850Z',
    })
  })

  const malformedVariants: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an object payload', { id: 1 }],
    ['a string payload', 'nope'],
    ['a missing key', [withoutKey(transactionFixture(), 'note')]],
    ['an extra key', [{ ...transactionFixture(), user: 1 }]],
    ['a zero id', [transactionFixture({ id: 0 })]],
    ['a negative id', [transactionFixture({ id: -3 })]],
    ['a fractional id', [transactionFixture({ id: 1.5 })]],
    ['a string id', [transactionFixture({ id: '1' })]],
    ['an unsafe id', [transactionFixture({ id: 9007199254740992 })]],
    ['a NaN id', [transactionFixture({ id: Number.NaN })]],
    ['a zero account', [transactionFixture({ account: 0 })]],
    ['a negative account', [transactionFixture({ account: -3 })]],
    ['a fractional account', [transactionFixture({ account: 1.5 })]],
    ['a string account', [transactionFixture({ account: '1' })]],
    ['an unsafe account', [transactionFixture({ account: 9007199254740992 })]],
    ['a zero category', [transactionFixture({ category: 0 })]],
    ['a negative category', [transactionFixture({ category: -3 })]],
    ['a fractional category', [transactionFixture({ category: 1.5 })]],
    ['a string category', [transactionFixture({ category: '1' })]],
    ['an unsafe category', [transactionFixture({ category: 9007199254740992 })]],
    ['an invalid transaction type', [transactionFixture({ transaction_type: 'savings' })]],
    ['a numeric transaction type', [transactionFixture({ transaction_type: 42 })]],
    ['a zero amount', [transactionFixture({ amount: '0.00' })]],
    ['a negative amount', [transactionFixture({ amount: '-1.00' })]],
    ['a one-decimal amount', [transactionFixture({ amount: '1.5' })]],
    ['an exponent amount', [transactionFixture({ amount: '1e3' })]],
    ['a three-decimal amount', [transactionFixture({ amount: '1.500' })]],
    ['a 13-digit amount', [transactionFixture({ amount: '12345678901.23' })]],
    ['a numeric amount', [transactionFixture({ amount: 12.5 })]],
    ['an empty-string amount', [transactionFixture({ amount: '' })]],
    ['an impossible date', [transactionFixture({ date: '2026-02-30' })]],
    ['a datetime date', [transactionFixture({ date: '2026-09-11T00:00:00Z' })]],
    ['a slash date', [transactionFixture({ date: '09/11/2026' })]],
    ['a single-digit date', [transactionFixture({ date: '2026-9-11' })]],
    ['a numeric date', [transactionFixture({ date: 20260911 })]],
    ['a numeric note', [transactionFixture({ note: 42 })]],
    ['a null note', [transactionFixture({ note: null })]],
    ['an array note', [transactionFixture({ note: ['x'] })]],
    ['an impossible created_at date', [transactionFixture({ created_at: '2026-02-30T12:00:00Z' })]],
    ['a date-only created_at', [transactionFixture({ created_at: '2026-09-11' })]],
    ['a malformed created_at', [transactionFixture({ created_at: 'garbage' })]],
    ['an impossible updated_at date', [transactionFixture({ updated_at: '2026-02-30T12:00:00Z' })]],
    ['a date-only updated_at', [transactionFixture({ updated_at: '2026-09-11' })]],
    ['a malformed updated_at', [transactionFixture({ updated_at: 'garbage' })]],
    ['a missing updated_at', [withoutKey(transactionFixture(), 'updated_at')]],
    ['an unknown source', [transactionFixture({ source: 'card' })]],
    ['a numeric source', [transactionFixture({ source: 42 })]],
    ['a null source', [transactionFixture({ source: null })]],
    ['a missing source', [withoutKey(transactionFixture(), 'source')]],
    ['a numeric provider_name', [transactionFixture({ provider_name: 42 })]],
    ['an overlong provider_name', [transactionFixture({ provider_name: 'x'.repeat(201) })]],
    ['a numeric is_pending', [transactionFixture({ is_pending: 1 })]],
    ['a string is_pending', [transactionFixture({ is_pending: 'true' })]],
    ['a null is_pending', [transactionFixture({ is_pending: null })]],
    ['a numeric is_pending_initial_import', [transactionFixture({ is_pending_initial_import: 1 })]],
    ['a string is_pending_initial_import', [transactionFixture({ is_pending_initial_import: 'false' })]],
    ['a manual row with a provider_name', [transactionFixture({ provider_name: 'Chase' })]],
    ['a manual row with is_pending', [transactionFixture({ is_pending: true })]],
    ['a manual row with is_pending_initial_import', [transactionFixture({ is_pending_initial_import: true })]],
  ]

  it.each(malformedVariants)(
    'rejects %s safely with the real status',
    async (_label, payload) => {
      installFetchMock((url) => {
        if (url === '/api/transactions/') return jsonResponse(payload, 200)
        return jsonResponse({}, 404)
      })

      const error = await rejection(fetchTransactions())
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.status).toBe(200)
        expect(error.message).toBe('Unexpected server response.')
        expect(error.fieldErrors).toEqual({})
      }
    },
  )

  it('rejects a 204 response safely with the real status', async () => {
    installFetchMock((url) => {
      if (url === '/api/transactions/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchTransactions())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('rejects a structurally valid list at 201 safely', async () => {
    installFetchMock((url) => {
      if (url === '/api/transactions/') {
        return jsonResponse([transactionFixture({ id: 1 })], 201)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchTransactions())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  it.each([
    ['account', { account: 3 }, 'account=3'],
    ['category', { category: 5 }, 'category=5'],
    ['transaction_type', { transaction_type: 'income' }, 'transaction_type=income'],
    ['start_date', { start_date: '2026-09-01' }, 'start_date=2026-09-01'],
    ['end_date', { end_date: '2026-09-30' }, 'end_date=2026-09-30'],
  ])('builds the %s filter alone', async (_label, filters, query) => {
    const mock = installFetchMock((url) => {
      if (url === `/api/transactions/?${query}`) return jsonResponse([])
      return jsonResponse({}, 404)
    })

    await fetchTransactions(filters as TransactionFilters)

    expect(requestLog(mock)).toEqual([`GET /api/transactions/?${query}`])
  })

  it('builds combined filters in a deterministic order', async () => {
    const expected =
      '/api/transactions/?account=3&category=5&transaction_type=expense&start_date=2026-09-01&end_date=2026-09-30'
    const mock = installFetchMock((url) => {
      if (url === expected) return jsonResponse([])
      return jsonResponse({}, 404)
    })

    await fetchTransactions({
      end_date: '2026-09-30',
      transaction_type: 'expense',
      start_date: '2026-09-01',
      account: 3,
      category: 5,
    })

    expect(requestLog(mock)).toEqual([`GET ${expected}`])
  })

  it('omits query params when no filters are provided', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/transactions/') return jsonResponse([])
      return jsonResponse({}, 404)
    })

    await fetchTransactions()

    expect(requestLog(mock)).toEqual(['GET /api/transactions/'])
  })

  it('skips undefined and empty filter values', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/transactions/?account=3') return jsonResponse([])
      return jsonResponse({}, 404)
    })

    await fetchTransactions({
      account: 3,
      category: undefined,
      transaction_type: undefined,
      start_date: '',
      end_date: undefined,
    })

    expect(requestLog(mock)).toEqual(['GET /api/transactions/?account=3'])
  })

  const invalidFilterVariants: Array<[string, Record<string, unknown>]> = [
    ['a negative account id', { account: -1 }],
    ['a zero account id', { account: 0 }],
    ['a fractional category id', { category: 2.5 }],
    ['an unsafe category id', { category: 9007199254740992 }],
    ['an unknown transaction type', { transaction_type: 'savings' }],
    ['an impossible date', { start_date: '2026-02-30' }],
  ]

  it.each(invalidFilterVariants)(
    'rejects %s as a promise rejection with no network request',
    async (_label, filters) => {
      const mock = installFetchMock(() => jsonResponse({}, 404))
      let promise: Promise<unknown> | undefined
      let threwSynchronously = false
      try {
        promise = fetchTransactions(filters as TransactionFilters)
      } catch {
        threwSynchronously = true
      }
      expect(threwSynchronously).toBe(false)
      expect(promise).toBeInstanceOf(Promise)

      const error = await rejection(promise as Promise<unknown>)
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe('Invalid transaction filters.')
        expect(error.status).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
      expect(requestLog(mock)).toEqual([])
    },
  )

  it('shares a single in-flight request for identical concurrent filters and clears it on settle', async () => {
    let callsCount = 0
    const mock = installFetchMock((url) => {
      if (url === '/api/transactions/?account=1') {
        callsCount += 1
        return jsonResponse([transactionFixture()])
      }
      return jsonResponse({}, 404)
    })

    const first = fetchTransactions({ account: 1 })
    const second = fetchTransactions({ account: 1 })
    expect(await first).toHaveLength(1)
    expect(await second).toHaveLength(1)
    expect(callsCount).toBe(1)

    await fetchTransactions({ account: 1 })
    expect(callsCount).toBe(2)
    expect(calls(mock, '/api/transactions/?account=1')).toHaveLength(2)
  })

  it('keeps different filters as separate requests', async () => {
    let accountCalls = 0
    let categoryCalls = 0
    installFetchMock((url) => {
      if (url === '/api/transactions/?account=1') {
        accountCalls += 1
        return jsonResponse([transactionFixture({ id: 1 })])
      }
      if (url === '/api/transactions/?category=2') {
        categoryCalls += 1
        return jsonResponse([transactionFixture({ id: 2 })])
      }
      return jsonResponse({}, 404)
    })

    const byAccount = fetchTransactions({ account: 1 })
    const byCategory = fetchTransactions({ category: 2 })
    const byAccountAgain = fetchTransactions({ account: 1 })
    expect(await byAccount).toHaveLength(1)
    expect(await byCategory).toHaveLength(1)
    expect(await byAccountAgain).toHaveLength(1)
    expect(accountCalls).toBe(1)
    expect(categoryCalls).toBe(1)
  })

  it('preserves a 401 status and safe network failures', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/transactions/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      return jsonResponse({}, 404)
    })
    const error = await rejection(fetchTransactions())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(401)
      expect(error.detail).toBe('Authentication credentials were not provided.')
    }

    installFetchMock((url) => {
      if (url === '/api/transactions/') throw new TypeError('Failed to fetch')
      return jsonResponse({}, 404)
    })
    const networkError = await rejection(fetchTransactions())
    expect(networkError).toBeInstanceOf(ApiError)
    if (networkError instanceof ApiError) {
      expect(networkError.status).toBeNull()
      expect(networkError.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock((url) => {
      if (url === '/api/transactions/') return jsonResponse([transactionFixture()])
      return jsonResponse({}, 404)
    })

    await fetchTransactions()

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('createTransaction', () => {
  it('bootstraps CSRF then POSTs exactly six writable fields and parses the 201 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/') {
          return jsonResponse(
            transactionFixture({ id: 9, account: 1, category: 2 }),
            201,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const transaction = await createTransaction(createInput())

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/transactions/',
    ])
    const posts = calls(mock, '/api/transactions/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/transactions/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBe(
      JSON.stringify({
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-11',
        note: 'Groceries',
      }),
    )
    expect(transaction.id).toBe(9)
    expect(transaction.account).toBe(1)
    expect(transaction.category).toBe(2)
    expect(transaction.transaction_type).toBe('expense')
    expect(transaction.amount).toBe('12.50')
    expect(transaction.date).toBe('2026-09-11')
    expect(transaction.note).toBe('Groceries')
    expect(transaction.created_at).toBe('2026-09-11T14:52:48.008850Z')
    expect(transaction.updated_at).toBe('2026-09-11T14:52:48.008850Z')
  })

  it('rejects a 200 response even with a valid Transaction payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/') {
          return jsonResponse(transactionFixture(), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createTransaction(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })

  it('rejects a 204 response even for an exact create', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createTransaction(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })

  it('rejects a malformed 201 response safely', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/') return jsonResponse({ id: 1 }, 201)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createTransaction(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('aborts before POST when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/transactions/') return jsonResponse(transactionFixture(), 201)
      return jsonResponse({}, 404)
    })

    const error = await rejection(createTransaction(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
  })

  it('preserves backend field errors for an archived account', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/') {
          return jsonResponse(
            {
              account: ['Archived accounts cannot be used for new transactions.'],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createTransaction(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.account).toEqual([
        'Archived accounts cannot be used for new transactions.',
      ])
    }
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })

  it('preserves backend field errors for an archived category', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/') {
          return jsonResponse(
            {
              category: ['Archived categories cannot be used for new transactions.'],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createTransaction(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.category).toEqual([
        'Archived categories cannot be used for new transactions.',
      ])
    }
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })

  it('preserves backend field errors for a category/type mismatch', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/') {
          return jsonResponse(
            {
              category: ['Category type must match the transaction type.'],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createTransaction(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.category).toEqual([
        'Category type must match the transaction type.',
      ])
    }
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
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
      () => jsonResponse({ detail: 'No Transaction matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/transactions/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(createTransaction(createInput()))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
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

    const error = await rejection(createTransaction(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/') {
          return jsonResponse(transactionFixture(), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    await createTransaction(createInput())

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('updateTransaction', () => {
  it('bootstraps CSRF then PATCHes only the provided keys and parses the 200 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url, init) => {
        if (url === '/api/transactions/7/') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse(transactionFixture({ id: 7, ...body }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const transaction = await updateTransaction(7, {
      amount: '25.00',
      note: 'Updated note',
    })

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'PATCH /api/transactions/7/',
    ])
    const patches = calls(mock, '/api/transactions/7/', 'PATCH')
    expect(patches).toHaveLength(1)
    const [input, init] = patches[0]
    expect(String(input)).toBe('/api/transactions/7/')
    expect(init?.method).toBe('PATCH')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(JSON.parse(String(init?.body))).toEqual({
      amount: '25.00',
      note: 'Updated note',
    })
    expect(transaction.id).toBe(7)
    expect(transaction.amount).toBe('25.00')
    expect(transaction.note).toBe('Updated note')
  })

  it('PATCHes all six writable fields and never server-controlled fields', async () => {
    const mock = installFetchMock(
      mutationHandler((url, init) => {
        if (url === '/api/transactions/11/') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse(transactionFixture({ id: 11, ...body }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const transaction = await updateTransaction(11, {
      account: 3,
      category: 4,
      transaction_type: 'income',
      amount: '100.00',
      date: '2026-09-01',
      note: 'Paycheck',
    })

    const patches = calls(mock, '/api/transactions/11/', 'PATCH')
    expect(patches).toHaveLength(1)
    expect(JSON.parse(String(patches[0][1]?.body))).toEqual({
      account: 3,
      category: 4,
      transaction_type: 'income',
      amount: '100.00',
      date: '2026-09-01',
      note: 'Paycheck',
    })
    expect(transaction.id).toBe(11)
    expect(transaction.account).toBe(3)
    expect(transaction.category).toBe(4)
    expect(transaction.transaction_type).toBe('income')
    expect(transaction.amount).toBe('100.00')
    expect(transaction.date).toBe('2026-09-01')
    expect(transaction.note).toBe('Paycheck')
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, transactionId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(
      updateTransaction(transactionId as number, { amount: '1.00' }),
    )
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid transaction id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('rejects a 201 response even with a valid matching Transaction payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') {
          return jsonResponse(transactionFixture({ id: 7, note: 'Intruder' }), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateTransaction(7, { note: 'Intruder' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a 204 response even for an exact update', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateTransaction(7, { note: 'X' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a 200 response whose id does not match the requested transaction id', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') {
          return jsonResponse(transactionFixture({ id: 8, note: 'Intruder' }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateTransaction(7, { note: 'Intruder' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a malformed 200 response safely', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') return jsonResponse({}, 200)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateTransaction(7, { note: 'X' }))
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
      if (url === '/api/transactions/7/') return jsonResponse(transactionFixture(), 200)
      return jsonResponse({}, 404)
    })

    const error = await rejection(updateTransaction(7, { note: 'X' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(0)
  })

  it('preserves backend field errors from a 400 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') {
          return jsonResponse(
            {
              category: ['Category type must match the transaction type.'],
              amount: ['Ensure that there are no more than 10 digits before the decimal point.'],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateTransaction(7, { amount: '0.00' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.category).toEqual([
        'Category type must match the transaction type.',
      ])
      expect(error.fieldErrors.amount).toEqual([
        'Ensure that there are no more than 10 digits before the decimal point.',
      ])
    }
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(1)
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
      () => jsonResponse({ detail: 'No Transaction matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/transactions/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(updateTransaction(7, { note: 'X' }))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(1)
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

    const error = await rejection(updateTransaction(7, { note: 'X' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') {
          return jsonResponse(transactionFixture({ id: 7 }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    await updateTransaction(7, { note: 'X' })

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('deleteTransaction', () => {
  it('bootstraps CSRF then DELETEs the transaction path and resolves on an empty 204', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    await expect(deleteTransaction(7)).resolves.toBeUndefined()

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'DELETE /api/transactions/7/',
    ])
    const deletes = calls(mock, '/api/transactions/7/', 'DELETE')
    expect(deletes).toHaveLength(1)
    const [input, init] = deletes[0]
    expect(String(input)).toBe('/api/transactions/7/')
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBeUndefined()
  })

  it.each([
    ['a 200 response with a JSON body', () => jsonResponse(transactionFixture(), 200)],
    ['a 200 response with an empty body', () => new Response(null, { status: 200 })],
  ])('rejects unexpected success on %s safely', async (_label, respond) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') return respond()
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(deleteTransaction(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/transactions/7/', 'DELETE')).toHaveLength(1)
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, transactionId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(deleteTransaction(transactionId as number))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid transaction id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('aborts before DELETE when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/transactions/7/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(deleteTransaction(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/transactions/7/', 'DELETE')).toHaveLength(0)
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
      () => jsonResponse({ detail: 'No Transaction matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/transactions/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(deleteTransaction(7))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/transactions/7/', 'DELETE')).toHaveLength(1)
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

    const error = await rejection(deleteTransaction(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/transactions/7/', 'DELETE')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/transactions/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    await deleteTransaction(7)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
