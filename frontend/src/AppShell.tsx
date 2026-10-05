import { useEffect, useRef, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'
import { MohrMark } from './components/MohrMark'
import landingStyles from './screens/LandingScreen.module.css'

const DOWNLOAD_ICON = (
  <>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M5 21h14" />
  </>
)

const NAV_ITEMS = [
  {
    to: '/',
    label: 'Dashboard',
    end: true,
    icon: (
      <>
        <rect x="3" y="3" width="8" height="8" rx="1.5" />
        <rect x="13" y="3" width="8" height="8" rx="1.5" />
        <rect x="3" y="13" width="8" height="8" rx="1.5" />
        <rect x="13" y="13" width="8" height="8" rx="1.5" />
      </>
    ),
  },
  {
    to: '/cash-flow',
    label: 'Cash Flow',
    icon: (
      <>
        <path d="M3 3v18h18" />
        <path d="m7 14 4-4 3 3 5-6" />
      </>
    ),
  },
  {
    to: '/accounts',
    label: 'Accounts',
    icon: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M3 10h18" />
        <path d="M7 15h4" />
      </>
    ),
  },
  {
    to: '/connections',
    label: 'Connections',
    icon: (
      <>
        <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.1 1.1" />
        <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.1-1.1" />
      </>
    ),
  },
  {
    to: '/categories',
    label: 'Categories',
    icon: (
      <>
        <path d="M3 3h8l10 10-8 8L3 11V3Z" />
        <circle cx="7.5" cy="7.5" r="1.5" />
      </>
    ),
  },
  {
    to: '/transactions',
    label: 'Transactions',
    icon: (
      <>
        <path d="M4 7h13l-3-3" />
        <path d="M20 17H7l3 3" />
      </>
    ),
  },
  {
    to: '/budgets',
    label: 'Budgets',
    icon: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3v9h9" />
      </>
    ),
  },
]

const DESKTOP_MEDIA_QUERY = '(min-width: 48rem)'

export function AppShell() {
  const { status } = useAuth()
  const { pathname } = useLocation()
  const authenticated = status === 'authenticated'
  // Marketing chrome belongs only on the signed-out landing; every private
  // route, auth form, and not-found screen keeps the standard shell.
  const publicLanding = status === 'unauthenticated' && pathname === '/'
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
    <div
      className={`app-shell${authenticated ? ' is-authenticated' : ''}${
        publicLanding ? ` ${landingStyles.publicLanding}` : ''
      }`}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="site-rail">
        <header className="site-header">
          <div className="site-header-inner">
            <h1 className="brand">
              <Link to="/">
                <MohrMark />
                <span>Mohr</span>
              </Link>
            </h1>
            {publicLanding && (
              <nav className={landingStyles.publicNav} aria-label="Public">
                <a
                  className={`${landingStyles.publicNavLink} ${landingStyles.publicNavFeatures}`}
                  href="#features"
                >
                  Features
                </a>
                <Link className={landingStyles.publicNavLink} to="/login">
                  Sign in
                </Link>
                <Link
                  className={`${landingStyles.primaryAction} ${landingStyles.publicNavCta}`}
                  to="/register"
                >
                  Get started
                </Link>
              </nav>
            )}
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
                <svg
                  className="nav-icon"
                  viewBox="0 0 24 24"
                  width="20"
                  height="20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  {item.icon}
                </svg>
                <span>{item.label}</span>
              </NavLink>
            ))}
            <a
              className="site-nav-export"
              href="/api/auth/export/"
              onClick={() => setMenuOpen(false)}
            >
              <svg
                className="nav-icon"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                {DOWNLOAD_ICON}
              </svg>
              <span>Download data</span>
            </a>
          </nav>
        )}
      </div>
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
