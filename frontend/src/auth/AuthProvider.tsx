import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { loginRequest, logoutRequest, registerRequest, restoreSession } from '../api/auth'
import { ApiError, type User } from '../api/types'
import { AuthContext, type AuthContextValue, type AuthStatus } from './AuthContext'

const RESTORE_ERROR_MESSAGE = 'Could not restore your session.'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<User | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    void restoreSession()
      .then((restored) => {
        if (cancelled) return
        setUser(restored)
        setStatus('authenticated')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          setUser(null)
          setStatus('unauthenticated')
        } else {
          setRestoreError(RESTORE_ERROR_MESSAGE)
          setStatus('restore-error')
        }
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const retryRestore = useCallback(() => {
    setRestoreError(null)
    setStatus('loading')
    setAttempt((current) => current + 1)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const authenticated = await loginRequest(email, password)
    setUser(authenticated)
    setStatus('authenticated')
  }, [])

  const register = useCallback(async (email: string, password: string) => {
    await registerRequest(email, password)
  }, [])

  const logout = useCallback(async () => {
    await logoutRequest()
    setUser(null)
    setStatus('unauthenticated')
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      restoreError,
      login,
      register,
      logout,
      retryRestore,
    }),
    [status, user, restoreError, login, register, logout, retryRestore],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}