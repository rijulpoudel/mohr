import { afterEach, describe, expect, it } from 'vitest'
import {
  createBudget,
  deleteBudget,
  fetchBudgets,
  resetBudgetsRequest,
  updateBudget,
} from './budgets'
import type { BudgetInput } from './budgets'
import { resetApiRequests } from './resetRequests'
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

function budgetFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    category: 2,
    month: '2026-09-01',
    budgeted: '100.00',
    spent: '12.50',
    remaining: '87.50',
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

function createInput(overrides: Partial<BudgetInput> = {}): BudgetInput {
  return {
    category: 2,
    month: '2026-09-01',
    budgeted: '100.00',
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
  resetBudgetsRequest()
})

describe('fetchBudgets', () => {
  it('parses the budget list in server order with all eight keys', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/budgets/') {
        return jsonResponse([
          budgetFixture({
            id: 1,
            category: 2,
            month: '2026-09-01',
            budgeted: '100.00',
            spent: '12.50',
            remaining: '87.50',
            created_at: '2026-09-10T10:00:00Z',
            updated_at: '2026-09-10T10:00:00Z',
          }),
          budgetFixture({
            id: 2,
            category: 3,
            month: '2026-10-01',
            budgeted: '2500.00',
            spent: '-12.50',
            remaining: '1234567890123.45',
            created_at: '2026-09-11T16:08:00.000000Z',
            updated_at: '2026-09-11T16:08:00.000000Z',
          }),
        ])
      }
      return jsonResponse({}, 404)
    })

    const budgets = await fetchBudgets()

    expect(requestLog(mock)).toEqual(['GET /api/budgets/'])
    expect(budgets).toHaveLength(2)
    expect(budgets[0]).toEqual({
      id: 1,
      category: 2,
      month: '2026-09-01',
      budgeted: '100.00',
      spent: '12.50',
      remaining: '87.50',
      created_at: '2026-09-10T10:00:00Z',
      updated_at: '2026-09-10T10:00:00Z',
    })
    expect(budgets[1]).toEqual({
      id: 2,
      category: 3,
      month: '2026-10-01',
      budgeted: '2500.00',
      spent: '-12.50',
      remaining: '1234567890123.45',
      created_at: '2026-09-11T16:08:00.000000Z',
      updated_at: '2026-09-11T16:08:00.000000Z',
    })
  })

  it('accepts a large spent value beyond 12 digits', async () => {
    installFetchMock((url) => {
      if (url === '/api/budgets/') {
        return jsonResponse([
          budgetFixture({ spent: '1234567890123.45', remaining: '0.00' }),
        ])
      }
      return jsonResponse({}, 404)
    })

    const budgets = await fetchBudgets()

    expect(budgets).toHaveLength(1)
    expect(budgets[0].spent).toBe('1234567890123.45')
  })

  it('accepts a negative remaining value when overspent', async () => {
    installFetchMock((url) => {
      if (url === '/api/budgets/') {
        return jsonResponse([
          budgetFixture({ spent: '105.00', remaining: '-5.00' }),
        ])
      }
      return jsonResponse({}, 404)
    })

    const budgets = await fetchBudgets()

    expect(budgets).toHaveLength(1)
    expect(budgets[0].spent).toBe('105.00')
    expect(budgets[0].remaining).toBe('-5.00')
  })

  it('accepts a budgeted value at exactly 12 total digits', async () => {
    installFetchMock((url) => {
      if (url === '/api/budgets/') {
        return jsonResponse([budgetFixture({ budgeted: '1234567890.12' })])
      }
      return jsonResponse({}, 404)
    })

    const budgets = await fetchBudgets()

    expect(budgets).toHaveLength(1)
    expect(budgets[0].budgeted).toBe('1234567890.12')
  })

  const malformedVariants: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an object payload', { id: 1 }],
    ['a string payload', 'nope'],
    ['a missing key', [withoutKey(budgetFixture(), 'budgeted')]],
    ['an extra key', [{ ...budgetFixture(), owner: 1 }]],
    ['an extra user key', [{ ...budgetFixture(), user: 1 }]],
    ['a zero id', [budgetFixture({ id: 0 })]],
    ['a negative id', [budgetFixture({ id: -3 })]],
    ['a fractional id', [budgetFixture({ id: 1.5 })]],
    ['a string id', [budgetFixture({ id: '1' })]],
    ['an unsafe id', [budgetFixture({ id: 9007199254740992 })]],
    ['a NaN id', [budgetFixture({ id: Number.NaN })]],
    ['a zero category', [budgetFixture({ category: 0 })]],
    ['a negative category', [budgetFixture({ category: -3 })]],
    ['a fractional category', [budgetFixture({ category: 1.5 })]],
    ['a string category', [budgetFixture({ category: '1' })]],
    ['an unsafe category', [budgetFixture({ category: 9007199254740992 })]],
    ['an impossible month', [budgetFixture({ month: '2026-02-30' })]],
    ['a non-first-day month', [budgetFixture({ month: '2026-09-11' })]],
    ['a month-end date', [budgetFixture({ month: '2026-09-30' })]],
    ['a datetime month', [budgetFixture({ month: '2026-09-01T00:00:00Z' })]],
    ['a slash month', [budgetFixture({ month: '09/01/2026' })]],
    ['a single-digit month', [budgetFixture({ month: '2026-9-01' })]],
    ['a numeric month', [budgetFixture({ month: 20260901 })]],
    ['a zero budgeted', [budgetFixture({ budgeted: '0.00' })]],
    ['a negative budgeted', [budgetFixture({ budgeted: '-1.00' })]],
    ['a one-decimal budgeted', [budgetFixture({ budgeted: '1.5' })]],
    ['an exponent budgeted', [budgetFixture({ budgeted: '1e3' })]],
    ['a three-decimal budgeted', [budgetFixture({ budgeted: '1.500' })]],
    ['a 13-digit budgeted', [budgetFixture({ budgeted: '12345678901.23' })]],
    ['a numeric budgeted', [budgetFixture({ budgeted: 12.5 })]],
    ['an empty-string budgeted', [budgetFixture({ budgeted: '' })]],
    ['a one-decimal spent', [budgetFixture({ spent: '1.5' })]],
    ['an exponent spent', [budgetFixture({ spent: '1e3' })]],
    ['a three-decimal spent', [budgetFixture({ spent: '1.500' })]],
    ['a numeric spent', [budgetFixture({ spent: 12.5 })]],
    ['an empty-string spent', [budgetFixture({ spent: '' })]],
    ['a plus-sign spent', [budgetFixture({ spent: '+1.00' })]],
    ['a one-decimal remaining', [budgetFixture({ remaining: '1.5' })]],
    ['an exponent remaining', [budgetFixture({ remaining: '1e3' })]],
    ['a three-decimal remaining', [budgetFixture({ remaining: '1.500' })]],
    ['a numeric remaining', [budgetFixture({ remaining: 12.5 })]],
    ['an empty-string remaining', [budgetFixture({ remaining: '' })]],
    ['a plus-sign remaining', [budgetFixture({ remaining: '+1.00' })]],
    ['an impossible created_at date', [budgetFixture({ created_at: '2026-02-30T12:00:00Z' })]],
    ['a date-only created_at', [budgetFixture({ created_at: '2026-09-11' })]],
    ['a malformed created_at', [budgetFixture({ created_at: 'garbage' })]],
    ['an impossible updated_at date', [budgetFixture({ updated_at: '2026-02-30T12:00:00Z' })]],
    ['a date-only updated_at', [budgetFixture({ updated_at: '2026-09-11' })]],
    ['a malformed updated_at', [budgetFixture({ updated_at: 'garbage' })]],
    ['a missing updated_at', [withoutKey(budgetFixture(), 'updated_at')]],
  ]

  it.each(malformedVariants)(
    'rejects %s safely with the real status',
    async (_label, payload) => {
      installFetchMock((url) => {
        if (url === '/api/budgets/') return jsonResponse(payload, 200)
        return jsonResponse({}, 404)
      })

      const error = await rejection(fetchBudgets())
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
      if (url === '/api/budgets/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchBudgets())
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
      if (url === '/api/budgets/') {
        return jsonResponse([budgetFixture({ id: 1 })], 201)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchBudgets())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('shares a single in-flight request for concurrent calls and clears it on settle', async () => {
    let callsCount = 0
    const mock = installFetchMock((url) => {
      if (url === '/api/budgets/') {
        callsCount += 1
        return jsonResponse([budgetFixture()])
      }
      return jsonResponse({}, 404)
    })

    const first = fetchBudgets()
    const second = fetchBudgets()
    expect(await first).toHaveLength(1)
    expect(await second).toHaveLength(1)
    expect(callsCount).toBe(1)

    await fetchBudgets()
    expect(callsCount).toBe(2)
    expect(calls(mock, '/api/budgets/')).toHaveLength(2)
  })

  it('starts a fresh request after resetBudgetsRequest clears the in-flight entry', async () => {
    let callsCount = 0
    installFetchMock((url) => {
      if (url === '/api/budgets/') {
        callsCount += 1
        return jsonResponse([budgetFixture()])
      }
      return jsonResponse({}, 404)
    })

    const first = fetchBudgets()
    resetBudgetsRequest()
    const second = fetchBudgets()
    expect(await first).toHaveLength(1)
    expect(await second).toHaveLength(1)
    expect(callsCount).toBe(2)
  })

  it('starts a fresh request after resetApiRequests clears the in-flight entry', async () => {
    let callsCount = 0
    installFetchMock((url) => {
      if (url === '/api/budgets/') {
        callsCount += 1
        return jsonResponse([budgetFixture()])
      }
      return jsonResponse({}, 404)
    })

    const first = fetchBudgets()
    resetApiRequests()
    const second = fetchBudgets()
    expect(await first).toHaveLength(1)
    expect(await second).toHaveLength(1)
    expect(callsCount).toBe(2)
  })

  it('does not let a superseded request clear the newer map entry after reset', async () => {
    let callsCount = 0
    const firstResponse = deferred<Response>()
    const secondResponse = deferred<Response>()
    installFetchMock((url) => {
      if (url === '/api/budgets/') {
        callsCount += 1
        if (callsCount === 1) return firstResponse.promise
        return secondResponse.promise
      }
      return jsonResponse({}, 404)
    })

    const first = fetchBudgets()
    resetApiRequests()
    const second = fetchBudgets()
    expect(callsCount).toBe(2)

    firstResponse.resolve(jsonResponse([budgetFixture()]))
    await first

    const third = fetchBudgets()
    expect(callsCount).toBe(2)
    secondResponse.resolve(jsonResponse([budgetFixture()]))
    expect(await second).toHaveLength(1)
    expect(await third).toHaveLength(1)
    expect(callsCount).toBe(2)
  })

  it('preserves a 401 status without logging out or touching storage', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/budgets/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      return jsonResponse({}, 404)
    })
    const error = await rejection(fetchBudgets())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(401)
      expect(error.detail).toBe('Authentication credentials were not provided.')
    }
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/budgets/')).toHaveLength(1)
  })

  it('throws a safe network error when the server cannot be reached', async () => {
    installFetchMock((url) => {
      if (url === '/api/budgets/') throw new TypeError('Failed to fetch')
      return jsonResponse({}, 404)
    })
    const networkError = await rejection(fetchBudgets())
    expect(networkError).toBeInstanceOf(ApiError)
    if (networkError instanceof ApiError) {
      expect(networkError.status).toBeNull()
      expect(networkError.message).toBe('Could not reach the server.')
    }
  })

  it('never writes to local or session storage', async () => {
    installFetchMock((url) => {
      if (url === '/api/budgets/') return jsonResponse([budgetFixture()])
      return jsonResponse({}, 404)
    })

    await fetchBudgets()

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('createBudget', () => {
  it('bootstraps CSRF then POSTs exactly three writable fields and parses the 201 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/') {
          return jsonResponse(budgetFixture({ id: 9, category: 2 }), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const budget = await createBudget(createInput())

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/budgets/',
    ])
    const posts = calls(mock, '/api/budgets/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/budgets/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBe(
      JSON.stringify({ category: 2, month: '2026-09-01', budgeted: '100.00' }),
    )
    expect(budget).toEqual({
      id: 9,
      category: 2,
      month: '2026-09-01',
      budgeted: '100.00',
      spent: '12.50',
      remaining: '87.50',
      created_at: '2026-09-11T14:52:48.008850Z',
      updated_at: '2026-09-11T14:52:48.008850Z',
    })
  })

  it('rejects a 200 response even with a valid Budget payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/') {
          return jsonResponse(budgetFixture(), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createBudget(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
  })

  it('rejects a 204 response even for an exact create', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createBudget(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
  })

  it('rejects a malformed 201 response safely', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/') return jsonResponse({ id: 1 }, 201)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createBudget(createInput()))
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
      if (url === '/api/budgets/') return jsonResponse(budgetFixture(), 201)
      return jsonResponse({}, 404)
    })

    const error = await rejection(createBudget(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(0)
  })

  it('preserves backend field errors from a 400 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/') {
          return jsonResponse(
            {
              category: ['Archived categories cannot be used for new budgets.'],
              budgeted: ['Ensure that there are no more than 10 digits before the decimal point.'],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createBudget(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.category).toEqual([
        'Archived categories cannot be used for new budgets.',
      ])
      expect(error.fieldErrors.budgeted).toEqual([
        'Ensure that there are no more than 10 digits before the decimal point.',
      ])
    }
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
  })

  it('preserves backend non-field errors from a 400 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/') {
          return jsonResponse(
            { non_field_errors: ['A budget for this month already exists.'] },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createBudget(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.non_field_errors).toEqual([
        'A budget for this month already exists.',
      ])
    }
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
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
      () => jsonResponse({ detail: 'No Budget matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/budgets/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(createBudget(createInput()))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
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

    const error = await rejection(createBudget(createInput()))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/') {
          return jsonResponse(budgetFixture(), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    await createBudget(createInput())

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('updateBudget', () => {
  it('bootstraps CSRF then PATCHes only the provided keys and parses the 200 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url, init) => {
        if (url === '/api/budgets/7/') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse(budgetFixture({ id: 7, ...body }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const budget = await updateBudget(7, { budgeted: '250.00' })

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'PATCH /api/budgets/7/',
    ])
    const patches = calls(mock, '/api/budgets/7/', 'PATCH')
    expect(patches).toHaveLength(1)
    const [input, init] = patches[0]
    expect(String(input)).toBe('/api/budgets/7/')
    expect(init?.method).toBe('PATCH')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(JSON.parse(String(init?.body))).toEqual({ budgeted: '250.00' })
    expect(budget.id).toBe(7)
    expect(budget.budgeted).toBe('250.00')
  })

  it('PATCHes all three writable fields and never server-controlled fields', async () => {
    const mock = installFetchMock(
      mutationHandler((url, init) => {
        if (url === '/api/budgets/11/') {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>
          return jsonResponse(budgetFixture({ id: 11, ...body }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const budget = await updateBudget(11, {
      category: 4,
      month: '2026-10-01',
      budgeted: '300.00',
    })

    const patches = calls(mock, '/api/budgets/11/', 'PATCH')
    expect(patches).toHaveLength(1)
    expect(JSON.parse(String(patches[0][1]?.body))).toEqual({
      category: 4,
      month: '2026-10-01',
      budgeted: '300.00',
    })
    expect(budget.id).toBe(11)
    expect(budget.category).toBe(4)
    expect(budget.month).toBe('2026-10-01')
    expect(budget.budgeted).toBe('300.00')
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call as a promise rejection', async (_label, budgetId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    let promise: Promise<unknown> | undefined
    let threwSynchronously = false
    try {
      promise = updateBudget(budgetId as number, { budgeted: '1.00' })
    } catch {
      threwSynchronously = true
    }
    expect(threwSynchronously).toBe(false)
    expect(promise).toBeInstanceOf(Promise)

    const error = await rejection(promise as Promise<unknown>)
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid budget id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('rejects a 201 response even with a valid matching Budget payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') {
          return jsonResponse(budgetFixture({ id: 7 }), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/budgets/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a 204 response even for an exact update', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/budgets/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a 200 response whose id does not match the requested budget id', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') {
          return jsonResponse(budgetFixture({ id: 8 }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/budgets/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a malformed 200 response safely', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') return jsonResponse({}, 200)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
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
      if (url === '/api/budgets/7/') return jsonResponse(budgetFixture(), 200)
      return jsonResponse({}, 404)
    })

    const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/budgets/7/', 'PATCH')).toHaveLength(0)
  })

  it('preserves backend field errors from a 400 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') {
          return jsonResponse(
            {
              budgeted: ['Ensure that there are no more than 10 digits before the decimal point.'],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.budgeted).toEqual([
        'Ensure that there are no more than 10 digits before the decimal point.',
      ])
    }
    expect(calls(mock, '/api/budgets/7/', 'PATCH')).toHaveLength(1)
  })

  it('preserves backend non-field errors from a 400 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') {
          return jsonResponse(
            { non_field_errors: ['A budget for this month already exists.'] },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.non_field_errors).toEqual([
        'A budget for this month already exists.',
      ])
    }
    expect(calls(mock, '/api/budgets/7/', 'PATCH')).toHaveLength(1)
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
      () => jsonResponse({ detail: 'No Budget matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/budgets/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/budgets/7/', 'PATCH')).toHaveLength(1)
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

    const error = await rejection(updateBudget(7, { budgeted: '250.00' }))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/budgets/7/', 'PATCH')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') {
          return jsonResponse(budgetFixture({ id: 7 }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    await updateBudget(7, { budgeted: '250.00' })

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('deleteBudget', () => {
  it('bootstraps CSRF then DELETEs the budget path and resolves on an empty 204', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    await expect(deleteBudget(7)).resolves.toBeUndefined()

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'DELETE /api/budgets/7/',
    ])
    const deletes = calls(mock, '/api/budgets/7/', 'DELETE')
    expect(deletes).toHaveLength(1)
    const [input, init] = deletes[0]
    expect(String(input)).toBe('/api/budgets/7/')
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBeUndefined()
  })

  it.each([
    ['a 200 response with a JSON body', () => jsonResponse(budgetFixture(), 200)],
    ['a 200 response with an empty body', () => new Response(null, { status: 200 })],
  ])('rejects unexpected success on %s safely', async (_label, respond) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') return respond()
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(deleteBudget(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/budgets/7/', 'DELETE')).toHaveLength(1)
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call as a promise rejection', async (_label, budgetId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    let promise: Promise<unknown> | undefined
    let threwSynchronously = false
    try {
      promise = deleteBudget(budgetId as number)
    } catch {
      threwSynchronously = true
    }
    expect(threwSynchronously).toBe(false)
    expect(promise).toBeInstanceOf(Promise)

    const error = await rejection(promise as Promise<unknown>)
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid budget id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('aborts before DELETE when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/budgets/7/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(deleteBudget(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/budgets/7/', 'DELETE')).toHaveLength(0)
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
      () => jsonResponse({ detail: 'No Budget matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/budgets/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )

      const error = await rejection(deleteBudget(7))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/budgets/7/', 'DELETE')).toHaveLength(1)
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

    const error = await rejection(deleteBudget(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/budgets/7/', 'DELETE')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/budgets/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    await deleteBudget(7)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
