import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  calls,
  deferred,
  installFetchMock,
  jsonResponse,
  renderApp,
  requestLog,
} from '../test/testUtils'
import {
  CONNECTION_STALE_AFTER_MS,
} from './ConnectionsScreen'

vi.mock('react-plaid-link', () => ({
  usePlaidLink: vi.fn(() => ({
    open: vi.fn(),
    exit: vi.fn(),
    ready: true,
    error: null,
    submit: vi.fn(),
  })),
}))

const TIMESTAMP = '2026-09-11T14:52:48.008850Z'

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

function dashboardSummary() {
  return jsonResponse({
    total_balance: '1234.56',
    current_month_income: '2000.00',
    current_month_expenses: '765.44',
    total_budgeted: '1500.00',
    remaining_budget: '-100.10',
    recent_transactions: [],
  })
}

function authenticatedHandler(
  connections: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/dashboard/summary/') return dashboardSummary()
    if (url === '/api/plaid/connections/') return connections(url, init)
    return jsonResponse({}, 404)
  }
}

function connectionItem(name: string): HTMLElement {
  const item = screen
    .getAllByRole('listitem')
    .find((node) => node.textContent?.includes(name))
  if (item === undefined) throw new Error(`No list item for ${name}`)
  return item
}

describe('connections navigation', () => {
  it('shows Dashboard and Connections nav with current-page state when authenticated', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([connectionFixture()])))
    renderApp('/connections')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const dashboardLink = within(nav).getByRole('link', { name: 'Dashboard' })
    const connectionsLink = within(nav).getByRole('link', { name: 'Connections' })
    expect(connectionsLink).toHaveAttribute('href', '/connections')
    expect(connectionsLink).toHaveAttribute('aria-current', 'page')
    expect(dashboardLink).not.toHaveAttribute('aria-current', 'page')
  })

  it('marks Dashboard as current on the dashboard page', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([connectionFixture()])))
    renderApp('/')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const dashboardLink = within(nav).getByRole('link', { name: 'Dashboard' })
    const connectionsLink = within(nav).getByRole('link', { name: 'Connections' })
    expect(dashboardLink).toHaveAttribute('aria-current', 'page')
    expect(connectionsLink).not.toHaveAttribute('aria-current', 'page')
  })

  it('keeps the guest shell brand-only without the Connections nav link', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/login')

    expect(await screen.findByRole('link', { name: 'Mohr' })).toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Connections' }),
    ).not.toBeInTheDocument()
  })

  it('protects /connections for guests by redirecting to login', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/connections')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
  })
})

