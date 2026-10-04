import { useEffect, useRef, useState } from 'react'
import {
  fetchGoogleConfig,
  startGoogleAuthorization,
  type GoogleConfig,
  type GoogleIntent,
} from '../api/google'
import { ApiError, userMessage } from '../api/types'

const GENERIC_ERROR_MESSAGE = 'Could not start Google sign-in. Please try again.'
const SESSION_EXPIRED_MESSAGE = 'Your session expired. Please sign in again.'

interface GoogleSignInButtonProps {
  intent: GoogleIntent
  next?: string
  onAuthorize?: (url: string) => void
}

export function GoogleSignInButton({
  intent,
  next = '/',
  onAuthorize,
}: GoogleSignInButtonProps) {
  const [config, setConfig] = useState<GoogleConfig | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A ref is the synchronous duplicate lock: two same-tick activations both
  // observe ``pending === false`` before React re-renders.
  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchGoogleConfig()
      .then((value) => {
        if (!cancelled) setConfig(value)
      })
      .catch(() => {
        if (!cancelled) setConfig({ enabled: false, linked: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (config === null || !config.enabled) return null
  if (intent === 'link' && config.linked) {
    return (
      <p className="google-connected" role="status">
        Google connected
      </p>
    )
  }

  async function handleClick() {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setError(null)
    setPending(true)
    try {
      const url = await startGoogleAuthorization(intent, next)
      if (!mountedRef.current) return
      if (onAuthorize !== undefined) {
        onAuthorize(url)
      } else {
        window.location.assign(url)
      }
    } catch (caught) {
      if (!mountedRef.current) return
      inFlightRef.current = false
      setPending(false)
      if (caught instanceof ApiError && caught.status === 401) {
        setError(SESSION_EXPIRED_MESSAGE)
        return
      }
      setError(
        caught instanceof ApiError ? userMessage(caught) : GENERIC_ERROR_MESSAGE,
      )
    }
  }

  return (
    <div className="google-auth">
      <button
        type="button"
        className="btn btn-secondary"
        onClick={handleClick}
        disabled={pending}
      >
        {pending
          ? 'Redirecting…'
          : intent === 'link'
            ? 'Link Google account'
            : 'Continue with Google'}
      </button>
      {error !== null && (
        <div className="error-summary" role="alert">
          {error}
        </div>
      )}
    </div>
  )
}
