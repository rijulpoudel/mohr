import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

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

export function GuestRoute({ children }: { children: ReactNode }) {
  const { status, restoreError, retryRestore } = useAuth()
  if (status === 'loading') {
    return (
      <p className="screen" role="status">
        Checking your session…
      </p>
    )
  }
  if (status === 'authenticated') {
    return <Navigate to="/" replace />
  }
  if (status === 'restore-error') {
    return <RestoreError message={restoreError} onRetry={retryRestore} />
  }
  return children
}