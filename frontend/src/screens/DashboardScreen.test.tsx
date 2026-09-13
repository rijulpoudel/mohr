import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  calls,
  deferred,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  renderApp,
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
    id: 10,
    account: 1,
    category: 2,
    transaction_type: 'expense',
    amount: '25.50',
    date: '2026-09-15',
    note: '',
    created_at: '2026-09-15T12:00:00.123456Z',
    updated_at: '2026-09-15T12:00:00.123456Z',
    ...overrides,
  }
}

function withoutKey(record: Record<string, unknown>, key: string) {
  const copy = { ...record }
  delete copy[key]
  return copy
}

function summaryValue(label: string): string {
  const term = screen.getByText(label)
  const item = term.closest('div')
  if (item === null) throw new Error(`No summary item found for ${label}`)
  return item.textContent ?? ''
}

function authenticatedHandler(
  dashboard: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/dashboard/summary/') return dashboard(url, init)
    return jsonResponse({}, 404)
  }
}

describe('dashboard summary', () => {
  it('fetches the summary with the credentialed client and renders five exact values', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse(summaryFixture())),
    )
    renderApp('/')

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(summaryValue('Total balance')).toContain('$1,234.56')
    expect(summaryValue('Income this month')).toContain('$2,000.00')
    expect(summaryValue('Spending this month')).toContain('$765.44')
    expect(summaryValue('Budgeted this month')).toContain('$1,500.00')
    expect(summaryValue('Remaining budget')).toContain('-$100.10')
    expect(screen.getByText('Signed in as student@example.com')).toBeInTheDocument()

    const dashboardCalls = calls(mock, '/api/dashboard/summary/')
    expect(dashboardCalls).toHaveLength(1)
    expect(dashboardCalls[0][1]).toMatchObject({
      method: 'GET',
      credentials: 'include',
    })
  })

  it('renders large and negative values as exact strings', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          summaryFixture({
            total_balance: '123456789012345678.90',
            remaining_budget: '-987654321.01',
          }),
        ),
      ),
    )
    renderApp('/')

    expect(
      await screen.findByText('$123,456,789,012,345,678.90'),
    ).toBeInTheDocument()
    expect(screen.getByText('-$987,654,321.01')).toBeInTheDocument()
  })

  it('shows an accessible loading status while the summary is pending', async () => {
    const pending = deferred<Response>()
    installFetchMock(authenticatedHandler(() => pending.promise))
    renderApp('/')

    expect(await screen.findByText('Loading your dashboard…')).toBeInTheDocument()

    await act(async () => {
      pending.resolve(jsonResponse(summaryFixture()))
    })
    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.queryByText('Loading your dashboard…')).not.toBeInTheDocument()
  })

  it('shows a meaningful empty state without recent transactions', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(summaryFixture({ recent_transactions: [] })),
      ),
    )
    renderApp('/')

    expect(await screen.findByText('Recent transactions')).toBeInTheDocument()
    expect(screen.getByText(/No transactions yet/)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('retries a failed request and clears the stale error', async () => {
    let dashboardCalls = 0
    const mock = installFetchMock(
      authenticatedHandler(() => {
        dashboardCalls += 1
        if (dashboardCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse(summaryFixture())
      }),
    )
    renderApp('/')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(2)
  })

  it('issues exactly one dashboard request under StrictMode', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse(summaryFixture())),
    )
    renderApp('/')

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })

  it('ignores a dashboard response that settles after unmount', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(authenticatedHandler(() => pending.promise))
    const view = renderApp('/')

    expect(await screen.findByText('Loading your dashboard…')).toBeInTheDocument()
    view.unmount()
    await act(async () => {
      pending.resolve(jsonResponse(summaryFixture({ total_balance: '9999.99' })))
    })

    expect(screen.queryByText('$9,999.99')).not.toBeInTheDocument()
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })
})

