import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetCategoriesRequest } from '../api/categories'
import { resetTransactionsRequest } from '../api/transactions'
import {
  CSRF_TOKEN,
  calls,
  deferred,
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

  it('ignores a transactions response that settles after unmount', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedTransactionsHandler(() => pending.promise),
    )
    const view = renderApp('/transactions')

    expect(
      await screen.findByText('Loading your transactions…'),
    ).toBeInTheDocument()
    view.unmount()
    await act(async () => {
      pending.resolve(jsonResponse([transactionFixture({ note: 'Late' })]))
    })

    expect(screen.queryByText('Late')).not.toBeInTheDocument()
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
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
    expect(calls(mock, '/api/accounts/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)

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

  it('does nothing visible when a late 401 arrives after unmount', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return pending.promise
        },
      }),
    )
    const view = renderApp('/transactions')
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

    view.unmount()
    await act(async () => {
      pending.resolve(
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      )
    })

    expect(window.location.pathname).toBe('/transactions')
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('ignores a late success after unmount', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return pending.promise
        },
      }),
    )
    const view = renderApp('/transactions')
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

    view.unmount()
    await act(async () => {
      pending.resolve(
        jsonResponse(
          transactionFixture({
            id: 21,
            account: 1,
            category: 2,
            amount: '12.50',
            date: '2026-09-10',
            note: 'Late success',
          }),
          201,
        ),
      )
    })

    expect(screen.queryByText('Transaction created.')).not.toBeInTheDocument()
    expect(screen.queryByText('Late success')).not.toBeInTheDocument()
    expect(calls(mock, '/api/transactions/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/transactions/')).toHaveLength(1)
  })

  it('ignores a late error after unmount', async () => {
    const pending = deferred<Response>()
    installFetchMock(
      authenticatedCreateHandler({
        transactions: (_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return pending.promise
        },
      }),
    )
    const view = renderApp('/transactions')
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

    view.unmount()
    await act(async () => {
      pending.resolve(jsonResponse({ detail: 'Server exploded.' }, 500))
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Transaction created.')).not.toBeInTheDocument()
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