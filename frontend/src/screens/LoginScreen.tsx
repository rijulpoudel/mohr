import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ApiError, userMessage, type FieldErrors } from '../api/types'
import { useAuth } from '../auth/AuthContext'

interface LoginScreenState {
  from?: { pathname?: string }
  notice?: string
}

const FIELD_ERROR_SUMMARY = 'Please check the highlighted fields.'

export function LoginScreen() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const state = (location.state ?? {}) as LoginScreenState
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setErrorMessage(null)
    setFieldErrors(null)
    setPending(true)
    try {
      await login(email, password)
      navigate(state.from?.pathname ?? '/', { replace: true })
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrorMessage(userMessage(caught))
        setFieldErrors(caught.fieldErrors)
      } else {
        setErrorMessage('Something went wrong. Please try again.')
      }
    } finally {
      setPending(false)
    }
  }

  const summary =
    errorMessage ??
    (fieldErrors !== null && Object.keys(fieldErrors).length > 0
      ? FIELD_ERROR_SUMMARY
      : null)

  return (
    <div className="screen screen-narrow">
      <h2>Sign in</h2>
      {state.notice !== undefined && (
        <p className="notice" role="status">
          {state.notice}
        </p>
      )}
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            className="input"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-describedby={
              fieldErrors?.email !== undefined ? 'login-email-error' : undefined
            }
          />
          {fieldErrors?.email !== undefined && (
            <ul id="login-email-error" className="field-errors">
              {fieldErrors.email.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className="input"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={
              fieldErrors?.password !== undefined
                ? 'login-password-error'
                : undefined
            }
          />
          {fieldErrors?.password !== undefined && (
            <ul id="login-password-error" className="field-errors">
              {fieldErrors.password.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="screen-alt">
        New to Mohr? <Link to="/register">Create an account</Link>
      </p>
    </div>
  )
}