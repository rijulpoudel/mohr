import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  CSRF_TOKEN,
  calls,
  deferred,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  renderApp,
  requestLog,
  setCsrfCookie,
} from '../test/testUtils'

function accountFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Everyday Checking',
    account_type: 'checking',
    opening_balance: '100.00',
    current_balance: '100.00',
    sync_pending: false,
    is_archived: false,
    created_at: '2026-09-11T14:52:48.008850Z',
    updated_at: '2026-09-11T14:52:48.008850Z',
    ...overrides,
  }
}

function withoutKey(record: Record<string, unknown>, key: string) {
  const copy = { ...record }
  delete copy[key]
  return copy
}

function authenticatedHandler(
  accounts: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/dashboard/summary/') {
      return jsonResponse({
        total_balance: '100.00',
        current_month_income: '0.00',
        current_month_expenses: '0.00',
        total_budgeted: '0.00',
        remaining_budget: '0.00',
        recent_transactions: [],
      })
    }
    if (url === '/api/accounts/') return accounts(url, init)
    return jsonResponse({}, 404)
  }
}

describe('accounts navigation', () => {
  it('shows Dashboard and Accounts nav with current-page state when authenticated', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([accountFixture()])))
    renderApp('/accounts')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const dashboardLink = within(nav).getByRole('link', { name: 'Dashboard' })
    const accountsLink = within(nav).getByRole('link', { name: 'Accounts' })
    expect(dashboardLink).toHaveAttribute('href', '/')
    expect(accountsLink).toHaveAttribute('href', '/accounts')
    expect(accountsLink).toHaveAttribute('aria-current', 'page')
    expect(dashboardLink).not.toHaveAttribute('aria-current', 'page')
  })

  it('marks Dashboard as current on the dashboard page', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([accountFixture()])))
    renderApp('/')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const dashboardLink = within(nav).getByRole('link', { name: 'Dashboard' })
    const accountsLink = within(nav).getByRole('link', { name: 'Accounts' })
    expect(dashboardLink).toHaveAttribute('aria-current', 'page')
    expect(accountsLink).not.toHaveAttribute('aria-current', 'page')
  })

  it('keeps the guest shell brand-only without primary nav', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/login')

    expect(await screen.findByRole('link', { name: 'Mohr' })).toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Accounts' })).not.toBeInTheDocument()
  })

  it('protects /accounts for guests by redirecting to login', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
  })
})

describe('accounts list', () => {
  it('renders accounts in server order with friendly type and archived state', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          accountFixture({
            id: 1,
            name: 'Everyday Checking',
            account_type: 'checking',
            opening_balance: '100.00',
            current_balance: '150.25',
            is_archived: false,
          }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            opening_balance: '-50.00',
            current_balance: '-75.50',
            is_archived: true,
          }),
          accountFixture({
            id: 3,
            name: 'Cash Jar',
            account_type: 'cash',
            opening_balance: '0.00',
            current_balance: '0.00',
            is_archived: false,
          }),
        ]),
      ),
    )
    renderApp('/accounts')

    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Everyday Checking')
    expect(items[1]).toHaveTextContent('Old Card')
    expect(items[2]).toHaveTextContent('Cash Jar')
    expect(within(items[0]).getByText('Checking')).toBeInTheDocument()
    expect(within(items[1]).getByText('Credit card')).toBeInTheDocument()
    expect(within(items[2]).getByText('Cash')).toBeInTheDocument()
    expect(within(items[0]).getByText('$150.25')).toBeInTheDocument()
    expect(within(items[1]).getByText('-$75.50')).toBeInTheDocument()
    expect(within(items[0]).getByText('$100.00')).toBeInTheDocument()
    expect(within(items[1]).getByText('-$50.00')).toBeInTheDocument()
    expect(within(items[0]).getByText('Current balance')).toBeInTheDocument()
    expect(within(items[1]).getByText('Current balance')).toBeInTheDocument()
    expect(within(items[2]).getByText('Current balance')).toBeInTheDocument()
    expect(within(items[0]).getByText('Opening balance')).toBeInTheDocument()
    expect(within(items[1]).getByText('Opening balance')).toBeInTheDocument()
    expect(within(items[2]).getByText('Opening balance')).toBeInTheDocument()
    expect(screen.getAllByText('Active')).toHaveLength(2)
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  it('formats exact large and negative money strings', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse([
          accountFixture({
            id: 1,
            name: 'Big Saver',
            account_type: 'savings',
            opening_balance: '-987654321.01',
            current_balance: '123456789012345678.90',
          }),
        ]),
      ),
    )
    renderApp('/accounts')

    expect(
      await screen.findByText('$123,456,789,012,345,678.90'),
    ).toBeInTheDocument()
    const item = screen.getByRole('listitem')
    expect(within(item).getByText('-$987,654,321.01')).toBeInTheDocument()
    expect(within(item).getByText('Savings')).toBeInTheDocument()
  })

  it('shows an accessible loading status while accounts are pending', async () => {
    const pending = deferred<Response>()
    installFetchMock(authenticatedHandler(() => pending.promise))
    renderApp('/accounts')

    expect(await screen.findByText('Loading your accounts…')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading your accounts')

    await act(async () => {
      pending.resolve(jsonResponse([accountFixture()]))
    })
    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows meaningful empty text without a list', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([])))
    renderApp('/accounts')

    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('retries a failed request and clears the stale error', async () => {
    let accountCalls = 0
    const mock = installFetchMock(
      authenticatedHandler(() => {
        accountCalls += 1
        if (accountCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse([accountFixture()])
      }),
    )
    renderApp('/accounts')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/accounts/')).toHaveLength(2)
  })

  it('issues exactly one accounts request under StrictMode', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse([accountFixture()])),
    )
    renderApp('/accounts')

    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
  })

  it('ignores a late accounts 401 after navigating to dashboard', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock((url: string) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse({
          total_balance: '1234.56',
          current_month_income: '2000.00',
          current_month_expenses: '765.44',
          total_budgeted: '1500.00',
          remaining_budget: '-100.10',
          recent_transactions: [],
        })
      }
      if (url === '/api/accounts/') return pending.promise
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')

    expect(await screen.findByText('Loading your accounts…')).toBeInTheDocument()
    const user = userEvent.setup()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      pending.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(calls(mock, '/api/auth/logout/', 'POST')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })

  it('never writes auth values to web storage', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([accountFixture()])))
    renderApp('/accounts')

    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('malformed accounts payloads', () => {
  const malformedPayloads: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an object payload', { id: 1 }],
    ['a string payload', 'nope'],
    ['a missing key', withoutKey(accountFixture(), 'current_balance')],
    [
      'an extra key',
      { ...accountFixture(), user: 1 },
    ],
    ['a zero id', [accountFixture({ id: 0 })]],
    ['a negative id', [accountFixture({ id: -3 })]],
    ['a fractional id', [accountFixture({ id: 1.5 })]],
    ['a string id', [accountFixture({ id: '1' })]],
    ['an unsafe id', [accountFixture({ id: 9007199254740992 })]],
    ['an empty name', [accountFixture({ name: '' })]],
    ['a whitespace name', [accountFixture({ name: '   ' })]],
    ['a long name', [accountFixture({ name: 'x'.repeat(101) })]],
    ['a bad account type', [accountFixture({ account_type: 'crypto' })]],
    ['a one-decimal balance', [accountFixture({ current_balance: '12.3' })]],
    ['a comma balance', [accountFixture({ opening_balance: '1,234.56' })]],
    ['a numeric balance', [accountFixture({ current_balance: 12.5 })]],
    ['a string archived flag', [accountFixture({ is_archived: 'false' })]],
    ['a date-only created_at', [accountFixture({ created_at: '2026-09-11' })]],
    [
      'an impossible created_at date',
      [accountFixture({ created_at: '2026-02-30T12:00:00Z' })],
    ],
    [
      'an impossible updated_at date',
      [accountFixture({ updated_at: '2026-02-30T12:00:00Z' })],
    ],
    ['a missing updated_at', [withoutKey(accountFixture(), 'updated_at')]],
  ]

  it.each(malformedPayloads)('rejects %s safely', async (_label, payload) => {
    installFetchMock(authenticatedHandler(() => jsonResponse(payload)))
    renderApp('/accounts')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unexpected server response.',
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })
})

