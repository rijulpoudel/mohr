import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

// Exact private routes reachable only when authenticated. None has a dynamic
// subroute, so only an exact match is a safe destination: unknown, unknown
// subroutes, scheme-relative, backslash, and traversal paths all fall back to
// the dashboard at `/`. Shared with the password login sink so both redirects
// validate the same way.
const PRIVATE_PATHS = new Set([
  '/',
  '/cash-flow',
  '/accounts',
  '/connections',
  '/categories',
  '/transactions',
  '/budgets',
])

// eslint-disable-next-line react-refresh/only-export-components
export function privateDestination(state: unknown): string {
  const from = (state as { from?: { pathname?: unknown } } | null)?.from
  const pathname = from?.pathname
  if (typeof pathname !== 'string') return '/'
  return PRIVATE_PATHS.has(pathname) ? pathname : '/'
}

function RestoreError({
  message,
  onRetry,
}: {
  message: string | null
  onRetry: () => void
}) {
  return (
    <div className="screen" role="alert">
      <p>{message}</p>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { status, restoreError, retryRestore } = useAuth()
  const location = useLocation()
  if (status === 'loading') {
    return (
      <p className="screen" role="status">
        Checking your session…
      </p>
    )
  }
  if (status === 'restore-error') {
    return <RestoreError message={restoreError} onRetry={retryRestore} />
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace state={{ from: location }} />
  }
  return children
}

// The public landing and the private dashboard share the `/` path. A guest
// sees the landing page; an authenticated visitor sees the dashboard; a failed
// restore stays a retryable error rather than being misread as signed out.
export function HomeRoute({
  guest,
  authenticated,
}: {
  guest: ReactNode
  authenticated: ReactNode
}) {
  const { status, restoreError, retryRestore } = useAuth()
  if (status === 'loading') {
    return (
      <p className="screen" role="status">
        Checking your session…
      </p>
    )
  }
  if (status === 'restore-error') {
    return <RestoreError message={restoreError} onRetry={retryRestore} />
  }
  return status === 'authenticated' ? authenticated : guest
}

export function GuestRoute({ children }: { children: ReactNode }) {
  const { status, restoreError, retryRestore } = useAuth()
  const location = useLocation()
  if (status === 'loading') {
    return (
      <p className="screen" role="status">
        Checking your session…
      </p>
    )
  }
  if (status === 'authenticated') {
    // A signed-in visitor never sees the guest form. ProtectedRoute records
    // the intended destination in location.state.from; redirect there when it
    // is a known private path, otherwise fall back to the dashboard.
    return <Navigate to={privateDestination(location.state)} replace />
  }
  if (status === 'restore-error') {
    return <RestoreError message={restoreError} onRetry={retryRestore} />
  }
  return children
}