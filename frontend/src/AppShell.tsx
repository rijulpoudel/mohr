import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import { MohrMark } from './components/MohrMark'

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/cash-flow', label: 'Cash Flow' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/connections', label: 'Connections' },
  { to: '/categories', label: 'Categories' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/budgets', label: 'Budgets' },
]

const DESKTOP_MEDIA_QUERY = '(min-width: 48rem)'

export function AppShell() {
  const { status } = useAuth()
  const authenticated = status === 'authenticated'
  const [menuOpen, setMenuOpen] = useState(false)
  const [previousAuthenticated, setPreviousAuthenticated] = useState(
    authenticated,
  )

  // The shell outlives the session, so drop session-local drawer state when the
  // session ends instead of reopening it for the next user on the same page.
  if (previousAuthenticated !== authenticated) {
    setPreviousAuthenticated(authenticated)
    if (!authenticated) setMenuOpen(false)
  }
  const [isDesktop, setIsDesktop] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia(DESKTOP_MEDIA_QUERY).matches,
  )
  const toggleRef = useRef<HTMLButtonElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const desktopQuery = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches)
      if (event.matches) setMenuOpen(false)
    }
    desktopQuery.addEventListener('change', handleChange)
    return () => desktopQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    if (menuOpen) {
      wasOpenRef.current = true
      return
    }
    const shouldRestore = wasOpenRef.current && authenticated && !isDesktop
    wasOpenRef.current = false
    if (shouldRestore) toggleRef.current?.focus()
  }, [menuOpen, authenticated, isDesktop])

  useEffect(() => {
    if (!(authenticated && menuOpen && !isDesktop)) return
    const collectFocusable = () => {
      const items: HTMLElement[] = []
      if (toggleRef.current) items.push(toggleRef.current)
      if (navRef.current) {
        items.push(
          ...navRef.current.querySelectorAll<HTMLElement>('a[href]'),
        )
      }
      return items
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const items = collectFocusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement as HTMLElement | null
      const inside = active !== null && items.includes(active)
      if (event.shiftKey) {
        if (active === first || !inside) {
          event.preventDefault()
          last.focus()
        }
      } else if (active === last || !inside) {
        event.preventDefault()
        first.focus()
      }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    navRef.current?.querySelector<HTMLElement>('a[href]')?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [authenticated, menuOpen, isDesktop])

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="site-header-inner">
          <h1 className="brand">
            <Link to="/">
              <MohrMark />
              <span>Mohr</span>
            </Link>
          </h1>
          {authenticated && (
            <button
              ref={toggleRef}
              type="button"
              className="menu-toggle"
              aria-expanded={menuOpen}
              aria-controls="primary-nav"
              onClick={() => setMenuOpen((open) => !open)}
            >
              {menuOpen ? 'Close menu' : 'Menu'}
            </button>
          )}
        </div>
      </header>
      {authenticated && menuOpen && (
        <button
          type="button"
          className="scrim"
          aria-label="Close navigation"
          tabIndex={-1}
          onClick={() => setMenuOpen(false)}
        />
      )}
      {authenticated && (
        <nav
          id="primary-nav"
          ref={navRef}
          aria-label="Primary"
          className={`site-nav${menuOpen ? ' is-open' : ''}`}
        >
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setMenuOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
          <a href="/api/auth/export/" onClick={() => setMenuOpen(false)}>
            Download data
          </a>
        </nav>
      )}
      <main
        id="main"
        className={`site-main${authenticated ? '' : ' site-main-guest'}`}
        tabIndex={-1}
        inert={(authenticated && menuOpen) || undefined}
      >
        <Outlet />
      </main>
    </div>
  )
}
