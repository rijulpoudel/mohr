import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetCategoriesRequest } from '../api/categories'
import { resetTransactionsRequest } from '../api/transactions'
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
  type FetchMock,
} from '../test/testUtils'

function transactionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    account: 1,
    category: 1,
    transaction_type: 'expense',
    amount: '12.50',
    date: '2026-09-10',
    note: 'Groceries',
    source: 'manual',
    provider_name: '',
    is_pending: false,
    is_pending_initial_import: false,
    created_at: '2026-09-10T10:00:00Z',
    updated_at: '2026-09-10T10:00:00Z',
    ...overrides,
  }
}

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

function categoryFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Food',
    category_type: 'expense',
    is_archived: false,
    created_at: '2026-09-11T16:08:00.000000Z',
    updated_at: '2026-09-11T16:08:00.000000Z',
    ...overrides,
  }
}

function authenticatedTransactionsHandler(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
  options: {
    accounts?: unknown[]
    categories?: unknown[]
  } = {},
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/accounts/') return jsonResponse(options.accounts ?? [])
    if (url === '/api/categories/') return jsonResponse(options.categories ?? [])
    if (url.startsWith('/api/transactions/')) return respond(url, init)
    return jsonResponse({}, 404)
  }
}

function defaultAccounts() {
  return [
    accountFixture({ id: 1, name: 'Everyday Checking' }),
    accountFixture({
      id: 2,
      name: 'Savings',
      account_type: 'savings',
    }),
  ]
}

function defaultCategories() {
  return [
    categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
    categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
    categoryFixture({
      id: 3,
      name: 'Transport',
      category_type: 'expense',
    }),
  ]
}

function serverOrderedTransactions() {
  return [
    transactionFixture({
      id: 3,
      account: 2,
      category: 1,
      transaction_type: 'income',
      amount: '2500.00',
      date: '2026-09-11',
      note: 'Monthly paycheck',
    }),
    transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: '',
    }),
    transactionFixture({
      id: 2,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '45.00',
      date: '2026-09-09',
      note: 'Dinner',
    }),
  ]
}

function plaidTransactionFixture(overrides: Record<string, unknown> = {}) {
  return transactionFixture({
    source: 'plaid',
    provider_name: 'Chase',
    is_pending: false,
    is_pending_initial_import: false,
    ...overrides,
  })
}

function transactionRequests(mock: FetchMock): number {
  return mock.mock.calls.filter(([input]) =>
    String(input).startsWith('/api/transactions/'),
  ).length
}

afterEach(() => {
  resetTransactionsRequest()
  resetCategoriesRequest()
})

describe('transactions navigation', () => {
  it('shows Transactions nav after Categories with current-page state when authenticated', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const categoriesLink = within(nav).getByRole('link', { name: 'Categories' })
    const transactionsLink = within(nav).getByRole('link', { name: 'Transactions' })
    expect(transactionsLink).toHaveAttribute('href', '/transactions')
    expect(transactionsLink).toHaveAttribute('aria-current', 'page')
    expect(categoriesLink).not.toHaveAttribute('aria-current', 'page')
    expect(
      categoriesLink.compareDocumentPosition(transactionsLink) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      within(nav).getByRole('link', { name: 'Dashboard' }),
    ).toBeInTheDocument()
  })

  it('keeps the guest shell brand-only without the Transactions link', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/login')

    expect(await screen.findByRole('link', { name: 'Mohr' })).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Transactions' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
  })

  it('protects /transactions for guests by redirecting to login', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/transactions')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
  })
})

