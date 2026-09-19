import { useEffect } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetApiRequests } from '../api/resetRequests'
import { useAuth } from './AuthContext'
import { AuthProvider } from './AuthProvider'
import {
  emptyResponse,
  installFetchMock,
  jsonResponse,
  setCsrfCookie,
} from '../test/testUtils'

vi.mock('../api/resetRequests', () => ({ resetApiRequests: vi.fn() }))

const order: string[] = []

function AuthHarness() {
  const { status, user, login, logout, register, clearSession } = useAuth()
  useEffect(() => {
    order.push(`${status}:${user?.email ?? 'none'}`)
  }, [status, user])
  return (
    <div>
      <output data-testid="status">{status}</output>
      <output data-testid="user">{user?.email ?? 'none'}</output>
      <button
        type="button"
        onClick={() => {
          void login('a@example.com', 'correct-horse').catch(() => {})
        }}
      >
        Log in
      </button>
      <button
        type="button"
        onClick={() => {
          void logout().catch(() => {})
        }}
      >
        Log out
      </button>
      <button
        type="button"
        onClick={() => {
          void register('r@example.com', 'correct-horse').catch(() => {})
        }}
      >
        Register
      </button>
      <button type="button" onClick={clearSession}>
        Clear session
      </button>
    </div>
  )
}

function authenticatedHandler(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'a@example.com' })
    }
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    return handler(url, init)
  }
}

function renderHarness() {
  return render(
    <AuthProvider>
      <AuthHarness />
    </AuthProvider>,
  )
}

// The harness records state changes from a passive effect, which React flushes
// after the commit that publishes the new auth state. Await the record before
// asserting relative order, otherwise the assertion races that flush.
async function waitForRecord(entry: string) {
  await waitFor(() => {
    expect(order).toContain(entry)
  })
}

beforeEach(() => {
  order.length = 0
  vi.mocked(resetApiRequests).mockClear()
  vi.mocked(resetApiRequests).mockImplementation(() => {
    order.push('reset-requests')
  })
})

describe('auth transition request reset', () => {
  it('resets in-flight requests on restore-session 401 before going unauthenticated', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      return jsonResponse({}, 404)
    })
    renderHarness()

    expect(await screen.findByTestId('status')).toHaveTextContent(
      'unauthenticated',
    )
    expect(resetApiRequests).toHaveBeenCalledTimes(1)
    await waitForRecord('unauthenticated:none')
    expect(order.indexOf('reset-requests')).toBeLessThan(
      order.indexOf('unauthenticated:none'),
    )
  })

  it('does not reset in-flight requests on a successful restore', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'a@example.com' })
      }
      return jsonResponse({}, 404)
    })
    renderHarness()

    expect(await screen.findByTestId('user')).toHaveTextContent('a@example.com')
    expect(resetApiRequests).not.toHaveBeenCalled()
  })

  it('resets in-flight requests on successful login before publishing the new user', async () => {
    installFetchMock(
      authenticatedHandler((url) => {
        if (url === '/api/auth/login/') {
          return jsonResponse({ id: 2, email: 'b@example.com' })
        }
        return jsonResponse({}, 404)
      }),
    )
    renderHarness()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Log in' }))

    expect(await screen.findByTestId('user')).toHaveTextContent('b@example.com')
    expect(resetApiRequests).toHaveBeenCalledTimes(1)
    const resetIndex = order.indexOf('reset-requests')
    expect(resetIndex).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('authenticated:b@example.com')).toBeGreaterThan(
      resetIndex,
    )
  })

  it('does not reset in-flight requests when login fails', async () => {
    installFetchMock(
      authenticatedHandler((url) => {
        if (url === '/api/auth/login/') {
          return jsonResponse({ detail: 'Invalid credentials.' }, 400)
        }
        return jsonResponse({}, 404)
      }),
    )
    renderHarness()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Log in' }))

    expect(resetApiRequests).not.toHaveBeenCalled()
    expect(screen.getByTestId('user')).toHaveTextContent('a@example.com')
  })

  it('resets in-flight requests on successful logout before clearing the user', async () => {
    installFetchMock(
      authenticatedHandler((url) => {
        if (url === '/api/auth/logout/') return emptyResponse()
        return jsonResponse({}, 404)
      }),
    )
    renderHarness()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Log out' }))

    expect(await screen.findByTestId('status')).toHaveTextContent(
      'unauthenticated',
    )
    expect(resetApiRequests).toHaveBeenCalledTimes(1)
    await waitForRecord('unauthenticated:none')
    expect(order.indexOf('reset-requests')).toBeLessThan(
      order.indexOf('unauthenticated:none'),
    )
  })

  it('does not reset in-flight requests when logout fails and the user stays', async () => {
    installFetchMock(
      authenticatedHandler((url) => {
        if (url === '/api/auth/logout/') {
          return new Response(null, { status: 500 })
        }
        return jsonResponse({}, 404)
      }),
    )
    renderHarness()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Log out' }))

    expect(resetApiRequests).not.toHaveBeenCalled()
    expect(screen.getByTestId('user')).toHaveTextContent('a@example.com')
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
  })

  it('resets in-flight requests on clearSession before clearing the user', async () => {
    installFetchMock(
      authenticatedHandler((url) => {
        if (url === '/api/auth/login/') {
          return jsonResponse({ id: 2, email: 'b@example.com' })
        }
        return jsonResponse({}, 404)
      }),
    )
    renderHarness()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Log in' }))
    expect(await screen.findByTestId('user')).toHaveTextContent('b@example.com')

    vi.mocked(resetApiRequests).mockClear()
    order.length = 0
    await user.click(screen.getByRole('button', { name: 'Clear session' }))

    expect(await screen.findByTestId('status')).toHaveTextContent(
      'unauthenticated',
    )
    expect(resetApiRequests).toHaveBeenCalledTimes(1)
    await waitForRecord('unauthenticated:none')
    expect(order.indexOf('reset-requests')).toBeLessThan(
      order.indexOf('unauthenticated:none'),
    )
  })

  it('does not reset in-flight requests on registration', async () => {
    installFetchMock(
      authenticatedHandler((url) => {
        if (url === '/api/auth/register/') {
          return jsonResponse({ id: 3, email: 'r@example.com' })
        }
        return jsonResponse({}, 404)
      }),
    )
    renderHarness()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Register' }))

    expect(resetApiRequests).not.toHaveBeenCalled()
  })
})