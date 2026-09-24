import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  deferred,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  renderApp,
  setCsrfCookie,
} from '../test/testUtils'

function summaryFixture(note: string) {
  return {
    total_balance: '1234.56',
    current_month_income: '2000.00',
    current_month_expenses: '765.44',
    total_budgeted: '1500.00',
    remaining_budget: '500.00',
    recent_transactions: [
      {
        id: 10,
        account: 3,
        category: 4,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-14',
        note,
        source: 'manual',
        provider_name: '',
        is_pending: false,
        is_pending_initial_import: false,
        created_at: '2026-09-14T08:00:00.000000Z',
        updated_at: '2026-09-14T08:00:00.000000Z',
      },
    ],
  }
}

function crossSessionHandler(options: {
  firstDashboard: Promise<Response>
  secondDashboard: Promise<Response>
}) {
  let dashboardCalls = 0
  const mock = installFetchMock((url) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'owner-a@example.com' })
    }
    if (url === '/api/dashboard/summary/') {
      dashboardCalls += 1
      if (dashboardCalls === 1) return options.firstDashboard
      return options.secondDashboard
    }
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url === '/api/auth/login/') {
      return jsonResponse({ id: 2, email: 'owner-b@example.com' })
    }
    if (url === '/api/auth/logout/') return emptyResponse(204)
    return jsonResponse({}, 404)
  })
  return { mock, dashboardCalls: () => dashboardCalls }
}

async function crossAuthBoundary() {
  const user = userEvent.setup()
  renderApp('/')
  await screen.findByText('Signed in as owner-a@example.com')

  await user.click(screen.getByRole('button', { name: 'Sign out' }))
  await screen.findByLabelText('Email')

  await user.type(screen.getByLabelText('Email'), 'owner-b@example.com')
  await user.type(screen.getByLabelText('Password'), 'correct-horse')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
  await screen.findByText('Signed in as owner-b@example.com')
}

describe('cross-session request isolation', () => {
  it('does not reuse a session A dashboard request after logout and login as session B', async () => {
    const firstDashboard = deferred<Response>()
    const secondDashboard = deferred<Response>()
    const { dashboardCalls } = crossSessionHandler({
      firstDashboard: firstDashboard.promise,
      secondDashboard: secondDashboard.promise,
    })
    await crossAuthBoundary()

    await vi.waitFor(() => expect(dashboardCalls()).toBe(2))

    await act(async () => {
      firstDashboard.resolve(
        jsonResponse(summaryFixture('OLD SESSION A SECRET')),
      )
    })
    await act(async () => {
      secondDashboard.resolve(
        jsonResponse(summaryFixture('NEW SESSION B DATA')),
      )
    })

    expect(await screen.findByText('NEW SESSION B DATA')).toBeInTheDocument()
    expect(screen.queryByText('OLD SESSION A SECRET')).not.toBeInTheDocument()
    expect(screen.getByText('Signed in as owner-b@example.com')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('does not let a delayed session A 401 clear the new session B', async () => {
    const firstDashboard = deferred<Response>()
    const secondDashboard = deferred<Response>()
    const { dashboardCalls } = crossSessionHandler({
      firstDashboard: firstDashboard.promise,
      secondDashboard: secondDashboard.promise,
    })
    await crossAuthBoundary()

    await vi.waitFor(() => expect(dashboardCalls()).toBe(2))

    await act(async () => {
      firstDashboard.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(screen.getByText('Signed in as owner-b@example.com')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      secondDashboard.resolve(
        jsonResponse(summaryFixture('NEW SESSION B DATA')),
      )
    })

    expect(await screen.findByText('NEW SESSION B DATA')).toBeInTheDocument()
    expect(screen.getByText('Signed in as owner-b@example.com')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })
})