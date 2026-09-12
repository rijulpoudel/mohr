import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  calls,
  CSRF_TOKEN,
  deferred,
  installFetchMock,
  jsonResponse,
  renderApp,
  requestLog,
  setCsrfCookie,
  type FetchHandler,
} from '../test/testUtils'

async function openLogin(handler: FetchHandler) {
  const mock = installFetchMock(handler)
  renderApp('/')
  await screen.findByLabelText('Email')
  return { user: userEvent.setup(), mock }
}

describe('login', () => {
  it('fetches a CSRF token, posts credentials, and navigates to the shell', async () => {
    const { user, mock } = await openLogin((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/') {
        return jsonResponse({ id: 3, email: 'me@example.com' })
      }
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Signed in as me@example.com')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    expect(mock.mock.calls).toHaveLength(3)
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/auth/csrf/',
      'POST /api/auth/login/',
    ])

    const csrfInit = mock.mock.calls[1][1]
    expect(csrfInit).toMatchObject({ method: 'GET', credentials: 'include' })
    expect(csrfInit?.headers).toBeInstanceOf(Headers)
    expect((csrfInit?.headers as Headers).get('Content-Type')).toBeNull()
    expect(csrfInit?.body).toBeUndefined()

    const loginInit = mock.mock.calls[2][1]
    expect(loginInit).toMatchObject({ method: 'POST', credentials: 'include' })
    const loginHeaders = loginInit?.headers as Headers
    expect(loginHeaders.get('Content-Type')).toBe('application/json')
    expect(loginHeaders.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    expect(loginInit?.body).toBe(
      JSON.stringify({ email: 'me@example.com', password: 'correct-horse' }),
    )
  })

  it('shows the backend credential error and stays on the login screen', async () => {
    const { user } = await openLogin((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/') {
        return jsonResponse({ detail: 'Invalid email or password.' }, 401)
      }
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'wrong@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid email or password.',
    )
    expect(window.location.pathname).toBe('/login')
    expect(screen.getByLabelText('Email')).toHaveValue('wrong@example.com')
  })

  it('refuses to post credentials when the csrf cookie is missing', async () => {
    const { user, mock } = await openLogin((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/') {
        return jsonResponse({ id: 3, email: 'me@example.com' })
      }
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Missing CSRF token',
    )
    expect(calls(mock, '/api/auth/login/', 'POST')).toHaveLength(0)
    expect(window.location.pathname).toBe('/login')
  })

  it('prevents duplicate submissions while pending', async () => {
    const pending = deferred<Response>()
    const { user, mock } = await openLogin((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/') return pending.promise
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'dupe@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    const pendingButton = await screen.findByRole('button', {
      name: 'Signing in…',
    })
    expect(pendingButton).toBeDisabled()
    await user.click(pendingButton)
    expect(calls(mock, '/api/auth/login/', 'POST')).toHaveLength(1)
    pending.resolve(jsonResponse({ id: 5, email: 'dupe@example.com' }))
    expect(await screen.findByText('Signed in as dupe@example.com')).toBeInTheDocument()
  })

  it('clears a stale error on the next attempt', async () => {
    let failNext = true
    const { user } = await openLogin((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/') {
        if (failNext) {
          return jsonResponse({ detail: 'Invalid email or password.' }, 401)
        }
        return jsonResponse({ id: 9, email: 'ok@example.com' })
      }
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'retry@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid email or password.',
    )
    failNext = false
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Signed in as ok@example.com')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not authenticate when login succeeds with a malformed payload', async () => {
    const { user } = await openLogin((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/') {
        return jsonResponse({ id: '3', email: 'x@y.z' })
      }
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response',
    )
    expect(window.location.pathname).toBe('/login')
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument()
  })
})