import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaidLinkError } from 'react-plaid-link'
import {
  calls,
  deferred,
  installFetchMock,
  jsonResponse,
  renderApp,
  requestLog,
  setCsrfCookie,
} from '../test/testUtils'
import {
  CONNECTION_STALE_AFTER_MS,
} from './ConnectionsScreen'

interface CapturedLinkOptions {
  token: string | null
  onSuccess: (publicToken: string | null, metadata: unknown) => void
  onExit: (error: PlaidLinkError | null, metadata: unknown) => void
}

const plaidLink = vi.hoisted(() => {
  const open = vi.fn()
  const exit = vi.fn()
  const submit = vi.fn()
  let options: CapturedLinkOptions | null = null
  let result: { ready: boolean; error: ErrorEvent | null } = {
    ready: true,
    error: null,
  }
  const optionsByToken = new Map<string, CapturedLinkOptions>()
  const usePlaidLink = vi.fn((next: CapturedLinkOptions) => {
    options = next
    if (next.token !== null) {
      optionsByToken.set(next.token, next)
    }
    return { open, exit, ready: result.ready, error: result.error, submit }
  })
  return {
    open,
    exit,
    submit,
    usePlaidLink,
    latestOptions: () => options,
    optionsForToken: (token: string) => optionsByToken.get(token) ?? null,
    setResult: (next: { ready: boolean; error: ErrorEvent | null }) => {
      result = next
    },
    reset: () => {
      options = null
      optionsByToken.clear()
      result = { ready: true, error: null }
      open.mockClear()
      exit.mockClear()
      submit.mockClear()
      usePlaidLink.mockClear()
    },
  }
})

vi.mock('react-plaid-link', () => ({
  usePlaidLink: plaidLink.usePlaidLink,
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

const UPDATE_LINK_TOKEN = 'link-sandbox-update-abcdef1234567890'
const UPDATE_TOKEN_URL = '/api/plaid/connections/5/link-token/'
const UPDATE_COMPLETE_URL = '/api/plaid/connections/5/update-complete/'
const EXCHANGE_URL = '/api/plaid/exchange/'
const DISCONNECT_URL = '/api/plaid/connections/5/disconnect/'

function updateLinkTokenFixture(overrides: Record<string, unknown> = {}) {
  return {
    link_token: UPDATE_LINK_TOKEN,
    expiration: '2026-09-18T12:00:00Z',
    ...overrides,
  }
}

function updateCompleteFixture(overrides: Record<string, unknown> = {}) {
  return {
    connection_id: 5,
    status: 'active',
    sync_pending: true,
    ...overrides,
  }
}

function lifecycleHandler(
  overrides: Partial<{
    connections: (url: string, init?: RequestInit) => Response | Promise<Response>
    linkToken: (url: string, init?: RequestInit) => Response | Promise<Response>
    disconnect: (url: string, init?: RequestInit) => Response | Promise<Response>
    exchange: (url: string, init?: RequestInit) => Response | Promise<Response>
    sync: (url: string, init?: RequestInit) => Response | Promise<Response>
    updateComplete: (url: string, init?: RequestInit) => Response | Promise<Response>
  }> = {},
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/auth/csrf/') {
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url === '/api/dashboard/summary/') return dashboardSummary()
    if (url === '/api/plaid/connections/' && init?.method !== 'POST') {
      return overrides.connections
        ? overrides.connections(url, init)
        : jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
          ])
    }
    if (url === EXCHANGE_URL && init?.method === 'POST') {
      return overrides.exchange
        ? overrides.exchange(url, init)
        : jsonResponse({}, 404)
    }
    if (url === UPDATE_TOKEN_URL && init?.method === 'POST') {
      return overrides.linkToken
        ? overrides.linkToken(url, init)
        : jsonResponse(updateLinkTokenFixture())
    }
    if (url === UPDATE_COMPLETE_URL && init?.method === 'POST') {
      return overrides.updateComplete
        ? overrides.updateComplete(url, init)
        : jsonResponse(updateCompleteFixture())
    }
    if (url.endsWith('/sync/') && init?.method === 'POST') {
      return overrides.sync
        ? overrides.sync(url, init)
        : jsonResponse({}, 404)
    }
    if (
      /^\/api\/plaid\/connections\/\d+\/disconnect\/$/.test(url) &&
      init?.method === 'POST'
    ) {
      return overrides.disconnect
        ? overrides.disconnect(url, init)
        : jsonResponse({ connection_id: 5, status: 'disconnected' })
    }
    return jsonResponse({}, 404)
  }
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