describe('accounts session expiry', () => {
  it('clears in-memory auth and redirects to login on 401 without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )
    renderApp('/accounts')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/accounts/',
    ])
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

function authenticatedCreateHandler(
  accounts: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/dashboard/summary/') {
      return jsonResponse({
        total_balance: '100.00',
        current_month_income: '0.00',
        current_month_expenses: '0.00',
        total_budgeted: '0.00',
        remaining_budget: '0.00',
        recent_transactions: [],
      })
    }
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url === '/api/accounts/') return accounts(url, init)
    return jsonResponse({}, 404)
  }
}

function authenticatedMutationHandler(
  accounts: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/dashboard/summary/') {
      return jsonResponse({
        total_balance: '100.00',
        current_month_income: '0.00',
        current_month_expenses: '0.00',
        total_budgeted: '0.00',
        remaining_budget: '0.00',
        recent_transactions: [],
      })
    }
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url.startsWith('/api/accounts/')) return accounts(url, init)
    return jsonResponse({}, 404)
  }
}

async function fillCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  name = 'Travel Fund',
  opening = '250.00',
  accountType = 'savings',
) {
  await user.type(screen.getByLabelText('Name'), name)
  await user.selectOptions(screen.getByLabelText('Account type'), accountType)
  await user.clear(screen.getByLabelText('Opening balance'))
  await user.type(screen.getByLabelText('Opening balance'), opening)
}

