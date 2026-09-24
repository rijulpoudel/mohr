import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MohrMark } from './components/MohrMark'
import {
  emptyResponse,
  installFetchMock,
  jsonResponse,
  renderApp,
  setCsrfCookie,
} from './test/testUtils'

function authenticatedHandler(url: string) {
  if (url === '/api/auth/me/') {
    return jsonResponse({ id: 1, email: 'student@example.com' })
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
}

function guestHandler(url: string) {
  if (url === '/api/auth/me/') return jsonResponse({}, 401)
  return jsonResponse({}, 404)
}

function sessionEndHandler(url: string) {
  if (url === '/api/auth/me/') {
    return jsonResponse({ id: 1, email: 'student@example.com' })
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
  if (url === '/api/auth/csrf/') {
    setCsrfCookie()
    return jsonResponse({ detail: 'CSRF cookie set.' })
  }
  if (url === '/api/auth/logout/') return emptyResponse(204)
  return jsonResponse({}, 404)
}

function installDesktopMediaQuery(initialMatches = false) {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  const mql = {
    matches: initialMatches,
    media: '(min-width: 48rem)',
    onchange: null,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'change') listeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'change') listeners.delete(listener)
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      expect(query).toBe('(min-width: 48rem)')
      return mql
    }),
  )
  return {
    mql,
    listenerCount: () => listeners.size,
    fireChange(matches: boolean) {
      mql.matches = matches
      for (const listener of [...listeners]) listener({ matches })
    },
  }
}

describe('application shell navigation', () => {
  it('renders the seven authenticated routes with current-page state', async () => {
    installFetchMock(authenticatedHandler)
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    for (const name of [
      'Dashboard',
      'Cash Flow',
      'Accounts',
      'Connections',
      'Categories',
      'Transactions',
      'Budgets',
    ]) {
      expect(within(nav).getByRole('link', { name })).toBeInTheDocument()
    }
    expect(within(nav).getByRole('link', { name: 'Accounts' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('keeps the brand link but hides navigation and the menu button on guest routes', async () => {
    installFetchMock(guestHandler)
    renderApp('/login')

    expect(await screen.findByRole('link', { name: 'Mohr' })).toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveClass('site-main-guest')
  })

  it('exposes an accessible menu button that opens and closes the navigation', async () => {
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const toggle = screen.getByRole('button', { name: 'Menu' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', nav.id)

    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(nav).toHaveClass('is-open')

    await user.keyboard('{Escape}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(nav).not.toHaveClass('is-open')
  })

  it('closes the navigation after choosing a route from it', async () => {
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const toggle = screen.getByRole('button', { name: 'Menu' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('closes the navigation through the full-viewport scrim', async () => {
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    renderApp('/accounts')

    const toggle = await screen.findByRole('button', { name: 'Menu' })
    expect(
      screen.queryByRole('button', { name: 'Close navigation' }),
    ).not.toBeInTheDocument()

    await user.click(toggle)
    const scrim = screen.getByRole('button', { name: 'Close navigation' })
    await user.click(scrim)

    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('button', { name: 'Close navigation' }),
    ).not.toBeInTheDocument()
  })

  it('locks background scroll and makes main content inert while the drawer is open', async () => {
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    renderApp('/accounts')

    const toggle = await screen.findByRole('button', { name: 'Menu' })
    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('')

    await user.click(toggle)
    expect(screen.getByRole('main')).toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('hidden')

    await user.keyboard('{Escape}')
    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('')
  })

  it('never shows the scrim on guest routes', async () => {
    installFetchMock(guestHandler)
    renderApp('/login')

    await screen.findByRole('link', { name: 'Mohr' })
    expect(
      screen.queryByRole('button', { name: 'Close navigation' }),
    ).not.toBeInTheDocument()
  })

  it('closes the drawer and restores scrolling when the viewport crosses into desktop', async () => {
    const desktop = installDesktopMediaQuery(false)
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    const view = renderApp('/accounts')

    const toggle = await screen.findByRole('button', { name: 'Menu' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.body.style.overflow).toBe('hidden')
    expect(desktop.listenerCount()).toBe(1)

    desktop.fireChange(true)

    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-expanded', 'false'),
    )
    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('')
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()

    view.unmount()
    expect(desktop.listenerCount()).toBe(0)
  })

  it('releases the scroll lock when the session ends while the drawer is open', async () => {
    installFetchMock(sessionEndHandler)
    const user = userEvent.setup()
    renderApp('/')

    await screen.findByText('Signed in as student@example.com')
    const toggle = screen.getByRole('button', { name: 'Menu' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.body.style.overflow).toBe('hidden')

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByRole('button', { name: 'Sign in' })

    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('')
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
  })
})

describe('application shell accessibility', () => {
  it('keeps the skip link pointing at the main content anchor', async () => {
    installFetchMock(guestHandler)
    renderApp('/login')

    const skip = await screen.findByRole('link', { name: 'Skip to content' })
    expect(skip).toHaveAttribute('href', '#main')
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main')
  })
})

describe('Mohr brand mark', () => {
  it('gives each mark instance a unique def id', () => {
    const first = render(<MohrMark />)
    const second = render(<MohrMark />)

    const firstId = first.container.querySelector('svg defs path')?.id
    const secondId = second.container.querySelector('svg defs path')?.id
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()
    expect(firstId).not.toBe(secondId)
  })
})
