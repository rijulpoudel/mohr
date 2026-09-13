import { Link, NavLink, Outlet } from 'react-router-dom'
import { useAuth } from './auth/AuthContext'

export function AppShell() {
  const { status } = useAuth()
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="site-header-inner">
          <h1 className="brand">
            <Link to="/">Mohr</Link>
          </h1>
          {status === 'authenticated' && (
            <nav aria-label="Primary" className="site-nav">
              <NavLink to="/" end>
                Dashboard
              </NavLink>
              <NavLink to="/accounts">Accounts</NavLink>
              <NavLink to="/categories">Categories</NavLink>
              <NavLink to="/transactions">Transactions</NavLink>
            </nav>
          )}
        </div>
      </header>
      <main id="main" className="site-main">
        <Outlet />
      </main>
    </>
  )
}