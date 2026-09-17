import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchDashboardSummary,
  parseDashboardSummary,
  resetDashboardRequest,
} from './dashboard'
import { ApiError } from './types'
import {
  calls,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  requestLog,
} from '../test/testUtils'

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    total_balance: '1234.56',
    current_month_income: '2000.00',
    current_month_expenses: '765.44',
    total_budgeted: '1500.00',
    remaining_budget: '-100.10',
    recent_transactions: [],
    ...overrides,
  }
}

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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (caught) {
    return caught
  }
  throw new Error('Expected the promise to reject.')
}

afterEach(() => {
  resetDashboardRequest()
})

describe('fetchDashboardSummary', () => {
  it('parses five money values and recent transactions with all thirteen fields', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(
          summaryFixture({
            recent_transactions: [
              transactionFixture({
                id: 10,
                account: 3,
                category: 4,
                transaction_type: 'income',
                amount: '1000.00',
                date: '2026-09-14',
                note: 'Paycheck',
                created_at: '2026-09-14T08:00:00.000000Z',
                updated_at: '2026-09-14T08:00:00.000000Z',
              }),
              transactionFixture({
                id: 11,
                source: 'plaid',
                provider_name: 'Chase',
                is_pending: true,
                is_pending_initial_import: true,
              }),
            ],
          }),
        )
      }
      return jsonResponse({}, 404)
    })

    const summary = await fetchDashboardSummary()

    expect(requestLog(mock)).toEqual(['GET /api/dashboard/summary/'])
    expect(summary.total_balance).toBe('1234.56')
    expect(summary.current_month_income).toBe('2000.00')
    expect(summary.current_month_expenses).toBe('765.44')
    expect(summary.total_budgeted).toBe('1500.00')
    expect(summary.remaining_budget).toBe('-100.10')
    expect(summary.recent_transactions).toEqual([
      {
        id: 10,
        account: 3,
        category: 4,
        transaction_type: 'income',
        amount: '1000.00',
        date: '2026-09-14',
        note: 'Paycheck',
        source: 'manual',
        provider_name: '',
        is_pending: false,
        is_pending_initial_import: false,
        created_at: '2026-09-14T08:00:00.000000Z',
        updated_at: '2026-09-14T08:00:00.000000Z',
      },
      {
        id: 11,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-11',
        note: 'Groceries',
        source: 'plaid',
        provider_name: 'Chase',
        is_pending: true,
        is_pending_initial_import: true,
        created_at: '2026-09-11T14:52:48.008850Z',
        updated_at: '2026-09-11T14:52:48.008850Z',
      },
    ])
  })

  it('parses the exact backend summary payload shape', () => {
    const summary = parseDashboardSummary(
      {
        total_balance: '1234.56',
        current_month_income: '2000.00',
        current_month_expenses: '765.44',
        total_budgeted: '1500.00',
        remaining_budget: '-100.10',
        recent_transactions: [
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
        ],
      },
      200,
    )

    expect(summary.recent_transactions[0]).toEqual({
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
  })

  it('parses a valid thirteen-key recent transaction', async () => {
    installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(
          summaryFixture({
            recent_transactions: [transactionFixture({ id: 7 })],
          }),
        )
      }
      return jsonResponse({}, 404)
    })

    const summary = await fetchDashboardSummary()

    expect(summary.recent_transactions).toHaveLength(1)
    expect(summary.recent_transactions[0].id).toBe(7)
    expect(summary.recent_transactions[0].source).toBe('manual')
    expect(summary.recent_transactions[0].provider_name).toBe('')
    expect(summary.recent_transactions[0].is_pending).toBe(false)
    expect(summary.recent_transactions[0].is_pending_initial_import).toBe(false)
  })

  it('rejects a recent transaction missing source as malformed', async () => {
    installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(
          summaryFixture({
            recent_transactions: [withoutKey(transactionFixture(), 'source')],
          }),
        )
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchDashboardSummary())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  const malformedVariants: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an array payload', []],
    ['a string payload', 'nope'],
    ['a missing summary key', withoutKey(summaryFixture(), 'total_budgeted')],
    ['an extra summary key', { ...summaryFixture(), extra: 'nope' }],
    ['a wrong-typed money value', summaryFixture({ total_balance: 1234.56 })],
    ['a one-decimal money value', summaryFixture({ total_balance: '12.3' })],
    ['a comma-grouped money value', summaryFixture({ total_balance: '1,234.56' })],
    ['a non-numeric money value', summaryFixture({ remaining_budget: 'not-money' })],
    ['a null transactions field', summaryFixture({ recent_transactions: null })],
    [
      'an invalid transaction type',
      summaryFixture({
        recent_transactions: [transactionFixture({ transaction_type: 'transfer' })],
      }),
    ],
    ['a zero transaction id', summaryFixture({ recent_transactions: [transactionFixture({ id: 0 })] })],
    ['a negative transaction id', summaryFixture({ recent_transactions: [transactionFixture({ id: -3 })] })],
    ['a fractional transaction id', summaryFixture({ recent_transactions: [transactionFixture({ id: 1.5 })] })],
    ['a string transaction id', summaryFixture({ recent_transactions: [transactionFixture({ id: '1' })] })],
    ['an unsafe transaction id', summaryFixture({ recent_transactions: [transactionFixture({ id: 9007199254740992 })] })],
    ['a zero account id', summaryFixture({ recent_transactions: [transactionFixture({ account: 0 })] })],
    ['a fractional account id', summaryFixture({ recent_transactions: [transactionFixture({ account: 1.5 })] })],
    ['a string account id', summaryFixture({ recent_transactions: [transactionFixture({ account: '1' })] })],
    ['a zero category id', summaryFixture({ recent_transactions: [transactionFixture({ category: 0 })] })],
    ['a fractional category id', summaryFixture({ recent_transactions: [transactionFixture({ category: 1.5 })] })],
    ['a string category id', summaryFixture({ recent_transactions: [transactionFixture({ category: '1' })] })],
    ['a zero transaction amount', summaryFixture({ recent_transactions: [transactionFixture({ amount: '0.00' })] })],
    ['a negative transaction amount', summaryFixture({ recent_transactions: [transactionFixture({ amount: '-1.00' })] })],
    ['a one-decimal transaction amount', summaryFixture({ recent_transactions: [transactionFixture({ amount: '1.5' })] })],
    ['an exponent transaction amount', summaryFixture({ recent_transactions: [transactionFixture({ amount: '1e3' })] })],
    ['a three-decimal transaction amount', summaryFixture({ recent_transactions: [transactionFixture({ amount: '1.500' })] })],
    ['a numeric transaction amount', summaryFixture({ recent_transactions: [transactionFixture({ amount: 12.5 })] })],
    ['an empty-string transaction amount', summaryFixture({ recent_transactions: [transactionFixture({ amount: '' })] })],
    ['a malformed transaction date', summaryFixture({ recent_transactions: [transactionFixture({ date: '09/15/2026' })] })],
    ['an impossible transaction date', summaryFixture({ recent_transactions: [transactionFixture({ date: '2026-02-30' })] })],
    ['a datetime transaction date', summaryFixture({ recent_transactions: [transactionFixture({ date: '2026-09-11T00:00:00Z' })] })],
    ['a numeric transaction note', summaryFixture({ recent_transactions: [transactionFixture({ note: 42 })] })],
    ['a null transaction note', summaryFixture({ recent_transactions: [transactionFixture({ note: null })] })],
    ['a malformed created_at', summaryFixture({ recent_transactions: [transactionFixture({ created_at: '2026-09-15' })] })],
    ['an impossible created_at calendar date', summaryFixture({ recent_transactions: [transactionFixture({ created_at: '2026-02-30T12:00:00Z' })] })],
    ['an impossible updated_at calendar date', summaryFixture({ recent_transactions: [transactionFixture({ updated_at: '2026-02-30T12:00:00Z' })] })],
    ['a transaction missing a key', summaryFixture({ recent_transactions: [withoutKey(transactionFixture(), 'note')] })],
    ['a transaction with an extra key', summaryFixture({ recent_transactions: [{ ...transactionFixture(), user: 1 }] })],
    ['an unknown transaction source', summaryFixture({ recent_transactions: [transactionFixture({ source: 'card' })] })],
    ['a numeric transaction source', summaryFixture({ recent_transactions: [transactionFixture({ source: 42 })] })],
    ['a null transaction source', summaryFixture({ recent_transactions: [transactionFixture({ source: null })] })],
    ['a numeric provider_name', summaryFixture({ recent_transactions: [transactionFixture({ provider_name: 42 })] })],
    ['an overlong provider_name', summaryFixture({ recent_transactions: [transactionFixture({ provider_name: 'x'.repeat(201) })] })],
    ['a numeric is_pending', summaryFixture({ recent_transactions: [transactionFixture({ is_pending: 1 })] })],
    ['a string is_pending', summaryFixture({ recent_transactions: [transactionFixture({ is_pending: 'true' })] })],
    ['a null is_pending', summaryFixture({ recent_transactions: [transactionFixture({ is_pending: null })] })],
    ['a numeric is_pending_initial_import', summaryFixture({ recent_transactions: [transactionFixture({ is_pending_initial_import: 1 })] })],
    ['a string is_pending_initial_import', summaryFixture({ recent_transactions: [transactionFixture({ is_pending_initial_import: 'false' })] })],
    ['a null is_pending_initial_import', summaryFixture({ recent_transactions: [transactionFixture({ is_pending_initial_import: null })] })],
    ['a manual row with a provider_name', summaryFixture({ recent_transactions: [transactionFixture({ provider_name: 'Chase' })] })],
    ['a manual row with is_pending', summaryFixture({ recent_transactions: [transactionFixture({ is_pending: true })] })],
    ['a manual row with is_pending_initial_import', summaryFixture({ recent_transactions: [transactionFixture({ is_pending_initial_import: true })] })],
    [
      'six recent transactions',
      summaryFixture({
        recent_transactions: [
          transactionFixture({ id: 1 }),
          transactionFixture({ id: 2 }),
          transactionFixture({ id: 3 }),
          transactionFixture({ id: 4 }),
          transactionFixture({ id: 5 }),
          transactionFixture({ id: 6 }),
        ],
      }),
    ],
  ]

  it.each(malformedVariants)(
    'rejects %s safely with the real status',
    async (_label, payload) => {
      installFetchMock((url) => {
        if (url === '/api/dashboard/summary/') return jsonResponse(payload, 200)
        return jsonResponse({}, 404)
      })

      const error = await rejection(fetchDashboardSummary())
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.status).toBe(200)
        expect(error.message).toBe('Unexpected server response.')
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
    },
  )

  it('rejects a 204 response safely with the real status', async () => {
    installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchDashboardSummary())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('rejects a structurally valid summary at 201 safely', async () => {
    installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(summaryFixture(), 201)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchDashboardSummary())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('shares a single in-flight request and clears it on settle', async () => {
    let callsCount = 0
    const mock = installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') {
        callsCount += 1
        return jsonResponse(summaryFixture())
      }
      return jsonResponse({}, 404)
    })

    const first = fetchDashboardSummary()
    const second = fetchDashboardSummary()
    expect(await first).toBeDefined()
    expect(await second).toBeDefined()
    expect(callsCount).toBe(1)

    await fetchDashboardSummary()
    expect(callsCount).toBe(2)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(2)
  })

  it('preserves a 401 status and safe network failures', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      return jsonResponse({}, 404)
    })
    const error = await rejection(fetchDashboardSummary())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(401)
      expect(error.detail).toBe('Authentication credentials were not provided.')
    }

    installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse({}, 404)
    })
    const networkError = await rejection(fetchDashboardSummary())
    expect(networkError).toBeInstanceOf(ApiError)
    if (networkError instanceof ApiError) {
      expect(networkError.status).toBeNull()
      expect(networkError.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock((url) => {
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(summaryFixture())
      }
      return jsonResponse({}, 404)
    })

    await fetchDashboardSummary()

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})