import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  calls,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  renderApp,
  requestLog,
  type FetchHandler,
} from '../test/testUtils'

async function openProtected(handler: FetchHandler) {
  const mock = installFetchMock(handler)
  renderApp('/')
  await screen.findByText(/Signed in as/)
  return { user: userEvent.setup(), mock }
}

describe('logout', () => {
  it('fetches a CSRF token, posts logout, and returns to login on a 204', async () => {
    const { user, mock } = await openProtected((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'out@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        document.cookie = 'csrftoken=logout-csrf-token; Path=/'
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/logout/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/auth/csrf/',
      'POST /api/auth/logout/',
    ])
    const logoutCalls = calls(mock, '/api/auth/logout/', 'POST')
    expect(logoutCalls).toHaveLength(1)
    const init = logoutCalls[0][1]
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe('logout-csrf-token')
    expect(headers.get('Content-Type')).toBeNull()
    expect(init?.body).toBeUndefined()
  })

  it('keeps the user authenticated when logout fails', async () => {
    const { user } = await openProtected((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'stuck@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        document.cookie = 'csrftoken=logout-csrf-token; Path=/'
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/auth/logout/') {
        return new Response(null, { status: 500 })
      }
      return jsonResponse({}, 404)
    })
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not sign out',
    )
    expect(screen.getByText('Signed in as stuck@example.com')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })
})