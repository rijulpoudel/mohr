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
  setCsrfCookie,
} from '../test/testUtils'

const LINK_TOKEN = 'link-sandbox-abcdef1234567890'
const EXPIRATION = '2026-09-18T12:00:00Z'
const EXCHANGE_HANDLE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const PUBLIC_TOKEN = 'public-sandbox-abc123def456ghi789'
const TIMESTAMP = '2026-09-11T14:52:48.008850Z'

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
  const usePlaidLink = vi.fn((next: CapturedLinkOptions) => {
    options = next
    return { open, exit, ready: true, error: null, submit }
  })
  return {
    open,
    exit,
    submit,
    usePlaidLink,
    latestOptions: () => options,
    reset: () => {
      options = null
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

function linkTokenFixture(overrides: Record<string, unknown> = {}) {
  return {
    link_token: LINK_TOKEN,
    expiration: EXPIRATION,
    exchange_handle: EXCHANGE_HANDLE,
    ...overrides,
  }
}

function exchangeFixture(overrides: Record<string, unknown> = {}) {
  return {
    connection: {
      id: 5,
      institution_name: 'First Plaid Bank',
      status: 'active',
      linked_accounts: [],
    },
    ...overrides,
  }
}

function syncFixture(overrides: Record<string, unknown> = {}) {
  return {
    connection_id: 5,
    status: 'active',
    added: 3,
    modified: 1,
    removed: 0,
    ...overrides,
  }
}

function processingFixture() {
  return { connection_id: 5, status: 'processing' }
}

function connectionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    institution_name: 'First Plaid Bank',
    status: 'active',
    sync_pending: false,
    last_synced_at: TIMESTAMP,
    linked_accounts: [],
    ...overrides,
  }
}

function authenticatedHandler(
  overrides: Partial<{
    connections: (url: string, init?: RequestInit) => Response | Promise<Response>
    linkToken: (url: string, init?: RequestInit) => Response | Promise<Response>
    exchange: (url: string, init?: RequestInit) => Response | Promise<Response>
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
    if (url === '/api/plaid/link-token/' && init?.method === 'POST') {
      return overrides.linkToken
        ? overrides.linkToken(url, init)
        : jsonResponse(linkTokenFixture())
    }
    if (url === '/api/plaid/exchange/' && init?.method === 'POST') {
      return overrides.exchange
        ? overrides.exchange(url, init)
        : jsonResponse(exchangeFixture(), 201)
    }
    if (url === '/api/plaid/connections/5/sync/' && init?.method === 'POST') {
      return overrides.sync
        ? overrides.sync(url, init)
        : jsonResponse(syncFixture())
    }
    if (url === '/api/plaid/connections/') {
      return overrides.connections
        ? overrides.connections(url, init)
        : jsonResponse([])
    }
    return jsonResponse({}, 404)
  }
}

function linkSuccess() {
  act(() => {
    plaidLink.latestOptions()?.onSuccess(PUBLIC_TOKEN, {})
  })
}

function linkDismiss() {
  act(() => {
    plaidLink.latestOptions()?.onExit?.(null, {})
  })
}

function linkExitWith(error: PlaidLinkError) {
  act(() => {
    plaidLink.latestOptions()?.onExit?.(error, {})
  })
}

async function openLinkViaButton() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Connect a bank' }))
  await waitFor(() => expect(plaidLink.open).toHaveBeenCalled())
}

beforeEach(() => {
  setCsrfCookie()
  plaidLink.reset()
})

describe('connect bank button states', () => {
  it('renders a real Connect a bank button in the empty list state', async () => {
    installFetchMock(authenticatedHandler())
    renderApp('/connections')

    expect(await screen.findByText(/No bank connections yet/)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Connect a bank' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toBeEnabled()
  })

  it('renders a real Connect a bank button in the non-empty list state', async () => {
    installFetchMock(
      authenticatedHandler({
        connections: () => jsonResponse([connectionFixture()]),
      }),
    )
    renderApp('/connections')

    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Bank connections' })).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Connect a bank' })
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toBeEnabled()
  })

  it('disables the button and states that preparation is in progress while the link-token request is pending', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedHandler({ linkToken: () => pending.promise }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Connect a bank' }))

    const preparing = await screen.findByRole('button', {
      name: /Preparing/,
    })
    expect(preparing).toHaveAttribute('disabled')
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)

    await act(async () => {
      pending.resolve(jsonResponse(linkTokenFixture()))
    })
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it('opens Link exactly once per live token and never again while that token is live', async () => {
    const mock = installFetchMock(authenticatedHandler())
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    expect(plaidLink.open).toHaveBeenCalledTimes(1)

    linkDismiss()
    expect(plaidLink.open).toHaveBeenCalledTimes(1)

    await openLinkViaButton()
    expect(plaidLink.open).toHaveBeenCalledTimes(2)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(2)
  })

  it('issues exactly one link-token request and one open for two clicks in the same tick', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedHandler({ linkToken: () => pending.promise }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    const button = screen.getByRole('button', { name: 'Connect a bank' })
    act(() => {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      button.dispatchEvent(click)
      button.dispatchEvent(click)
    })

    await waitFor(() =>
      expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1),
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Preparing/ })).toBeDisabled(),
    )

    await act(async () => {
      pending.resolve(jsonResponse(linkTokenFixture()))
    })
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })
})