describe('account creation form', () => {
  it('renders a compact accessible form above the list with all four account types', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse([accountFixture()])))
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const heading = screen.getByRole('heading', { name: 'Add account' })
    const list = screen.getByRole('list')
    expect(
      heading.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    const nameInput = screen.getByLabelText('Name')
    expect(nameInput).toHaveAttribute('type', 'text')
    expect(nameInput).toHaveValue('')

    const typeSelect = screen.getByLabelText('Account type')
    expect(typeSelect).toHaveValue('checking')
    const options = within(typeSelect).getAllByRole('option')
    expect(options.map((option) => option.getAttribute('value'))).toEqual([
      'checking',
      'savings',
      'cash',
      'credit_card',
    ])
    expect(options.map((option) => option.textContent)).toEqual([
      'Checking',
      'Savings',
      'Cash',
      'Credit card',
    ])

    const openingInput = screen.getByLabelText('Opening balance')
    expect(openingInput).toHaveValue('0.00')
    expect(openingInput).toHaveAttribute('inputmode', 'decimal')
    expect(openingInput).not.toHaveAttribute('type', 'number')

    expect(
      screen.getByRole('button', { name: 'Create account' }),
    ).toBeInTheDocument()
  })

  it('creates an account with exact CSRF order, body, append, reset, and success status on an initially empty list', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          accountFixture({
            id: 5,
            name: 'Travel Fund',
            account_type: 'savings',
            opening_balance: '250.00',
            current_balance: '275.50',
          }),
          201,
        )
      }),
    )
    renderApp('/accounts')
    expect(await screen.findByText(/No accounts yet/)).toBeInTheDocument()

    const user = userEvent.setup()
    await fillCreateForm(user, '  Travel Fund  ', '250.00')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Account created.',
    )
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/accounts/',
      'GET /api/auth/csrf/',
      'POST /api/accounts/',
    ])
    const posts = calls(mock, '/api/accounts/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/accounts/')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Travel Fund',
      account_type: 'savings',
      opening_balance: '250.00',
    })

    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Account type')).toHaveValue('checking')
    expect(screen.getByLabelText('Opening balance')).toHaveValue('0.00')
    expect(screen.queryByText(/No accounts yet/)).not.toBeInTheDocument()
    const createdItem = screen.getByRole('listitem')
    expect(within(createdItem).getByText('Travel Fund')).toBeInTheDocument()
    expect(within(createdItem).getByText('Savings')).toBeInTheDocument()
    expect(within(createdItem).getByText('$275.50')).toBeInTheDocument()
    expect(screen.queryByText('5')).not.toBeInTheDocument()
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
  })

  it('appends a created account after existing ones without refetching or reordering', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse([accountFixture({ id: 1, name: 'Everyday Checking' })])
        }
        return jsonResponse(
          accountFixture({
            id: 9,
            name: 'New Card',
            account_type: 'credit_card',
            opening_balance: '10.00',
            current_balance: '10.00',
          }),
          201,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    await fillCreateForm(user, 'New Card', '10.00', 'credit_card')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    await screen.findByRole('status')
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Everyday Checking')
    expect(items[1]).toHaveTextContent('New Card')
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('preserves exact maximum and negative decimal strings in the POST body', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        const body = JSON.parse(String(init?.body)) as {
          name: string
          account_type: string
          opening_balance: string
        }
        return jsonResponse(
          accountFixture({
            id: 2,
            name: body.name,
            account_type: body.account_type,
            opening_balance: body.opening_balance,
            current_balance: '0.00',
          }),
          201,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText(/No accounts yet/)

    const user = userEvent.setup()
    await fillCreateForm(user, 'Max Saver', '1234567890.12')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await screen.findByRole('status')

    await fillCreateForm(user, 'Negative Card', '-1234567890.99', 'credit_card')
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await screen.findByText('Negative Card')

    const posts = calls(mock, '/api/accounts/', 'POST')
    expect(posts).toHaveLength(2)
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual({
      name: 'Max Saver',
      account_type: 'savings',
      opening_balance: '1234567890.12',
    })
    expect(JSON.parse(String(posts[1][1]?.body))).toEqual({
      name: 'Negative Card',
      account_type: 'credit_card',
      opening_balance: '-1234567890.99',
    })
    const items = screen.getAllByRole('listitem')
    expect(within(items[0]).getByText('$1,234,567,890.12')).toBeInTheDocument()
    expect(within(items[1]).getByText('-$1,234,567,890.99')).toBeInTheDocument()
  })

  it.each([
    ['a blank name', '   ', 'Enter a name for this account.'],
    ['a 101-character name', 'x'.repeat(101), 'Name must be 100 characters or fewer.'],
  ])('rejects %s before any network call', async (_label, name, message) => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(accountFixture(), 201)
      }),
    )
    renderApp('/accounts')
    await screen.findByText(/No accounts yet/)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Name'), name)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText(message)).toBeInTheDocument()
    const input = screen.getByLabelText('Name')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', 'create-account-name-error')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(input).toHaveValue(name)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(0)
  })

  it.each([
    ['one decimal place', '12.3'],
    ['no decimals', '12'],
    ['too many integer digits', '12345678901.12'],
    ['too many integer digits when negative', '-12345678901.12'],
    ['non-numeric text', 'abc'],
  ])('rejects an opening balance with %s before any network call', async (_label, opening) => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(accountFixture(), 201)
      }),
    )
    renderApp('/accounts')
    await screen.findByText(/No accounts yet/)

    const user = userEvent.setup()
    await fillCreateForm(user, 'Travel Fund', opening)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(
      await screen.findByText(
        'Enter an amount with exactly 2 decimals and at most 10 integer digits.',
      ),
    ).toBeInTheDocument()
    const input = screen.getByLabelText('Opening balance')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute(
      'aria-describedby',
      'create-account-opening-error',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(input).toHaveValue(opening)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(0)
  })

  it('renders backend field errors inline with the summary and preserves values and list', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse([accountFixture()])
        }
        return jsonResponse(
          {
            name: ['This field is required.'],
            opening_balance: [
              'Ensure that there are no more than 10 digits before the decimal point.',
            ],
          },
          400,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    await fillCreateForm(user, 'Travel Fund', '250.00')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(
      await screen.findByText('This field is required.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Ensure that there are no more than 10 digits before the decimal point.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Opening balance')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByLabelText('Name')).toHaveValue('Travel Fund')
    expect(screen.getByLabelText('Opening balance')).toHaveValue('250.00')
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create account' }),
    ).not.toBeDisabled()
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('shows a safe alert for backend non-field errors and preserves values and list', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse([accountFixture()])
        }
        return jsonResponse(
          { non_field_errors: ['Unable to create account.'] },
          400,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to create account.',
    )
    expect(screen.getByLabelText('Name')).toHaveValue('Travel Fund')
    expect(screen.getByLabelText('Opening balance')).toHaveValue('250.00')
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create account' }),
    ).not.toBeDisabled()
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('shows a generic safe alert when backend field errors map to unknown keys only', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse([accountFixture()])
        }
        return jsonResponse({ server_note: ['unexpected'] }, 400)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(screen.queryByText('unexpected')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Travel Fund')
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
  })

  it('shows a safe alert and never POSTs when the CSRF cookie is missing', async () => {
    const mock = installFetchMock((url, init) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/accounts/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse([accountFixture()])
      }
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Missing CSRF token.',
    )
    expect(screen.getByLabelText('Name')).toHaveValue('Travel Fund')
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(0)
  })

  const failureCases: Array<[string, () => Response, string]> = [
    [
      'a network failure',
      () => {
        throw new TypeError('Failed to fetch')
      },
      'Could not reach the server.',
    ],
    [
      'a 403 response',
      () => jsonResponse({ detail: 'Forbidden.' }, 403),
      'Forbidden.',
    ],
    [
      'a 500 response',
      () => new Response(null, { status: 500 }),
      'Something went wrong. Please try again.',
    ],
    [
      'a malformed 201 response',
      () => jsonResponse({}, 201),
      'Unexpected server response.',
    ],
  ]

  it.each(failureCases)(
    'keeps values and the existing list on %s',
    async (_label, respond, message) => {
      const mock = installFetchMock(
        authenticatedCreateHandler((_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([accountFixture()])
          }
          return respond()
        }),
      )
      renderApp('/accounts')
      await screen.findByText('Everyday Checking')

      const user = userEvent.setup()
      await fillCreateForm(user)
      await user.click(screen.getByRole('button', { name: 'Create account' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.getByLabelText('Name')).toHaveValue('Travel Fund')
      expect(screen.getByLabelText('Opening balance')).toHaveValue('250.00')
      expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
      expect(screen.queryByText('Travel Fund')).not.toBeInTheDocument()
      expect(screen.queryByText('Account created.')).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Create account' }),
      ).not.toBeDisabled()
      expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
    },
  )

  it('disables fields while pending and makes duplicate submits a single request', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return pending.promise
      }),
    )
    renderApp('/accounts')
    await screen.findByText(/No accounts yet/)

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    const submitButton = await screen.findByRole('button', {
      name: 'Creating account…',
    })
    expect(submitButton).toBeDisabled()
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.getByLabelText('Account type')).toBeDisabled()
    expect(screen.getByLabelText('Opening balance')).toBeDisabled()

    await user.click(submitButton)
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)

    await act(async () => {
      pending.resolve(
        jsonResponse(
          accountFixture({ id: 3, name: 'Travel Fund', current_balance: '250.00' }),
          201,
        ),
      )
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Account created.',
    )
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
    expect(screen.getByRole('listitem')).toHaveTextContent('Travel Fund')
  })

  it('never writes auth values to web storage after creating an account', async () => {
    installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(accountFixture({ id: 4, name: 'Travel Fund' }), 201)
      }),
    )
    renderApp('/accounts')
    await screen.findByText(/No accounts yet/)

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await screen.findByRole('status')

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('account creation session expiry', () => {
  it('clears session and redirects to login on a 401 create without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText(/No accounts yet/)

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/accounts/',
      'GET /api/auth/csrf/',
      'POST /api/accounts/',
    ])
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('clears session and redirects to login on a 401 CSRF bootstrap', async () => {
    const mock = installFetchMock((url, init) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      if (url === '/api/accounts/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse([])
      }
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')
    await screen.findByText(/No accounts yet/)

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('account creation lifecycle', () => {
  it('ignores a late create 401 after navigating to dashboard', async () => {
    const pendingCreate = deferred<Response>()
    const mock = installFetchMock((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse({
          total_balance: '1234.56',
          current_month_income: '2000.00',
          current_month_expenses: '765.44',
          total_budgeted: '1500.00',
          remaining_budget: '-100.10',
          recent_transactions: [],
        })
      }
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/accounts/') {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return pendingCreate.promise
      }
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')
    await screen.findByText(/No accounts yet/)

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create account' }))
    await screen.findByRole('button', { name: 'Creating account…' })
    await waitFor(() =>
      expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1),
    )

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      pendingCreate.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(calls(mock, '/api/auth/logout/', 'POST')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })
})

function editAccounts() {
  return [
    accountFixture({
      id: 7,
      name: 'Everyday Checking',
      account_type: 'checking',
      opening_balance: '100.00',
      current_balance: '100.00',
      is_archived: false,
    }),
    accountFixture({
      id: 8,
      name: 'Old Card',
      account_type: 'credit_card',
      opening_balance: '-50.00',
      current_balance: '-75.50',
      is_archived: true,
    }),
    accountFixture({
      id: 9,
      name: 'Cash Jar',
      account_type: 'cash',
      opening_balance: '0.00',
      current_balance: '0.00',
      is_archived: false,
    }),
  ]
}

function accountItem(name: string): HTMLElement {
  const item = screen
    .getAllByRole('listitem')
    .find((node) => node.textContent?.includes(name))
  if (item === undefined) throw new Error(`No list item for ${name}`)
  return item
}

async function openEditForm(
  user: ReturnType<typeof userEvent.setup>,
  accountName: string,
) {
  const item = accountItem(accountName)
  await user.click(within(item).getByRole('button', { name: `Edit ${accountName}` }))
  return screen.getByRole('form', { name: 'Edit account' })
}

async function setEditFields(
  user: ReturnType<typeof userEvent.setup>,
  editor: HTMLElement,
  name: string,
  opening: string,
  accountType = 'savings',
) {
  const nameInput = within(editor).getByLabelText('Name')
  await user.clear(nameInput)
  await user.type(nameInput, name)
  await user.selectOptions(within(editor).getByLabelText('Account type'), accountType)
  const openingInput = within(editor).getByLabelText('Opening balance')
  await user.clear(openingInput)
  await user.type(openingInput, opening)
}

describe('account editing', () => {
  it('shows an Edit button on every row and prefills the editor from exact server strings', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse(editAccounts())),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    for (const name of ['Everyday Checking', 'Old Card', 'Cash Jar']) {
      expect(
        within(accountItem(name)).getByRole('button', { name: `Edit ${name}` }),
      ).toBeInTheDocument()
    }

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')

    const nameInput = within(editor).getByLabelText('Name')
    expect(nameInput).toHaveValue('Everyday Checking')
    expect(nameInput).toHaveAttribute('type', 'text')
    const typeSelect = within(editor).getByLabelText('Account type')
    expect(typeSelect).toHaveValue('checking')
    const openingInput = within(editor).getByLabelText('Opening balance')
    expect(openingInput).toHaveValue('100.00')
    expect(openingInput).toHaveAttribute('type', 'text')
    expect(openingInput).toHaveAttribute('inputmode', 'decimal')
    expect(openingInput).not.toHaveAttribute('type', 'number')
    expect(
      within(editor).getByRole('button', { name: 'Save' }),
    ).toBeInTheDocument()
    expect(
      within(editor).getByRole('button', { name: 'Cancel' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(0)
  })

  it('cancel closes the editor without mutation and restores the row', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse(editAccounts())),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Changed Name')
    await user.click(within(editor).getByRole('button', { name: 'Cancel' }))

    expect(
      screen.queryByRole('form', { name: 'Edit account' }),
    ).not.toBeInTheDocument()
    const restored = accountItem('Everyday Checking')
    expect(within(restored).getByText('Everyday Checking')).toBeInTheDocument()
    expect(within(restored).getAllByText('$100.00')).toHaveLength(2)
    expect(within(restored).getByText('Active')).toBeInTheDocument()
    expect(screen.queryByText('Account updated.')).not.toBeInTheDocument()
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(0)
  })

  it('switching edit targets resets the editor to that account', async () => {
    installFetchMock(
      authenticatedHandler(() => jsonResponse(editAccounts())),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await user.clear(within(editor).getByLabelText('Name'))
    await user.type(within(editor).getByLabelText('Name'), 'Discarded Change')

    const switched = await openEditForm(user, 'Old Card')
    expect(within(switched).getByLabelText('Name')).toHaveValue('Old Card')
    expect(within(switched).getByLabelText('Account type')).toHaveValue(
      'credit_card',
    )
    expect(within(switched).getByLabelText('Opening balance')).toHaveValue(
      '-50.00',
    )
    expect(screen.getAllByRole('form', { name: 'Edit account' })).toHaveLength(1)
  })

  it('saves all three fields via exact CSRF-bootstrapped PATCH and announces update', async () => {
    const mock = installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        return jsonResponse(
          accountFixture({
            id: 7,
            name: 'Renamed',
            account_type: 'savings',
            opening_balance: '-1234.56',
            current_balance: '1250.00',
          }),
          200,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await setEditFields(user, editor, 'Renamed', '-1234.56')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Account updated.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Account updated.')
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/accounts/',
      'GET /api/auth/csrf/',
      'PATCH /api/accounts/7/',
    ])
    const patches = calls(mock, '/api/accounts/7/', 'PATCH')
    expect(patches).toHaveLength(1)
    const [input, init] = patches[0]
    expect(String(input)).toBe('/api/accounts/7/')
    expect(init?.method).toBe('PATCH')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Renamed',
      account_type: 'savings',
      opening_balance: '-1234.56',
    })

    expect(
      screen.queryByRole('form', { name: 'Edit account' }),
    ).not.toBeInTheDocument()
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(within(items[0]).getByText('Renamed')).toBeInTheDocument()
    expect(within(items[0]).getByText('-$1,234.56')).toBeInTheDocument()
    expect(within(items[0]).getByText('$1,250.00')).toBeInTheDocument()
    expect(screen.queryByText('7')).not.toBeInTheDocument()
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('replaces the edited account at its original position and keeps archived state', async () => {
    const mock = installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        return jsonResponse(
          accountFixture({
            id: 8,
            name: 'Old Card Renamed',
            account_type: 'credit_card',
            opening_balance: '-50.00',
            current_balance: '-75.50',
            is_archived: true,
          }),
          200,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Old Card')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Old Card Renamed')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    await screen.findByText('Old Card Renamed')
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(within(items[0]).getByText('Everyday Checking')).toBeInTheDocument()
    expect(within(items[1]).getByText('Old Card Renamed')).toBeInTheDocument()
    expect(within(items[2]).getByText('Cash Jar')).toBeInTheDocument()
    expect(within(items[1]).getByText('Archived')).toBeInTheDocument()
    expect(within(items[1]).getByText('Credit card')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/8/', 'PATCH')).toHaveLength(1)
  })

  it.each([
    ['a blank name', '   ', 'Enter a name for this account.', 'name'],
    [
      'a 101-character name',
      'x'.repeat(101),
      'Name must be 100 characters or fewer.',
      'name',
    ],
    [
      'an opening balance with one decimal',
      '12.3',
      'Enter an amount with exactly 2 decimals and at most 10 integer digits.',
      'opening',
    ],
    [
      'an opening balance with 11 integer digits',
      '12345678901.12',
      'Enter an amount with exactly 2 decimals and at most 10 integer digits.',
      'opening',
    ],
    [
      'a non-numeric opening balance',
      'abc',
      'Enter an amount with exactly 2 decimals and at most 10 integer digits.',
      'opening',
    ],
  ])('rejects %s before any network call', async (_label, badValue, message, field) => {
    const mock = installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        return jsonResponse(accountFixture(), 200)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    const input =
      field === 'name'
        ? within(editor).getByLabelText('Name')
        : within(editor).getByLabelText('Opening balance')
    await user.clear(input)
    await user.type(input, badValue)
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute(
      'aria-describedby',
      field === 'name' ? 'edit-account-name-error' : 'edit-account-opening-error',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(input).toHaveValue(badValue)
    expect(
      screen.getByRole('form', { name: 'Edit account' }),
    ).toBeInTheDocument()
    expect(within(accountItem('Cash Jar')).getByText('Cash Jar')).toBeInTheDocument()
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(0)
  })

  it('renders backend known-field errors inline and preserves values and list', async () => {
    const mock = installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        return jsonResponse(
          {
            name: ['This field is required.'],
            opening_balance: [
              'Ensure that there are no more than 10 digits before the decimal point.',
            ],
          },
          400,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Renamed')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByText('This field is required.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Ensure that there are no more than 10 digits before the decimal point.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(nameInput).toHaveValue('Renamed')
    expect(
      screen.getByRole('form', { name: 'Edit account' }),
    ).toBeInTheDocument()
    expect(within(accountItem('Cash Jar')).getByText('Cash Jar')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
  })

  it('shows a safe alert for backend non-field errors', async () => {
    const mock = installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        return jsonResponse({ non_field_errors: ['Unable to update account.'] }, 400)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await setEditFields(user, editor, 'Renamed', '-1234.56')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to update account.',
    )
    expect(within(editor).getByLabelText('Name')).toHaveValue('Renamed')
    expect(within(editor).getByLabelText('Opening balance')).toHaveValue('-1234.56')
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
  })

  it('shows a generic safe alert for unknown backend error keys only', async () => {
    installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        return jsonResponse({ server_note: ['unexpected'] }, 400)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await setEditFields(user, editor, 'Renamed', '-1234.56')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(screen.queryByText('unexpected')).not.toBeInTheDocument()
    expect(
      screen.getByRole('form', { name: 'Edit account' }),
    ).toBeInTheDocument()
  })

  const editFailureCases: Array<[string, () => Response, string]> = [
    [
      'a network failure',
      () => {
        throw new TypeError('Failed to fetch')
      },
      'Could not reach the server.',
    ],
    [
      'a 403 response',
      () => jsonResponse({ detail: 'Forbidden.' }, 403),
      'Forbidden.',
    ],
    [
      'a 404 response',
      () =>
        jsonResponse(
          { detail: 'No Account matches the given query.' },
          404,
        ),
      'No Account matches the given query.',
    ],
    [
      'a 500 response',
      () => new Response(null, { status: 500 }),
      'Something went wrong. Please try again.',
    ],
    [
      'a malformed 200 response',
      () => jsonResponse({}, 200),
      'Unexpected server response.',
    ],
  ]

  it.each(editFailureCases)(
    'keeps the editor values and list on %s',
    async (_label, respond, message) => {
      const mock = installFetchMock(
        authenticatedMutationHandler((_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
          return respond()
        }),
      )
      renderApp('/accounts')
      await screen.findByText('Everyday Checking')

      const user = userEvent.setup()
      const editor = await openEditForm(user, 'Everyday Checking')
      await setEditFields(user, editor, 'Renamed', '-1234.56')
      await user.click(within(editor).getByRole('button', { name: 'Save' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(within(editor).getByLabelText('Name')).toHaveValue('Renamed')
      expect(within(editor).getByLabelText('Opening balance')).toHaveValue('-1234.56')
      expect(within(accountItem('Cash Jar')).getByText('Cash Jar')).toBeInTheDocument()
      expect(screen.queryByText('Account updated.')).not.toBeInTheDocument()
      expect(
        within(editor).getByRole('button', { name: 'Save' }),
      ).not.toBeDisabled()
      expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
    },
  )

  it('disables controls while pending and makes duplicate saves a single request', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        return pending.promise
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await setEditFields(user, editor, 'Renamed', '-1234.56')
    const saveButton = within(editor).getByRole('button', { name: 'Save' })
    await user.click(saveButton)

    const pendingButton = await screen.findByRole('button', {
      name: 'Saving account…',
    })
    expect(pendingButton).toBeDisabled()
    expect(within(editor).getByLabelText('Name')).toBeDisabled()
    expect(within(editor).getByLabelText('Account type')).toBeDisabled()
    expect(within(editor).getByLabelText('Opening balance')).toBeDisabled()
    expect(within(editor).getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await user.click(pendingButton)
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)

    await act(async () => {
      pending.resolve(
        jsonResponse(
          accountFixture({
            id: 7,
            name: 'Renamed',
            account_type: 'savings',
            opening_balance: '-1234.56',
            current_balance: '-1234.56',
          }),
          200,
        ),
      )
    })
    expect(await screen.findByText('Account updated.')).toBeInTheDocument()
    expect(
      screen.queryByRole('form', { name: 'Edit account' }),
    ).not.toBeInTheDocument()
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
  })

  it('clears session and redirects to login on a 401 PATCH without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await setEditFields(user, editor, 'Renamed', '-1234.56')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('clears session and redirects to login on a 401 CSRF bootstrap', async () => {
    const mock = installFetchMock((url, init) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      if (url === '/api/accounts/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(editAccounts())
      }
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await setEditFields(user, editor, 'Renamed', '-1234.56')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('ignores a late edit 401 after navigating to dashboard', async () => {
    const pendingPatch = deferred<Response>()
    const mock = installFetchMock((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse({
          total_balance: '1234.56',
          current_month_income: '2000.00',
          current_month_expenses: '765.44',
          total_budgeted: '1500.00',
          remaining_budget: '-100.10',
          recent_transactions: [],
        })
      }
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/accounts/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(editAccounts())
      }
      if (url === '/api/accounts/7/' && init?.method === 'PATCH') {
        return pendingPatch.promise
      }
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await setEditFields(user, editor, 'Renamed', '-1234.56')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Saving account…' })
    await waitFor(() =>
      expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1),
    )

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      pendingPatch.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(calls(mock, '/api/auth/logout/', 'POST')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/7/', 'PATCH')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })
})

function deleteHandler(
  onDelete: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return authenticatedMutationHandler((url, init) => {
    if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
    if ((init?.method ?? 'GET') === 'DELETE') return onDelete(url, init)
    return jsonResponse({}, 404)
  })
}

async function openArchiveConfirm(
  user: ReturnType<typeof userEvent.setup>,
  accountName: string,
) {
  const item = accountItem(accountName)
  await user.click(
    within(item).getByRole('button', { name: `Archive ${accountName}` }),
  )
  return screen.getByRole('group', { name: 'Archive account' })
}

describe('account archiving', () => {
  it('shows Archive only on active rows and keeps Edit on archived rows', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse(editAccounts())))
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    expect(
      within(accountItem('Everyday Checking')).getByRole('button', {
        name: 'Archive Everyday Checking',
      }),
    ).toBeInTheDocument()
    expect(
      within(accountItem('Cash Jar')).getByRole('button', {
        name: 'Archive Cash Jar',
      }),
    ).toBeInTheDocument()
    expect(
      within(accountItem('Old Card')).queryByRole('button', {
        name: 'Archive Old Card',
      }),
    ).not.toBeInTheDocument()
    expect(
      within(accountItem('Old Card')).getByRole('button', {
        name: 'Edit Old Card',
      }),
    ).toBeInTheDocument()
  })

  it('opens an inline confirmation naming the account and explaining archive semantics', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse(editAccounts())),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')

    expect(
      within(confirm).getByText(
        'Everyday Checking will be archived, not deleted.',
      ),
    ).toBeInTheDocument()
    expect(
      within(confirm).getByText('Historical transactions remain available.'),
    ).toBeInTheDocument()
    const confirmButton = within(confirm).getByRole('button', {
      name: 'Confirm archive Everyday Checking',
    })
    expect(confirmButton).toHaveTextContent('Archive')
    expect(
      within(confirm).getByRole('button', { name: 'Cancel' }),
    ).toBeInTheDocument()
    expect(
      within(accountItem('Everyday Checking')).queryByRole('button', {
        name: 'Edit Everyday Checking',
      }),
    ).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(0)
  })

  it('cancel closes the confirmation with zero mutation and restores the row', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse(editAccounts())),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))

    expect(
      screen.queryByRole('group', { name: 'Archive account' }),
    ).not.toBeInTheDocument()
    const restored = accountItem('Everyday Checking')
    expect(within(restored).getByText('Active')).toBeInTheDocument()
    expect(
      within(restored).getByRole('button', {
        name: 'Archive Everyday Checking',
      }),
    ).toBeInTheDocument()
    expect(
      within(restored).getByRole('button', { name: 'Edit Everyday Checking' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Account archived.')).not.toBeInTheDocument()
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(0)
  })

  it('opening an editor closes an open archive confirmation', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse(editAccounts())))
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    await openArchiveConfirm(user, 'Everyday Checking')
    await user.click(
      within(accountItem('Cash Jar')).getByRole('button', {
        name: 'Edit Cash Jar',
      }),
    )

    expect(
      screen.queryByRole('group', { name: 'Archive account' }),
    ).not.toBeInTheDocument()
    const editor = screen.getByRole('form', { name: 'Edit account' })
    expect(within(editor).getByLabelText('Name')).toHaveValue('Cash Jar')
  })

  it('opening an archive confirmation closes an open editor', async () => {
    installFetchMock(authenticatedHandler(() => jsonResponse(editAccounts())))
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const editor = await openEditForm(user, 'Everyday Checking')
    await user.type(within(editor).getByLabelText('Name'), ' discarded')
    await openArchiveConfirm(user, 'Cash Jar')

    expect(
      screen.queryByRole('form', { name: 'Edit account' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: 'Archive account' }),
    ).toBeInTheDocument()
  })

  it('sends an exact CSRF-bootstrapped DELETE with no body and announces on 204', async () => {
    const mock = installFetchMock(
      deleteHandler((url) => {
        if (url === '/api/accounts/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    await user.click(
      within(confirm).getByRole('button', {
        name: 'Confirm archive Everyday Checking',
      }),
    )

    expect(await screen.findByText('Account archived.')).toBeInTheDocument()
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/accounts/',
      'GET /api/auth/csrf/',
      'DELETE /api/accounts/7/',
    ])
    const deletes = calls(mock, '/api/accounts/7/', 'DELETE')
    expect(deletes).toHaveLength(1)
    const [input, init] = deletes[0]
    expect(String(input)).toBe('/api/accounts/7/')
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    expect(init?.body).toBeUndefined()
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
    expect(screen.queryByText('7')).not.toBeInTheDocument()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('archives exactly that row in place without removing or reordering it', async () => {
    const mock = installFetchMock(
      deleteHandler((url) => {
        if (url === '/api/accounts/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    await user.click(
      within(confirm).getByRole('button', {
        name: 'Confirm archive Everyday Checking',
      }),
    )

    await screen.findByText('Account archived.')
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(within(items[0]).getByText('Everyday Checking')).toBeInTheDocument()
    expect(within(items[0]).getByText('Archived')).toBeInTheDocument()
    expect(within(items[0]).getByText('Checking')).toBeInTheDocument()
    expect(within(items[0]).getAllByText('$100.00')).toHaveLength(2)
    expect(within(items[1]).getByText('Old Card')).toBeInTheDocument()
    expect(within(items[2]).getByText('Cash Jar')).toBeInTheDocument()
    expect(
      within(items[0]).queryByRole('button', {
        name: 'Archive Everyday Checking',
      }),
    ).not.toBeInTheDocument()
    expect(
      within(items[0]).getByRole('button', { name: 'Edit Everyday Checking' }),
    ).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1)
  })

  it('keeps archived rows editable after archiving', async () => {
    installFetchMock(
      authenticatedMutationHandler((url, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET') return jsonResponse(editAccounts())
        if (method === 'DELETE' && url === '/api/accounts/7/') {
          return emptyResponse(204)
        }
        if (method === 'PATCH' && url === '/api/accounts/7/') {
          return jsonResponse(
            accountFixture({ id: 7, name: 'Everyday Renamed', is_archived: true }),
            200,
          )
        }
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    await user.click(
      within(confirm).getByRole('button', {
        name: 'Confirm archive Everyday Checking',
      }),
    )
    await screen.findByText('Account archived.')

    const editor = await openEditForm(user, 'Everyday Checking')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Everyday Renamed')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    await screen.findByText('Account updated.')
    const item = accountItem('Everyday Renamed')
    expect(within(item).getByText('Archived')).toBeInTheDocument()
  })

  it('is duplicate-safe while pending and disables the confirmation controls', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedMutationHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(editAccounts())
        if ((init?.method ?? 'GET') === 'DELETE') return pending.promise
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    const confirmButton = within(confirm).getByRole('button', {
      name: 'Confirm archive Everyday Checking',
    })
    await user.click(confirmButton)

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Archiving account…',
    )
    expect(
      screen.getByRole('button', { name: 'Confirm archive Everyday Checking' }),
    ).toBeDisabled()
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await user.click(confirmButton)
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1)

    await act(async () => {
      pending.resolve(emptyResponse(204))
    })
    expect(await screen.findByText('Account archived.')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1)
  })

  const archiveFailureCases: Array<[string, () => Response, string]> = [
    [
      'a network failure',
      () => {
        throw new TypeError('Failed to fetch')
      },
      'Could not reach the server.',
    ],
    [
      'a 403 response',
      () => jsonResponse({ detail: 'Forbidden.' }, 403),
      'Forbidden.',
    ],
    [
      'a 404 response',
      () =>
        jsonResponse(
          { detail: 'No Account matches the given query.' },
          404,
        ),
      'No Account matches the given query.',
    ],
    [
      'a 500 response',
      () => new Response(null, { status: 500 }),
      'Something went wrong. Please try again.',
    ],
    [
      'an unexpected 200 response',
      () => jsonResponse(accountFixture({ id: 7 }), 200),
      'Unexpected server response.',
    ],
  ]

  it.each(archiveFailureCases)(
    'keeps the confirmation and list intact on %s',
    async (_label, respond, message) => {
      const mock = installFetchMock(
        deleteHandler((url) => {
          if (url === '/api/accounts/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )
      renderApp('/accounts')
      await screen.findByText('Everyday Checking')

      const user = userEvent.setup()
      const confirm = await openArchiveConfirm(user, 'Everyday Checking')
      await user.click(
        within(confirm).getByRole('button', {
          name: 'Confirm archive Everyday Checking',
        }),
      )

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(
        screen.getByRole('group', { name: 'Archive account' }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: 'Confirm archive Everyday Checking' }),
      ).not.toBeDisabled()
      expect(
        screen.getByRole('button', { name: 'Cancel' }),
      ).toBeInTheDocument()
      expect(within(accountItem('Cash Jar')).getByText('Cash Jar')).toBeInTheDocument()
      expect(screen.queryByText('Account archived.')).not.toBeInTheDocument()
      expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1)
    },
  )

  it('lets the user retry after a failure and succeed on the second attempt', async () => {
    let deleteCalls = 0
    const mock = installFetchMock(
      deleteHandler(() => {
        deleteCalls += 1
        if (deleteCalls === 1) return new Response(null, { status: 500 })
        return emptyResponse(204)
      }),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    const confirmButton = within(confirm).getByRole('button', {
      name: 'Confirm archive Everyday Checking',
    })
    await user.click(confirmButton)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(
      screen.getByRole('group', { name: 'Archive account' }),
    ).toBeInTheDocument()

    await user.click(confirmButton)
    expect(await screen.findByText('Account archived.')).toBeInTheDocument()
    expect(within(accountItem('Everyday Checking')).getByText('Archived')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(2)
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
  })

  it('clears session and redirects to login on a 401 DELETE without logout or storage', async () => {
    const mock = installFetchMock(
      deleteHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    await user.click(
      within(confirm).getByRole('button', {
        name: 'Confirm archive Everyday Checking',
      }),
    )

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('clears session and redirects to login on a 401 CSRF bootstrap', async () => {
    const mock = installFetchMock((url, init) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      if (url === '/api/accounts/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(editAccounts())
      }
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    await user.click(
      within(confirm).getByRole('button', {
        name: 'Confirm archive Everyday Checking',
      }),
    )

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('ignores a late archive 401 after navigating to dashboard', async () => {
    const pendingDelete = deferred<Response>()
    const mock = installFetchMock((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/dashboard/summary/') {
        return jsonResponse({
          total_balance: '1234.56',
          current_month_income: '2000.00',
          current_month_expenses: '765.44',
          total_budgeted: '1500.00',
          remaining_budget: '-100.10',
          recent_transactions: [],
        })
      }
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/accounts/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(editAccounts())
      }
      if (url === '/api/accounts/7/' && init?.method === 'DELETE') {
        return pendingDelete.promise
      }
      return jsonResponse({}, 404)
    })
    renderApp('/accounts')
    await screen.findByText('Everyday Checking')

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Everyday Checking')
    await user.click(
      within(confirm).getByRole('button', {
        name: 'Confirm archive Everyday Checking',
      }),
    )
    await screen.findByRole('status')
    await waitFor(() =>
      expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1),
    )

    const nav = screen.getByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }))

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')

    await act(async () => {
      pendingDelete.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/')
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(screen.getByText('$1,234.56')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(calls(mock, '/api/auth/logout/', 'POST')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/accounts/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/7/', 'DELETE')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })
})
