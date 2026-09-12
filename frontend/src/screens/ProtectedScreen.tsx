import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'

export function ProtectedScreen() {
  const { user, logout } = useAuth()
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleLogout() {
    if (pending) return
    setErrorMessage(null)
    setPending(true)
    try {
      await logout()
    } catch {
      setErrorMessage('Could not sign out. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="screen">
      <p>Signed in as {user?.email}</p>
      {errorMessage !== null && (
        <div className="error-summary" role="alert">
          {errorMessage}
        </div>
      )}
      <button
        type="button"
        className="btn"
        onClick={handleLogout}
        disabled={pending}
      >
        {pending ? 'Signing out…' : 'Sign out'}
      </button>
      <p className="empty-state">
        Your accounts, transactions, and budgets will appear here once they are
        added.
      </p>
    </div>
  )
}