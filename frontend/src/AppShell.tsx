import { useEffect, useState } from 'react'
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

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const desktopQuery = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) setMenuOpen(false)
    }
    desktopQuery.addEventListener('change', handleChange)
    return () => desktopQuery.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    if (!(authenticated && menuOpen)) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [authenticated, menuOpen])

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
          onClick={() => setMenuOpen(false)}
        />
      )}
      {authenticated && (
        <nav
          id="primary-nav"
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
        </nav>
      )}
      <main
        id="main"
        className={`site-main${authenticated ? '' : ' site-main-guest'}`}
        inert={(authenticated && menuOpen) || undefined}
      >
        <Outlet />
      </main>
    </div>
  )
}
