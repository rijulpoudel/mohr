import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  installFetchMock,
  jsonResponse,
  renderApp,
  setCsrfCookie,
} from './test/testUtils'

describe('Mohr shell', () => {
  it('renders the Mohr brand', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/')
    expect(await screen.findByRole('link', { name: 'Mohr' })).toBeInTheDocument()
  })
})

describe('unknown routes', () => {
  it('renders a restrained not-found screen', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/no/such/page')
    expect(
      await screen.findByRole('heading', { name: 'Page not found' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to Mohr' })).toBeInTheDocument()
  })
})

describe('session storage', () => {
  it('never writes auth values to web storage', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/login/') {
        return jsonResponse({ id: 1, email: 'stored@example.com' })
      }
      return jsonResponse({}, 404)
    })
    const user = userEvent.setup()
    renderApp('/')
    await user.type(await screen.findByLabelText('Email'), 'stored@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('Signed in as stored@example.com')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})