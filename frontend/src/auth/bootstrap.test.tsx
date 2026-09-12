import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  calls,
  deferred,
  installFetchMock,
  jsonResponse,
  renderApp,
  setCsrfCookie,
} from '../test/testUtils'

describe('session bootstrap', () => {
  it('shows a loading status then redirects to login when no session exists', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/me/') return pending.promise
      return jsonResponse({}, 404)
    })
    renderApp('/')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking your session',
    )
    pending.resolve(
      jsonResponse(
        { detail: 'Authentication credentials were not provided.' },
        401,
      ),
    )
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/auth/me/')).toHaveLength(1)
  })

  it('restores an authenticated session into the protected shell', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      return jsonResponse({}, 404)
    })
    renderApp('/')
    expect(
      await screen.findByText('Signed in as student@example.com'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(calls(mock, '/api/auth/me/')).toHaveLength(1)
  })

  it('shows a restore error with Retry for non-401 failures and recovers', async () => {
    let meCalls = 0
    const pending = deferred<Response>()
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        meCalls += 1
        if (meCalls === 1) return pending.promise
        return jsonResponse({ id: 7, email: 'retry@example.com' })
      }
      return jsonResponse({}, 404)
    })
    renderApp('/')
    pending.resolve(new Response(null, { status: 500 }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not restore your session',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Signed in as retry@example.com')).toBeInTheDocument()
    expect(calls(mock, '/api/auth/me/')).toHaveLength(2)
  })

  it('redirects a protected visitor to login and preserves the destination', async () => {
    const user = userEvent.setup()
    installFetchMock((url, init) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/' && (init?.method ?? 'GET') === 'POST') {
        return jsonResponse({ id: 4, email: 'back@example.com' })
      }
      return jsonResponse({}, 404)
    })
    renderApp('/')
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    await user.type(screen.getByLabelText('Email'), 'back@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Signed in as back@example.com')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('redirects authenticated users away from guest routes', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 2, email: 'guest@example.com' })
      }
      return jsonResponse({}, 404)
    })
    renderApp('/login')
    expect(await screen.findByText('Signed in as guest@example.com')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })
})

describe('malformed restore payloads', () => {
  it.each([
    ['an empty object', {}],
    ['a wrong-typed id', { id: '1', email: 'x@y.z' }],
    ['a null payload', null],
    ['an array', []],
    ['a wrong-typed email', { id: 1, email: 42 }],
  ])('does not authenticate on %s', async (_label, payload) => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse(payload)
      return jsonResponse({}, 404)
    })
    renderApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not restore your session',
    )
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument()
  })
})

describe('restore request lifecycle', () => {
  it('shares a single in-flight restore request across remounts and discards abandoned handlers', async () => {
    const pending = deferred<Response>()
    let meCalls = 0
    installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        meCalls += 1
        if (meCalls === 1) return pending.promise
        return jsonResponse({ id: 1, email: 'fresh@example.com' })
      }
      return jsonResponse({}, 404)
    })
    const first = renderApp('/')
    first.unmount()
    renderApp('/')
    expect(meCalls).toBe(1)
    pending.resolve(jsonResponse({ id: 1, email: 'fresh@example.com' }))
    expect(
      await screen.findByText('Signed in as fresh@example.com'),
    ).toBeInTheDocument()
  })

  it('issues a fresh restore after an abandoned request settles and never shows its user', async () => {
    const pending = deferred<Response>()
    let meCalls = 0
    installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        meCalls += 1
        if (meCalls === 1) return pending.promise
        return jsonResponse({ id: 2, email: 'fresh@example.com' })
      }
      return jsonResponse({}, 404)
    })
    const first = renderApp('/')
    first.unmount()
    await act(async () => {
      pending.resolve(jsonResponse({ id: 99, email: 'stale@example.com' }))
    })
    renderApp('/')
    expect(
      await screen.findByText('Signed in as fresh@example.com'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Signed in as stale@example.com')).not.toBeInTheDocument()
    expect(meCalls).toBe(2)
  })
})