import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, userMessage, type FieldErrors } from '../api/types'
import { useAuth } from '../auth/AuthContext'

const FIELD_ERROR_SUMMARY = 'Please check the highlighted fields.'

export function RegisterScreen() {
  const { register } = useAuth()
  const navigate = useNavigate()
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
      await register(email, password)
      navigate('/login', { state: { notice: 'Account created. Sign in to continue.' } })
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
      <h2>Create account</h2>
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor="register-email">Email</label>
          <input
            id="register-email"
            className="input"
            type="email"
            name="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-describedby={
              fieldErrors?.email !== undefined ? 'register-email-error' : undefined
            }
          />
          {fieldErrors?.email !== undefined && (
            <ul id="register-email-error" className="field-errors">
              {fieldErrors.email.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            className="input"
            type="password"
            name="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby={
              fieldErrors?.password !== undefined
                ? 'register-password-error'
                : undefined
            }
          />
          {fieldErrors?.password !== undefined && (
            <ul id="register-password-error" className="field-errors">
              {fieldErrors.password.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
      <p className="screen-alt">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  )
}