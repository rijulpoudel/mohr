import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  calls,
  installFetchMock,
  jsonResponse,
  renderApp,
  type FetchHandler,
} from '../test/testUtils'

async function openRegister(handler: FetchHandler) {
  const mock = installFetchMock(handler)
  renderApp('/register')
  await screen.findByLabelText('Email')
  return { user: userEvent.setup(), mock }
}

describe('registration', () => {
  it('renders backend field errors inline and never signs in', async () => {
    const { user, mock } = await openRegister((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        document.cookie = 'csrftoken=register-csrf-token; Path=/'
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/register/') {
        return jsonResponse(
          {
            email: ['Enter a valid email address.'],
            password: [
              'This password is too short. It must contain at least 8 characters.',
            ],
          },
          400,
        )
      }
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'not-an-email')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'This password is too short. It must contain at least 8 characters.',
      ),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/register')
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument()

    const registerCalls = calls(mock, '/api/auth/register/', 'POST')
    expect(registerCalls).toHaveLength(1)
    const init = registerCalls[0][1]
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('register-csrf-token')
    expect(init?.body).toBe(JSON.stringify({ email: 'not-an-email', password: 'short' }))
  })

  it('navigates to login with an account-created notice after success', async () => {
    const { user, mock } = await openRegister((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        document.cookie = 'csrftoken=register-csrf-token; Path=/'
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/register/') {
        return jsonResponse({ id: 11, email: 'new@example.com' }, 201)
      }
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(
      await screen.findByText('Account created. Sign in to continue.'),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(calls(mock, '/api/auth/me/')).toHaveLength(1)
  })

  it('does not treat a malformed successful registration as success', async () => {
    const { user, mock } = await openRegister((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      if (url === '/api/auth/csrf/') {
        document.cookie = 'csrftoken=register-csrf-token; Path=/'
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/register/') return jsonResponse({}, 201)
      return jsonResponse({}, 404)
    })
    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response',
    )
    expect(window.location.pathname).toBe('/register')
    expect(calls(mock, '/api/auth/register/', 'POST')).toHaveLength(1)
  })
})