describe('connections list', () => {
  it('renders connections in server order with friendly labels, sync time, and masks', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({
            id: 1,
            institution_name: 'First Plaid Bank',
            status: 'active',
            linked_accounts: [
              linkedAccountFixture({
                id: 10,
                name: 'Everyday Checking',
                account_type: 'checking',
                mask: '1234',
              }),
            ],
          }),
          connectionFixture({
            id: 2,
            institution_name: 'Second Bank',
            status: 'error',
            last_synced_at: null,
            linked_accounts: [
              linkedAccountFixture({
                id: 11,
                name: 'Gold Card',
                account_type: 'credit_card',
                mask: '0001',
              }),
              linkedAccountFixture({
                id: 12,
                name: 'Rainy Day',
                account_type: 'savings',
                mask: '',
              }),
            ],
          }),
        ]),
      ),
    )
    renderApp('/connections')

    expect(
      await screen.findByRole('heading', { name: 'Connections' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Bank connections' })
    const items = within(list)
      .getAllByRole('listitem')
      .filter((node) => within(node).queryByRole('heading') !== null)
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('First Plaid Bank')
    expect(items[1]).toHaveTextContent('Second Bank')
    expect(within(items[0]).getByText('Connected')).toBeInTheDocument()
    expect(within(items[1]).getByText('Attention needed')).toBeInTheDocument()
    expect(within(items[0]).getByText('Everyday Checking')).toBeInTheDocument()
    expect(within(items[0]).getByText('Checking')).toBeInTheDocument()
    expect(within(items[0]).getByText('Ending in 1234')).toBeInTheDocument()
    expect(within(items[1]).getByText('Gold Card')).toBeInTheDocument()
    expect(within(items[1]).getByText('Credit card')).toBeInTheDocument()
    expect(within(items[1]).getByText('Ending in 0001')).toBeInTheDocument()
    expect(within(items[1]).getByText('Rainy Day')).toBeInTheDocument()
    expect(within(items[1]).getByText('Savings')).toBeInTheDocument()
    expect(screen.queryByText('Ending in')).not.toBeInTheDocument()
    expect(screen.queryByText('5')).not.toBeInTheDocument()
    expect(screen.queryByText('2')).not.toBeInTheDocument()
  })

  it('renders a connection with no linked accounts without an empty account list', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({
            id: 1,
            institution_name: 'Empty Bank',
            linked_accounts: [],
          }),
        ]),
      ),
    )
    renderApp('/connections')

    expect(await screen.findByText('Empty Bank')).toBeInTheDocument()
    const item = connectionItem('Empty Bank')
    expect(within(item).getByText('Connected')).toBeInTheDocument()
    expect(
      within(item).queryByRole('list', { name: 'Accounts linked to Empty Bank' }),
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })

  it('shows an accessible loading status while connections are pending', async () => {
    const pending = deferred<Response>()
    installFetchMock(authenticatedHandler(() => pending.promise))
    renderApp('/connections')

    expect(
      await screen.findByText('Loading your connections…'),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading your connections',
    )

    await act(async () => {
      pending.resolve(jsonResponse([connectionFixture()]))
    })
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows meaningful empty text with the real connect control', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([])))
    renderApp('/connections')

    expect(await screen.findByText(/No bank connections yet/)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect a bank' })).toHaveAttribute(
      'type',
      'button',
    )
  })

  it('renders every lifecycle label and never claims a disconnected card is syncing', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({ id: 1, institution_name: 'Alpha', status: 'active' }),
          connectionFixture({ id: 2, institution_name: 'Beta', status: 'updating' }),
          connectionFixture({ id: 3, institution_name: 'Gamma', status: 'error' }),
          connectionFixture({ id: 4, institution_name: 'Delta', status: 'revoked' }),
          connectionFixture({
            id: 5,
            institution_name: 'Epsilon',
            status: 'disconnected',
          }),
        ]),
      ),
    )
    renderApp('/connections')

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('Reconnect required')).toBeInTheDocument()
    expect(screen.getByText('Attention needed')).toBeInTheDocument()
    expect(screen.getByText('Access revoked')).toBeInTheDocument()
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
    const disconnected = connectionItem('Epsilon')
    expect(
      within(disconnected).getByText('Not syncing while disconnected.'),
    ).toBeInTheDocument()
    expect(within(disconnected).queryByText('Up to date')).not.toBeInTheDocument()
    expect(
      within(disconnected).queryByText('Data may be stale'),
    ).not.toBeInTheDocument()
  })

  it('renders the last sync as a readable UTC time element or Not synced yet', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({ id: 1, institution_name: 'Synced Bank' }),
          connectionFixture({
            id: 2,
            institution_name: 'Fresh Bank',
            last_synced_at: null,
          }),
        ]),
      ),
    )
    renderApp('/connections')

    expect(await screen.findByText('Synced Bank')).toBeInTheDocument()
    const synced = connectionItem('Synced Bank')
    const time = within(synced).getByRole('time')
    expect(time).toHaveAttribute('datetime', TIMESTAMP)
    expect(time).toHaveTextContent('Sep 11, 2026, 2:52 PM UTC')
    expect(within(synced).queryByText('Not synced yet')).not.toBeInTheDocument()
    const fresh = connectionItem('Fresh Bank')
    expect(within(fresh).getByText('Not synced yet')).toBeInTheDocument()
    expect(within(fresh).queryByRole('time')).not.toBeInTheDocument()
  })

  it('never implies sync progress for updating, error, or revoked even when pending', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({
            id: 1,
            institution_name: 'Needs Link',
            status: 'updating',
            sync_pending: true,
            linked_accounts: [
              linkedAccountFixture({ id: 30, name: 'Checking', sync_pending: true }),
            ],
          }),
          connectionFixture({
            id: 2,
            institution_name: 'Broken Bank',
            status: 'error',
            sync_pending: true,
            linked_accounts: [
              linkedAccountFixture({ id: 31, name: 'Checking', sync_pending: true }),
            ],
          }),
          connectionFixture({
            id: 3,
            institution_name: 'Lost Access',
            status: 'revoked',
            sync_pending: true,
            linked_accounts: [
              linkedAccountFixture({ id: 32, name: 'Checking', sync_pending: true }),
            ],
          }),
        ]),
      ),
    )
    renderApp('/connections')

    expect(await screen.findByText('Needs Link')).toBeInTheDocument()
    expect(screen.getByText('Reconnect required')).toBeInTheDocument()
    expect(screen.getByText('Attention needed')).toBeInTheDocument()
    expect(screen.getByText('Access revoked')).toBeInTheDocument()
    expect(
      screen.queryByText('Initial import in progress'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Bank updates are waiting to sync.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Balances are temporarily excluded/),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument()
    expect(screen.queryByText('Data may be stale')).not.toBeInTheDocument()
  })

  it('distinguishes initial import from a waiting bank update honestly', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({
            id: 1,
            institution_name: 'Importing Bank',
            status: 'active',
            sync_pending: false,
            last_synced_at: null,
            linked_accounts: [
              linkedAccountFixture({ id: 20, name: 'Checking One', sync_pending: true }),
              linkedAccountFixture({ id: 21, name: 'Checking Two', sync_pending: false }),
            ],
          }),
          connectionFixture({
            id: 2,
            institution_name: 'Waiting Bank',
            status: 'active',
            sync_pending: true,
            last_synced_at: null,
            linked_accounts: [
              linkedAccountFixture({ id: 22, name: 'Checking Three', sync_pending: false }),
            ],
          }),
        ]),
      ),
    )
    renderApp('/connections')

    expect(await screen.findByText('Importing Bank')).toBeInTheDocument()
    const importing = connectionItem('Importing Bank')
    expect(
      within(importing).getByText('Initial import in progress'),
    ).toBeInTheDocument()
    expect(
      within(importing).getByText(
        'Balances are temporarily excluded while transaction history finishes and the opening balance is anchored.',
      ),
    ).toBeInTheDocument()
    expect(within(importing).getByText('Balance pending')).toBeInTheDocument()
    const waiting = connectionItem('Waiting Bank')
    expect(
      within(waiting).getByText('Bank updates are waiting to sync.'),
    ).toBeInTheDocument()
    expect(
      within(waiting).queryByText('Initial import in progress'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Up to date')).not.toBeInTheDocument()
  })

  it('shows Up to date for a fresh active connection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-12T14:52:48.008850Z'))
    try {
      installFetchMock(
        authenticatedHandler(() =>
          jsonResponse([
            connectionFixture({
              id: 1,
              institution_name: 'Fresh Bank',
              last_synced_at: '2026-09-12T12:00:00.000000Z',
            }),
          ]),
        ),
      )
      renderApp('/connections')

      expect(await screen.findByText('Fresh Bank')).toBeInTheDocument()
      expect(screen.getByText('Up to date')).toBeInTheDocument()
      expect(screen.queryByText('Data may be stale')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows Data may be stale for an active connection synced over 24 hours ago', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-12T14:52:48.008850Z'))
    try {
      installFetchMock(
        authenticatedHandler(() =>
          jsonResponse([
            connectionFixture({
              id: 1,
              institution_name: 'Old Bank',
              last_synced_at: '2026-09-11T14:52:48.007850Z',
            }),
          ]),
        ),
      )
      renderApp('/connections')

      expect(await screen.findByText('Old Bank')).toBeInTheDocument()
      expect(screen.getByText('Data may be stale')).toBeInTheDocument()
      expect(screen.queryByText('Up to date')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects malformed connection payloads safely', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({
            id: 1,
            institution_name: 'First Plaid Bank',
            last_synced_at: 'not-a-timestamp',
          }),
        ]),
      ),
    )
    renderApp('/connections')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})

