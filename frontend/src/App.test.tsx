import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'
import {
  installFetchMock,
  jsonResponse,
  renderApp,
  setCsrfCookie,
} from './test/testUtils'

function renderAtLoginWithFrom(fromPath: string) {
  window.history.replaceState({ usr: null, key: 'default', idx: 0 }, '', '/')
  window.history.pushState(
    { usr: { from: { pathname: fromPath } }, key: 'login', idx: 1 },
    '',
    '/login',
  )
  return render(<App />)
}

const DASHBOARD_SUMMARY = {
  total_balance: '0.00',
  current_month_income: '0.00',
  current_month_expenses: '0.00',
  total_budgeted: '0.00',
  remaining_budget: '0.00',
  recent_transactions: [],
}

// None of Mohr's private routes has a dynamic subroute, and none may host a
// scheme-relative, backslash, or traversal path. Each must fall back to `/`.
const INVALID_FROM_DESTINATIONS = [
  '/unknown',
  '//evil.example',
  '/\\evil.example',
  '/accounts/../../evil',
  '/accounts/not-a-real-subroute',
] as const

describe('Mohr shell', () => {
  it('renders the Mohr brand', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/')
    expect(await screen.findByRole('link', { name: 'Mohr' })).toBeInTheDocument()
  })

  it('shows the public landing page to signed-out visitors at /', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/')
    expect(
      await screen.findByRole('heading', {
        level: 2,
        name: /Where your money went/i,
      }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'Get started' }).length).toBe(
      2,
    )
    expect(window.location.pathname).toBe('/')
    expect(screen.queryByText('Signed in as')).not.toBeInTheDocument()
  })
})

describe('guest route guard for signed-in visitors', () => {
  it('redirects an already-restored visitor with a private from destination', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'restored@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse({
          total_balance: '0.00',
          current_month_income: '0.00',
          current_month_expenses: '0.00',
          total_budgeted: '0.00',
          remaining_budget: '0.00',
          recent_transactions: [],
        })
      }
      if (url === '/api/accounts/') return jsonResponse([])
      return jsonResponse({}, 404)
    })
    renderAtLoginWithFrom('/accounts')
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Accounts' }),
      ).toBeInTheDocument()
      expect(window.location.pathname).toBe('/accounts')
    })
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it('falls back to the dashboard for an unknown from destination', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'restored@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse({
          total_balance: '0.00',
          current_month_income: '0.00',
          current_month_expenses: '0.00',
          total_budgeted: '0.00',
          remaining_budget: '0.00',
          recent_transactions: [],
        })
      }
      return jsonResponse({}, 404)
    })
    renderAtLoginWithFrom('/evil')
    expect(
      await screen.findByRole('heading', { name: 'Overview' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it.each(INVALID_FROM_DESTINATIONS)(
    'falls back to the dashboard for the invalid restored destination %s',
    async (fromPath) => {
      installFetchMock((url) => {
        if (url === '/api/auth/me/') {
          return jsonResponse({ id: 1, email: 'restored@example.com' })
        }
        if (url === '/api/dashboard/summary/') {
          return jsonResponse(DASHBOARD_SUMMARY)
        }
        return jsonResponse({}, 404)
      })
      renderAtLoginWithFrom(fromPath)
      expect(
        await screen.findByRole('heading', { name: 'Overview' }),
      ).toBeInTheDocument()
      expect(window.location.pathname).toBe('/')
      expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    },
  )
})

describe('password login destination', () => {
  it('returns a password login to the protected from destination', async () => {
    installFetchMock((url, init) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse({ id: 4, email: 'back@example.com' })
      }
      if (url === '/api/accounts/') return jsonResponse([])
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    renderApp('/accounts')
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    await user.type(screen.getByLabelText('Email'), 'back@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Accounts' }),
      ).toBeInTheDocument()
      expect(window.location.pathname).toBe('/accounts')
    })
  })

  it.each(INVALID_FROM_DESTINATIONS)(
    'returns a password login to the dashboard for the invalid destination %s',
    async (fromPath) => {
      installFetchMock((url, init) => {
        if (url === '/api/auth/me/') return jsonResponse({}, 401)
        if (url === '/api/auth/csrf/') {
          setCsrfCookie()
          return jsonResponse({ detail: 'CSRF cookie set.' })
        }
        if (url === '/api/auth/login/' && (init?.method ?? 'GET') === 'POST') {
          return jsonResponse({ id: 4, email: 'back@example.com' })
        }
        if (url === '/api/dashboard/summary/') {
          return jsonResponse(DASHBOARD_SUMMARY)
        }
        return jsonResponse({}, 404)
      })
      const user = userEvent.setup()
      renderAtLoginWithFrom(fromPath)
      expect(await screen.findByLabelText('Email')).toBeInTheDocument()
      await user.type(screen.getByLabelText('Email'), 'back@example.com')
      await user.type(screen.getByLabelText('Password'), 'correct-horse')
      await user.click(screen.getByRole('button', { name: 'Sign in' }))
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: 'Overview' }),
        ).toBeInTheDocument()
        expect(window.location.pathname).toBe('/')
      })
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    },
  )
})

describe('unknown routes', () => {
  it('renders a restrained not-found screen', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/no/such/page')
    expect(
      await screen.findByRole('heading', { name: 'Page not found' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Mohr' })).toBeInTheDocument()
  })
})

describe('session storage', () => {
  it('never writes auth values to web storage', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/') {
        return jsonResponse({ id: 1, email: 'stored@example.com' })
      }
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    renderApp('/')
    await user.click(
      (await screen.findAllByRole('link', { name: 'Sign in' }))[0],
    )
    await user.type(await screen.findByLabelText('Email'), 'stored@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('Signed in as stored@example.com')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})