describe('transactions list', () => {
  it('renders transactions in server order with friendly labels, exact signed amounts, note, and resolved names', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    expect(
      await screen.findByRole('heading', { name: 'Transactions' }),
    ).toBeInTheDocument()
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Monthly paycheck')
    expect(items[1]).toHaveTextContent('Expense')
    expect(items[2]).toHaveTextContent('Dinner')

    expect(within(items[0]).getByText('Income')).toBeInTheDocument()
    expect(within(items[0]).getByText('+$2,500.00')).toBeInTheDocument()
    expect(within(items[1]).getByText('-$12.50')).toBeInTheDocument()
    expect(within(items[2]).getByText('Expense')).toBeInTheDocument()
    expect(within(items[2]).getByText('-$45.00')).toBeInTheDocument()
    expect(within(items[1]).queryByText('Groceries')).not.toBeInTheDocument()

    expect(within(items[0]).getByText('Savings')).toBeInTheDocument()
    expect(within(items[0]).getByText('Salary')).toBeInTheDocument()
    expect(within(items[1]).getByText('Everyday Checking')).toBeInTheDocument()
    expect(within(items[1]).getByText('Food')).toBeInTheDocument()
    expect(within(items[2]).getByText('Everyday Checking')).toBeInTheDocument()
    expect(within(items[2]).getByText('Food')).toBeInTheDocument()

    expect(within(items[0]).getByText('2026-09-11')).toHaveAttribute(
      'datetime',
      '2026-09-11',
    )
    expect(within(items[1]).getByText('2026-09-10')).toHaveAttribute(
      'datetime',
      '2026-09-10',
    )

    expect(screen.queryByText('1')).not.toBeInTheDocument()
    expect(screen.queryByText('2')).not.toBeInTheDocument()
    expect(screen.queryByText('3')).not.toBeInTheDocument()
  })

  it('renders historical names for transactions linked to archived accounts and categories without exposing their ids', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () =>
          jsonResponse([
            transactionFixture({
              id: 7,
              account: 2,
              category: 3,
              transaction_type: 'expense',
              amount: '88.50',
              date: '2026-08-15',
              note: 'Vintage purchase',
            }),
          ]),
        {
          accounts: [
            accountFixture({ id: 1, name: 'Everyday Checking' }),
            accountFixture({
              id: 2,
              name: 'Old Card',
              account_type: 'credit_card',
              is_archived: true,
            }),
          ],
          categories: [
            categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
            categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
            categoryFixture({
              id: 3,
              name: 'Old Hobby',
              category_type: 'expense',
              is_archived: true,
            }),
          ],
        },
      ),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    expect(within(item).getByText('Old Card')).toBeInTheDocument()
    expect(within(item).getByText('Old Hobby')).toBeInTheDocument()
    expect(within(item).getByText('-$88.50')).toBeInTheDocument()
    expect(within(item).getByText('Vintage purchase')).toBeInTheDocument()
    expect(screen.queryByText('2')).not.toBeInTheDocument()
    expect(screen.queryByText('3')).not.toBeInTheDocument()
  })

  it('formats exact large and negative-looking amounts as strings end to end', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () =>
          jsonResponse([
            transactionFixture({
              id: 5,
              account: 2,
              category: 1,
              transaction_type: 'income',
              amount: '1234567890.12',
              date: '2026-09-12',
              note: 'Bonus',
            }),
            transactionFixture({
              id: 6,
              account: 1,
              category: 2,
              transaction_type: 'expense',
              amount: '9999999999.99',
              date: '2026-09-08',
              note: '',
            }),
          ]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    expect(await screen.findByText('+$1,234,567,890.12')).toBeInTheDocument()
    expect(screen.getByText('-$9,999,999,999.99')).toBeInTheDocument()
    expect(screen.queryByText('$1,234,567,890.12')).not.toBeInTheDocument()
  })

  it('shows an accessible loading status while transactions are pending and keeps filters usable', async () => {
    const pending = deferred<Response>()
    installFetchMock(
      authenticatedTransactionsHandler(() => pending.promise, {
        accounts: defaultAccounts(),
        categories: defaultCategories(),
      }),
    )
    renderApp('/transactions')

    expect(
      await screen.findByText('Loading your transactions…'),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading your transactions',
    )
    expect(screen.getByLabelText('Account')).toBeEnabled()
    expect(screen.getByLabelText('Category')).toBeEnabled()
    expect(screen.getByLabelText('Transaction type')).toBeEnabled()
    expect(screen.getByLabelText('Start date')).toBeEnabled()
    expect(screen.getByLabelText('End date')).toBeEnabled()

    await act(async () => {
      pending.resolve(jsonResponse(serverOrderedTransactions()))
    })
    expect(await screen.findByText('Monthly paycheck')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows meaningful empty text before any data', async () => {
    installFetchMock(authenticatedTransactionsHandler(() => jsonResponse([])))
    renderApp('/transactions')

    expect(await screen.findByText(/No transactions yet/)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('shows a no-matches empty state after applying a filter', async () => {
    installFetchMock(
      authenticatedTransactionsHandler((url) => {
        if (url === '/api/transactions/?transaction_type=expense') {
          return jsonResponse([])
        }
        return jsonResponse([])
      }),
    )
    renderApp('/transactions')
    expect(await screen.findByText(/No transactions yet/)).toBeInTheDocument()

    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByLabelText('Transaction type'),
      'expense',
    )

    expect(
      await screen.findByText(/No matches for these filters/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/No transactions yet/)).not.toBeInTheDocument()
  })

  it('retries a failed request and clears the stale error', async () => {
    let transactionsCalls = 0
    const mock = installFetchMock(
      authenticatedTransactionsHandler(() => {
        transactionsCalls += 1
        if (transactionsCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse(serverOrderedTransactions())
      }),
    )
    renderApp('/transactions')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Monthly paycheck')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/transactions/')).toHaveLength(2)
  })

  it('refetches account and category metadata after a metadata failure instead of caching the rejection', async () => {
    let accountsCalls = 0
    let categoriesCalls = 0
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/accounts/') {
        accountsCalls += 1
        if (accountsCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse(defaultAccounts())
      }
      if (url === '/api/categories/') {
        categoriesCalls += 1
        return jsonResponse(defaultCategories())
      }
      if (url.startsWith('/api/transactions/')) {
        return jsonResponse(serverOrderedTransactions())
      }
      return jsonResponse({}, 404)
    })
    renderApp('/transactions')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Monthly paycheck')).toBeInTheDocument()
    expect(accountsCalls).toBe(2)
    expect(categoriesCalls).toBe(2)
    expect(calls(mock, '/api/transactions/')).toHaveLength(2)
  })

  it('issues exactly one request per endpoint under StrictMode', async () => {
    const mock = installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    expect(await screen.findByText('Monthly paycheck')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
  })

  it('late list 401 after navigating away stays on accounts without logout or storage writes', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedTransactionsHandler(() => pending.promise, {
        accounts: defaultAccounts(),
        categories: defaultCategories(),
      }),
    )
    renderApp('/transactions')

    expect(
      await screen.findByText('Loading your transactions…'),
    ).toBeInTheDocument()

    const user = userEvent.setup()
    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }))

    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/accounts')
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(2)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)

    await act(async () => {
      pending.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/accounts')
    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
    expect(
      await screen.findByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(2)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
  })

  it('never writes auth values to web storage', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    expect(await screen.findByText('Monthly paycheck')).toBeInTheDocument()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('transaction provenance', () => {
  it('marks a bank-synced row as coming from the bank and labels the bank description', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () =>
          jsonResponse([
            plaidTransactionFixture({
              id: 4,
              note: 'Coffee shop',
              provider_name: 'Chase',
            }),
          ]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    // provider_name is the bank's description of the transaction, not the
    // institution, so it must never be phrased as the source of the data.
    expect(within(item).getByText('From your bank')).toBeInTheDocument()
    expect(within(item).getByText('Bank description: Chase')).toBeInTheDocument()
    expect(within(item).queryByText('From Chase')).not.toBeInTheDocument()
  })

  it('identifies a bank-synced row without inventing a provider when provider_name is empty', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse([plaidTransactionFixture({ id: 4, provider_name: '' })]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    expect(within(item).getByText('From your bank')).toBeInTheDocument()
    expect(within(item).queryByText(/Bank description/)).not.toBeInTheDocument()
    expect(within(item).queryByText(/Chase|provider/i)).not.toBeInTheDocument()
  })

  it('omits the bank description when the provider name is only whitespace', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse([plaidTransactionFixture({ id: 4, provider_name: '   ' })]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    // The backend bounds this field by length only, so whitespace is possible
    // and must not produce a hollow label with no value after it.
    expect(within(item).getByText('From your bank')).toBeInTheDocument()
    expect(within(item).queryByText(/Bank description/)).not.toBeInTheDocument()
  })

  it('renders no provenance marker on a manual row', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    await screen.findByText('Monthly paycheck')
    expect(screen.queryByText(/^From /)).not.toBeInTheDocument()
  })

  it('renders a distinct Pending marker on a pending bank-synced row', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse([plaidTransactionFixture({ id: 4, is_pending: true })]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    expect(within(item).getByText('Pending')).toBeInTheDocument()
  })

  it('renders a distinct initial-import note worded differently from Pending', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () =>
          jsonResponse([
            plaidTransactionFixture({
              id: 4,
              is_pending_initial_import: true,
            }),
          ]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    expect(
      within(item).getByText('History still importing'),
    ).toBeInTheDocument()
    expect(within(item).queryByText('Pending')).not.toBeInTheDocument()
  })

  it('renders both pending markers when a bank-synced row is pending and still importing', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () =>
          jsonResponse([
            plaidTransactionFixture({
              id: 4,
              is_pending: true,
              is_pending_initial_import: true,
            }),
          ]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    expect(within(item).getByText('Pending')).toBeInTheDocument()
    expect(
      within(item).getByText('History still importing'),
    ).toBeInTheDocument()
  })

  it('renders no Delete control on a bank-synced row and keeps it on a manual row', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () =>
          jsonResponse([
            plaidTransactionFixture({ id: 4 }),
            transactionFixture({
              id: 5,
              account: 1,
              category: 2,
              amount: '9.99',
              date: '2026-09-09',
              note: 'Manual entry',
            }),
          ]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    await screen.findByText('Manual entry')
    const items = screen.getAllByRole('listitem')
    expect(
      within(items[0]).queryByRole('button', { name: 'Delete transaction 4' }),
    ).not.toBeInTheDocument()
    expect(
      within(items[1]).getByRole('button', { name: 'Delete transaction 5' }),
    ).toBeInTheDocument()
  })

  it('keeps the Edit control and its accessible name on a bank-synced row', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse([plaidTransactionFixture({ id: 4 })]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    const edit = within(item).getByRole('button', { name: 'Edit transaction 4' })
    expect(edit).toBeEnabled()
  })

  it('keeps the retention note out of view when every row is manual', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    await screen.findByText('Monthly paycheck')
    expect(screen.queryByText(/kept for the audit trail/)).not.toBeInTheDocument()
  })

  it('states once that bank-synced transactions are kept for the audit trail and cannot be deleted', async () => {
    installFetchMock(
      authenticatedTransactionsHandler(
        () =>
          jsonResponse([
            plaidTransactionFixture({ id: 4 }),
            transactionFixture({
              id: 5,
              account: 1,
              category: 2,
              amount: '9.99',
              date: '2026-09-09',
              note: 'Manual entry',
            }),
          ]),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    await screen.findByText('Manual entry')
    expect(screen.getAllByText(/kept for the audit trail/)).toHaveLength(1)
    expect(
      screen.getByText(
        'Bank-synced transactions are kept for the audit trail and cannot be deleted.',
      ),
    ).toBeInTheDocument()
  })
})

describe('transactions filters', () => {
  it.each([
    ['account', 'Account', '2', 'account=2'],
    ['category', 'Category', '3', 'category=3'],
    [
      'transaction type',
      'Transaction type',
      'expense',
      'transaction_type=expense',
    ],
    ['start date', 'Start date', '2026-09-01', 'start_date=2026-09-01'],
    ['end date', 'End date', '2026-09-30', 'end_date=2026-09-30'],
  ])(
    'sends the %s filter alone as its own query parameter',
    async (_label, fieldLabel, value, query) => {
      const mock = installFetchMock(
        authenticatedTransactionsHandler(
          () => jsonResponse(serverOrderedTransactions()),
          { accounts: defaultAccounts(), categories: defaultCategories() },
        ),
      )
      renderApp('/transactions')
      await screen.findByText('Monthly paycheck')

      if (query.startsWith('start_date') || query.startsWith('end_date')) {
        fireEvent.change(screen.getByLabelText(fieldLabel), {
          target: { value },
        })
      } else {
        const user = userEvent.setup()
        await user.selectOptions(screen.getByLabelText(fieldLabel), value)
      }

      await waitFor(() =>
        expect(calls(mock, `/api/transactions/?${query}`)).toHaveLength(1),
      )
    },
  )

  it('combines all filters in the backend deterministic order and never refetches account or category lists', async () => {
    const mock = installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Account'), '2')
    await user.selectOptions(screen.getByLabelText('Category'), '3')
    await user.selectOptions(
      screen.getByLabelText('Transaction type'),
      'income',
    )
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-09-01' },
    })
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-09-30' },
    })

    await waitFor(() =>
      expect(
        calls(
          mock,
          '/api/transactions/?account=2&category=3&transaction_type=income&start_date=2026-09-01&end_date=2026-09-30',
        ),
      ).toHaveLength(1),
    )
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
  })

  it('clearing a filter removes its parameter from the next request', async () => {
    const mock = installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    const accountSelect = screen.getByLabelText('Account')
    await user.selectOptions(accountSelect, '2')
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/?account=2')).toHaveLength(1),
    )

    await user.selectOptions(accountSelect, '')
    await waitFor(() => expect(calls(mock, '/api/transactions/')).toHaveLength(2))
    expect(calls(mock, '/api/transactions/?account=2')).toHaveLength(1)
  })

  it('rejects a reversed date range before any request with an accessible error tied to the end date', async () => {
    const mock = installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')
    expect(transactionRequests(mock)).toBe(1)

    const startInput = screen.getByLabelText('Start date')
    const endInput = screen.getByLabelText('End date')
    fireEvent.change(startInput, { target: { value: '2026-09-30' } })
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?start_date=2026-09-30'),
      ).toHaveLength(1),
    )

    fireEvent.change(endInput, { target: { value: '2026-09-01' } })
    expect(endInput).toHaveAttribute('aria-invalid', 'true')
    expect(endInput).toHaveAttribute(
      'aria-describedby',
      'transactions-end-date-error',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Start date must not be after end date.',
    )
    expect(transactionRequests(mock)).toBe(2)

    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByLabelText('Transaction type'),
      'expense',
    )
    expect(transactionRequests(mock)).toBe(2)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Start date must not be after end date.',
    )

    fireEvent.change(endInput, { target: { value: '2026-09-30' } })
    await waitFor(() =>
      expect(
        calls(
          mock,
          '/api/transactions/?transaction_type=expense&start_date=2026-09-30&end_date=2026-09-30',
        ),
      ).toHaveLength(1),
    )
    expect(transactionRequests(mock)).toBe(3)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(endInput).toHaveAttribute('aria-invalid', 'false')
  })

  it('never sends a non-strict date value', async () => {
    const mock = installFetchMock(
      authenticatedTransactionsHandler(
        () => jsonResponse(serverOrderedTransactions()),
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-13-01' },
    })
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '09/01/2026' },
    })

    expect(transactionRequests(mock)).toBe(1)
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).startsWith('/api/transactions/?'),
      ),
    ).toBe(false)
  })

  it('keeps entered filter values and results context on error and recovers on retry', async () => {
    let filteredCalls = 0
    const mock = installFetchMock(
      authenticatedTransactionsHandler((url) => {
        if (url === '/api/transactions/?transaction_type=income') {
          filteredCalls += 1
          if (filteredCalls === 1) {
            return jsonResponse({ detail: 'Server exploded.' }, 500)
          }
          return jsonResponse([
            transactionFixture({
              id: 8,
              account: 2,
              category: 1,
              transaction_type: 'income',
              amount: '2500.00',
              date: '2026-09-11',
              note: 'Paycheck',
            }),
          ])
        }
        return jsonResponse(serverOrderedTransactions())
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByLabelText('Transaction type'),
      'income',
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Server exploded.',
    )
    expect(screen.getByLabelText('Transaction type')).toHaveValue('income')

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Paycheck')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/transactions/?transaction_type=income')).toHaveLength(
      2,
    )
  })

  it('lets the newest request own the rendered result over a stale response', async () => {
    const unfiltered = deferred<Response>()
    const filtered = deferred<Response>()
    installFetchMock(
      authenticatedTransactionsHandler(
        (url) => {
          if (url === '/api/transactions/?transaction_type=expense') {
            return filtered.promise
          }
          return unfiltered.promise
        },
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')
    await screen.findByText('Loading your transactions…')

    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByLabelText('Transaction type'),
      'expense',
    )

    await act(async () => {
      filtered.resolve(
        jsonResponse([
          transactionFixture({ id: 9, note: 'Filtered result' }),
        ]),
      )
    })
    expect(await screen.findByText('Filtered result')).toBeInTheDocument()

    await act(async () => {
      unfiltered.resolve(
        jsonResponse([
          transactionFixture({ id: 1, note: 'Stale result' }),
        ]),
      )
    })
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument()
    expect(screen.getByText('Filtered result')).toBeInTheDocument()
  })

  it('reuses the single metadata fetch across a filter change while the initial transaction request is still pending', async () => {
    const unfiltered = deferred<Response>()
    const mock = installFetchMock(
      authenticatedTransactionsHandler(
        (url) => {
          if (url === '/api/transactions/?transaction_type=expense') {
            return jsonResponse([
              transactionFixture({ id: 9, note: 'Filtered result' }),
            ])
          }
          return unfiltered.promise
        },
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')

    expect(
      await screen.findByText('Loading your transactions…'),
    ).toBeInTheDocument()
    await waitFor(() => {
      expect(calls(mock, '/api/accounts/')).toHaveLength(1)
      expect(calls(mock, '/api/categories/')).toHaveLength(1)
    })

    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByLabelText('Transaction type'),
      'expense',
    )
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(1),
    )
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)

    await act(async () => {
      unfiltered.resolve(
        jsonResponse([transactionFixture({ note: 'Stale result' })]),
      )
    })
    expect(await screen.findByText('Filtered result')).toBeInTheDocument()
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument()
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
  })
})

describe('transactions session expiry', () => {
  it('clears in-memory auth and redirects to login on 401 without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedTransactionsHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )
    renderApp('/transactions')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/auth/me/')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

function authenticatedCreateHandler(
  options: {
    accounts?: unknown[]
    categories?: unknown[]
    transactions?: (url: string, init?: RequestInit) => Response | Promise<Response>
  } = {},
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url === '/api/accounts/') {
      return jsonResponse(options.accounts ?? defaultAccounts())
    }
    if (url === '/api/categories/') {
      return jsonResponse(options.categories ?? defaultCategories())
    }
    if (url.startsWith('/api/transactions/')) {
      if (options.transactions !== undefined) {
        return options.transactions(url, init)
      }
      return jsonResponse([])
    }
    return jsonResponse({}, 404)
  }
}

function localToday(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function fillValidCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  overrides: {
    account?: string
    category?: string
    type?: string
    amount?: string
    date?: string
    note?: string
  } = {},
) {
  if (overrides.type !== undefined) {
    await user.selectOptions(
      screen.getByLabelText('New transaction type'),
      overrides.type,
    )
  }
  if (overrides.account !== undefined) {
    await user.selectOptions(
      screen.getByLabelText('New transaction account'),
      overrides.account,
    )
  }
  if (overrides.category !== undefined) {
    await user.selectOptions(
      screen.getByLabelText('New transaction category'),
      overrides.category,
    )
  }
  if (overrides.amount !== undefined) {
    const amountInput = screen.getByLabelText('Amount')
    await user.clear(amountInput)
    if (overrides.amount !== '') {
      await user.type(amountInput, overrides.amount)
    }
  }
  if (overrides.date !== undefined) {
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: overrides.date },
    })
  }
  if (overrides.note !== undefined) {
    const noteInput = screen.getByLabelText('Note')
    await user.clear(noteInput)
    if (overrides.note !== '') {
      await user.type(noteInput, overrides.note)
    }
  }
}

