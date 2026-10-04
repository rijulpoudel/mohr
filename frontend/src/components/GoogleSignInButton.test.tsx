import { StrictMode, useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  calls,
  deferred,
  installFetchMock,
  jsonResponse,
  setCsrfCookie,
} from '../test/testUtils'
import { GoogleSignInButton } from './GoogleSignInButton'

const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'

function GuardHarness({ onAuthorize }: { onAuthorize: (url: string) => void }) {
  const [visible, setVisible] = useState(true)
  return (
    <div>
      <span data-testid="observer">observer</span>
      <button type="button" onClick={() => setVisible(false)}>
        Leave
      </button>
      {visible && (
        <GoogleSignInButton intent="sign-in" onAuthorize={onAuthorize} />
      )}
    </div>
  )
}

function configHandler(
  config: unknown,
  start: () => Response | Promise<Response> = () =>
    jsonResponse({ authorization_url: GOOGLE_URL }),
) {
  return (url: string) => {
    if (url === '/api/auth/google/config/') return jsonResponse(config)
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url === '/api/auth/google/start/') return start()
    return jsonResponse({}, 404)
  }
}

describe('GoogleSignInButton', () => {
  it('stays hidden when the feature is disabled', async () => {
    const mock = installFetchMock(
      configHandler({ enabled: false, linked: false }),
    )
    render(<GoogleSignInButton intent="sign-in" />)

    await waitFor(() =>
      expect(calls(mock, '/api/auth/google/config/')).toHaveLength(1),
    )
    expect(
      screen.queryByRole('button', { name: 'Continue with Google' }),
    ).not.toBeInTheDocument()
  })

  it('stays hidden when the config request fails', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/google/config/') return jsonResponse({}, 500)
      return jsonResponse({}, 404)
    })
    render(<GoogleSignInButton intent="sign-in" />)

    await waitFor(() =>
      expect(calls(mock, '/api/auth/google/config/')).toHaveLength(1),
    )
    expect(
      screen.queryByRole('button', { name: 'Continue with Google' }),
    ).not.toBeInTheDocument()
  })

  it('starts the server flow and hands the fixed Google URL to navigation', async () => {
    const onAuthorize = vi.fn()
    const mock = installFetchMock(
      configHandler({ enabled: true, linked: false }),
    )
    const user = userEvent.setup()
    render(
      <GoogleSignInButton
        intent="sign-in"
        next="/accounts"
        onAuthorize={onAuthorize}
      />,
    )

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )

    await waitFor(() => expect(onAuthorize).toHaveBeenCalledWith(GOOGLE_URL))
    const init = calls(mock, '/api/auth/google/start/', 'POST')[0][1]
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(init?.body).toBe(
      JSON.stringify({ intent: 'sign-in', next: '/accounts' }),
    )
  })

  it('shows an explicit link control and the connected state', async () => {
    const linked = installFetchMock(
      configHandler({ enabled: true, linked: true }),
    )
    render(<GoogleSignInButton intent="link" />)
    expect(await screen.findByText('Google connected')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Link Google account' }),
    ).not.toBeInTheDocument()
    expect(calls(linked, '/api/auth/google/start/', 'POST')).toHaveLength(0)
  })

  it('renders the link button when the actor is not yet connected', async () => {
    installFetchMock(configHandler({ enabled: true, linked: false }))
    render(<GoogleSignInButton intent="link" />)

    expect(
      await screen.findByRole('button', { name: 'Link Google account' }),
    ).toBeInTheDocument()
  })

  it('refuses an authorization URL that is not Google and shows an error', async () => {
    installFetchMock(
      configHandler(
        { enabled: true, linked: false },
        () => jsonResponse({ authorization_url: 'https://evil.example/consent' }),
      ),
    )
    const user = userEvent.setup()
    render(<GoogleSignInButton intent="sign-in" />)

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
  })

  it('shows the backend start error and allows another attempt', async () => {
    const mock = installFetchMock(
      configHandler(
        { enabled: true, linked: false },
        () => jsonResponse({ detail: 'Invalid Google sign-in request.' }, 400),
      ),
    )
    const user = userEvent.setup()
    render(<GoogleSignInButton intent="sign-in" />)

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid Google sign-in request.',
    )
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }),
    ).toBeEnabled()
    expect(calls(mock, '/api/auth/google/start/', 'POST')).toHaveLength(1)
  })

  it('reports an expired session when linking without one', async () => {
    installFetchMock(
      configHandler(
        { enabled: true, linked: false },
        () =>
          jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          ),
      ),
    )
    const user = userEvent.setup()
    render(<GoogleSignInButton intent="link" />)

    await user.click(
      await screen.findByRole('button', { name: 'Link Google account' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your session expired. Please sign in again.',
    )
  })

  it('prevents duplicate start requests while one is pending', async () => {
    const pending = deferred<Response>()
    const onAuthorize = vi.fn()
    const mock = installFetchMock(
      configHandler({ enabled: true, linked: false }, () => pending.promise),
    )
    const user = userEvent.setup()
    render(<GoogleSignInButton intent="sign-in" onAuthorize={onAuthorize} />)

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )
    const pendingButton = await screen.findByRole('button', {
      name: 'Redirecting…',
    })
    expect(pendingButton).toBeDisabled()
    await user.click(pendingButton)

    expect(calls(mock, '/api/auth/google/start/', 'POST')).toHaveLength(1)

    pending.resolve(jsonResponse({ authorization_url: GOOGLE_URL }))
    await waitFor(() => expect(onAuthorize).toHaveBeenCalledTimes(1))
  })

  it('issues one csrf and start for two activations in the same tick', async () => {
    const pending = deferred<Response>()
    const onAuthorize = vi.fn()
    const mock = installFetchMock(
      configHandler({ enabled: true, linked: false }, () => pending.promise),
    )
    render(<GoogleSignInButton intent="sign-in" onAuthorize={onAuthorize} />)

    const button = await screen.findByRole('button', {
      name: 'Continue with Google',
    })
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(
      calls(mock, '/api/auth/google/start/', 'POST'),
    ).toHaveLength(1)

    pending.resolve(jsonResponse({ authorization_url: GOOGLE_URL }))
    await waitFor(() => expect(onAuthorize).toHaveBeenCalledTimes(1))
  })

  it('does not authorize after the button unmounts', async () => {
    const pending = deferred<Response>()
    const onAuthorize = vi.fn()
    installFetchMock(
      configHandler({ enabled: true, linked: false }, () => pending.promise),
    )
    const user = userEvent.setup()
    render(<GuardHarness onAuthorize={onAuthorize} />)

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )
    await screen.findByRole('button', { name: 'Redirecting…' })
    await user.click(screen.getByRole('button', { name: 'Leave' }))

    expect(screen.getByTestId('observer')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Redirecting…' }),
    ).not.toBeInTheDocument()

    pending.resolve(jsonResponse({ authorization_url: GOOGLE_URL }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(onAuthorize).not.toHaveBeenCalled()
    expect(screen.getByTestId('observer')).toBeInTheDocument()
  })

  it('stays usable across a StrictMode remount', async () => {
    const onAuthorize = vi.fn()
    installFetchMock(configHandler({ enabled: true, linked: false }))
    const user = userEvent.setup()
    render(
      <StrictMode>
        <GoogleSignInButton intent="sign-in" onAuthorize={onAuthorize} />
      </StrictMode>,
    )

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )

    await waitFor(() => expect(onAuthorize).toHaveBeenCalledWith(GOOGLE_URL))
  })

  it('refuses a userinfo-bearing authorization URL and never navigates', async () => {
    const onAuthorize = vi.fn()
    installFetchMock(
      configHandler({ enabled: true, linked: false }, () =>
        jsonResponse({
          authorization_url:
            'https://evil@accounts.google.com/o/oauth2/v2/auth?client_id=x',
        }),
      ),
    )
    const user = userEvent.setup()
    render(<GoogleSignInButton intent="sign-in" onAuthorize={onAuthorize} />)

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  it('refuses a fragment-bearing authorization URL and never navigates', async () => {
    const onAuthorize = vi.fn()
    installFetchMock(
      configHandler({ enabled: true, linked: false }, () =>
        jsonResponse({
          authorization_url:
            'https://accounts.google.com/o/oauth2/v2/auth#fragment',
        }),
      ),
    )
    const user = userEvent.setup()
    render(<GoogleSignInButton intent="sign-in" onAuthorize={onAuthorize} />)

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  it('stays hidden when the config response is not 200', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/google/config/') {
        return jsonResponse({ enabled: true, linked: false }, 201)
      }
      return jsonResponse({}, 404)
    })
    render(<GoogleSignInButton intent="sign-in" />)

    await waitFor(() =>
      expect(calls(mock, '/api/auth/google/config/')).toHaveLength(1),
    )
    expect(
      screen.queryByRole('button', { name: 'Continue with Google' }),
    ).not.toBeInTheDocument()
  })

  it('stays hidden when the config response has extra fields', async () => {
    const mock = installFetchMock(
      configHandler({ enabled: true, linked: false, extra: true }),
    )
    render(<GoogleSignInButton intent="sign-in" />)

    await waitFor(() =>
      expect(calls(mock, '/api/auth/google/config/')).toHaveLength(1),
    )
    expect(
      screen.queryByRole('button', { name: 'Continue with Google' }),
    ).not.toBeInTheDocument()
  })

  it('refuses a non-200 start response and does not navigate', async () => {
    const onAuthorize = vi.fn()
    installFetchMock(
      configHandler({ enabled: true, linked: false }, () =>
        jsonResponse({ authorization_url: GOOGLE_URL }, 201),
      ),
    )
    const user = userEvent.setup()
    render(<GoogleSignInButton intent="sign-in" onAuthorize={onAuthorize} />)

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  it('refuses a start response with extra fields and does not navigate', async () => {
    const onAuthorize = vi.fn()
    installFetchMock(
      configHandler({ enabled: true, linked: false }, () =>
        jsonResponse({ authorization_url: GOOGLE_URL, extra: true }),
      ),
    )
    const user = userEvent.setup()
    render(<GoogleSignInButton intent="sign-in" onAuthorize={onAuthorize} />)

    await user.click(
      await screen.findByRole('button', { name: 'Continue with Google' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(onAuthorize).not.toHaveBeenCalled()
  })
})
