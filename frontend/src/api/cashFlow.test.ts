import { afterEach, describe, expect, it } from 'vitest'
import {
  fetchCashFlowSummary,
  parseCashFlowSummary,
  resetCashFlowRequest,
} from './cashFlow'
import { ApiError } from './types'
import {
  calls,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  requestLog,
} from '../test/testUtils'

function categoryFixture(overrides: Record<string, unknown> = {}) {
  return {
    category_id: 1,
    category_name: 'Salary',
    amount: '1000.00',
    transaction_count: 1,
    ...overrides,
  }
}

function summaryFixture(overrides: Record<string, unknown> = {}) {
  return {
    month: '2026-09',
    income: '1000.00',
    expenses: '300.00',
    net: '700.00',
    transaction_count: 3,
    income_categories: [categoryFixture()],
    expense_categories: [categoryFixture({ category_id: 2, category_name: 'Groceries', amount: '300.00', transaction_count: 2 })],
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
  resetCashFlowRequest()
})

describe('fetchCashFlowSummary', () => {
  it('requests the exact URL for the selected month and parses the payload', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        return jsonResponse(summaryFixture())
      }
      return jsonResponse({}, 404)
    })

    const summary = await fetchCashFlowSummary('2026-09')

    expect(requestLog(mock)).toEqual(['GET /api/cash-flow/summary/?month=2026-09'])
    expect(summary.month).toBe('2026-09')
    expect(summary.income).toBe('1000.00')
    expect(summary.expenses).toBe('300.00')
    expect(summary.net).toBe('700.00')
    expect(summary.transaction_count).toBe(3)
    expect(summary.income_categories).toEqual([
      {
        category_id: 1,
        category_name: 'Salary',
        amount: '1000.00',
        transaction_count: 1,
      },
    ])
    expect(summary.expense_categories).toEqual([
      {
        category_id: 2,
        category_name: 'Groceries',
        amount: '300.00',
        transaction_count: 2,
      },
    ])
  })

  it('parses the exact backend summary payload shape', () => {
    const summary = parseCashFlowSummary(
      {
        month: '2026-09',
        income: '1000.00',
        expenses: '300.00',
        net: '700.00',
        transaction_count: 3,
        income_categories: [
          {
            category_id: 1,
            category_name: 'Salary',
            amount: '1000.00',
            transaction_count: 1,
          },
        ],
        expense_categories: [
          {
            category_id: 2,
            category_name: 'Groceries',
            amount: '300.00',
            transaction_count: 2,
          },
        ],
      },
      200,
      '2026-09',
    )

    expect(summary.month).toBe('2026-09')
    expect(summary.income).toBe('1000.00')
    expect(summary.expenses).toBe('300.00')
    expect(summary.net).toBe('700.00')
    expect(summary.transaction_count).toBe(3)
    expect(summary.income_categories[0]).toEqual({
      category_id: 1,
      category_name: 'Salary',
      amount: '1000.00',
      transaction_count: 1,
    })
    expect(summary.expense_categories[0]).toEqual({
      category_id: 2,
      category_name: 'Groceries',
      amount: '300.00',
      transaction_count: 2,
    })
  })

  const malformedVariants: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an array payload', []],
    ['a string payload', 'nope'],
    ['a missing summary key', withoutKey(summaryFixture(), 'income')],
    ['a missing net key', withoutKey(summaryFixture(), 'net')],
    ['a missing transaction_count key', withoutKey(summaryFixture(), 'transaction_count')],
    ['an extra summary key', { ...summaryFixture(), extra: 'nope' }],
    ['a non-string month', summaryFixture({ month: 202609 })],
    ['a malformed month echo', summaryFixture({ month: '2026-9' })],
    ['an out-of-range month echo', summaryFixture({ month: '2026-13' })],
    ['a month echo for the wrong month', summaryFixture({ month: '2026-10' })],
    ['a numeric income', summaryFixture({ income: 1000.0 })],
    ['a one-decimal income', summaryFixture({ income: '12.3' })],
    ['a comma-grouped income', summaryFixture({ income: '1,234.56' })],
    ['a negative income', summaryFixture({ income: '-100.00' })],
    ['a numeric expenses value', summaryFixture({ expenses: 300.0 })],
    ['a negative expenses value', summaryFixture({ expenses: '-300.00' })],
    ['a numeric net value', summaryFixture({ net: 700.0 })],
    ['a numeric transaction_count', summaryFixture({ transaction_count: '3' })],
    ['a negative transaction_count', summaryFixture({ transaction_count: -1 })],
    ['a fractional transaction_count', summaryFixture({ transaction_count: 1.5 })],
    ['an unsafe transaction_count', summaryFixture({ transaction_count: 9007199254740992 })],
    ['a null income_categories field', summaryFixture({ income_categories: null })],
    ['an object income_categories field', summaryFixture({ income_categories: {} })],
    ['a null expense_categories field', summaryFixture({ expense_categories: null })],
    ['a non-array expense_categories field', summaryFixture({ expense_categories: 'nope' })],
    ['a category item that is a string', summaryFixture({ income_categories: ['Salary'] })],
    ['a category item that is null', summaryFixture({ income_categories: [null] })],
    ['a category item missing a key', summaryFixture({ income_categories: [withoutKey(categoryFixture(), 'amount')] })],
    ['a category item with an extra key', summaryFixture({ income_categories: [{ ...categoryFixture(), user: 1 }] })],
    ['a zero category_id', summaryFixture({ income_categories: [categoryFixture({ category_id: 0 })] })],
    ['a negative category_id', summaryFixture({ income_categories: [categoryFixture({ category_id: -3 })] })],
    ['a fractional category_id', summaryFixture({ income_categories: [categoryFixture({ category_id: 1.5 })] })],
    ['a string category_id', summaryFixture({ income_categories: [categoryFixture({ category_id: '1' })] })],
    ['an empty category_name', summaryFixture({ income_categories: [categoryFixture({ category_name: '' })] })],
    ['a blank category_name', summaryFixture({ income_categories: [categoryFixture({ category_name: '   ' })] })],
    ['a numeric category_name', summaryFixture({ income_categories: [categoryFixture({ category_name: 42 })] })],
    ['a numeric category amount', summaryFixture({ income_categories: [categoryFixture({ amount: 1000.0 })] })],
    ['a negative category amount', summaryFixture({ income_categories: [categoryFixture({ amount: '-100.00' })] })],
    ['a one-decimal category amount', summaryFixture({ income_categories: [categoryFixture({ amount: '1.5' })] })],
    ['a string category transaction_count', summaryFixture({ income_categories: [categoryFixture({ transaction_count: '1' })] })],
    ['a negative category transaction_count', summaryFixture({ income_categories: [categoryFixture({ transaction_count: -1 })] })],
    ['a fractional category transaction_count', summaryFixture({ income_categories: [categoryFixture({ transaction_count: 1.5 })] })],
  ]

  it.each(malformedVariants)(
    'rejects %s safely with the real status',
    async (_label, payload) => {
      installFetchMock((url) => {
        if (url === '/api/cash-flow/summary/?month=2026-09') {
          return jsonResponse(payload, 200)
        }
        return jsonResponse({}, 404)
      })

      const error = await rejection(fetchCashFlowSummary('2026-09'))
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
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        return emptyResponse(204)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchCashFlowSummary('2026-09'))
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
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        return jsonResponse(summaryFixture(), 201)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchCashFlowSummary('2026-09'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('shares a single in-flight request for the same month and clears it on settle', async () => {
    let callsCount = 0
    const mock = installFetchMock((url) => {
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        callsCount += 1
        return jsonResponse(summaryFixture())
      }
      return jsonResponse({}, 404)
    })

    const first = fetchCashFlowSummary('2026-09')
    const second = fetchCashFlowSummary('2026-09')
    expect(await first).toBeDefined()
    expect(await second).toBeDefined()
    expect(callsCount).toBe(1)

    await fetchCashFlowSummary('2026-09')
    expect(callsCount).toBe(2)
    expect(calls(mock, '/api/cash-flow/summary/?month=2026-09')).toHaveLength(2)
  })

  it('does not dedupe different months', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        return jsonResponse(summaryFixture())
      }
      if (url === '/api/cash-flow/summary/?month=2026-10') {
        return jsonResponse(summaryFixture({ month: '2026-10' }))
      }
      return jsonResponse({}, 404)
    })

    const first = fetchCashFlowSummary('2026-09')
    const second = fetchCashFlowSummary('2026-10')
    expect((await first).month).toBe('2026-09')
    expect((await second).month).toBe('2026-10')
    expect(calls(mock, '/api/cash-flow/summary/?month=2026-09')).toHaveLength(1)
    expect(calls(mock, '/api/cash-flow/summary/?month=2026-10')).toHaveLength(1)
  })

  it('rejects an invalid month input as a rejection instead of throwing synchronously', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        return jsonResponse(summaryFixture())
      }
      return jsonResponse({}, 404)
    })

    let returned = false
    let pending: Promise<unknown> | null = null
    try {
      pending = fetchCashFlowSummary('2026-13')
      returned = true
    } catch (caught) {
      expect(caught).toBeUndefined()
    }
    expect(returned).toBe(true)
    expect(pending).toBeInstanceOf(Promise)

    const error = await rejection(pending as Promise<unknown>)
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid month.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(mock).not.toHaveBeenCalled()
  })

  it('rejects an empty month input without fetching', async () => {
    installFetchMock(() => jsonResponse(summaryFixture()))

    const error = await rejection(fetchCashFlowSummary(''))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid month.')
    }
  })

  it('preserves a 401 status and safe network failures', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      return jsonResponse({}, 404)
    })
    const error = await rejection(fetchCashFlowSummary('2026-09'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(401)
      expect(error.detail).toBe('Authentication credentials were not provided.')
    }

    installFetchMock((url) => {
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        throw new TypeError('Failed to fetch')
      }
      return jsonResponse({}, 404)
    })
    const networkError = await rejection(fetchCashFlowSummary('2026-09'))
    expect(networkError).toBeInstanceOf(ApiError)
    if (networkError instanceof ApiError) {
      expect(networkError.status).toBeNull()
      expect(networkError.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/cash-flow/summary/?month=2026-09')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock((url) => {
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        return jsonResponse(summaryFixture())
      }
      return jsonResponse({}, 404)
    })

    await fetchCashFlowSummary('2026-09')

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})