describe('transaction creation form', () => {
  it('renders an accessible Add transaction form above the list with local-date default', async () => {
    const yearSpy = vi
      .spyOn(Date.prototype, 'getFullYear')
      .mockReturnValue(2026)
    const monthSpy = vi.spyOn(Date.prototype, 'getMonth').mockReturnValue(0)
    const dateSpy = vi.spyOn(Date.prototype, 'getDate').mockReturnValue(5)
    try {
      installFetchMock(authenticatedCreateHandler())
      renderApp('/transactions')

      const heading = await screen.findByRole('heading', {
        name: 'Add transaction',
      })
      expect(await screen.findByText(/No transactions yet/)).toBeInTheDocument()
      const emptyState = screen.getByText(/No transactions yet/)
      expect(
        heading.compareDocumentPosition(emptyState) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()

      const accountSelect = screen.getByLabelText('New transaction account')
      expect(accountSelect).toHaveAttribute('name', 'account')
      expect(accountSelect).toBeRequired()
      const categorySelect = screen.getByLabelText('New transaction category')
      expect(categorySelect).toHaveAttribute('name', 'category')
      expect(categorySelect).toBeRequired()
      const typeSelect = screen.getByLabelText('New transaction type')
      expect(typeSelect).toHaveAttribute('name', 'transaction_type')
      expect(typeSelect).toHaveValue('expense')
      expect(typeSelect).toBeRequired()

      const amountInput = screen.getByLabelText('Amount')
      expect(amountInput).toHaveAttribute('type', 'text')
      expect(amountInput).toHaveAttribute('inputmode', 'decimal')
      expect(amountInput).toHaveAttribute('name', 'amount')
      expect(amountInput).toBeRequired()

      const dateInput = screen.getByLabelText('Date')
      expect(dateInput).toHaveAttribute('name', 'date')
      expect(dateInput).toHaveValue('2026-01-05')
      expect(dateInput).toBeRequired()

      const noteInput = screen.getByLabelText('Note')
      expect(noteInput).toHaveAttribute('name', 'note')

      expect(
        screen.getByRole('button', { name: 'Create transaction' }),
      ).toBeInTheDocument()
      expect(yearSpy).toHaveBeenCalled()
      expect(monthSpy).toHaveBeenCalled()
      expect(dateSpy).toHaveBeenCalled()
    } finally {
      yearSpy.mockRestore()
      monthSpy.mockRestore()
      dateSpy.mockRestore()
    }
  })

  it('limits create options to active accounts and type-matching active categories while archived names still resolve in old rows', async () => {
    installFetchMock(
      authenticatedCreateHandler({
        accounts: [
          accountFixture({ id: 1, name: 'Everyday Checking' }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            is_archived: true,
          }),
        ],
        categories: [
          categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
          categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
          categoryFixture({
            id: 3,
            name: 'Old Hobby',
            category_type: 'expense',
            is_archived: true,
          }),
        ],
        transactions: () =>
          jsonResponse([
            transactionFixture({
              id: 7,
              account: 2,
              category: 3,
              amount: '88.50',
              date: '2026-08-15',
              note: 'Vintage purchase',
            }),
          ]),
      }),
    )
    renderApp('/transactions')

    const item = (await screen.findAllByRole('listitem'))[0]
    expect(within(item).getByText('Old Card')).toBeInTheDocument()
    expect(within(item).getByText('Old Hobby')).toBeInTheDocument()

    const accountOptions = within(
      screen.getByLabelText('New transaction account'),
    ).getAllByRole('option')
    expect(accountOptions.map((option) => option.textContent)).toEqual([
      'Select an account',
      'Everyday Checking',
    ])
    expect(
      accountOptions.map((option) => option.getAttribute('value')),
    ).toEqual(['', '1'])

    const typeSelect = screen.getByLabelText('New transaction type')
    expect(typeSelect).toHaveValue('expense')
    let categoryOptions = within(
      screen.getByLabelText('New transaction category'),
    ).getAllByRole('option')
    expect(categoryOptions.map((option) => option.textContent)).toEqual([
      'Select a category',
      'Food',
    ])

    const user = userEvent.setup()
    await user.selectOptions(typeSelect, 'income')
    categoryOptions = within(
      screen.getByLabelText('New transaction category'),
    ).getAllByRole('option')
    expect(categoryOptions.map((option) => option.textContent)).toEqual([
      'Select a category',
      'Salary',
    ])
  })

  it('clears an incompatible category when the type changes', async () => {
    installFetchMock(authenticatedCreateHandler())
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    const typeSelect = screen.getByLabelText('New transaction type')
    const categorySelect = screen.getByLabelText(
      'New transaction category',
    ) as HTMLSelectElement
    await user.selectOptions(categorySelect, '2')
    expect(categorySelect).toHaveValue('2')

    await user.selectOptions(typeSelect, 'income')
    expect(categorySelect).toHaveValue('')
    const categoryOptions = within(categorySelect).getAllByRole('option')
    expect(categoryOptions.map((option) => option.textContent)).toEqual([
      'Select a category',
      'Salary',
    ])
  })

  it.each([
    ['zero', '0.00'],
    ['double-zero', '00.00'],
    ['negative', '-12.50'],
    ['exponent', '1e3'],
    ['one decimal', '12.5'],
    ['three decimals', '12.345'],
    ['thirteen digits', '12345678901.23'],
  ])(
    'rejects an invalid %s amount before any network call',
    async (_label, amount) => {
      const mock = installFetchMock(
        authenticatedCreateHandler({
          transactions: (_url, init) => {
            if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
            return jsonResponse(transactionFixture(), 201)
          },
        }),
      )
      renderApp('/transactions')
      await screen.findByText(/No transactions yet/)

      const user = userEvent.setup()
      await fillValidCreateForm(user, {
        account: '1',
        category: '2',
        amount,
        date: '2026-09-10',
        note: 'Dinner',
      })
      await user.click(
        screen.getByRole('button', { name: 'Create transaction' }),
      )

      expect(await screen.findByLabelText('Amount')).toHaveAttribute(
        'aria-invalid',
        'true',
      )
      expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
      expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    },
  )

  it('submits the exact six-key object on valid input', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse(
            transactionFixture({
              id: 10,
              account: 1,
              category: 2,
              transaction_type: 'expense',
              amount: '12.50',
              date: '2026-09-10',
              note: 'Dinner',
            }),
            201,
          )
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByText('Transaction created.')).toBeInTheDocument()
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/accounts/',
      'GET /api/categories/',
      'GET /api/transactions/',
      'GET /api/auth/csrf/',
      'POST /api/transactions/',
      expect.stringMatching(/^GET \/api\/transactions\/$/),
    ])
    const posts = calls(mock, '/api/transactions/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/transactions/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    const body = JSON.parse(String(init?.body))
    expect(Object.keys(body).sort()).toEqual(
      ['account', 'amount', 'category', 'date', 'note', 'transaction_type'].sort(),
    )
    expect(body).toEqual({
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
  })

  it('disables the form while pending and prevents duplicate POSTs', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return pending.promise
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    const pendingButton = await screen.findByRole('button', {
      name: 'Creating transaction…',
    })
    expect(pendingButton).toBeDisabled()
    expect(screen.getByLabelText('New transaction account')).toBeDisabled()
    expect(screen.getByLabelText('New transaction category')).toBeDisabled()
    expect(screen.getByLabelText('New transaction type')).toBeDisabled()
    expect(screen.getByLabelText('Amount')).toBeDisabled()
    expect(screen.getByLabelText('Date')).toBeDisabled()
    expect(screen.getByLabelText('Note')).toBeDisabled()

    await user.click(pendingButton)
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)

    await act(async () => {
      pending.resolve(
        jsonResponse(
          transactionFixture({
            id: 11,
            account: 1,
            category: 2,
            amount: '12.50',
            date: '2026-09-10',
            note: 'Dinner',
          }),
          201,
        ),
      )
    })
    expect(await screen.findByText('Transaction created.')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })

  it('resets the form, preserves filter drafts, and refetches only filtered transactions with zero metadata refetch', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (url, init) => {
          if ((init?.method ?? 'GET') === 'POST') {
            return jsonResponse(
              transactionFixture({
                id: 12,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Dinner',
              }),
              201,
            )
          }
          if (url === '/api/transactions/?transaction_type=expense') {
            return jsonResponse([
              transactionFixture({
                id: 12,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Dinner',
              }),
            ])
          }
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Transaction type'), 'expense')
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(1),
    )
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)

    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByText('Transaction created.')).toBeInTheDocument()
    expect(await screen.findByText('Dinner')).toBeInTheDocument()

    expect(screen.getByLabelText('Transaction type')).toHaveValue('expense')
    expect(screen.getByLabelText('New transaction account')).toHaveValue('')
    expect(screen.getByLabelText('New transaction category')).toHaveValue('')
    expect(screen.getByLabelText('New transaction type')).toHaveValue('expense')
    expect(screen.getByLabelText('Amount')).toHaveValue('')
    expect(screen.getByLabelText('Date')).toHaveValue(localToday())
    expect(screen.getByLabelText('Note')).toHaveValue('')

    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(2),
    )
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })
})

