import { act, screen, within } from '@testing-library/react'
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
    source: 'manual',
    provider_name: '',
    is_pending: false,
    is_pending_initial_import: false,
    created_at: '2026-09-15T12:00:00.123456Z',
    updated_at: '2026-09-15T12:00:00.123456Z',
    ...overrides,
  }
}

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
    expect(screen.getAllByText('-$987,654,321.01')).toHaveLength(2)
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

  it('ignores a late dashboard 401 after navigating away', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock((url: string) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/dashboard/summary/') return pending.promise
      if (url === '/api/accounts/') return jsonResponse([accountFixture()])
      return jsonResponse({}, 404)
    })
    renderApp('/')

    expect(await screen.findByText('Loading your dashboard…')).toBeInTheDocument()

    const user = userEvent.setup()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }))

    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/accounts')

    await act(async () => {
      pending.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/accounts')
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(calls(mock, '/api/auth/logout/', 'POST')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
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

    const date = screen.getByText('Sep 14, 2026')
    expect(date.tagName).toBe('TIME')
    expect(date).toHaveAttribute('datetime', '2026-09-14')
    expect(screen.getByText('Sep 15, 2026')).toHaveAttribute(
      'datetime',
      '2026-09-15',
    )

    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('dashboard ready state', () => {
  it('keeps the Overview heading and adds a truthful subtitle with a secondary sign-out', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse(summaryFixture())))
    renderApp('/')

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Overview' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Your money this month, without the noise.'),
    ).toBeInTheDocument()
    const signOut = screen.getByRole('button', { name: 'Sign out' })
    expect(signOut).toHaveClass('btn-secondary')
  })

  it('renders four metric cards with exact money strings', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse(summaryFixture())))
    renderApp('/')

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(summaryValue('Total balance')).toContain('$1,234.56')
    expect(summaryValue('Income this month')).toContain('$2,000.00')
    expect(summaryValue('Spending this month')).toContain('$765.44')
    expect(summaryValue('Budget remaining')).toContain('-$100.10')
  })

  it('renders an Income vs spending comparison with exact amounts and proportional decorative bars', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse(summaryFixture())))
    renderApp('/')

    const compare = await screen.findByRole('region', {
      name: 'Income vs spending',
    })
    within(compare).getByText('Money in')
    within(compare).getByText('Money out')
    within(compare).getByText('$2,000.00')
    within(compare).getByText('$765.44')

    const fills = compare.querySelectorAll('.dashboard-compare-fill')
    expect(fills).toHaveLength(2)
    expect((fills[0] as HTMLElement).style.width).toBe('100%')
    expect((fills[1] as HTMLElement).style.width).toBe('38%')
    expect(fills[0].closest('[aria-hidden="true"]')).not.toBeNull()
    expect(fills[1].closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it('scales the comparison bars to the larger amount when one side is zero', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          summaryFixture({
            current_month_income: '0.00',
            current_month_expenses: '500.00',
          }),
        ),
      ),
    )
    renderApp('/')

    const compare = await screen.findByRole('region', {
      name: 'Income vs spending',
    })
    const fills = compare.querySelectorAll('.dashboard-compare-fill')
    expect((fills[0] as HTMLElement).style.width).toBe('0%')
    expect((fills[1] as HTMLElement).style.width).toBe('100%')
  })

  it('renders a very large exact income and expense pair without losing precision', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          summaryFixture({
            current_month_income: '123456789012345678.90',
            current_month_expenses: '99999999999999.99',
          }),
        ),
      ),
    )
    renderApp('/')

    const compare = await screen.findByRole('region', {
      name: 'Income vs spending',
    })
    within(compare).getByText('$123,456,789,012,345,678.90')
    within(compare).getByText('$99,999,999,999,999.99')
    const fills = compare.querySelectorAll('.dashboard-compare-fill')
    expect((fills[0] as HTMLElement).style.width).toBe('100%')
    expect((fills[1] as HTMLElement).style.width).toBe('0%')
  })

  it('renders the monthly budget card with an accessible progressbar for a positive budget', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse(summaryFixture())))
    renderApp('/')

    const budget = await screen.findByRole('region', { name: 'Monthly budget' })
    within(budget).getByText('$1,500.00')
    within(budget).getByText('-$100.10')

    const bar = within(budget).getByRole('progressbar')
    expect(bar).toHaveAccessibleName('Remaining budget')
    expect(bar).toHaveAttribute('aria-valuemin', '0')
    expect(bar).toHaveAttribute('aria-valuemax', '100')
    expect(bar).toHaveAttribute('aria-valuenow', '0')
    expect(bar).toHaveAttribute(
      'aria-valuetext',
      'Remaining -$100.10 of $1,500.00 budgeted',
    )
    const fill = bar.querySelector('.dashboard-budget-progress-fill') as HTMLElement
    expect(fill.style.width).toBe('0%')
  })

  it('renders a proportional progressbar for remaining budget below budgeted', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          summaryFixture({
            total_budgeted: '1500.00',
            remaining_budget: '1395.55',
          }),
        ),
      ),
    )
    renderApp('/')

    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '93')
    expect(bar).toHaveAttribute(
      'aria-valuetext',
      'Remaining $1,395.55 of $1,500.00 budgeted',
    )
    expect((bar.querySelector('.dashboard-budget-progress-fill') as HTMLElement).style.width).toBe(
      '93%',
    )
  })

  it('clamps the progressbar to 100 when remaining exceeds the budget', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          summaryFixture({
            total_budgeted: '1500.00',
            remaining_budget: '2000.00',
          }),
        ),
      ),
    )
    renderApp('/')

    const fullBar = await screen.findByRole('progressbar')
    expect(fullBar).toHaveAttribute('aria-valuenow', '100')
    expect(fullBar).toHaveAttribute(
      'aria-valuetext',
      'Remaining $2,000.00 of $1,500.00 budgeted',
    )
    expect(
      (fullBar.querySelector('.dashboard-budget-progress-fill') as HTMLElement).style.width,
    ).toBe('100%')
  })

  it('shows the no-budget message without a progressbar when nothing is budgeted', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          summaryFixture({
            total_budgeted: '0.00',
            remaining_budget: '0.00',
          }),
        ),
      ),
    )
    renderApp('/')

    const budget = await screen.findByRole('region', { name: 'Monthly budget' })
    expect(within(budget).getAllByText('$0.00')).toHaveLength(2)
    expect(
      within(budget).getByText('No budget set for this month.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })

  it('links to the transactions screen for managing transactions', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(summaryFixture({ recent_transactions: [] })),
      ),
    )
    renderApp('/')

    const link = await screen.findByRole('link', {
      name: 'Manage transactions',
    })
    expect(link).toHaveAttribute('href', '/transactions')
    expect(screen.getByText(/No transactions yet/)).toBeInTheDocument()
  })

  it('wraps the loading state in a status card without changing its accessible text', async () => {
    const pending = deferred<Response>()
    installFetchMock(authenticatedHandler(() => pending.promise))
    renderApp('/')

    const loadingText = await screen.findByText('Loading your dashboard…')
    expect(loadingText.closest('[role="status"]')).not.toBeNull()

    await act(async () => {
      pending.resolve(jsonResponse(summaryFixture()))
    })
    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.queryByText('Loading your dashboard…')).not.toBeInTheDocument()
  })
})