describe('recent transaction semantics', () => {
  it('renders type, signed amount, date, and optional note without exposing raw IDs', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          summaryFixture({
            recent_transactions: [
              transactionFixture({
                id: 11,
                account: 3,
                category: 4,
                transaction_type: 'income',
                amount: '1000.00',
                date: '2026-09-14',
                note: 'Paycheck',
              }),
              transactionFixture({
                id: 12,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '25.50',
                date: '2026-09-15',
                note: '',
              }),
            ],
          }),
        ),
      ),
    )
    renderApp('/')

    expect(await screen.findByText('+$1,000.00')).toBeInTheDocument()
    expect(screen.getByText('-$25.50')).toBeInTheDocument()
    expect(screen.getByText('Income')).toBeInTheDocument()
    expect(screen.getByText('Expense')).toBeInTheDocument()
    expect(screen.getByText('Paycheck')).toBeInTheDocument()
    expect(screen.queryByText('Account #3')).not.toBeInTheDocument()
    expect(screen.queryByText('Category #4')).not.toBeInTheDocument()
    expect(screen.queryByText('Account #1')).not.toBeInTheDocument()
    expect(screen.queryByText('Category #2')).not.toBeInTheDocument()

    const date = screen.getByText('2026-09-14')
    expect(date.tagName).toBe('TIME')
    expect(date).toHaveAttribute('datetime', '2026-09-14')

    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('malformed dashboard payloads', () => {
  const malformedPayloads: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an array payload', []],
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
    [
      'a fractional transaction id',
      summaryFixture({ recent_transactions: [transactionFixture({ id: 1.5 })] }),
    ],
    [
      'a string transaction id',
      summaryFixture({ recent_transactions: [transactionFixture({ id: '1' })] }),
    ],
    [
      'a malformed transaction date',
      summaryFixture({
        recent_transactions: [transactionFixture({ date: '09/15/2026' })],
      }),
    ],
    [
      'an impossible transaction date',
      summaryFixture({
        recent_transactions: [transactionFixture({ date: '2026-02-30' })],
      }),
    ],
    [
      'a malformed created_at',
      summaryFixture({
        recent_transactions: [transactionFixture({ created_at: '2026-09-15' })],
      }),
    ],
    [
      'a transaction missing a key',
      summaryFixture({
        recent_transactions: [withoutKey(transactionFixture(), 'note')],
      }),
    ],
    [
      'a transaction with an extra key',
      summaryFixture({
        recent_transactions: [{ ...transactionFixture(), user: 1 }],
      }),
    ],
    [
      'a zero transaction amount',
      summaryFixture({
        recent_transactions: [transactionFixture({ amount: '0.00' })],
      }),
    ],
    [
      'an id above the safe integer range',
      summaryFixture({
        recent_transactions: [transactionFixture({ id: 9007199254740992 })],
      }),
    ],
    [
      'an impossible created_at calendar date',
      summaryFixture({
        recent_transactions: [
          transactionFixture({ created_at: '2026-02-30T12:00:00Z' }),
        ],
      }),
    ],
    [
      'an impossible updated_at calendar date',
      summaryFixture({
        recent_transactions: [
          transactionFixture({ updated_at: '2026-02-30T12:00:00Z' }),
        ],
      }),
    ],
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

  it.each(malformedPayloads)('rejects %s safely', async (_label, payload) => {
    installFetchMock(authenticatedHandler(() => jsonResponse(payload)))
    renderApp('/')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('Total balance')).not.toBeInTheDocument()
  })

  it('rejects a 204 summary safely with the malformed error and Retry', async () => {
    installFetchMock(authenticatedHandler(() => emptyResponse(204)))
    renderApp('/')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('Total balance')).not.toBeInTheDocument()
  })

  it('rejects a structurally valid summary at 201 safely', async () => {
    installFetchMock(
      authenticatedHandler(() => jsonResponse(summaryFixture(), 201)),
    )
    renderApp('/')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText('Total balance')).not.toBeInTheDocument()
  })
})

describe('dashboard session expiry', () => {
  it('clears in-memory auth and redirects to login on 401 without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )
    renderApp('/')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/dashboard/summary/',
    ])
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('logout from the dashboard', () => {
  it('fetches a CSRF token, posts logout, and returns to login on a 204', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'out@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(summaryFixture())
      }
      if (url === '/api/auth/csrf/') {
        document.cookie = 'csrftoken=logout-csrf-token; Path=/'
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/logout/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    renderApp('/')
    await screen.findByText('Signed in as out@example.com')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/dashboard/summary/',
      'GET /api/auth/csrf/',
      'POST /api/auth/logout/',
    ])
    const logoutCalls = calls(mock, '/api/auth/logout/', 'POST')
    expect(logoutCalls).toHaveLength(1)
    const init = logoutCalls[0][1]
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe('logout-csrf-token')
    expect(headers.get('Content-Type')).toBeNull()
    expect(init?.body).toBeUndefined()
  })

  it('keeps the user authenticated when logout fails', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'stuck@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(summaryFixture())
      }
      if (url === '/api/auth/csrf/') {
        document.cookie = 'csrftoken=logout-csrf-token; Path=/'
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/logout/') {
        return new Response(null, { status: 500 })
      }
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    renderApp('/')
    await screen.findByText('Signed in as stuck@example.com')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not sign out',
    )
    expect(
      screen.getByText('Signed in as stuck@example.com'),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('keeps the user authenticated when logout returns a 200 JSON body', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'stuck@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse(summaryFixture())
      }
      if (url === '/api/auth/csrf/') {
        document.cookie = 'csrftoken=logout-csrf-token; Path=/'
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/logout/') {
        return jsonResponse({ detail: 'Signed out.' })
      }
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    renderApp('/')
    await screen.findByText('Signed in as stuck@example.com')
    await user.click(screen.getByRole('button', { name: 'Sign out' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not sign out',
    )
    expect(
      screen.getByText('Signed in as stuck@example.com'),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
    expect(
      calls(mock, '/api/auth/logout/', 'POST'),
    ).toHaveLength(1)
  })
})
