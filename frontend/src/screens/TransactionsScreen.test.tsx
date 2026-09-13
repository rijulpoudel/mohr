import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { resetCategoriesRequest } from '../api/categories'
import { resetTransactionsRequest } from '../api/transactions'
import {
  calls,
  deferred,
  installFetchMock,
  jsonResponse,
  renderApp,
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