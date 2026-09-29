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
  if (url === '/api/auth/login/') {
    return jsonResponse({ id: 1, email: 'student@example.com' })
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

  it('offers an authenticated native download link to the export endpoint', async () => {
    installFetchMock(authenticatedHandler)
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const download = within(nav).getByRole('link', { name: 'Download data' })
    expect(download).toHaveAttribute('href', '/api/auth/export/')
    expect(download.tagName).toBe('A')
  })

  it('never shows the download link to guests', async () => {
    installFetchMock(guestHandler)
    renderApp('/login')

    await screen.findByRole('link', { name: 'Mohr' })
    expect(
      screen.queryByRole('link', { name: 'Download data' }),
    ).not.toBeInTheDocument()
  })

  it('closes the mobile drawer when the download link is activated', async () => {
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const toggle = screen.getByRole('button', { name: 'Menu' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    const download = within(nav).getByRole('link', { name: 'Download data' })
    download.addEventListener('click', (event) => event.preventDefault())

    await user.click(download)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus()
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
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus()
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

  it('keeps the drawer closed when a new session starts after signing out', async () => {
    installFetchMock(sessionEndHandler)
    const user = userEvent.setup()
    renderApp('/')

    await screen.findByText('Signed in as student@example.com')
    const toggle = screen.getByRole('button', { name: 'Menu' })
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.body.style.overflow).toBe('hidden')

    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    await screen.findByLabelText('Email')

    await user.type(screen.getByLabelText('Email'), 'student@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('Signed in as student@example.com')

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const reopenedToggle = screen.getByRole('button', { name: /menu/i })
    expect(reopenedToggle).toHaveAttribute('aria-expanded', 'false')
    expect(nav).not.toHaveClass('is-open')
    expect(screen.getByRole('main')).not.toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('')
    expect(
      within(nav).getByRole('link', { name: 'Dashboard' }),
    ).not.toHaveFocus()
  })
})

describe('mobile drawer keyboard focus', () => {
  it('focuses the first nav link, contains Tab, and skips the scrim', async () => {
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const toggle = screen.getByRole('button', { name: 'Menu' })
    await user.click(toggle)

    const closeToggle = screen.getByRole('button', { name: 'Close menu' })
    const firstLink = within(nav).getByRole('link', { name: 'Dashboard' })
    const download = within(nav).getByRole('link', { name: 'Download data' })
    const scrim = screen.getByRole('button', { name: 'Close navigation' })

    expect(firstLink).toHaveFocus()
    expect(scrim).toHaveAttribute('tabindex', '-1')

    await user.tab({ shift: true })
    expect(closeToggle).toHaveFocus()

    await user.tab({ shift: true })
    expect(download).toHaveFocus()

    await user.tab()
    expect(closeToggle).toHaveFocus()

    await user.tab()
    expect(firstLink).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus()
  })

  it('returns focus to the toggle when a nav route closes the drawer', async () => {
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const toggle = screen.getByRole('button', { name: 'Menu' })
    await user.click(toggle)

    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveFocus()
  })

  it('does not focus the hidden toggle when the viewport becomes desktop', async () => {
    const desktop = installDesktopMediaQuery(false)
    installFetchMock(authenticatedHandler)
    const user = userEvent.setup()
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const toggle = await screen.findByRole('button', { name: 'Menu' })
    await user.click(toggle)

    desktop.fireChange(true)

    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-expanded', 'false'),
    )
    expect(toggle).not.toHaveFocus()
    expect(document.activeElement).toBe(
      within(nav).getByRole('link', { name: 'Dashboard' }),
    )
  })

  it('leaves focus on the document body on initial render', async () => {
    installFetchMock(authenticatedHandler)
    renderApp('/accounts')

    await screen.findByRole('navigation', { name: 'Primary' })
    expect(document.body).toHaveFocus()
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