describe('connections manual sync', () => {
  const SYNC_URL = '/api/plaid/connections/5/sync/'
  // The exact detail the backend sends for every blocked or disabled sync run:
  // backend/plaid_integration/gateway.py PLAID_UNAVAILABLE_DETAIL, returned by
  // connection_sync in backend/plaid_integration/views.py. The client renders
  // the server's detail verbatim, so this test must assert the real string
  // rather than a convenient stand-in.
  const SAFE_503_MESSAGE = 'Plaid service is unavailable. Try again later.'

  function syncFixture(overrides: Record<string, unknown> = {}) {
    return {
      connection_id: 5,
      status: 'active',
      added: 12,
      modified: 3,
      removed: 1,
      ...overrides,
    }
  }

  function syncAuthenticatedHandler(
    overrides: Partial<{
      connections: (url: string, init?: RequestInit) => Response | Promise<Response>
      sync: (url: string, init?: RequestInit) => Response | Promise<Response>
    }> = {},
  ) {
    return (url: string, init?: RequestInit) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/dashboard/summary/') return dashboardSummary()
      if (url === '/api/plaid/connections/' && init?.method !== 'POST') {
        return overrides.connections
          ? overrides.connections(url, init)
          : jsonResponse([connectionFixture()])
      }
      if (url === SYNC_URL && init?.method === 'POST') {
        return overrides.sync
          ? overrides.sync(url, init)
          : jsonResponse(syncFixture())
      }
      return jsonResponse({}, 404)
    }
  }

  beforeEach(() => {
    setCsrfCookie()
  })

  it('renders a Sync now control only for active connections with a distinct accessible name', async () => {
    installFetchMock(
      syncAuthenticatedHandler({
        connections: () =>
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
      }),
    )
    renderApp('/connections')

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Sync now for / })).toHaveLength(1)
    const alphaButton = screen.getByRole('button', { name: 'Sync now for Alpha' })
    expect(alphaButton).toHaveAttribute('type', 'button')
    expect(alphaButton).toBeEnabled()
    for (const name of ['Beta', 'Gamma', 'Delta', 'Epsilon']) {
      expect(
        screen.queryByRole('button', { name: `Sync now for ${name}` }),
      ).not.toBeInTheDocument()
    }
  })

  it('issues exactly one sync POST for the clicked connection and refetches the list', async () => {
    let connectionsCalls = 0
    const mock = installFetchMock(
      syncAuthenticatedHandler({
        connections: () => {
          connectionsCalls += 1
          return jsonResponse([
            connectionFixture({ id: 5, institution_name: 'First Plaid Bank' }),
          ])
        },
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Sync now for First Plaid Bank' }),
    )

    await waitFor(() => expect(calls(mock, SYNC_URL, 'POST')).toHaveLength(1))
    await waitFor(() => expect(connectionsCalls).toBe(2))
    expect(calls(mock, '/api/plaid/connections/', 'GET')).toHaveLength(2)
  })

  it('allows only one sync in flight: two clicks in the same tick produce one request and every control disables', async () => {
    const pendingSync = deferred<Response>()
    const mock = installFetchMock(
      syncAuthenticatedHandler({
        connections: () =>
          jsonResponse([
            connectionFixture({ id: 5, institution_name: 'First Plaid Bank' }),
            connectionFixture({ id: 6, institution_name: 'Second Bank' }),
          ]),
        sync: () => pendingSync.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const firstButton = screen.getByRole('button', {
      name: 'Sync now for First Plaid Bank',
    })
    act(() => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      firstButton.dispatchEvent(click)
      firstButton.dispatchEvent(click)
    })

    await waitFor(() => expect(calls(mock, SYNC_URL, 'POST')).toHaveLength(1))
    const secondButton = screen.getByRole('button', {
      name: 'Sync now for Second Bank',
    })
    expect(firstButton).toBeDisabled()
    expect(secondButton).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent(
      /Syncing First Plaid Bank/,
    )

    await act(async () => {
      pendingSync.resolve(jsonResponse(syncFixture()))
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Sync now for First Plaid Bank' }),
      ).toBeEnabled(),
    )
    expect(calls(mock, SYNC_URL, 'POST')).toHaveLength(1)
  })

  it('renders the real counts only on the requested connection and keeps them readable afterwards', async () => {
    const refetch = deferred<Response>()
    let connectionsCalls = 0
    installFetchMock(
      syncAuthenticatedHandler({
        connections: () => {
          connectionsCalls += 1
          if (connectionsCalls === 1) {
            return jsonResponse([
              connectionFixture({ id: 5, institution_name: 'First Plaid Bank' }),
              connectionFixture({ id: 6, institution_name: 'Second Bank' }),
            ])
          }
          return refetch.promise
        },
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Sync now for First Plaid Bank' }),
    )

    expect(
      await screen.findByText('12 added, 3 updated, 1 removed.'),
    ).toBeInTheDocument()
    const requested = connectionItem('First Plaid Bank')
    expect(
      within(requested).getByText('12 added, 3 updated, 1 removed.'),
    ).toBeInTheDocument()
    const other = connectionItem('Second Bank')
    expect(
      within(other).queryByText('12 added, 3 updated, 1 removed.'),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      '12 added, 3 updated, 1 removed.',
    )
    expect(connectionsCalls).toBe(2)

    await act(async () => {
      refetch.resolve(
        jsonResponse([
          connectionFixture({
            id: 5,
            institution_name: 'First Plaid Bank',
            last_synced_at: '2026-09-12T09:00:00.000000Z',
          }),
          connectionFixture({ id: 6, institution_name: 'Second Bank' }),
        ]),
      )
    })

    // The refetched list has landed, which is proven by the connection's new
    // last-sync time. The result of the synchronization the user just asked for
    // is still the most recent thing that happened to this connection, so it
    // stays readable until another synchronization replaces it. Clearing it the
    // moment its own refetch landed would make the result effectively invisible.
    expect(
      await screen.findByText('Sep 12, 2026, 9:00 AM UTC'),
    ).toBeInTheDocument()
    expect(
      within(connectionItem('First Plaid Bank')).getByText(
        '12 added, 3 updated, 1 removed.',
      ),
    ).toBeInTheDocument()
    expect(
      within(connectionItem('Second Bank')).queryByText(
        '12 added, 3 updated, 1 removed.',
      ),
    ).not.toBeInTheDocument()
    expect(connectionsCalls).toBe(2)
  })

  it('shows an honest still-importing state for a 202 sync and still refetches', async () => {
    const refetch = deferred<Response>()
    let connectionsCalls = 0
    const mock = installFetchMock(
      syncAuthenticatedHandler({
        connections: () => {
          connectionsCalls += 1
          if (connectionsCalls === 1) {
            return jsonResponse([
              connectionFixture({ id: 5, institution_name: 'First Plaid Bank' }),
            ])
          }
          return refetch.promise
        },
        sync: () => jsonResponse({ connection_id: 5, status: 'processing' }, 202),
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Sync now for First Plaid Bank' }),
    )

    expect(await screen.findByRole('status')).toHaveTextContent(/Still importing/)
    expect(screen.queryByText(/\d+ added/)).not.toBeInTheDocument()
    expect(connectionsCalls).toBe(2)
    expect(calls(mock, SYNC_URL, 'POST')).toHaveLength(1)

    await act(async () => {
      refetch.resolve(
        jsonResponse([
          connectionFixture({
            id: 5,
            institution_name: 'First Plaid Bank',
            last_synced_at: '2026-09-12T09:00:00.000000Z',
          }),
        ]),
      )
    })
    expect(
      await screen.findByText('Sep 12, 2026, 9:00 AM UTC'),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/Still importing/)
  })

  it('surfaces the safe user message for a 503 with a Retry that re-issues the same sync', async () => {
    const secondSync = deferred<Response>()
    const refetch = deferred<Response>()
    let syncCalls = 0
    let connectionsCalls = 0
    const mock = installFetchMock(
      syncAuthenticatedHandler({
        connections: () => {
          connectionsCalls += 1
          if (connectionsCalls === 1) {
            return jsonResponse([
              connectionFixture({ id: 5, institution_name: 'First Plaid Bank' }),
            ])
          }
          return refetch.promise
        },
        sync: () => {
          syncCalls += 1
          if (syncCalls === 1) {
            return jsonResponse({ detail: SAFE_503_MESSAGE }, 503)
          }
          return secondSync.promise
        },
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Sync now for First Plaid Bank' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(SAFE_503_MESSAGE)
    expect(calls(mock, SYNC_URL, 'POST')).toHaveLength(1)

    await user.click(
      within(alert).getByRole('button', {
        name: 'Retry sync for First Plaid Bank',
      }),
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, SYNC_URL, 'POST')).toHaveLength(2)
    expect(screen.getByRole('status')).toHaveTextContent(/Syncing/)

    await act(async () => {
      secondSync.resolve(jsonResponse(syncFixture({ added: 4, modified: 0, removed: 0 })))
    })
    expect(await screen.findByText('4 added.')).toBeInTheDocument()

    await act(async () => {
      refetch.resolve(
        jsonResponse([
          connectionFixture({
            id: 5,
            institution_name: 'First Plaid Bank',
            last_synced_at: '2026-09-12T09:00:00.000000Z',
          }),
        ]),
      )
    })
    expect(
      await screen.findByText('Sep 12, 2026, 9:00 AM UTC'),
    ).toBeInTheDocument()
    expect(screen.getByText('4 added.')).toBeInTheDocument()
    expect(connectionsCalls).toBe(2)
  })

  it('clears the session on a 401 sync with no alert and no storage writes', async () => {
    const mock = installFetchMock(
      syncAuthenticatedHandler({
        sync: () =>
          jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          ),
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Sync now for First Plaid Bank' }),
    )

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, SYNC_URL, 'POST')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('never writes token material to storage, cookies, or the console on the sync success path', async () => {
    const refetch = deferred<Response>()
    let connectionsCalls = 0
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      installFetchMock(
        syncAuthenticatedHandler({
          connections: () => {
            connectionsCalls += 1
            if (connectionsCalls === 1) {
              return jsonResponse([
                connectionFixture({ id: 5, institution_name: 'First Plaid Bank' }),
              ])
            }
            return refetch.promise
          },
        }),
      )
      renderApp('/connections')
      expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

      const user = userEvent.setup()
      await user.click(
        screen.getByRole('button', { name: 'Sync now for First Plaid Bank' }),
      )
      expect(
        await screen.findByText('12 added, 3 updated, 1 removed.'),
      ).toBeInTheDocument()

      const output = [
        ...consoleSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .flat()
        .join('\n')
      expect(output).not.toContain('test-csrf-token')
      expect(localStorage.length).toBe(0)
      expect(sessionStorage.length).toBe(0)
    } finally {
      consoleSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})

describe('connections reconnect (update mode)', () => {
  function reconnectLinkOptions() {
    const captured = plaidLink.optionsForToken(UPDATE_LINK_TOKEN)
    if (captured === null) {
      throw new Error('No update-mode Link options captured')
    }
    return captured
  }

  function linkUpdateDismiss() {
    act(() => {
      reconnectLinkOptions().onExit(null, {})
    })
  }

  function linkUpdateSuccess() {
    act(() => {
      reconnectLinkOptions().onSuccess('public-sandbox-update-abc', {})
    })
  }

  function linkUpdateExitWith(error: PlaidLinkError) {
    act(() => {
      reconnectLinkOptions().onExit(error, {})
    })
  }

  beforeEach(() => {
    setCsrfCookie()
    plaidLink.reset()
  })

  it('renders Reconnect only for updating, error, and revoked connections with a distinct accessible name', async () => {
    installFetchMock(
      lifecycleHandler({
        connections: () =>
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
      }),
    )
    renderApp('/connections')

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Reconnect / })).toHaveLength(3)
    const beta = screen.getByRole('button', { name: 'Reconnect Beta' })
    expect(beta).toHaveAttribute('type', 'button')
    expect(beta).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Reconnect Gamma' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Reconnect Delta' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Reconnect Alpha' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Reconnect Epsilon' }),
    ).not.toBeInTheDocument()
  })

  it('issues exactly one link-token POST for the clicked connection and opens Link exactly once for that token', async () => {
    const mock = installFetchMock(lifecycleHandler())
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )

    await waitFor(() =>
      expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(1),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(plaidLink.optionsForToken(UPDATE_LINK_TOKEN)).not.toBeNull()
    expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(1)
  })

  it('shows a pending status and disables every mutation control while preparing and while Link is open', async () => {
    const pendingToken = deferred<Response>()
    installFetchMock(
      lifecycleHandler({
        connections: () =>
          jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
            connectionFixture({ id: 6, institution_name: 'Second Bank', status: 'active' }),
          ]),
        linkToken: () => pendingToken.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )

    expect(await screen.findByRole('status')).toHaveTextContent(
      /Preparing First Plaid Bank/,
    )
    expect(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Sync now for Second Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Disconnect Second Bank' }),
    ).toBeDisabled()

    await act(async () => {
      pendingToken.resolve(jsonResponse(updateLinkTokenFixture()))
    })
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status')).toHaveTextContent(/bank window/)
    expect(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    ).toBeDisabled()

    linkUpdateDismiss()

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
      ).toBeEnabled(),
    )
    expect(
      screen.getByRole('button', { name: 'Sync now for Second Bank' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    ).toBeEnabled()
  })

  it('refetches the list after success and after dismissal with zero exchange calls in the update-mode flow', async () => {
    let connectionsCalls = 0
    const mock = installFetchMock(
      lifecycleHandler({
        connections: () => {
          connectionsCalls += 1
          return jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
          ])
        },
        linkToken: () => {
          if (connectionsCalls === 1) {
            return jsonResponse(updateLinkTokenFixture())
          }
          return jsonResponse(
            updateLinkTokenFixture({
              link_token: `${UPDATE_LINK_TOKEN}-fresh`,
            }),
          )
        },
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    expect(connectionsCalls).toBe(1)

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(plaidLink.optionsForToken(UPDATE_LINK_TOKEN)).not.toBeNull()

    linkUpdateDismiss()
    await waitFor(() => expect(connectionsCalls).toBe(2))
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)

    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(2))
    expect(plaidLink.optionsForToken(`${UPDATE_LINK_TOKEN}-fresh`)).not.toBeNull()
    linkUpdateSuccess()
    await waitFor(() => expect(connectionsCalls).toBe(3))

    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)
    expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(2)
  })

  it('issues exactly one link-token request for two Reconnect clicks in the same tick', async () => {
    const pendingToken = deferred<Response>()
    const mock = installFetchMock(
      lifecycleHandler({ linkToken: () => pendingToken.promise }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const button = screen.getByRole('button', {
      name: 'Reconnect First Plaid Bank',
    })
    act(() => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      button.dispatchEvent(click)
      button.dispatchEvent(click)
    })

    await waitFor(() =>
      expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(1),
    )
    expect(screen.getByRole('status')).toHaveTextContent(/Preparing/)

    await act(async () => {
      pendingToken.resolve(jsonResponse(updateLinkTokenFixture()))
    })
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(1)
  })

  it('renders a retryable alert on a 503 link-token request and retries with a fresh token', async () => {
    let linkTokenCalls = 0
    const mock = installFetchMock(
      lifecycleHandler({
        linkToken: () => {
          linkTokenCalls += 1
          if (linkTokenCalls === 1) {
            return jsonResponse(
              { detail: 'Plaid service is unavailable. Try again later.' },
              503,
            )
          }
          return jsonResponse(
            updateLinkTokenFixture({ link_token: `${UPDATE_LINK_TOKEN}-retry` }),
          )
        },
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Plaid service is unavailable. Try again later.',
    )
    expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(1)
    expect(plaidLink.open).not.toHaveBeenCalled()
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)

    await user.click(
      within(alert).getByRole('button', {
        name: 'Retry reconnect for First Plaid Bank',
      }),
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(2),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(plaidLink.optionsForToken(`${UPDATE_LINK_TOKEN}-retry`)).not.toBeNull()
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)
  })

  it('renders a retryable alert on a non-token Link exit error and retries the link-token request', async () => {
    const mock = installFetchMock(lifecycleHandler())
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

    linkUpdateExitWith({
      error_type: 'RATE_LIMIT_EXCEEDED',
      error_code: 'RATE_LIMIT_EXCEEDED',
      error_message: 'Too many attempts.',
      display_message: null,
    })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/could not be completed/i)
    expect(plaidLink.open).toHaveBeenCalledTimes(1)
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)

    await user.click(
      within(alert).getByRole('button', {
        name: 'Retry reconnect for First Plaid Bank',
      }),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(2))
    expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)
  })

  it('shows the link-expired message on an INVALID_LINK_TOKEN exit', async () => {
    installFetchMock(lifecycleHandler())
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

    linkUpdateExitWith({
      error_type: 'INVALID_LINK_TOKEN',
      error_code: 'INVALID_LINK_TOKEN',
      error_message: 'The link token has expired.',
      display_message: null,
    })

    expect(screen.getByRole('alert')).toHaveTextContent(/link expired/i)
  })

  it('shows no alert and re-enables the control when Link is dismissed', async () => {
    installFetchMock(lifecycleHandler())
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

    linkUpdateDismiss()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
      ).toBeEnabled(),
    )
  })

  it('fails to a retryable alert when the Plaid script fails to load while reconnecting', async () => {
    plaidLink.setResult({
      ready: false,
      error: {
        message: 'Plaid script failed to load',
      } as unknown as ErrorEvent,
    })
    const mock = installFetchMock(lifecycleHandler())
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/could not start/i)
    expect(plaidLink.open).not.toHaveBeenCalled()
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)

    plaidLink.setResult({ ready: true, error: null })
    await user.click(
      within(alert).getByRole('button', {
        name: 'Retry reconnect for First Plaid Bank',
      }),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(2)
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)
  })

  it('clears the session and shows no alert when the update link-token request returns 401', async () => {
    const mock = installFetchMock(
      lifecycleHandler({
        linkToken: () =>
          jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          ),
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(plaidLink.open).not.toHaveBeenCalled()
    expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('disables Reconnect and Disconnect controls while a sync is in flight', async () => {
    const pendingSync = deferred<Response>()
    installFetchMock(
      lifecycleHandler({
        connections: () =>
          jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
            connectionFixture({ id: 6, institution_name: 'Second Bank', status: 'active' }),
          ]),
        sync: () => pendingSync.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Sync now for Second Bank' }),
    )

    expect(screen.getByRole('status')).toHaveTextContent(/Syncing Second Bank/)
    expect(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Disconnect Second Bank' }),
    ).toBeDisabled()

    await act(async () => {
      pendingSync.resolve(
        jsonResponse({
          connection_id: 6,
          status: 'active',
          added: 1,
          modified: 0,
          removed: 0,
        }),
      )
    })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
      ).toBeEnabled(),
    )
  })

  it('blocks a reconnect on another connection while the first Link session is open', async () => {
    const mock = installFetchMock(
      lifecycleHandler({
        connections: () =>
          jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
            connectionFixture({ id: 6, institution_name: 'Second Bank', status: 'updating' }),
          ]),
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(plaidLink.optionsForToken(UPDATE_LINK_TOKEN)).not.toBeNull()

    expect(
      screen.getByRole('button', { name: 'Reconnect Second Bank' }),
    ).toBeDisabled()

    const secondButton = screen.getByRole('button', {
      name: 'Reconnect Second Bank',
    })
    act(() => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      secondButton.dispatchEvent(click)
    })

    expect(
      calls(mock, '/api/plaid/connections/6/link-token/', 'POST'),
    ).toHaveLength(0)
    expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(1)
    expect(plaidLink.open).toHaveBeenCalledTimes(1)
  })

  it('never writes the update-mode token to storage, cookies, or the console', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      installFetchMock(lifecycleHandler())
      renderApp('/connections')
      expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

      const user = userEvent.setup()
      await user.click(
        screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
      )
      await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

      linkUpdateDismiss()
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
        ).toBeEnabled(),
      )

      const output = [
        ...consoleSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .flat()
        .join('\n')
      expect(output).not.toContain(UPDATE_LINK_TOKEN)
      expect(localStorage.length).toBe(0)
      expect(sessionStorage.length).toBe(0)
      expect(document.cookie).not.toContain(UPDATE_LINK_TOKEN)
    } finally {
      consoleSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})

describe('connections update-mode completion', () => {
  function reconnectLinkOptions() {
    const captured = plaidLink.optionsForToken(UPDATE_LINK_TOKEN)
    if (captured === null) {
      throw new Error('No update-mode Link options captured')
    }
    return captured
  }

  function openReconnect(user: ReturnType<typeof userEvent.setup>) {
    return user.click(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    )
  }

  beforeEach(() => {
    setCsrfCookie()
    plaidLink.reset()
  })

  it('completes update mode exactly once for a same-tick double onSuccess, refetches only after completion resolves, and locks competing mutations', async () => {
    const completion = deferred<Response>()
    let connectionsCalls = 0
    const mock = installFetchMock(
      lifecycleHandler({
        connections: () => {
          connectionsCalls += 1
          return jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
          ])
        },
        updateComplete: () => completion.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    expect(connectionsCalls).toBe(1)

    const user = userEvent.setup()
    await openReconnect(user)
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

    act(() => {
      reconnectLinkOptions().onSuccess('public-sandbox-update-a', {})
      reconnectLinkOptions().onSuccess('public-sandbox-update-b', {})
    })

    expect(screen.getByRole('status')).toHaveTextContent(
      'Verifying the repaired connection…',
    )
    await waitFor(() =>
      expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1),
    )
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)
    expect(connectionsCalls).toBe(1)
    expect(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    ).toBeDisabled()

    await act(async () => {
      completion.resolve(jsonResponse(updateCompleteFixture()))
    })

    await waitFor(() => expect(connectionsCalls).toBe(2))
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)
    await waitFor(() =>
      expect(
        screen.queryByText('Verifying the repaired connection…'),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    ).toBeEnabled()
  })

  it('never stores or logs the onSuccess public token during completion', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const publicToken = 'public-sandbox-secret-token-xyz'
    try {
      let connectionsCalls = 0
      const mock = installFetchMock(
        lifecycleHandler({
          connections: () => {
            connectionsCalls += 1
            return jsonResponse([
              connectionFixture({
                id: 5,
                institution_name: 'First Plaid Bank',
                status: 'updating',
              }),
            ])
          },
        }),
      )
      renderApp('/connections')
      expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

      const user = userEvent.setup()
      await openReconnect(user)
      await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

      act(() => {
        reconnectLinkOptions().onSuccess(publicToken, {})
      })

      await waitFor(() => expect(connectionsCalls).toBe(2))
      expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)

      const output = [
        ...consoleSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .flat()
        .join('\n')
      expect(output).not.toContain(publicToken)
      expect(localStorage.length).toBe(0)
      expect(sessionStorage.length).toBe(0)
      expect(document.cookie).not.toContain(publicToken)
    } finally {
      consoleSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('shows a retryable alert on a failed completion and a Retry re-issues the link-token flow', async () => {
    const mock = installFetchMock(
      lifecycleHandler({
        updateComplete: () =>
          jsonResponse(
            { detail: 'Plaid service is unavailable. Try again later.' },
            503,
          ),
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await openReconnect(user)
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

    act(() => {
      reconnectLinkOptions().onSuccess('public-sandbox-update-a', {})
    })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'Plaid service is unavailable. Try again later.',
    )
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)
    expect(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    ).toBeEnabled()

    await user.click(
      within(alert).getByRole('button', {
        name: 'Retry reconnect for First Plaid Bank',
      }),
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(calls(mock, UPDATE_TOKEN_URL, 'POST')).toHaveLength(2),
    )
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(2))
    expect(calls(mock, EXCHANGE_URL, 'POST')).toHaveLength(0)
  })

  it('clears the session on a 401 completion with no alert and no storage writes', async () => {
    const mock = installFetchMock(
      lifecycleHandler({
        updateComplete: () =>
          jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          ),
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await openReconnect(user)
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

    act(() => {
      reconnectLinkOptions().onSuccess('public-sandbox-update-a', {})
    })

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('ignores a late completion 401 after navigating to the dashboard', async () => {
    const pendingCompletion = deferred<Response>()
    const mock = installFetchMock(
      lifecycleHandler({
        updateComplete: () => pendingCompletion.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await openReconnect(user)
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))

    act(() => {
      reconnectLinkOptions().onSuccess('public-sandbox-update-a', {})
    })
    await waitFor(() =>
      expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1),
    )

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      pendingCompletion.resolve(
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
    expect(calls(mock, UPDATE_COMPLETE_URL, 'POST')).toHaveLength(1)
  })
})

describe('connections disconnect', () => {
  beforeEach(() => {
    setCsrfCookie()
    plaidLink.reset()
  })

  it('renders Disconnect for every non-disconnected connection with a connection-specific accessible name', async () => {
    installFetchMock(
      lifecycleHandler({
        connections: () =>
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
      }),
    )
    renderApp('/connections')

    expect(await screen.findByText('Alpha')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Disconnect / })).toHaveLength(4)
    const alpha = screen.getByRole('button', { name: 'Disconnect Alpha' })
    expect(alpha).toHaveAttribute('type', 'button')
    expect(alpha).toBeEnabled()
    for (const name of ['Beta', 'Gamma', 'Delta']) {
      expect(
        screen.getByRole('button', { name: `Disconnect ${name}` }),
      ).toBeInTheDocument()
    }
    expect(
      screen.queryByRole('button', { name: 'Disconnect Epsilon' }),
    ).not.toBeInTheDocument()
  })

  it('opens a labelled confirmation naming the institution and the archive, history, and stop-syncing facts with Cancel first and focused', async () => {
    installFetchMock(lifecycleHandler())
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )

    const group = await screen.findByRole('group', {
      name: 'Disconnect First Plaid Bank confirmation',
    })
    expect(group).toHaveTextContent('First Plaid Bank')
    expect(group).toHaveTextContent(/linked Mohr accounts will be archived/i)
    expect(group).toHaveTextContent(/imported history is kept/i)
    expect(group).toHaveTextContent(/stop syncing/i)
    const cancel = within(group).getByRole('button', { name: 'Cancel' })
    const confirm = within(group).getByRole('button', { name: 'Disconnect' })
    expect(
      cancel.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(cancel).toHaveFocus()
    // The destructive action carries the app's existing danger affordance while
    // the safe cancel action does not, matching the transactions and budgets
    // confirmations. The labels alone are not the only distinction.
    expect(confirm.classList.contains('btn-danger')).toBe(true)
    expect(cancel.classList.contains('btn-danger')).toBe(false)
  })

  it('treats an immediate Enter on the open confirmation as Cancel with no request', async () => {
    const mock = installFetchMock(lifecycleHandler())
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )
    await screen.findByRole('group', {
      name: 'Disconnect First Plaid Bank confirmation',
    })

    await user.keyboard('{Enter}')

    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(0)
    expect(
      screen.queryByRole('group', {
        name: 'Disconnect First Plaid Bank confirmation',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    ).toHaveFocus()
  })

  it('confirms with exactly one disconnect POST, refetches, and renders the disconnected row without controls', async () => {
    let connectionsCalls = 0
    const mock = installFetchMock(
      lifecycleHandler({
        connections: () => {
          connectionsCalls += 1
          if (connectionsCalls === 1) {
            return jsonResponse([
              connectionFixture({
                id: 5,
                institution_name: 'First Plaid Bank',
                status: 'updating',
              }),
            ])
          }
          return jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'disconnected',
            }),
          ])
        },
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }))

    await waitFor(() =>
      expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(1),
    )
    await waitFor(() => expect(connectionsCalls).toBe(2))

    const item = connectionItem('First Plaid Bank')
    expect(within(item).getByText('Disconnected')).toBeInTheDocument()
    expect(
      within(item).getByText('Not syncing while disconnected.'),
    ).toBeInTheDocument()
    expect(
      within(item).queryByRole('button', { name: /^Sync now/ }),
    ).not.toBeInTheDocument()
    expect(
      within(item).queryByRole('button', { name: /^Reconnect/ }),
    ).not.toBeInTheDocument()
    expect(
      within(item).queryByRole('button', { name: /^Disconnect/ }),
    ).not.toBeInTheDocument()
  })

  it('dedups same-tick double confirm and disables every control while the disconnect is pending', async () => {
    const pendingDisconnect = deferred<Response>()
    let connectionsCalls = 0
    const mock = installFetchMock(
      lifecycleHandler({
        connections: () => {
          connectionsCalls += 1
          return jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
            connectionFixture({ id: 6, institution_name: 'Second Bank', status: 'active' }),
          ])
        },
        disconnect: () => pendingDisconnect.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )
    const confirm = await screen.findByRole('button', { name: 'Disconnect' })

    act(() => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      confirm.dispatchEvent(click)
      confirm.dispatchEvent(click)
    })

    await waitFor(() =>
      expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(1),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      /Disconnecting First Plaid Bank/,
    )
    expect(confirm).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Sync now for Second Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Disconnect Second Bank' }),
    ).toBeDisabled()

    await act(async () => {
      pendingDisconnect.resolve(
        jsonResponse({ connection_id: 5, status: 'disconnected' }),
      )
    })
    await waitFor(() => expect(connectionsCalls).toBe(2))
    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(1)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
      ).toBeEnabled(),
    )
  })

  it('shows a retryable alert on a failed disconnect and a Retry re-issues the same confirmation request', async () => {
    const retryDisconnect = deferred<Response>()
    let disconnectCalls = 0
    const mock = installFetchMock(
      lifecycleHandler({
        disconnect: () => {
          disconnectCalls += 1
          if (disconnectCalls === 1) {
            return jsonResponse({ detail: 'Disconnect service down.' }, 500)
          }
          return retryDisconnect.promise
        },
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Disconnect service down.')
    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(1)
    expect(
      screen.getByRole('group', {
        name: 'Disconnect First Plaid Bank confirmation',
      }),
    ).toBeInTheDocument()

    await user.click(
      within(alert).getByRole('button', {
        name: 'Retry disconnect for First Plaid Bank',
      }),
    )

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(2),
    )
    expect(screen.getByRole('status')).toHaveTextContent(
      /Disconnecting First Plaid Bank/,
    )

    await act(async () => {
      retryDisconnect.resolve(
        jsonResponse({ connection_id: 5, status: 'disconnected' }),
      )
    })
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })

  it('cancel returns focus to the Disconnect control that opened the confirmation', async () => {
    const mock = installFetchMock(lifecycleHandler())
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )
    await screen.findByRole('group', {
      name: 'Disconnect First Plaid Bank confirmation',
    })

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    ).toHaveFocus()
    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(0)
  })

  it('clears the session and renders no alert when the disconnect returns 401', async () => {
    const mock = installFetchMock(
      lifecycleHandler({
        disconnect: () =>
          jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          ),
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('disables every other mutation control while a confirmation is open and leaves the confirm enabled', async () => {
    installFetchMock(
      lifecycleHandler({
        connections: () =>
          jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
            connectionFixture({ id: 6, institution_name: 'Second Bank', status: 'active' }),
          ]),
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )
    await screen.findByRole('group', {
      name: 'Disconnect First Plaid Bank confirmation',
    })

    expect(
      screen.getByRole('button', { name: 'Reconnect First Plaid Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Sync now for Second Bank' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Disconnect Second Bank' }),
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
  })

  it('allows exactly one network request when a sync and a disconnect confirmation are activated in the same tick', async () => {
    const pendingSync = deferred<Response>()
    const mock = installFetchMock(
      lifecycleHandler({
        connections: () =>
          jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
            connectionFixture({ id: 6, institution_name: 'Second Bank', status: 'active' }),
          ]),
        sync: () => pendingSync.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const syncButton = screen.getByRole('button', {
      name: 'Sync now for Second Bank',
    })
    const disconnectButton = screen.getByRole('button', {
      name: 'Disconnect First Plaid Bank',
    })
    act(() => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      syncButton.dispatchEvent(click)
      disconnectButton.dispatchEvent(click)
    })

    await waitFor(() =>
      expect(
        calls(mock, '/api/plaid/connections/6/sync/', 'POST'),
      ).toHaveLength(1),
    )
    expect(
      requestLog(mock).filter((entry) => entry.startsWith('POST')),
    ).toHaveLength(1)

    // The confirmation opened in the same tick; while the sync holds the shared
    // lock its confirm is disabled, and even a programmatic activation cannot
    // issue a disconnect request.
    const confirm = screen.getByRole('button', { name: 'Disconnect' })
    expect(confirm).toBeDisabled()
    act(() => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      confirm.dispatchEvent(click)
    })
    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(0)
    expect(
      calls(mock, '/api/plaid/connections/6/sync/', 'POST'),
    ).toHaveLength(1)

    await act(async () => {
      pendingSync.resolve(
        jsonResponse({
          connection_id: 6,
          status: 'active',
          added: 1,
          modified: 0,
          removed: 0,
        }),
      )
    })
    // The sync lock is released, but the confirmation opened in the same tick
    // still locks the screen until it is cancelled.
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(
      screen.getByRole('button', { name: 'Sync now for Second Bank' }),
    ).toBeDisabled()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByRole('button', { name: 'Sync now for Second Bank' }),
    ).toBeEnabled()
    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(0)
  })
})

describe('connections late mutation responses after navigation', () => {
  const SYNC_5_URL = '/api/plaid/connections/5/sync/'

  beforeEach(() => {
    setCsrfCookie()
    plaidLink.reset()
  })

  it('ignores a late disconnect 401 after navigating to the dashboard', async () => {
    const pendingDisconnect = deferred<Response>()
    const mock = installFetchMock(
      lifecycleHandler({
        connections: () =>
          jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'updating',
            }),
          ]),
        disconnect: () => pendingDisconnect.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Disconnect First Plaid Bank' }),
    )
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }))
    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(1)

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      pendingDisconnect.resolve(
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
    expect(calls(mock, DISCONNECT_URL, 'POST')).toHaveLength(1)
  })

  it('ignores a late sync 401 after navigating to the dashboard', async () => {
    const pendingSync = deferred<Response>()
    const mock = installFetchMock(
      lifecycleHandler({
        connections: () =>
          jsonResponse([
            connectionFixture({
              id: 5,
              institution_name: 'First Plaid Bank',
              status: 'active',
            }),
          ]),
        sync: () => pendingSync.promise,
      }),
    )
    renderApp('/connections')
    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Sync now for First Plaid Bank' }),
    )
    expect(calls(mock, SYNC_5_URL, 'POST')).toHaveLength(1)

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      pendingSync.resolve(
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
    expect(calls(mock, SYNC_5_URL, 'POST')).toHaveLength(1)
  })
})