describe('connection freshness boundary', () => {
  it('defines a 24-hour stale threshold constant', () => {
    expect(CONNECTION_STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('treats exactly 24 hours as fresh but 1 ms later as stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-12T14:52:48.008850Z'))
    try {
      installFetchMock(
        authenticatedHandler(() =>
          jsonResponse([
            connectionFixture({
              id: 1,
              institution_name: 'Exactly A Day Old',
              last_synced_at: '2026-09-11T14:52:48.008850Z',
            }),
            connectionFixture({
              id: 2,
              institution_name: 'A Millisecond Older',
              last_synced_at: '2026-09-11T14:52:48.007850Z',
            }),
          ]),
        ),
      )
      renderApp('/connections')

      expect(await screen.findByText('Exactly A Day Old')).toBeInTheDocument()
      const exactly = connectionItem('Exactly A Day Old')
      expect(within(exactly).getByText('Up to date')).toBeInTheDocument()
      const older = connectionItem('A Millisecond Older')
      expect(within(older).getByText('Data may be stale')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('recomputes staleness across the boundary while the screen stays open without refetching', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({
            id: 1,
            institution_name: 'Crossing Bank',
            last_synced_at: '2026-09-11T14:52:48.008850Z',
          }),
        ]),
      ),
    )
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-09-12T14:52:48.008850Z'))
    try {
      renderApp('/connections')

      expect(await screen.findByText('Up to date')).toBeInTheDocument()
      expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)

      await act(async () => {
        vi.advanceTimersByTime(60_000)
      })

      expect(await screen.findByText('Data may be stale')).toBeInTheDocument()
      expect(screen.queryByText('Up to date')).not.toBeInTheDocument()
      expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up the staleness refresh timer on unmount', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({ id: 1, institution_name: 'Leaving Bank' }),
        ]),
      ),
    )
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-09-12T14:52:48.008850Z'))
    try {
      renderApp('/connections')
      await screen.findByText('Leaving Bank')

      const user = userEvent.setup()
      const nav = screen.getByRole('navigation', { name: 'Primary' })
      await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

      expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never calls a stale date current for updating, error, or revoked cards', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-12T14:52:48.008850Z'))
    try {
      installFetchMock(
        authenticatedHandler(() =>
          jsonResponse([
            connectionFixture({
              id: 1,
              institution_name: 'Needs Attention',
              status: 'updating',
              last_synced_at: '2026-09-12T14:00:00.000000Z',
            }),
            connectionFixture({
              id: 2,
              institution_name: 'Blocked Bank',
              status: 'error',
              last_synced_at: '2026-09-12T14:00:00.000000Z',
            }),
            connectionFixture({
              id: 3,
              institution_name: 'Cut Off Bank',
              status: 'revoked',
              last_synced_at: '2026-09-12T14:00:00.000000Z',
            }),
          ]),
        ),
      )
      renderApp('/connections')

      expect(await screen.findByText('Needs Attention')).toBeInTheDocument()
      expect(screen.queryByText('Up to date')).not.toBeInTheDocument()
      expect(screen.queryByText('Data may be stale')).not.toBeInTheDocument()
      expect(screen.getByText('Reconnect required')).toBeInTheDocument()
      expect(screen.getByText('Attention needed')).toBeInTheDocument()
      expect(screen.getByText('Access revoked')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('connections error handling', () => {
  it('retries a failed request and clears the stale error', async () => {
    let connectionCalls = 0
    const mock = installFetchMock(
      authenticatedHandler(() => {
        connectionCalls += 1
        if (connectionCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse([connectionFixture()])
      }),
    )
    renderApp('/connections')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(2)
  })

  it('issues exactly one connections request under StrictMode', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse([connectionFixture()])),
    )
    renderApp('/connections')

    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
  })

  it('ignores a late connections 401 after navigating to dashboard', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock((url: string) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/dashboard/summary/') return dashboardSummary()
      if (url === '/api/plaid/connections/') return pending.promise
      return jsonResponse({}, 404)
    })
    renderApp('/connections')

    expect(
      await screen.findByText('Loading your connections…'),
    ).toBeInTheDocument()
    const user = userEvent.setup()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      pending.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/plaid/connections/')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })
})

describe('connections session expiry', () => {
  it('clears in-memory auth and redirects to login on 401 without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )
    renderApp('/connections')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/plaid/connections/',
    ])
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('connections accessibility', () => {
  it('uses semantic headings, lists, and time markup without leaking ids', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          connectionFixture({ id: 5, institution_name: 'First Plaid Bank' }),
        ]),
      ),
    )
    renderApp('/connections')

    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Connections' }),
    ).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Bank connections' })
    const item = within(list).getAllByRole('listitem').find(
      (node) => within(node).queryByRole('heading') !== null,
    )
    if (item === undefined) throw new Error('No connection list item found')
    expect(
      within(item).getByRole('heading', { name: 'First Plaid Bank' }),
    ).toBeInTheDocument()
    expect(within(item).getByRole('time')).toBeInTheDocument()
    expect(
      screen.getByRole('list', { name: 'Bank connections' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('list', { name: 'Accounts linked to First Plaid Bank' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('5')).not.toBeInTheDocument()
  })
})