describe('metric card semantic classes', () => {
  it('applies scoped emphasis classes to each metric card', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse(summaryFixture())))
    renderApp('/')

    await screen.findByText('$1,234.56')

    const total = screen.getByText('Total balance').closest('div')
    expect(total).toHaveClass('dashboard-metric-card-total')
    expect(total).toHaveClass('dashboard-metric-card')

    const income = screen.getByText('Income this month').closest('div')
    expect(income).toHaveClass('dashboard-metric-card')
    expect(income?.querySelector('dd')).toHaveClass('dashboard-metric-value-income')

    const spending = screen.getByText('Spending this month').closest('div')
    expect(spending).toHaveClass('dashboard-metric-card')
    expect(spending?.querySelector('dd')).toHaveClass('dashboard-metric-value-expense')

    const remaining = screen.getByText('Budget remaining').closest('div')
    expect(remaining).toHaveClass('dashboard-metric-card')
    expect(remaining?.querySelector('dd')).toHaveClass('dashboard-metric-value-remaining')
  })

  it('leaves budget remaining unstyled when its decimal string is nonnegative', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(summaryFixture({ remaining_budget: '412.30' })),
      ),
    )
    renderApp('/')

    const remaining = (await screen.findByText('Budget remaining')).closest(
      'div',
    )
    expect(remaining?.querySelector('dd')).not.toHaveClass(
      'dashboard-metric-value-remaining',
    )
    expect(remaining?.querySelector('dd')).toHaveTextContent('$412.30')
    expect(screen.getByText('Budget remaining')).toBeInTheDocument()
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
      'a recent transaction missing source',
      summaryFixture({
        recent_transactions: [withoutKey(transactionFixture(), 'source')],
      }),
    ],
    [
      'a manual recent transaction with a provider_name',
      summaryFixture({
        recent_transactions: [transactionFixture({ provider_name: 'Chase' })],
      }),
    ],
    [
      'a manual recent transaction that is pending',
      summaryFixture({
        recent_transactions: [transactionFixture({ is_pending: true })],
      }),
    ],
    [
      'a manual recent transaction with an initial import flag',
      summaryFixture({
        recent_transactions: [
          transactionFixture({ is_pending_initial_import: true }),
        ],
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
