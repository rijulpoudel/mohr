import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  calls,
  deferred,
  installFetchMock,
  jsonResponse,
  renderApp,
  requestLog,
} from '../test/testUtils'

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

function withoutKey(record: Record<string, unknown>, key: string) {
  const copy = { ...record }
  delete copy[key]
  return copy
}

function authenticatedHandler(
  accounts: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/dashboard/summary/') {
      return jsonResponse({
        total_balance: '100.00',
        current_month_income: '0.00',
        current_month_expenses: '0.00',
        total_budgeted: '0.00',
        remaining_budget: '0.00',
        recent_transactions: [],
      })
    }
    if (url === '/api/accounts/') return accounts(url, init)
    return jsonResponse({}, 404)
  }
}

describe('accounts navigation', () => {
  it('shows Dashboard and Accounts nav with current-page state when authenticated', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([accountFixture()])))
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const dashboardLink = within(nav).getByRole('link', { name: 'Dashboard' })
    const accountsLink = within(nav).getByRole('link', { name: 'Accounts' })
    expect(dashboardLink).toHaveAttribute('href', '/')
    expect(accountsLink).toHaveAttribute('href', '/accounts')
    expect(accountsLink).toHaveAttribute('aria-current', 'page')
    expect(dashboardLink).not.toHaveAttribute('aria-current', 'page')
  })

  it('marks Dashboard as current on the dashboard page', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([accountFixture()])))
    renderApp('/')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const dashboardLink = within(nav).getByRole('link', { name: 'Dashboard' })
    const accountsLink = within(nav).getByRole('link', { name: 'Accounts' })
    expect(dashboardLink).toHaveAttribute('aria-current', 'page')
    expect(accountsLink).not.toHaveAttribute('aria-current', 'page')
  })

  it('keeps the guest shell brand-only without primary nav', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/login')

    expect(await screen.findByRole('link', { name: 'Mohr' })).toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Accounts' })).not.toBeInTheDocument()
  })

  it('protects /accounts for guests by redirecting to login', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
  })
})

describe('accounts list', () => {
  it('renders accounts in server order with friendly type and archived state', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          accountFixture({
            id: 1,
            name: 'Everyday Checking',
            account_type: 'checking',
            opening_balance: '100.00',
            current_balance: '150.25',
            is_archived: false,
          }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            opening_balance: '-50.00',
            current_balance: '-75.50',
            is_archived: true,
          }),
          accountFixture({
            id: 3,
            name: 'Cash Jar',
            account_type: 'cash',
            opening_balance: '0.00',
            current_balance: '0.00',
            is_archived: false,
          }),
        ]),
      ),
    )
    renderApp('/accounts')

    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Everyday Checking')
    expect(items[1]).toHaveTextContent('Old Card')
    expect(items[2]).toHaveTextContent('Cash Jar')
    expect(screen.getByText('Checking')).toBeInTheDocument()
    expect(screen.getByText('Credit card')).toBeInTheDocument()
    expect(screen.getByText('Cash')).toBeInTheDocument()
    expect(screen.getByText('$150.25')).toBeInTheDocument()
    expect(screen.getByText('-$75.50')).toBeInTheDocument()
    expect(screen.getByText('$100.00')).toBeInTheDocument()
    expect(screen.getByText('-$50.00')).toBeInTheDocument()
    expect(screen.getAllByText('Current balance')).toHaveLength(3)
    expect(screen.getAllByText('Opening balance')).toHaveLength(3)
    expect(screen.getAllByText('Active')).toHaveLength(2)
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  it('formats exact large and negative money strings', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          accountFixture({
            id: 1,
            name: 'Big Saver',
            account_type: 'savings',
            opening_balance: '-987654321.01',
            current_balance: '123456789012345678.90',
          }),
        ]),
      ),
    )
    renderApp('/accounts')

    expect(
      await screen.findByText('$123,456,789,012,345,678.90'),
    ).toBeInTheDocument()
    expect(screen.getByText('-$987,654,321.01')).toBeInTheDocument()
    expect(screen.getByText('Savings')).toBeInTheDocument()
  })

  it('shows an accessible loading status while accounts are pending', async () => {
    const pending = deferred<Response>()
    installFetchMock(authenticatedHandler(() => pending.promise))
    renderApp('/accounts')

    expect(await screen.findByText('Loading your accounts…')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your accounts')

    await act(async () => {
      pending.resolve(jsonResponse([accountFixture()]))
    })
    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows meaningful empty text without a list', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([])))
    renderApp('/accounts')

    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('retries a failed request and clears the stale error', async () => {
    let accountCalls = 0
    const mock = installFetchMock(
      authenticatedHandler(() => {
        accountCalls += 1
        if (accountCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse([accountFixture()])
      }),
    )
    renderApp('/accounts')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/accounts/')).toHaveLength(2)
  })

  it('issues exactly one accounts request under StrictMode', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse([accountFixture()])),
    )
    renderApp('/accounts')

    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
  })

  it('ignores an accounts response that settles after unmount', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(authenticatedHandler(() => pending.promise))
    const view = renderApp('/accounts')

    expect(await screen.findByText('Loading your accounts…')).toBeInTheDocument()
    view.unmount()
    await act(async () => {
      pending.resolve(jsonResponse([accountFixture({ name: 'Late Account' })]))
    })

    expect(screen.queryByText('Late Account')).not.toBeInTheDocument()
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
  })

  it('never writes auth values to web storage', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([accountFixture()])))
    renderApp('/accounts')

    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('malformed accounts payloads', () => {
  const malformedPayloads: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an object payload', { id: 1 }],
    ['a string payload', 'nope'],
    ['a missing key', withoutKey(accountFixture(), 'current_balance')],
    [
      'an extra key',
      { ...accountFixture(), user: 1 },
    ],
    ['a zero id', [accountFixture({ id: 0 })]],
    ['a negative id', [accountFixture({ id: -3 })]],
    ['a fractional id', [accountFixture({ id: 1.5 })]],
    ['a string id', [accountFixture({ id: '1' })]],
    ['an unsafe id', [accountFixture({ id: 9007199254740992 })]],
    ['an empty name', [accountFixture({ name: '' })]],
    ['a whitespace name', [accountFixture({ name: '   ' })]],
    ['a long name', [accountFixture({ name: 'x'.repeat(101) })]],
    ['a bad account type', [accountFixture({ account_type: 'crypto' })]],
    ['a one-decimal balance', [accountFixture({ current_balance: '12.3' })]],
    ['a comma balance', [accountFixture({ opening_balance: '1,234.56' })]],
    ['a numeric balance', [accountFixture({ current_balance: 12.5 })]],
    ['a string archived flag', [accountFixture({ is_archived: 'false' })]],
    ['a date-only created_at', [accountFixture({ created_at: '2026-09-11' })]],
    [
      'an impossible created_at date',
      [accountFixture({ created_at: '2026-02-30T12:00:00Z' })],
    ],
    [
      'an impossible updated_at date',
      [accountFixture({ updated_at: '2026-02-30T12:00:00Z' })],
    ],
    ['a missing updated_at', [withoutKey(accountFixture(), 'updated_at')]],
  ]

  it.each(malformedPayloads)('rejects %s safely', async (_label, payload) => {
    installFetchMock(authenticatedHandler(() => jsonResponse(payload)))
    renderApp('/accounts')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})

describe('accounts session expiry', () => {
  it('clears in-memory auth and redirects to login on 401 without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )
    renderApp('/accounts')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/accounts/',
    ])
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
