import { Link, Outlet } from 'react-router-dom'

export function AppShell() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <h1 className="brand">
          <Link to="/">Mohr</Link>
        </h1>
      </header>
      <main id="main" className="site-main">
        <Outlet />
      </main>
    </>
  )
}