describe('transaction creation client validation', () => {
  it('shows an alert summary with linked inline errors and preserves text when required fields are missing', async () => {
    const mock = installFetchMock(authenticatedCreateHandler())
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    await userEvent.click(
      screen.getByRole('button', { name: 'Create transaction' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    const accountSelect = screen.getByLabelText('New transaction account')
    expect(accountSelect).toHaveAttribute('aria-invalid', 'true')
    expect(accountSelect).toHaveAttribute(
      'aria-describedby',
      'create-transaction-account-error',
    )
    expect(
      within(
        document.getElementById('create-transaction-account-error') as HTMLElement,
      ).getByText('Choose an account.'),
    ).toBeInTheDocument()

    const categorySelect = screen.getByLabelText('New transaction category')
    expect(categorySelect).toHaveAttribute('aria-invalid', 'true')
    expect(categorySelect).toHaveAttribute(
      'aria-describedby',
      'create-transaction-category-error',
    )

    const amountInput = screen.getByLabelText('Amount')
    expect(amountInput).toHaveAttribute('aria-invalid', 'true')
    expect(amountInput).toHaveAttribute(
      'aria-describedby',
      'create-transaction-amount-error',
    )
    expect(amountInput).toHaveValue('')
    expect(screen.getByLabelText('Date')).toHaveAttribute(
      'aria-invalid',
      'false',
    )
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('rejects forged account and category ids before any network call', async () => {
    const mock = installFetchMock(authenticatedCreateHandler())
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    fireEvent.change(screen.getByLabelText('New transaction account'), {
      target: { value: '999' },
    })
    fireEvent.change(screen.getByLabelText('New transaction category'), {
      target: { value: '999' },
    })
    await fillValidCreateForm(userEvent.setup(), {
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Create transaction' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(screen.getByLabelText('New transaction account')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByLabelText('New transaction category')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('rejects an archived account and archived category before any network call', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        accounts: [
          accountFixture({ id: 1, name: 'Everyday Checking' }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            is_archived: true,
          }),
        ],
        categories: [
          categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
          categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
          categoryFixture({
            id: 3,
            name: 'Old Hobby',
            category_type: 'expense',
            is_archived: true,
          }),
        ],
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    fireEvent.change(screen.getByLabelText('New transaction account'), {
      target: { value: '2' },
    })
    fireEvent.change(screen.getByLabelText('New transaction category'), {
      target: { value: '3' },
    })
    await fillValidCreateForm(userEvent.setup(), {
      amount: '12.50',
      date: '2026-09-10',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Create transaction' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(screen.getByLabelText('New transaction account')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByLabelText('New transaction category')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('rejects a category that does not match the selected type before any network call', async () => {
    const mock = installFetchMock(authenticatedCreateHandler())
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    fireEvent.change(screen.getByLabelText('New transaction account'), {
      target: { value: '1' },
    })
    fireEvent.change(screen.getByLabelText('New transaction category'), {
      target: { value: '1' },
    })
    await fillValidCreateForm(userEvent.setup(), {
      amount: '12.50',
      date: '2026-09-10',
    })
    await userEvent.click(
      screen.getByRole('button', { name: 'Create transaction' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    const categorySelect = screen.getByLabelText('New transaction category')
    expect(categorySelect).toHaveAttribute('aria-invalid', 'true')
    expect(categorySelect).toHaveAttribute(
      'aria-describedby',
      'create-transaction-category-error',
    )
    expect(
      document.getElementById('create-transaction-category-error'),
    ).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('rejects an invalid transaction type by blocking submit before any network call', async () => {
    const mock = installFetchMock(authenticatedCreateHandler())
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    fireEvent.change(screen.getByLabelText('New transaction type'), {
      target: { value: 'transfer' },
    })

    expect(
      await screen.findByText(
        'Create an active category for this type before adding transactions.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeDisabled()
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it.each([
    ['missing', ''],
    ['impossible', '2026-02-30'],
  ])('rejects a %s date before any network call', async (_label, date) => {
    const mock = installFetchMock(authenticatedCreateHandler())
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
    })
    fireEvent.change(screen.getByLabelText('Date'), {
      target: { value: date },
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(screen.getByLabelText('Date')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it.each([
    ['leading space', ' 12.50'],
    ['trailing space', '12.50 '],
  ])(
    'rejects a whitespace-wrapped amount (%s) without changing it and before any network call',
    async (_label, amount) => {
      const mock = installFetchMock(authenticatedCreateHandler())
      renderApp('/transactions')
      await screen.findByText(/No transactions yet/)

      const user = userEvent.setup()
      await fillValidCreateForm(user, {
        account: '1',
        category: '2',
        date: '2026-09-10',
      })
      fireEvent.change(screen.getByLabelText('Amount'), {
        target: { value: amount },
      })
      await user.click(
        screen.getByRole('button', { name: 'Create transaction' }),
      )

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Please check the highlighted fields.',
      )
      const amountInput = screen.getByLabelText('Amount')
      expect(amountInput).toHaveAttribute('aria-invalid', 'true')
      expect(amountInput).toHaveValue(amount)
      expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
      expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
      expect(localStorage.length).toBe(0)
      expect(sessionStorage.length).toBe(0)
    },
  )
})

describe('transaction creation backend errors', () => {
  it('renders every backend 400 field message at its linked field and keeps values', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse(
            {
              account: ['Bad account.', 'Second account message.'],
              category: ['Bad category.'],
              transaction_type: ['Bad type.'],
              amount: ['Bad amount.', 'Second amount message.'],
              date: ['Bad date.'],
              note: ['Bad note.'],
              non_field_errors: ['Check everything.'],
            },
            400,
          )
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByText('Bad account.')).toBeInTheDocument()
    expect(screen.getByText('Second account message.')).toBeInTheDocument()
    expect(screen.getByText('Bad category.')).toBeInTheDocument()
    expect(screen.getByText('Bad type.')).toBeInTheDocument()
    expect(screen.getByText('Bad amount.')).toBeInTheDocument()
    expect(screen.getByText('Second amount message.')).toBeInTheDocument()
    expect(screen.getByText('Bad date.')).toBeInTheDocument()
    expect(screen.getByText('Bad note.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Check everything.')
    for (const label of [
      'New transaction account',
      'New transaction category',
      'New transaction type',
      'Amount',
      'Date',
      'Note',
    ]) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        'aria-invalid',
        'true',
      )
    }
    expect(screen.getByLabelText('New transaction account')).toHaveValue('1')
    expect(screen.getByLabelText('Amount')).toHaveValue('12.50')
    expect(screen.getByLabelText('Note')).toHaveValue('Dinner')
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
    expect(screen.queryByText('Transaction created.')).not.toBeInTheDocument()
  })

  it('shows a generic alert for unknown-only 400 payloads without exposing contents', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse({ mystery: ['boom-exposed'], other: ['hidden'] }, 400)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(screen.queryByText('boom-exposed')).not.toBeInTheDocument()
    expect(screen.queryByText('hidden')).not.toBeInTheDocument()
    expect(screen.queryByText('mystery')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Amount')).toHaveValue('12.50')
    expect(screen.getByLabelText('Note')).toHaveValue('Dinner')
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })

  it.each([
    ['forbidden', 403, { detail: 'No permission here.' }, 'No permission here.'],
    ['missing', 404, { detail: 'Not found.' }, 'Not found.'],
    [
      'server error',
      500,
      { detail: 'Server exploded.' },
      'Server exploded.',
    ],
  ])(
    'shows a safe retryable error and preserves values on %s',
    async (_label, status, body, message) => {
      const mock = installFetchMock(
        authenticatedCreateHandler({
          transactions: (_url, init) => {
            if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
            return jsonResponse(body, status)
          },
        }),
      )
      renderApp('/transactions')
      await screen.findByText(/No transactions yet/)

      const user = userEvent.setup()
      await fillValidCreateForm(user, {
        account: '1',
        category: '2',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Dinner',
      })
      await user.click(
        screen.getByRole('button', { name: 'Create transaction' }),
      )

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.getByLabelText('New transaction account')).toHaveValue('1')
      expect(screen.getByLabelText('Amount')).toHaveValue('12.50')
      expect(screen.getByLabelText('Note')).toHaveValue('Dinner')
      expect(
        screen.getByRole('button', { name: 'Create transaction' }),
      ).toBeEnabled()
      expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
      expect(
        screen.queryByText('Transaction created.'),
      ).not.toBeInTheDocument()
    },
  )

  it('shows a safe retryable error and preserves values on a network failure', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          throw new TypeError('Failed to fetch')
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server.',
    )
    expect(screen.getByLabelText('Amount')).toHaveValue('12.50')
    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeEnabled()
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })
})

describe('transaction creation session expiry', () => {
  it('clears only in-memory session and returns to login on POST 401', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('clears only in-memory session and returns to login on CSRF bootstrap 401', async () => {
    const mock = installFetchMock((url: string, init?: RequestInit) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      if (url === '/api/accounts/') {
        return jsonResponse(defaultAccounts())
      }
      if (url === '/api/categories/') {
        return jsonResponse(defaultCategories())
      }
      if (url.startsWith('/api/transactions/')) {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(transactionFixture(), 201)
      }
      return jsonResponse({}, 404)
    })
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('late create 401 after navigating away stays on accounts without logout or storage writes', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return pending.promise
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Creating transaction…',
    )
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1),
    )
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }))
    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/accounts')
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(2)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)

    await act(async () => {
      pending.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/accounts')
    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
    expect(
      await screen.findByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(2)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
  })
})

describe('transaction creation empty states', () => {
  it('explains an active account is required and disables submit when none exist', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        accounts: [],
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse(transactionFixture(), 201)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    expect(
      await screen.findByText(
        'Create an active account before adding transactions.',
      ),
    ).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Create transaction' })
    expect(submit).toBeDisabled()
    await userEvent.click(submit)
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('explains an active category is required and disables submit when the type has none', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        categories: [
          categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
        ],
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse(transactionFixture(), 201)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    expect(screen.getByLabelText('New transaction type')).toHaveValue('expense')
    expect(
      await screen.findByText(
        'Create an active category for this type before adding transactions.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeDisabled()

    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByLabelText('New transaction type'),
      'income',
    )
    expect(
      screen.queryByText(
        'Create an active category for this type before adding transactions.',
      ),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeEnabled()
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
  })
})

describe('transaction creation pending announcement', () => {
  it('announces Creating transaction… via a live status while pending', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return pending.promise
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Creating transaction…')
    expect(screen.getByLabelText('Amount')).toBeDisabled()
    await user.click(
      screen.getByRole('button', { name: 'Creating transaction…' }),
    )
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)

    await act(async () => {
      pending.resolve(
        jsonResponse(
          transactionFixture({
            id: 22,
            account: 1,
            category: 2,
            amount: '12.50',
            date: '2026-09-10',
            note: 'Dinner',
          }),
          201,
        ),
      )
    })
    expect(await screen.findByText('Transaction created.')).toBeInTheDocument()
    expect(screen.queryByText('Creating transaction…')).not.toBeInTheDocument()
  })
})

describe('transaction creation filtered refresh', () => {
  it('keeps the created row hidden when the authoritative filtered refresh excludes it', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (url, init) => {
          if ((init?.method ?? 'GET') === 'POST') {
            return jsonResponse(
              transactionFixture({
                id: 30,
                account: 1,
                category: 1,
                transaction_type: 'income',
                amount: '20.00',
                date: '2026-09-10',
                note: 'Side gig',
              }),
              201,
            )
          }
          if (url === '/api/transactions/?transaction_type=expense') {
            return jsonResponse([])
          }
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Transaction type'), 'expense')
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(1),
    )

    await fillValidCreateForm(user, {
      type: 'income',
      account: '1',
      category: '1',
      amount: '20.00',
      date: '2026-09-10',
      note: 'Side gig',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByText('Transaction created.')).toBeInTheDocument()
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(2),
    )
    expect(screen.queryByText('Side gig')).not.toBeInTheDocument()
    expect(
      await screen.findByText(/No matches for these filters/),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Transaction type')).toHaveValue('expense')
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })
})

describe('transaction creation refresh race', () => {
  it('issues a distinct refresh GET for a second create while the first refresh is still pending', async () => {
    let getCalls = 0
    let postCalls = 0
    const firstRefresh = deferred<Response>()
    const secondRefresh = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'POST') {
            postCalls += 1
            if (postCalls === 1) {
              return jsonResponse(
                transactionFixture({
                  id: 40,
                  account: 1,
                  category: 2,
                  transaction_type: 'expense',
                  amount: '10.00',
                  date: '2026-09-10',
                  note: 'First create',
                }),
                201,
              )
            }
            return jsonResponse(
              transactionFixture({
                id: 41,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '20.00',
                date: '2026-09-10',
                note: 'Second create',
              }),
              201,
            )
          }
          getCalls += 1
          if (getCalls === 1) return jsonResponse([])
          if (getCalls === 2) return firstRefresh.promise
          return secondRefresh.promise
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '10.00',
      date: '2026-09-10',
      note: 'First create',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))
    expect(await screen.findByText('Transaction created.')).toBeInTheDocument()
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/')).toHaveLength(2),
    )

    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '20.00',
      date: '2026-09-10',
      note: 'Second create',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(2),
    )
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/')).toHaveLength(3),
    )

    await act(async () => {
      secondRefresh.resolve(
        jsonResponse([
          transactionFixture({
            id: 40,
            account: 1,
            category: 2,
            transaction_type: 'expense',
            amount: '10.00',
            date: '2026-09-10',
            note: 'First create',
          }),
          transactionFixture({
            id: 41,
            account: 1,
            category: 2,
            transaction_type: 'expense',
            amount: '20.00',
            date: '2026-09-10',
            note: 'Second create',
          }),
        ]),
      )
    })
    expect(await screen.findByText('First create')).toBeInTheDocument()
    expect(screen.getByText('Second create')).toBeInTheDocument()

    await act(async () => {
      firstRefresh.resolve(
        jsonResponse([
          transactionFixture({
            id: 40,
            account: 1,
            category: 2,
            transaction_type: 'expense',
            amount: '10.00',
            date: '2026-09-10',
            note: 'First create',
          }),
        ]),
      )
    })
    expect(screen.getByText('First create')).toBeInTheDocument()
    expect(screen.getByText('Second create')).toBeInTheDocument()
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(2)
    expect(calls(mock, '/api/transactions/')).toHaveLength(3)
  })
})

describe('transaction creation submit lock', () => {
  it('submits only once when the create form is submitted twice in the same tick while POST is pending', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return pending.promise
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    const form = screen
      .getByRole('button', { name: 'Create transaction' })
      .closest('form') as HTMLFormElement
    await act(async () => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })

    await waitFor(() =>
      expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1),
    )
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)

    await act(async () => {
      pending.resolve(
        jsonResponse(
          transactionFixture({
            id: 50,
            account: 1,
            category: 2,
            amount: '12.50',
            date: '2026-09-10',
            note: 'Dinner',
          }),
          201,
        ),
      )
    })
    expect(await screen.findByText('Transaction created.')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
  })
})