describe('connect bank exchange and first sync', () => {
  it('exchanges the public token with the exact body and an unmodified exchange handle', async () => {
    const mock = installFetchMock(authenticatedHandler())
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    await waitFor(() =>
      expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1),
    )
    const exchangeCalls = calls(mock, '/api/plaid/exchange/', 'POST')
    expect(exchangeCalls).toHaveLength(1)
    const [, init] = exchangeCalls[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      public_token: PUBLIC_TOKEN,
      exchange_handle: EXCHANGE_HANDLE,
    })
  })

  it('automatically runs the first sync after exchange and refetches the connection list from the server', async () => {
    let connectionsCalls = 0
    const mock = installFetchMock(
      authenticatedHandler({
        connections: () => {
          connectionsCalls += 1
          if (connectionsCalls === 1) return jsonResponse([])
          return jsonResponse([connectionFixture()])
        },
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    await waitFor(() =>
      expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1),
    )
    const syncCalls = calls(mock, '/api/plaid/connections/5/sync/', 'POST')
    expect(syncCalls).toHaveLength(1)

    expect(await screen.findByText('First Plaid Bank')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Bank connections' })).toBeInTheDocument()
    expect(connectionsCalls).toBe(2)
    expect(calls(mock, '/api/plaid/connections/', 'GET')).toHaveLength(2)
  })

  it('renders an honest completion summary built only from the validated counts', async () => {
    installFetchMock(authenticatedHandler())
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    expect(
      await screen.findByText('Bank connected. 3 added, 1 updated.'),
    ).toBeInTheDocument()
  })

  it('reports No changes when the first sync finds nothing', async () => {
    installFetchMock(
      authenticatedHandler({
        sync: () =>
          jsonResponse(
            syncFixture({ added: 0, modified: 0, removed: 0 }),
          ),
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    expect(
      await screen.findByText('Bank connected. No changes were found.'),
    ).toBeInTheDocument()
  })

  it('shows an honest still-importing state for a 202 sync instead of claiming completion', async () => {
    installFetchMock(
      authenticatedHandler({
        sync: () => jsonResponse(processingFixture(), 202),
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    expect(await screen.findByRole('status')).toHaveTextContent(
      /Still importing/,
    )
    expect(screen.queryByText(/Bank connected/)).not.toBeInTheDocument()
  })

  it('exposes the in-progress import with role=status and keeps the button disabled', async () => {
    const syncPending = deferred<Response>()
    installFetchMock(
      authenticatedHandler({ sync: () => syncPending.promise }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    expect(await screen.findByRole('status')).toHaveTextContent(
      /Importing your bank data/,
    )
    expect(screen.getByRole('button', { name: 'Connect a bank' })).toBeDisabled()

    await act(async () => {
      syncPending.resolve(jsonResponse(syncFixture()))
    })
    expect(
      await screen.findByText('Bank connected. 3 added, 1 updated.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect a bank' })).toBeEnabled()
  })
})

describe('connect bank failure handling', () => {
  it('shows a retryable alert when the link-token request fails', async () => {
    let linkTokenCalls = 0
    const mock = installFetchMock(
      authenticatedHandler({
        linkToken: () => {
          linkTokenCalls += 1
          if (linkTokenCalls === 1) {
            return jsonResponse({ detail: 'Token service down.' }, 500)
          }
          return jsonResponse(linkTokenFixture())
        },
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Connect a bank' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Token service down.')
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
    expect(plaidLink.open).not.toHaveBeenCalled()

    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(1))
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a retryable alert when the exchange fails', async () => {
    let exchangeCalls = 0
    const mock = installFetchMock(
      authenticatedHandler({
        exchange: () => {
          exchangeCalls += 1
          if (exchangeCalls === 1) {
            return jsonResponse({ detail: 'Exchange rejected.' }, 400)
          }
          return jsonResponse(exchangeFixture(), 201)
        },
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Exchange rejected.')
    expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(0)

    const user = userEvent.setup()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(2))
    linkSuccess()
    await waitFor(() =>
      expect(calls(mock, '/api/plaid/exchange/', 'POST')).toHaveLength(2),
    )
    expect(
      await screen.findByText('Bank connected. 3 added, 1 updated.'),
    ).toBeInTheDocument()
  })

  it('shows a retryable alert when the first sync fails', async () => {
    let syncCalls = 0
    const mock = installFetchMock(
      authenticatedHandler({
        sync: () => {
          syncCalls += 1
          if (syncCalls === 1) {
            return jsonResponse({ detail: 'Sync service down.' }, 500)
          }
          return jsonResponse(syncFixture())
        },
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Sync service down.')
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)

    const user = userEvent.setup()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(2))
    linkSuccess()
    await waitFor(() => expect(syncCalls).toBe(2))
    expect(
      await screen.findByText('Bank connected. 3 added, 1 updated.'),
    ).toBeInTheDocument()
  })

  it('clears the session and shows no alert when the link-token request returns 401', async () => {
    const mock = installFetchMock(
      authenticatedHandler({
        linkToken: () =>
          jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          ),
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Connect a bank' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(plaidLink.open).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(1)
  })

  it('clears the session and shows no alert when the exchange returns 401', async () => {
    const mock = installFetchMock(
      authenticatedHandler({
        exchange: () =>
          jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          ),
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      calls(mock, '/api/plaid/connections/5/sync/', 'POST'),
    ).toHaveLength(0)
  })

  it('clears the session and shows no alert when the first sync returns 401', async () => {
    const mock = installFetchMock(
      authenticatedHandler({
        sync: () =>
          jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          ),
      }),
    )
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/plaid/connections/5/sync/', 'POST')).toHaveLength(1)
  })
})

describe('connect bank onExit behavior', () => {
  it('returns to idle with no alert when Link is dismissed, clearing the token for the next click', async () => {
    const mock = installFetchMock(authenticatedHandler())
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkDismiss()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect a bank' })).toBeEnabled()
    expect(plaidLink.open).toHaveBeenCalledTimes(1)

    await openLinkViaButton()
    expect(plaidLink.open).toHaveBeenCalledTimes(2)
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(2)
  })

  it('shows a retryable message on INVALID_LINK_TOKEN exit without reopening Link automatically', async () => {
    const mock = installFetchMock(authenticatedHandler())
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkExitWith({
      error_type: 'INVALID_LINK_TOKEN',
      error_code: 'INVALID_LINK_TOKEN',
      error_message: 'The link token has expired.',
      display_message: null,
    })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/link expired/i)
    expect(plaidLink.open).toHaveBeenCalledTimes(1)

    const user = userEvent.setup()
    await user.click(within(alert).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(plaidLink.open).toHaveBeenCalledTimes(2))
    expect(calls(mock, '/api/plaid/link-token/', 'POST')).toHaveLength(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('connect bank token secrecy', () => {
  it('never writes token material to storage, cookies, or the console on the success path', async () => {
    installFetchMock(authenticatedHandler())
    renderApp('/connections')
    await screen.findByText(/No bank connections yet/)

    await openLinkViaButton()
    linkSuccess()
    await screen.findByText('Bank connected. 3 added, 1 updated.')

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(document.cookie).not.toContain(LINK_TOKEN)
    expect(document.cookie).not.toContain(PUBLIC_TOKEN)
    expect(document.cookie).not.toContain(EXCHANGE_HANDLE)
  })

  it('never writes token material to storage or the console on the failure path', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      installFetchMock(
        authenticatedHandler({
          linkToken: () => jsonResponse({ detail: 'Token service down.' }, 500),
        }),
      )
      renderApp('/connections')
      await screen.findByText(/No bank connections yet/)

      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Connect a bank' }))
      await screen.findByRole('alert')

      const output = [
        ...consoleSpy.mock.calls,
        ...warnSpy.mock.calls,
        ...errorSpy.mock.calls,
      ]
        .flat()
        .join('\n')
      expect(output).not.toContain(LINK_TOKEN)
      expect(output).not.toContain(PUBLIC_TOKEN)
      expect(output).not.toContain(EXCHANGE_HANDLE)
      expect(localStorage.length).toBe(0)
      expect(sessionStorage.length).toBe(0)
    } finally {
      consoleSpy.mockRestore()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })
})