describe('transaction creation field error clearing', () => {
  it('clears only the edited client field error while preserving unrelated errors and values', async () => {
    const mock = installFetchMock(authenticatedCreateHandler())
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    await userEvent.click(
      screen.getByRole('button', { name: 'Create transaction' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    const accountSelect = screen.getByLabelText('New transaction account')
    const categorySelect = screen.getByLabelText('New transaction category')
    const amountInput = screen.getByLabelText('Amount')
    expect(accountSelect).toHaveAttribute('aria-invalid', 'true')
    expect(categorySelect).toHaveAttribute('aria-invalid', 'true')
    expect(amountInput).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(accountSelect, { target: { value: '1' } })
    expect(accountSelect).toHaveAttribute('aria-invalid', 'false')
    expect(accountSelect).toHaveValue('1')
    expect(
      document.getElementById('create-transaction-account-error'),
    ).not.toBeInTheDocument()
    expect(categorySelect).toHaveAttribute('aria-invalid', 'true')
    expect(amountInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(amountInput).toHaveValue('')
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)

    fireEvent.change(categorySelect, { target: { value: '2' } })
    fireEvent.change(amountInput, { target: { value: '12.50' } })
    expect(categorySelect).toHaveAttribute('aria-invalid', 'false')
    expect(amountInput).toHaveAttribute('aria-invalid', 'false')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(accountSelect).toHaveValue('1')
    expect(categorySelect).toHaveValue('2')
    expect(amountInput).toHaveValue('12.50')
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
  })

  it('clears only the edited server field error while keeping the non-field alert and values', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse(
            {
              amount: ['Bad amount.'],
              date: ['Bad date.'],
              non_field_errors: ['Check everything.'],
            },
            400,
          )
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByText('Bad amount.')).toBeInTheDocument()
    expect(screen.getByText('Bad date.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Check everything.')
    const amountInput = screen.getByLabelText('Amount')
    const dateInput = screen.getByLabelText('Date')
    expect(amountInput).toHaveAttribute('aria-invalid', 'true')
    expect(dateInput).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(amountInput, { target: { value: '20.00' } })
    expect(amountInput).toHaveAttribute('aria-invalid', 'false')
    expect(amountInput).toHaveValue('20.00')
    expect(
      document.getElementById('create-transaction-amount-error'),
    ).not.toBeInTheDocument()
    expect(dateInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Bad date.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Check everything.')

    fireEvent.change(dateInput, { target: { value: '2026-09-11' } })
    expect(dateInput).toHaveAttribute('aria-invalid', 'false')
    expect(dateInput).toHaveValue('2026-09-11')
    expect(screen.queryByText('Bad date.')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Check everything.')
    expect(amountInput).toHaveValue('20.00')
    expect(screen.getByLabelText('Note')).toHaveValue('Dinner')
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })

  it('clears backend category and type errors when type changes because category validity depends on type', async () => {
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse(
            {
              category: ['Bad category.'],
              transaction_type: ['Bad type.'],
              amount: ['Bad amount.'],
              non_field_errors: ['Check everything.'],
            },
            400,
          )
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Dinner',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))

    expect(await screen.findByText('Bad category.')).toBeInTheDocument()
    expect(screen.getByText('Bad type.')).toBeInTheDocument()
    const categorySelect = screen.getByLabelText('New transaction category')
    const typeSelect = screen.getByLabelText('New transaction type')
    expect(categorySelect).toHaveAttribute('aria-invalid', 'true')
    expect(categorySelect).toHaveAttribute(
      'aria-describedby',
      'create-transaction-category-error',
    )
    expect(typeSelect).toHaveAttribute('aria-invalid', 'true')

    await user.selectOptions(typeSelect, 'income')

    expect(typeSelect).toHaveValue('income')
    expect(screen.queryByText('Bad type.')).not.toBeInTheDocument()
    expect(typeSelect).toHaveAttribute('aria-invalid', 'false')
    expect(
      document.getElementById('create-transaction-type-error'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Bad category.')).not.toBeInTheDocument()
    expect(
      document.getElementById('create-transaction-category-error'),
    ).not.toBeInTheDocument()
    expect(categorySelect).toHaveAttribute('aria-invalid', 'false')
    expect(categorySelect).not.toHaveAttribute('aria-describedby')
    expect(categorySelect).toHaveValue('')
    expect(screen.getByText('Bad amount.')).toBeInTheDocument()
    expect(screen.getByLabelText('Amount')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Check everything.')
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
  })
})

describe('transaction creation pre-create race', () => {
  it('invalidates a pending pre-create GET when creation succeeds so it cannot commit stale rows', async () => {
    let getCalls = 0
    const preCreate = deferred<Response>()
    const createPending = deferred<Response>()
    const refresh = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (url, init) => {
          if ((init?.method ?? 'GET') === 'POST') return createPending.promise
          getCalls += 1
          if (getCalls === 1) return jsonResponse([])
          if (url === '/api/transactions/?transaction_type=expense') {
            if (getCalls === 2) return preCreate.promise
            return refresh.promise
          }
          return jsonResponse([])
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText(/No transactions yet/)

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Transaction type'), 'expense')
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(1),
    )

    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Fresh create',
    })
    await user.click(screen.getByRole('button', { name: 'Create transaction' }))
    expect(
      await screen.findByRole('button', { name: 'Creating transaction…' }),
    ).toBeInTheDocument()

    await act(async () => {
      createPending.resolve(
        jsonResponse(
          transactionFixture({
            id: 60,
            account: 1,
            category: 2,
            transaction_type: 'expense',
            amount: '12.50',
            date: '2026-09-10',
            note: 'Fresh create',
          }),
          201,
        ),
      )
      await Promise.resolve()
      preCreate.resolve(
        jsonResponse([transactionFixture({ id: 61, note: 'Stale result' })]),
      )
    })

    expect(await screen.findByText('Transaction created.')).toBeInTheDocument()
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument()
    expect(screen.queryByText('Fresh create')).not.toBeInTheDocument()

    await act(async () => {
      refresh.resolve(
        jsonResponse([
          transactionFixture({
            id: 60,
            account: 1,
            category: 2,
            transaction_type: 'expense',
            amount: '12.50',
            date: '2026-09-10',
            note: 'Fresh create',
          }),
        ]),
      )
    })
    expect(await screen.findByText('Fresh create')).toBeInTheDocument()
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument()
  })
})

function authenticatedEditHandler(
  options: {
    accounts?: unknown[]
    categories?: unknown[]
    transactions?: (url: string, init?: RequestInit) => Response | Promise<Response>
  } = {},
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url === '/api/accounts/') {
      return jsonResponse(options.accounts ?? defaultAccounts())
    }
    if (url === '/api/categories/') {
      return jsonResponse(options.categories ?? defaultCategories())
    }
    if (url.startsWith('/api/transactions/')) {
      if (options.transactions !== undefined) {
        return options.transactions(url, init)
      }
      return jsonResponse([])
    }
    return jsonResponse({}, 404)
  }
}

function editListHandler(
  rows: unknown[],
  patchImpl?: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return authenticatedEditHandler({
    transactions: (url, init) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        if (patchImpl !== undefined) return patchImpl(url, init)
        const id = Number(url.split('/')[3])
        const body = JSON.parse(String(init?.body))
        const original = (rows as Record<string, unknown>[]).find(
          (item) => item.id === id,
        ) as Record<string, unknown>
        return jsonResponse({ ...original, ...body })
      }
      return jsonResponse(rows)
    },
  })
}

async function openEditorFor(user: ReturnType<typeof userEvent.setup>, index = 0) {
  const edits = await screen.findAllByRole('button', { name: /^Edit/ })
  await user.click(edits[index])
  return edits
}

describe('transaction editing', () => {
  it('shows an Edit action on every row including archived-linked rows; cancel sends no request and restores the row', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        accounts: [
          accountFixture({ id: 1, name: 'Everyday Checking' }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            is_archived: true,
          }),
        ],
        categories: [
          categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
          categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
          categoryFixture({
            id: 3,
            name: 'Old Hobby',
            category_type: 'expense',
            is_archived: true,
          }),
        ],
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 7,
                account: 2,
                category: 3,
                amount: '88.50',
                date: '2026-08-15',
                note: 'Vintage purchase',
              }),
            ])
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Vintage purchase')

    const edits = await screen.findAllByRole('button', { name: /^Edit/ })
    expect(edits).toHaveLength(1)

    const user = userEvent.setup()
    await user.click(edits[0])
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()

    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Changed')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.getByText('Vintage purchase')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('prefills the editor with the exact account, category, type, amount, date, and note', async () => {
    installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)

    expect(screen.getByLabelText('Edit transaction account')).toHaveValue('1')
    expect(screen.getByLabelText('Edit transaction category')).toHaveValue('2')
    expect(screen.getByLabelText('Edit transaction type')).toHaveValue('expense')
    expect(screen.getByLabelText('Edit transaction amount')).toHaveValue('12.50')
    expect(screen.getByLabelText('Edit transaction date')).toHaveValue('2026-09-10')
    expect(screen.getByLabelText('Edit transaction note')).toHaveValue('Groceries')
  })

  it('keeps only one editor open at a time', async () => {
    installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse(serverOrderedTransactions())
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    const edits = await screen.findAllByRole('button', { name: /^Edit/ })
    expect(edits).toHaveLength(3)
    await user.click(edits[0])
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Edit/ })).toHaveLength(2)

    const remaining = screen.getAllByRole('button', { name: /^Edit/ })
    for (const button of remaining) {
      expect(button).toBeDisabled()
    }
    await user.click(remaining[1])
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Edit/ })).toHaveLength(2)
  })

  it('offers active choices plus the current archived account and category as marked historical options', async () => {
    installFetchMock(
      authenticatedEditHandler({
        accounts: [
          accountFixture({ id: 1, name: 'Everyday Checking' }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            is_archived: true,
          }),
        ],
        categories: [
          categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
          categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
          categoryFixture({
            id: 3,
            name: 'Old Hobby',
            category_type: 'expense',
            is_archived: true,
          }),
        ],
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 7,
                account: 2,
                category: 3,
                amount: '88.50',
                date: '2026-08-15',
                note: 'Vintage purchase',
              }),
            ])
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Vintage purchase')

    const user = userEvent.setup()
    await openEditorFor(user, 0)

    const accountOptions = within(
      screen.getByLabelText('Edit transaction account'),
    ).getAllByRole('option')
    expect(accountOptions.map((option) => option.getAttribute('value'))).toEqual([
      '1',
      '2',
    ])
    const archivedAccount = accountOptions.find(
      (option) => option.getAttribute('value') === '2',
    ) as HTMLOptionElement
    expect(archivedAccount.textContent).toMatch(/archived/i)
    expect(screen.getByLabelText('Edit transaction account')).toHaveValue('2')

    const categoryOptions = within(
      screen.getByLabelText('Edit transaction category'),
    ).getAllByRole('option')
    expect(categoryOptions.map((option) => option.getAttribute('value'))).toEqual([
      '',
      '2',
      '3',
    ])
    const archivedCategory = categoryOptions.find(
      (option) => option.getAttribute('value') === '3',
    ) as HTMLOptionElement
    expect(archivedCategory.textContent).toMatch(/archived/i)
    expect(screen.getByLabelText('Edit transaction category')).toHaveValue('3')
  })

  it('sends only the changed note when archived relations are unchanged', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        accounts: [
          accountFixture({ id: 1, name: 'Everyday Checking' }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            is_archived: true,
          }),
        ],
        categories: [
          categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
          categoryFixture({
            id: 3,
            name: 'Old Hobby',
            category_type: 'expense',
            is_archived: true,
          }),
        ],
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 7,
                account: 2,
                category: 3,
                amount: '88.50',
                date: '2026-08-15',
                note: 'Vintage purchase',
              }),
            ])
          }
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 7,
                account: 2,
                category: 3,
                amount: '88.50',
                date: '2026-08-15',
                note: 'Corrected note',
              }),
            )
          }
          return jsonResponse({}, 404)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Vintage purchase')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Corrected note')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(1),
    )
    const [, init] = calls(mock, '/api/transactions/7/', 'PATCH')[0]
    expect(JSON.parse(String(init?.body))).toEqual({ note: 'Corrected note' })
    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
  })

  it('sends exactly the changed writable fields', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    const mock = installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const amountInput = screen.getByLabelText('Edit transaction amount')
    await user.clear(amountInput)
    await user.type(amountInput, '20.00')
    fireEvent.change(screen.getByLabelText('Edit transaction date'), {
      target: { value: '2026-09-11' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1),
    )
    const [, init] = calls(mock, '/api/transactions/1/', 'PATCH')[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      amount: '20.00',
      date: '2026-09-11',
    })
  })

  it('clears an incompatible category on type change and requires an active matching category', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const typeSelect = screen.getByLabelText('Edit transaction type')
    await user.selectOptions(typeSelect, 'income')
    expect(
      screen.getByLabelText('Edit transaction category'),
    ).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(0)

    await user.selectOptions(
      screen.getByLabelText('Edit transaction category'),
      '1',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1),
    )
    const [, init] = calls(mock, '/api/transactions/1/', 'PATCH')[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      transaction_type: 'income',
      category: 1,
    })
  })

  it('blocks client-invalid edits before any network call without float conversion', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const amountInput = screen.getByLabelText('Edit transaction amount')
    await user.clear(amountInput)
    await user.type(amountInput, '0.00')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(amountInput).toHaveValue('0.00')
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('maps backend 400 field errors safely and preserves editor values', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return jsonResponse(
            {
              amount: ['Bad amount.'],
              note: ['Bad note.'],
              non_field_errors: ['Check everything.'],
            },
            400,
          )
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const amountInput = screen.getByLabelText('Edit transaction amount')
    await user.clear(amountInput)
    await user.type(amountInput, '20.00')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Bad amount.')).toBeInTheDocument()
    expect(screen.getByText('Bad note.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Check everything.')
    expect(screen.getByLabelText('Edit transaction amount')).toHaveValue('20.00')
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
    expect(screen.queryByText('Transaction updated.')).not.toBeInTheDocument()
  })

  it('shows a generic alert for unknown-only 400 without exposing contents', async () => {
    installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return jsonResponse({ mystery: ['boom-exposed'] }, 400)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'New note')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(screen.queryByText('boom-exposed')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Edit transaction note')).toHaveValue('New note')
  })

  it.each([
    ['forbidden', 403],
    ['missing', 404],
    ['server error', 500],
  ])('preserves the editor for retry on %s', async (_label, status) => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return jsonResponse({ detail: 'Edit failed.' }, status)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Retry me')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Edit failed.')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    expect(screen.getByLabelText('Edit transaction note')).toHaveValue('Retry me')
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
  })

  it('preserves the editor on network failure', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          throw new TypeError('Failed to fetch')
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Retry me')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server.',
    )
    expect(screen.getByLabelText('Edit transaction note')).toHaveValue('Retry me')
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
  })

  it('disables editor controls, announces updating, and dedups same-tick duplicate PATCH', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return pending.promise
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Pending note')
    const form = screen
      .getByRole('button', { name: 'Save changes' })
      .closest('form') as HTMLFormElement
    await act(async () => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })

    await waitFor(() =>
      expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1),
    )
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Updating transaction…',
    )
    expect(screen.getByLabelText('Edit transaction note')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Updating transaction…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()

    await act(async () => {
      pending.resolve(
        jsonResponse(
          transactionFixture({
            id: 1,
            account: 1,
            category: 2,
            transaction_type: 'expense',
            amount: '12.50',
            date: '2026-09-10',
            note: 'Pending note',
          }),
        ),
      )
    })
    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
  })

  it('replaces only the matching row at the same position without refetching list or metadata', async () => {
    const rows = serverOrderedTransactions()
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse(rows)
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '99.99',
                date: '2026-09-10',
                note: 'Updated row',
              }),
            )
          }
          return jsonResponse({}, 404)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')
    const beforeLists = calls(mock, '/api/transactions/').length
    const beforeAccounts = calls(mock, '/api/accounts/').length
    const beforeCategories = calls(mock, '/api/categories/').length

    const user = userEvent.setup()
    const edits = await screen.findAllByRole('button', { name: /^Edit/ })
    await user.click(edits[1])
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Updated row')
    const amountInput = screen.getByLabelText('Edit transaction amount')
    await user.clear(amountInput)
    await user.type(amountInput, '99.99')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Monthly paycheck')
    expect(items[1]).toHaveTextContent('Updated row')
    expect(items[1]).toHaveTextContent('-$99.99')
    expect(items[2]).toHaveTextContent('Dinner')
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(calls(mock, '/api/transactions/')).toHaveLength(beforeLists)
    expect(calls(mock, '/api/accounts/')).toHaveLength(beforeAccounts)
    expect(calls(mock, '/api/categories/')).toHaveLength(beforeCategories)
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('clears only in-memory session and returns to login on edit 401', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'New note')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('opening an editor does not alter filter state or issue metadata refetches', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse(serverOrderedTransactions())
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Transaction type'), 'expense')
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(1),
    )
    const txCalls = transactionRequests(mock)
    const accountCalls = calls(mock, '/api/accounts/').length
    const categoryCalls = calls(mock, '/api/categories/').length

    const edits = await screen.findAllByRole('button', { name: /^Edit/ })
    await user.click(edits[0])

    expect(screen.getByLabelText('Transaction type')).toHaveValue('expense')
    expect(transactionRequests(mock)).toBe(txCalls)
    expect(calls(mock, '/api/accounts/')).toHaveLength(accountCalls)
    expect(calls(mock, '/api/categories/')).toHaveLength(categoryCalls)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('blocks an archived account that is changed away and restored before any network call', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        accounts: [
          accountFixture({ id: 1, name: 'Everyday Checking' }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            is_archived: true,
          }),
        ],
        categories: [categoryFixture({ id: 2, name: 'Food', category_type: 'expense' })],
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 7,
                account: 2,
                category: 2,
                transaction_type: 'expense',
                amount: '88.50',
                date: '2026-08-15',
                note: 'Vintage purchase',
              }),
            ])
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Vintage purchase')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const accountSelect = screen.getByLabelText('Edit transaction account')
    await user.selectOptions(accountSelect, '1')
    await user.selectOptions(accountSelect, '2')
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Touched note')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(screen.getByText('Choose an active account.')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    expect(screen.getByLabelText('Edit transaction account')).toHaveValue('2')
  })

  it('blocks an archived category that is changed away, type-changed, and restored before any network call', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        accounts: [accountFixture({ id: 1, name: 'Everyday Checking' })],
        categories: [
          categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
          categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
          categoryFixture({
            id: 3,
            name: 'Old Hobby',
            category_type: 'expense',
            is_archived: true,
          }),
        ],
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 7,
                account: 1,
                category: 3,
                transaction_type: 'expense',
                amount: '88.50',
                date: '2026-08-15',
                note: 'Vintage purchase',
              }),
            ])
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Vintage purchase')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    await user.selectOptions(screen.getByLabelText('Edit transaction category'), '2')
    await user.selectOptions(screen.getByLabelText('Edit transaction type'), 'income')
    await user.selectOptions(screen.getByLabelText('Edit transaction type'), 'expense')
    await user.selectOptions(screen.getByLabelText('Edit transaction category'), '3')
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Touched note')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(
      screen.getByText('Choose an active category matching the transaction type.'),
    ).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/7/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    expect(screen.getByLabelText('Edit transaction category')).toHaveValue('3')
  })

  it('blocks a no-op save without any network call and keeps the editor open', async () => {
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Make at least one change',
    )
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()
    expect(screen.getByLabelText('Edit transaction note')).toHaveValue('Groceries')
  })

  it('removes an updated row that no longer matches the active expense filter without refetching', async () => {
    const expenseRow = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 1,
                account: 1,
                category: 1,
                transaction_type: 'income',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            )
          }
          return jsonResponse([expenseRow])
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Transaction type'), 'expense')
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(1),
    )
    expect(await screen.findByText('Groceries')).toBeInTheDocument()
    const filteredLists = calls(
      mock,
      '/api/transactions/?transaction_type=expense',
    ).length
    const unfilteredLists = calls(mock, '/api/transactions/').length
    const accountCalls = calls(mock, '/api/accounts/').length
    const categoryCalls = calls(mock, '/api/categories/').length

    await openEditorFor(user, 0)
    await user.selectOptions(screen.getByLabelText('Edit transaction type'), 'income')
    await user.selectOptions(screen.getByLabelText('Edit transaction category'), '1')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
    expect(
      screen.getByText('No matches for these filters. Try clearing or changing a filter.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Transaction type')).toHaveValue('expense')
    expect(
      calls(mock, '/api/transactions/?transaction_type=expense'),
    ).toHaveLength(filteredLists)
    expect(calls(mock, '/api/transactions/')).toHaveLength(unfilteredLists)
    expect(calls(mock, '/api/accounts/')).toHaveLength(accountCalls)
    expect(calls(mock, '/api/categories/')).toHaveLength(categoryCalls)
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
  })
})

describe('transaction editing independent review defects', () => {
  it('(a) sends the exact account-only patch on active account change', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    const mock = installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    await user.selectOptions(
      screen.getByLabelText('Edit transaction account'),
      '2',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1),
    )
    const [, init] = calls(mock, '/api/transactions/1/', 'PATCH')[0]
    expect(JSON.parse(String(init?.body))).toEqual({ account: 2 })
  })

  it('(b-account) removes an updated row that no longer matches the active account filter', async () => {
    const row = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 1,
                account: 2,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            )
          }
          return jsonResponse([row])
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Account'), '1')
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/?account=1')).toHaveLength(1),
    )
    expect(await screen.findByText('Groceries')).toBeInTheDocument()

    await openEditorFor(user, 0)
    await user.selectOptions(
      screen.getByLabelText('Edit transaction account'),
      '2',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
    expect(
      screen.getByText('No matches for these filters. Try clearing or changing a filter.'),
    ).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
  })

  it('(b-category) removes an updated row that no longer matches the active category filter', async () => {
    const row = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 1,
                account: 1,
                category: 3,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            )
          }
          return jsonResponse([row])
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Category'), '2')
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/?category=2')).toHaveLength(1),
    )
    expect(await screen.findByText('Groceries')).toBeInTheDocument()

    await openEditorFor(user, 0)
    await user.selectOptions(
      screen.getByLabelText('Edit transaction category'),
      '3',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
    expect(
      screen.getByText('No matches for these filters. Try clearing or changing a filter.'),
    ).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
  })

  it('(b-dates) removes an updated row that falls outside the active start/end range', async () => {
    const row = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-08-01',
                note: 'Groceries',
              }),
            )
          }
          return jsonResponse([row])
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-09-01' },
    })
    fireEvent.change(screen.getByLabelText('End date'), {
      target: { value: '2026-09-30' },
    })
    await waitFor(() =>
      expect(
        calls(
          mock,
          '/api/transactions/?start_date=2026-09-01&end_date=2026-09-30',
        ),
      ).toHaveLength(1),
    )
    expect(await screen.findByText('Groceries')).toBeInTheDocument()

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    fireEvent.change(screen.getByLabelText('Edit transaction date'), {
      target: { value: '2026-08-01' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
    expect(
      screen.getByText('No matches for these filters. Try clearing or changing a filter.'),
    ).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
  })

  it('(c) filter change while PATCH pending is impossible; save still applies and unlocks', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    const patchPending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') return patchPending.promise
          return jsonResponse(rows)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Pending raced')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Updating transaction…',
    )
    expect(screen.getByLabelText('Account')).toBeDisabled()
    expect(screen.getByLabelText('Category')).toBeDisabled()
    expect(screen.getByLabelText('Transaction type')).toBeDisabled()
    expect(screen.getByLabelText('Start date')).toBeDisabled()
    expect(screen.getByLabelText('End date')).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeDisabled()

    await act(async () => {
      patchPending.resolve(
        jsonResponse(
          transactionFixture({
            id: 1,
            account: 1,
            category: 2,
            transaction_type: 'expense',
            amount: '12.50',
            date: '2026-09-10',
            note: 'Pending raced',
          }),
        ),
      )
    })

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.getByText('Pending raced')).toBeInTheDocument()
    const editButtons = screen.getAllByRole('button', { name: /^Edit transaction / })
    expect(editButtons).toHaveLength(1)
    for (const button of editButtons) {
      expect(button).toBeEnabled()
    }
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
  })

  it('(d) filter controls stay locked while an editor is open so the typed draft cannot be destroyed', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    const mock = installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Draft keeps me')

    const accountFilter = screen.getByLabelText('Account')
    expect(accountFilter).toBeDisabled()
    await user.selectOptions(accountFilter, '1')

    expect(accountFilter).toHaveValue('')
    expect(
      screen.getByRole('button', { name: 'Save changes' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Edit transaction note')).toHaveValue(
      'Draft keeps me',
    )
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
  })

  it('(e) other rows Edit buttons are disabled while an editor is open and re-enabled after cancel', async () => {
    installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET')
            return jsonResponse(serverOrderedTransactions())
          return jsonResponse(transactionFixture(), 200)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    const edits = await screen.findAllByRole('button', { name: /^Edit/ })
    expect(edits).toHaveLength(3)
    await user.click(edits[0])

    const remaining = screen.getAllByRole('button', { name: /^Edit/ })
    expect(remaining).toHaveLength(2)
    for (const button of remaining) {
      expect(button).toBeDisabled()
    }

    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    const after = await screen.findAllByRole('button', { name: /^Edit/ })
    expect(after).toHaveLength(3)
    for (const button of after) {
      expect(button).toBeEnabled()
    }
  })

  it('(f) updateNotice clears after a filter change', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    const mock = installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Second note')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('Account'), '1')
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/?account=1')).toHaveLength(1),
    )
    await waitFor(() =>
      expect(screen.queryByText('Transaction updated.')).not.toBeInTheDocument(),
    )
  })

  it('(g-open) moves focus into the editor on open', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)

    expect(screen.getByLabelText('Edit transaction account')).toHaveFocus()
  })

  it('(g-save) returns focus to the Edit button after save', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Focused save')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    const editButton = await screen.findByRole('button', {
      name: 'Edit transaction 1',
    })
    expect(editButton).toHaveFocus()
    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
  })

  it('(g-cancel) returns focus to the Edit button after cancel', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    const editButton = await screen.findByRole('button', {
      name: 'Edit transaction 1',
    })
    expect(editButton).toHaveFocus()
  })

  it('(h-six) sends the exact six-field body when every writable field changes', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    const mock = installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    await user.selectOptions(
      screen.getByLabelText('Edit transaction account'),
      '2',
    )
    await user.selectOptions(screen.getByLabelText('Edit transaction type'), 'income')
    await user.selectOptions(
      screen.getByLabelText('Edit transaction category'),
      '1',
    )
    const amountInput = screen.getByLabelText('Edit transaction amount')
    await user.clear(amountInput)
    await user.type(amountInput, '20.00')
    fireEvent.change(screen.getByLabelText('Edit transaction date'), {
      target: { value: '2026-09-11' },
    })
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'New note')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1),
    )
    const [, init] = calls(mock, '/api/transactions/1/', 'PATCH')[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      account: 2,
      category: 1,
      transaction_type: 'income',
      amount: '20.00',
      date: '2026-09-11',
      note: 'New note',
    })
  })

  it('(h-type-category) sends the exact type plus category body', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    const mock = installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    await user.selectOptions(screen.getByLabelText('Edit transaction type'), 'income')
    await user.selectOptions(
      screen.getByLabelText('Edit transaction category'),
      '1',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() =>
      expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1),
    )
    const [, init] = calls(mock, '/api/transactions/1/', 'PATCH')[0]
    expect(JSON.parse(String(init?.body))).toEqual({
      transaction_type: 'income',
      category: 1,
    })
  })

  it('(i) late edit 401 after navigating away stays on accounts without logout or storage writes', async () => {
    const patchPending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            ])
          }
          return patchPending.promise
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Late 401 note')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Updating transaction…',
    )
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1),
    )
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }))
    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/accounts')
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(2)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)

    await act(async () => {
      patchPending.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/accounts')
    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Everyday Checking')).toBeInTheDocument()
    expect(
      await screen.findByRole('navigation', { name: 'Primary' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/accounts/')).toHaveLength(2)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
  })

  it('(swr) keeps ready rows with Updating results while a filter refresh is pending', async () => {
    const refreshPending = deferred<Response>()
    installFetchMock(
      authenticatedTransactionsHandler(
        (url) => {
          if (url === '/api/transactions/?transaction_type=expense') {
            return refreshPending.promise
          }
          return jsonResponse(serverOrderedTransactions())
        },
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByLabelText('Transaction type'),
      'expense',
    )

    expect(await screen.findByText('Updating results…')).toBeInTheDocument()
    expect(screen.queryByText('Loading your transactions…')).not.toBeInTheDocument()
    expect(screen.getByText('Monthly paycheck')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Updating results…')

    await act(async () => {
      refreshPending.resolve(
        jsonResponse([
          transactionFixture({ id: 9, note: 'Filtered result' }),
        ]),
      )
    })
    expect(await screen.findByText('Filtered result')).toBeInTheDocument()
    expect(screen.queryByText('Updating results…')).not.toBeInTheDocument()
  })

  it('(refresh-lock) disables every Edit button while a filter refresh is in flight, then re-enables', async () => {
    const refreshPending = deferred<Response>()
    installFetchMock(
      authenticatedTransactionsHandler(
        (url) => {
          if (url === '/api/transactions/?transaction_type=expense') {
            return refreshPending.promise
          }
          return jsonResponse(serverOrderedTransactions())
        },
        { accounts: defaultAccounts(), categories: defaultCategories() },
      ),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const initialEdits = await screen.findAllByRole('button', {
      name: /^Edit transaction /,
    })
    expect(initialEdits).toHaveLength(3)
    for (const button of initialEdits) {
      expect(button).toBeEnabled()
    }

    const user = userEvent.setup()
    await user.selectOptions(
      screen.getByLabelText('Transaction type'),
      'expense',
    )

    expect(await screen.findByText('Updating results…')).toBeInTheDocument()
    expect(screen.getByText('Monthly paycheck')).toBeInTheDocument()
    const lockedEdits = screen.getAllByRole('button', {
      name: /^Edit transaction /,
    })
    expect(lockedEdits).toHaveLength(3)
    for (const button of lockedEdits) {
      expect(button).toBeDisabled()
    }

    await act(async () => {
      refreshPending.resolve(
        jsonResponse([
          transactionFixture({ id: 9, note: 'Filtered result' }),
        ]),
      )
    })
    expect(await screen.findByText('Filtered result')).toBeInTheDocument()
    expect(screen.queryByText('Updating results…')).not.toBeInTheDocument()
    const unlockedEdits = screen.getAllByRole('button', {
      name: /^Edit transaction /,
    })
    expect(unlockedEdits).toHaveLength(1)
    for (const button of unlockedEdits) {
      expect(button).toBeEnabled()
    }
  })

  it('(create-lock) disables create submit while an editor is open, then re-enables after cancel', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeEnabled()

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      await screen.findByRole('button', { name: 'Edit transaction 1' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeEnabled()
  })

  it('(filters-locked) disables all five filter controls while an editor is open and re-enables after cancel', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)

    expect(screen.getByLabelText('Account')).toBeDisabled()
    expect(screen.getByLabelText('Category')).toBeDisabled()
    expect(screen.getByLabelText('Transaction type')).toBeDisabled()
    expect(screen.getByLabelText('Start date')).toBeDisabled()
    expect(screen.getByLabelText('End date')).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      await screen.findByRole('button', { name: 'Edit transaction 1' }),
    ).toBeInTheDocument()

    expect(screen.getByLabelText('Account')).toBeEnabled()
    expect(screen.getByLabelText('Category')).toBeEnabled()
    expect(screen.getByLabelText('Transaction type')).toBeEnabled()
    expect(screen.getByLabelText('Start date')).toBeEnabled()
    expect(screen.getByLabelText('End date')).toBeEnabled()
  })

  it('(filters-locked-draft) attempting a filter change with an open editor leaves the filter, editor, and draft untouched', async () => {
    const row = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (url, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 1,
                account: 2,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            )
          }
          if (url === '/api/transactions/?account=2') {
            return jsonResponse([])
          }
          return jsonResponse([row])
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Unsaved draft here')

    const accountFilter = screen.getByLabelText('Account')
    await user.selectOptions(accountFilter, '2')

    expect(accountFilter).toHaveValue('')
    expect(
      screen.getByRole('button', { name: 'Save changes' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Edit transaction note')).toHaveValue(
      'Unsaved draft here',
    )
    expect(calls(mock, '/api/transactions/?account=2')).toHaveLength(0)
  })

  it('(filters-locked-hint) renders and links the filters-locked hint while an editor is open', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    expect(
      screen.queryByText('Finish or cancel your edit to change filters.'),
    ).not.toBeInTheDocument()

    const user = userEvent.setup()
    await openEditorFor(user, 0)

    expect(
      screen.getByText('Finish or cancel your edit to change filters.'),
    ).toBeInTheDocument()
    expect(document.querySelector('.transaction-filters')).toHaveAttribute(
      'aria-describedby',
      'transactions-filters-locked-hint',
    )

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      await screen.findByRole('button', { name: 'Edit transaction 1' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Finish or cancel your edit to change filters.'),
    ).not.toBeInTheDocument()
  })

  it('(filters-locked-save) no refresh can start with an editor open; save applies, notices, and refocuses', async () => {
    const row = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 1,
                account: 1,
                category: 2,
                transaction_type: 'expense',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Saved and focused',
              }),
            )
          }
          return jsonResponse([row])
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)

    expect(screen.getByLabelText('Account')).toBeDisabled()
    expect(screen.getByLabelText('Category')).toBeDisabled()
    expect(screen.getByLabelText('Transaction type')).toBeDisabled()
    expect(screen.getByLabelText('Start date')).toBeDisabled()
    expect(screen.getByLabelText('End date')).toBeDisabled()
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)

    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Saved and focused')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.getByText('Saved and focused')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    const editButton = screen.getByRole('button', {
      name: 'Edit transaction 1',
    })
    expect(editButton).toHaveFocus()
    expect(editButton).toBeEnabled()
  })

  it('(create-submit-guard) requestSubmit on the create form with an editor open sends nothing and preserves the draft', async () => {
    const rows = [
      transactionFixture({
        id: 1,
        account: 1,
        category: 2,
        transaction_type: 'expense',
        amount: '12.50',
        date: '2026-09-10',
        note: 'Groceries',
      }),
    ]
    const mock = installFetchMock(editListHandler(rows))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    const noteInput = screen.getByLabelText('Edit transaction note')
    await user.clear(noteInput)
    await user.type(noteInput, 'Draft under edit')

    await fillValidCreateForm(user, {
      account: '1',
      category: '2',
      amount: '20.00',
      date: '2026-09-10',
      note: 'Create attempt',
    })
    expect(
      screen.getByRole('button', { name: 'Create transaction' }),
    ).toBeDisabled()

    const createForm = screen
      .getByRole('button', { name: 'Create transaction' })
      .closest('form') as HTMLFormElement
    await act(async () => {
      createForm.requestSubmit()
    })

    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Save changes' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Edit transaction note')).toHaveValue(
      'Draft under edit',
    )
    expect(screen.queryByText('Transaction created.')).not.toBeInTheDocument()
  })

  it('(focus-heading) save that removes the row from filtered results focuses the Transactions heading', async () => {
    const row = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(
      authenticatedEditHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'PATCH') {
            return jsonResponse(
              transactionFixture({
                id: 1,
                account: 1,
                category: 1,
                transaction_type: 'income',
                amount: '12.50',
                date: '2026-09-10',
                note: 'Groceries',
              }),
            )
          }
          return jsonResponse([row])
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Transaction type'), 'expense')
    await waitFor(() =>
      expect(
        calls(mock, '/api/transactions/?transaction_type=expense'),
      ).toHaveLength(1),
    )
    expect(await screen.findByText('Groceries')).toBeInTheDocument()

    await openEditorFor(user, 0)
    await user.selectOptions(screen.getByLabelText('Edit transaction type'), 'income')
    await user.selectOptions(
      screen.getByLabelText('Edit transaction category'),
      '1',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Transaction updated.')).toBeInTheDocument()
    expect(screen.queryByText('Groceries')).not.toBeInTheDocument()
    expect(
      screen.getByText('No matches for these filters. Try clearing or changing a filter.'),
    ).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'PATCH')).toHaveLength(1)
    const heading = screen.getByRole('heading', { name: 'Transactions' })
    expect(heading).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })
})

function authenticatedDeleteHandler(
  options: {
    accounts?: unknown[]
    categories?: unknown[]
    transactions?: (url: string, init?: RequestInit) => Response | Promise<Response>
  } = {},
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url === '/api/accounts/') {
      return jsonResponse(options.accounts ?? defaultAccounts())
    }
    if (url === '/api/categories/') {
      return jsonResponse(options.categories ?? defaultCategories())
    }
    if (url.startsWith('/api/transactions/')) {
      if (options.transactions !== undefined) {
        return options.transactions(url, init)
      }
      return jsonResponse([])
    }
    return jsonResponse({}, 404)
  }
}

function deleteListHandler(
  rows: unknown[],
  deleteImpl?: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return authenticatedDeleteHandler({
    transactions: (url, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') {
        if (deleteImpl !== undefined) return deleteImpl(url, init)
        return emptyResponse(204)
      }
      return jsonResponse(rows)
    },
  })
}

async function openDeleteFor(user: ReturnType<typeof userEvent.setup>, index = 0) {
  const deletes = await screen.findAllByRole('button', { name: /^Delete transaction \d+/ })
  await user.click(deletes[index])
  return deletes
}

describe('transaction deletion', () => {
  it('shows an accessible Delete control on every row including archived-linked rows', async () => {
    installFetchMock(
      authenticatedDeleteHandler({
        accounts: [
          accountFixture({ id: 1, name: 'Everyday Checking' }),
          accountFixture({
            id: 2,
            name: 'Old Card',
            account_type: 'credit_card',
            is_archived: true,
          }),
        ],
        categories: [
          categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
          categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
          categoryFixture({
            id: 3,
            name: 'Old Hobby',
            category_type: 'expense',
            is_archived: true,
          }),
        ],
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') {
            return jsonResponse([
              transactionFixture({
                id: 7,
                account: 2,
                category: 3,
                amount: '88.50',
                date: '2026-08-15',
                note: 'Vintage purchase',
              }),
            ])
          }
          return emptyResponse(204)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Vintage purchase')

    const deletes = await screen.findAllByRole('button', { name: /^Delete transaction \d+/ })
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toHaveAttribute('aria-label', 'Delete transaction 7')
    expect(deletes[0]).toBeEnabled()
  })

  it('shows a Delete control on every row of a multi-row list', async () => {
    installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const deletes = await screen.findAllByRole('button', { name: /^Delete transaction \d+/ })
    expect(deletes).toHaveLength(3)
    expect(deletes[0]).toHaveAttribute('aria-label', 'Delete transaction 3')
    expect(deletes[1]).toHaveAttribute('aria-label', 'Delete transaction 1')
    expect(deletes[2]).toHaveAttribute('aria-label', 'Delete transaction 2')
  })

  it('opens a two-step confirmation naming date, signed amount, account and category and stating permanence without archiving language', async () => {
    installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 0)

    const confirm = await screen.findByRole('button', { name: 'Delete transaction' })
    expect(confirm).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep transaction' })).toBeInTheDocument()
    const dialog = confirm.closest('li') as HTMLElement
    expect(within(dialog).getByText('2026-09-11')).toBeInTheDocument()
    expect(within(dialog).getByText('+$2,500.00')).toBeInTheDocument()
    expect(within(dialog).getByText('Savings')).toBeInTheDocument()
    expect(within(dialog).getByText('Salary')).toBeInTheDocument()
    expect(within(dialog).getByText(/permanent/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument()
    expect(within(dialog).queryByText(/archiv/i)).not.toBeInTheDocument()
    expect(dialog.textContent).not.toMatch(/recover|restor/i)
    expect(screen.getByRole('button', { name: 'Keep transaction' })).toHaveFocus()
    expect(confirm).not.toHaveFocus()
  })

  it('cancel closes the confirmation, sends no request, and returns focus to the Delete button', async () => {
    const mock = installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    expect(await screen.findByRole('button', { name: 'Delete transaction' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Keep transaction' }))

    expect(screen.queryByRole('button', { name: 'Keep transaction' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete transaction' })).not.toBeInTheDocument()
    expect(await screen.findByText('Monthly paycheck')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    const deleteButton = await screen.findByRole('button', { name: 'Delete transaction 1' })
    expect(deleteButton).toHaveFocus()
  })

  it('confirm sends exactly one DELETE to the transaction detail URL with CSRF', async () => {
    const mock = installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))

    await waitFor(() =>
      expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1),
    )
    const [input, init] = calls(mock, '/api/transactions/1/', 'DELETE')[0]
    expect(String(input)).toBe('/api/transactions/1/')
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
  })

  it('pending announces Deleting transaction…, disables controls, and dedups same-tick double confirm', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedDeleteHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'DELETE') return pending.promise
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    const confirm = await screen.findByRole('button', { name: 'Delete transaction' })
    const form = confirm.closest('li') as HTMLElement
    void form
    await act(async () => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })

    expect(await screen.findByRole('status')).toHaveTextContent('Deleting transaction…')
    expect(screen.getByRole('button', { name: 'Delete transaction' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep transaction' })).toBeDisabled()
    for (const button of screen.getAllByRole('button', { name: /^Edit transaction / })) {
      expect(button).toBeDisabled()
    }
    for (const button of screen.getAllByRole('button', { name: /^Delete transaction \d+/ })) {
      expect(button).toBeDisabled()
    }
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1)

    await act(async () => {
      pending.resolve(emptyResponse(204))
    })
    expect(await screen.findByText('Transaction deleted.')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1)
  })

  it('success removes only that row in place with no refetch, keeps filters, and announces Transaction deleted.', async () => {
    const rows = serverOrderedTransactions()
    const incomeRows = rows.filter(
      (row) => (row as { transaction_type: string }).transaction_type === 'income',
    )
    const mock = installFetchMock(
      authenticatedDeleteHandler({
        transactions: (url, init) => {
          if ((init?.method ?? 'GET') === 'DELETE') return emptyResponse(204)
          if (url === '/api/transactions/?transaction_type=income') {
            return jsonResponse(incomeRows)
          }
          return jsonResponse(rows)
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Transaction type'), 'income')
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/?transaction_type=income')).toHaveLength(1),
    )
    const listsBefore = calls(mock, '/api/transactions/?transaction_type=income').length
    const unfilteredBefore = calls(mock, '/api/transactions/').length
    const accountsBefore = calls(mock, '/api/accounts/').length
    const categoriesBefore = calls(mock, '/api/categories/').length

    await openDeleteFor(user, 0)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))

    expect(await screen.findByText('Transaction deleted.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Transaction deleted.')
    expect(
      screen.getByText('No matches for these filters. Try clearing or changing a filter.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/No transactions yet/)).not.toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    expect(screen.queryByText('Monthly paycheck')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Transaction type')).toHaveValue('income')
    expect(calls(mock, '/api/transactions/?transaction_type=income')).toHaveLength(
      listsBefore,
    )
    expect(calls(mock, '/api/transactions/')).toHaveLength(unfilteredBefore)
    expect(calls(mock, '/api/accounts/')).toHaveLength(accountsBefore)
    expect(calls(mock, '/api/categories/')).toHaveLength(categoriesBefore)
    expect(calls(mock, '/api/transactions/3/', 'DELETE')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('focus moves to the Transactions heading after successful deletion', async () => {
    installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 0)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))

    expect(await screen.findByText('Transaction deleted.')).toBeInTheDocument()
    const heading = screen.getByRole('heading', { name: 'Transactions' })
    expect(heading).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })

  it('delete controls are disabled while an editor is open and edit controls are disabled while a confirmation is open', async () => {
    installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openEditorFor(user, 0)
    for (const button of screen.getAllByRole('button', { name: /^Delete transaction \d+/ })) {
      expect(button).toBeDisabled()
    }
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Monthly paycheck')).toBeInTheDocument()
    for (const button of await screen.findAllByRole('button', { name: /^Delete transaction \d+/ })) {
      expect(button).toBeEnabled()
    }

    await openDeleteFor(user, 0)
    for (const button of screen.getAllByRole('button', { name: /^Edit transaction / })) {
      expect(button).toBeDisabled()
    }
    const otherDeletes = screen.getAllByRole('button', { name: /^Delete transaction \d+/ })
    for (const button of otherDeletes) {
      expect(button).toBeDisabled()
    }
    await user.click(screen.getByRole('button', { name: 'Keep transaction' }))
    for (const button of await screen.findAllByRole('button', { name: /^Edit transaction / })) {
      expect(button).toBeEnabled()
    }
  })

  it('filters are locked while a delete confirmation is open with the visible hint', async () => {
    const mock = installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 0)

    expect(screen.getByLabelText('Account')).toBeDisabled()
    expect(screen.getByLabelText('Category')).toBeDisabled()
    expect(screen.getByLabelText('Transaction type')).toBeDisabled()
    expect(screen.getByLabelText('Start date')).toBeDisabled()
    expect(screen.getByLabelText('End date')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create transaction' })).toBeDisabled()
    expect(screen.getByText(/Finish or cancel your delet/i)).toBeInTheDocument()
    expect(document.querySelector('.transaction-filters')).toHaveAttribute(
      'aria-describedby',
      'transactions-filters-locked-hint',
    )
    const listsBefore = transactionRequests(mock)
    await user.selectOptions(screen.getByLabelText('Account'), '1')
    expect(screen.getByLabelText('Account')).toHaveValue('')
    expect(transactionRequests(mock)).toBe(listsBefore)

    await user.click(screen.getByRole('button', { name: 'Keep transaction' }))
    expect(await screen.findByRole('button', { name: 'Delete transaction 3' })).toBeInTheDocument()
    expect(screen.getByLabelText('Account')).toBeEnabled()
  })

  it.each([
    ['forbidden', 403],
    ['missing', 404],
    ['server error', 500],
  ])('preserves the confirmation and list with a safe alert on delete %s', async (_label, status) => {
    const mock = installFetchMock(
      authenticatedDeleteHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'DELETE') {
            return jsonResponse({ detail: 'Delete failed.' }, status)
          }
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Delete failed.')
    expect(screen.getByRole('button', { name: 'Delete transaction' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Keep transaction' })).toBeEnabled()
    expect(screen.getByText('Monthly paycheck')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0)
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1)
    expect(screen.queryByText('Transaction deleted.')).not.toBeInTheDocument()
  })

  it('preserves the confirmation and list with a safe alert on delete network failure', async () => {
    const mock = installFetchMock(
      authenticatedDeleteHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'DELETE') throw new TypeError('Failed to fetch')
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.')
    expect(screen.getByRole('button', { name: 'Delete transaction' })).toBeEnabled()
    expect(screen.getByText('Monthly paycheck')).toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1)
  })

  it('clears only in-memory session and returns to login on delete 401 without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedDeleteHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'DELETE') {
            return jsonResponse(
              { detail: 'Authentication credentials were not provided.' },
              401,
            )
          }
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  // Once the transactions screen is gone, the absence of a parent callback is
  // the only observable claim left for late success/error: the destination
  // accounts screen must still render correctly with no error escaping.
  it('late delete success after navigating away leaves the accounts screen intact with no escaped update', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedDeleteHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'DELETE') return pending.promise
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Deleting transaction…')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }))
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/accounts')
    expect(screen.queryByRole('heading', { name: 'Transactions' })).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve(emptyResponse(204))
    })

    expect(window.location.pathname).toBe('/accounts')
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Transaction deleted.')).not.toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  // Same observability note as above: with the screen gone, only the intact
  // destination screen and the absence of an escaped error can be observed.
  it('late delete error after navigating away leaves the accounts screen intact with no escaped alert', async () => {
    const pending = deferred<Response>()
    installFetchMock(
      authenticatedDeleteHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'DELETE') return pending.promise
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Deleting transaction…')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }))
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/accounts')

    await act(async () => {
      pending.resolve(jsonResponse({ detail: 'Server exploded.' }, 500))
    })

    expect(window.location.pathname).toBe('/accounts')
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Transaction deleted.')).not.toBeInTheDocument()
  })

  it('late delete 401 after navigating away stays on accounts without logout or storage writes', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedDeleteHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'DELETE') return pending.promise
          return jsonResponse(serverOrderedTransactions())
        },
      }),
    )
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 1)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Deleting transaction…')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }))
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/accounts')

    await act(async () => {
      pending.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/accounts')
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('shows the filtered no-matches empty state after deleting the last matching row', async () => {
    const row = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(deleteListHandler([row]))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await user.selectOptions(screen.getByLabelText('Transaction type'), 'expense')
    await waitFor(() =>
      expect(calls(mock, '/api/transactions/?transaction_type=expense')).toHaveLength(1),
    )
    expect(await screen.findByText('Groceries')).toBeInTheDocument()

    await openDeleteFor(user, 0)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))

    expect(await screen.findByText('Transaction deleted.')).toBeInTheDocument()
    expect(
      screen.getByText('No matches for these filters. Try clearing or changing a filter.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/No transactions yet/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Transaction type')).toHaveValue('expense')
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1)
  })

  it('shows the unfiltered empty state after deleting the last transaction', async () => {
    const row = transactionFixture({
      id: 1,
      account: 1,
      category: 2,
      transaction_type: 'expense',
      amount: '12.50',
      date: '2026-09-10',
      note: 'Groceries',
    })
    const mock = installFetchMock(deleteListHandler([row]))
    renderApp('/transactions')
    await screen.findByText('Groceries')

    const user = userEvent.setup()
    await openDeleteFor(user, 0)
    await user.click(await screen.findByRole('button', { name: 'Delete transaction' }))

    expect(await screen.findByText('Transaction deleted.')).toBeInTheDocument()
    expect(screen.getByText(/No transactions yet/)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    expect(calls(mock, '/api/transactions/1/', 'DELETE')).toHaveLength(1)
  })
})

describe('transaction deletion confirmation safety', () => {
  it('moves focus to the safe Keep action when the confirmation opens', async () => {
    installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 0)

    const keep = await screen.findByRole('button', { name: 'Keep transaction' })
    expect(keep).toHaveFocus()
    expect(
      screen.getByRole('button', { name: 'Delete transaction' }),
    ).not.toHaveFocus()
  })

  it('places the safe action before the destructive action in document order', async () => {
    installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 0)

    const keep = await screen.findByRole('button', { name: 'Keep transaction' })
    const confirm = screen.getByRole('button', { name: 'Delete transaction' })
    expect(
      keep.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('gives the destructive action the distinct destructive class while the safe action stays primary', async () => {
    installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 0)

    const keep = await screen.findByRole('button', { name: 'Keep transaction' })
    const confirm = screen.getByRole('button', { name: 'Delete transaction' })
    expect(confirm.classList.contains('btn-danger')).toBe(true)
    expect(keep.classList.contains('btn')).toBe(true)
    expect(keep.classList.contains('btn-danger')).toBe(false)
  })

  it('labels the confirmation as a group and links the permanence warning to the destructive action', async () => {
    installFetchMock(deleteListHandler(serverOrderedTransactions()))
    renderApp('/transactions')
    await screen.findByText('Monthly paycheck')

    const user = userEvent.setup()
    await openDeleteFor(user, 0)

    const confirm = await screen.findByRole('button', { name: 'Delete transaction' })
    const group = await screen.findByRole('group', { name: /delete transaction 3/i })
    expect(group).toContainElement(confirm)
    expect(within(group).getByText(/permanent/i)).toBeInTheDocument()
    const describedBy = confirm.getAttribute('aria-describedby') ?? ''
    expect(describedBy).not.toBe('')
    const warning = document.getElementById(describedBy)
    expect(warning).not.toBeNull()
    expect(warning).toHaveTextContent(/permanent/i)
    expect(warning).toHaveTextContent(/cannot be undone/i)
  })
})