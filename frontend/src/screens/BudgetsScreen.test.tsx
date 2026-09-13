import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { resetBudgetsRequest } from '../api/budgets'
import { resetCategoriesRequest } from '../api/categories'
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

function budgetFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    category: 2,
    month: '2026-09-01',
    budgeted: '300.00',
    spent: '125.50',
    remaining: '174.50',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    ...overrides,
  }
}

function categoryFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    name: 'Food',
    category_type: 'expense',
    is_archived: false,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    ...overrides,
  }
}

function defaultCategories() {
  return [
    categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
    categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
    categoryFixture({ id: 3, name: 'Transport', category_type: 'expense' }),
  ]
}

function authenticatedBudgetsHandler(
  budgets: (url: string, init?: RequestInit) => Response | Promise<Response>,
  options: { categories?: unknown[] } = {},
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
      return jsonResponse([])
    }
    if (url === '/api/categories/') {
      return jsonResponse(options.categories ?? defaultCategories())
    }
    if (url.startsWith('/api/budgets/')) {
      return budgets(url, init)
    }
    return jsonResponse({}, 404)
  }
}

function serverOrderedBudgets() {
  return [
    budgetFixture({
      id: 30,
      category: 3,
      month: '2026-10-01',
      budgeted: '150.00',
      spent: '20.00',
      remaining: '130.00',
    }),
    budgetFixture({
      id: 10,
      category: 2,
      month: '2026-09-01',
      budgeted: '300.00',
      spent: '325.00',
      remaining: '-25.00',
    }),
    budgetFixture({
      id: 20,
      category: 4,
      month: '2026-08-01',
      budgeted: '9999999999.99',
      spent: '0.00',
      remaining: '9999999999.99',
    }),
  ]
}

function categoriesWithArchived() {
  return [
    categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
    categoryFixture({ id: 2, name: 'Food', category_type: 'expense' }),
    categoryFixture({ id: 3, name: 'Transport', category_type: 'expense' }),
    categoryFixture({
      id: 4,
      name: 'Old Hobby',
      category_type: 'expense',
      is_archived: true,
    }),
  ]
}

async function fillValidCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  overrides: { category?: string; month?: string; budgeted?: string } = {},
) {
  if (overrides.category !== undefined) {
    await user.selectOptions(
      screen.getByLabelText('New budget category'),
      overrides.category,
    )
  }
  if (overrides.month !== undefined) {
    fireEvent.change(screen.getByLabelText('Month'), {
      target: { value: overrides.month },
    })
  }
  if (overrides.budgeted !== undefined) {
    const budgetedInput = screen.getByLabelText('Budgeted amount')
    await user.clear(budgetedInput)
    if (overrides.budgeted !== '') {
      await user.type(budgetedInput, overrides.budgeted)
    }
  }
}

afterEach(() => {
  resetBudgetsRequest()
  resetCategoriesRequest()
})

describe('budgets navigation', () => {
  it('protects /budgets for guests by redirecting to login', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/budgets')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
  })

  it('marks Budgets as the current page immediately after Transactions when authenticated', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([]), {
        categories: defaultCategories(),
      }),
    )
    renderApp('/budgets')

    expect(
      await screen.findByRole('heading', { name: 'Budgets' }),
    ).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const transactionsLink = within(nav).getByRole('link', {
      name: 'Transactions',
    })
    const budgetsLink = within(nav).getByRole('link', { name: 'Budgets' })
    expect(budgetsLink).toHaveAttribute('href', '/budgets')
    expect(budgetsLink).toHaveAttribute('aria-current', 'page')
    expect(transactionsLink).not.toHaveAttribute('aria-current', 'page')
    expect(
      transactionsLink.compareDocumentPosition(budgetsLink) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('budgets list', () => {
  it('renders budgets in server order with friendly month labels, resolved names, and exact money', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(serverOrderedBudgets()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')

    expect(
      await screen.findByRole('heading', { name: 'Budgets' }),
    ).toBeInTheDocument()
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(3)

    expect(within(items[0]).getByText('October 2026')).toBeInTheDocument()
    expect(within(items[0]).getByText('Transport')).toBeInTheDocument()
    expect(within(items[0]).getByText('$150.00')).toBeInTheDocument()
    expect(within(items[0]).getByText('$20.00')).toBeInTheDocument()
    expect(within(items[0]).getByText('$130.00')).toBeInTheDocument()
    expect(
      within(items[0]).getByText('October 2026').closest('time'),
    ).toHaveAttribute('datetime', '2026-10-01')

    expect(within(items[1]).getByText('September 2026')).toBeInTheDocument()
    expect(within(items[1]).getByText('Food')).toBeInTheDocument()
    expect(within(items[1]).getByText('$300.00')).toBeInTheDocument()
    expect(within(items[1]).getByText('$325.00')).toBeInTheDocument()
    expect(within(items[1]).getByText('-$25.00')).toBeInTheDocument()
    expect(within(items[1]).getByText(/overspent/i)).toBeInTheDocument()

    expect(within(items[2]).getByText('August 2026')).toBeInTheDocument()
    expect(within(items[2]).getByText('Old Hobby')).toBeInTheDocument()
    expect(
      within(items[2]).getAllByText('$9,999,999,999.99'),
    ).toHaveLength(2)

    expect(screen.queryByText('30')).not.toBeInTheDocument()
    expect(screen.queryByText('10')).not.toBeInTheDocument()
    expect(screen.queryByText('20')).not.toBeInTheDocument()
  })

  it('marks only a genuinely negative remaining as overspent, not negative zero or positive', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() =>
        jsonResponse([
          budgetFixture({
            id: 41,
            category: 2,
            month: '2026-09-01',
            budgeted: '300.00',
            spent: '300.00',
            remaining: '-0.00',
          }),
          budgetFixture({
            id: 42,
            category: 3,
            month: '2026-09-01',
            budgeted: '300.00',
            spent: '250.00',
            remaining: '50.00',
          }),
          budgetFixture({
            id: 43,
            category: 3,
            month: '2026-08-01',
            budgeted: '300.00',
            spent: '325.00',
            remaining: '-25.00',
          }),
        ]),
      ),
    )
    renderApp('/budgets')

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(3)

    expect(within(items[0]).getByText('$0.00')).toBeInTheDocument()
    expect(within(items[0]).queryByText(/overspent/i)).not.toBeInTheDocument()

    expect(within(items[1]).getByText('$50.00')).toBeInTheDocument()
    expect(within(items[1]).queryByText(/overspent/i)).not.toBeInTheDocument()

    expect(within(items[2]).getByText('-$25.00')).toBeInTheDocument()
    expect(within(items[2]).getByText(/overspent/i)).toBeInTheDocument()
  })

  it('shows an accessible loading status while budgets are pending', async () => {
    const pending = deferred<Response>()
    installFetchMock(
      authenticatedBudgetsHandler(() => pending.promise, {
        categories: defaultCategories(),
      }),
    )
    renderApp('/budgets')

    expect(await screen.findByText('Loading your budgets…')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading your budgets',
    )

    await act(async () => {
      pending.resolve(jsonResponse([]))
    })
    expect(await screen.findByText(/no budgets exist yet/i)).toBeInTheDocument()
  })

  it('shows a retryable error with a working Retry control', async () => {
    let budgetCalls = 0
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => {
        budgetCalls += 1
        if (budgetCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse(serverOrderedBudgets())
      }),
    )
    renderApp('/budgets')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('October 2026')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/budgets/')).toHaveLength(2)
  })

  it('shows an empty state when no budgets exist yet', async () => {
    installFetchMock(authenticatedBudgetsHandler(() => jsonResponse([])))
    renderApp('/budgets')

    expect(await screen.findByText(/no budgets exist yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('refetches category metadata after a metadata failure instead of caching the rejection', async () => {
    let categoriesCalls = 0
    const mock = installFetchMock((url: string) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/categories/') {
        categoriesCalls += 1
        if (categoriesCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse(defaultCategories())
      }
      if (url.startsWith('/api/budgets/')) {
        return jsonResponse([])
      }
      return jsonResponse({}, 404)
    })
    renderApp('/budgets')

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText(/no budgets exist yet/i)).toBeInTheDocument()
    expect(categoriesCalls).toBe(2)
    expect(calls(mock, '/api/budgets/')).toHaveLength(2)
  })

  it('issues exactly one request per endpoint under StrictMode', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([])),
    )
    renderApp('/budgets')

    expect(await screen.findByText(/no budgets exist yet/i)).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
  })

  it('ignores a late list 401 after navigating away so a live observer stays put', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => pending.promise),
    )
    renderApp('/budgets')

    expect(await screen.findByText('Loading your budgets…')).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('link', { name: 'Accounts' }))
    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
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
    expect(
      screen.getByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('clears in-memory auth and redirects to login on list 401 without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )
    renderApp('/budgets')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/budgets/')).toHaveLength(1)
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

describe('budget creation form', () => {
  it('renders an accessible Add budget form above the list offering only active expense categories', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([]), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')

    const heading = await screen.findByRole('heading', { name: 'Add budget' })
    expect(await screen.findByText(/no budgets exist yet/i)).toBeInTheDocument()
    const emptyState = screen.getByText(/no budgets exist yet/i)
    expect(
      heading.compareDocumentPosition(emptyState) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()

    const categorySelect = screen.getByLabelText('New budget category')
    expect(categorySelect).toHaveAttribute('name', 'category')
    expect(categorySelect).toBeRequired()
    const options = within(categorySelect).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual([
      'Select a category',
      'Food',
      'Transport',
    ])

    const monthInput = screen.getByLabelText('Month')
    expect(monthInput).toHaveAttribute('type', 'month')
    expect(monthInput).toHaveAttribute('name', 'month')
    expect(monthInput).toBeRequired()

    const budgetedInput = screen.getByLabelText('Budgeted amount')
    expect(budgetedInput).toHaveAttribute('type', 'text')
    expect(budgetedInput).toHaveAttribute('inputmode', 'decimal')
    expect(budgetedInput).toHaveAttribute('name', 'budgeted')
    expect(budgetedInput).toBeRequired()

    expect(
      screen.getByRole('button', { name: 'Create budget' }),
    ).toBeInTheDocument()
  })

  it('explains the expense-category requirement and disables submit when none exist', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([]), {
        categories: [
          categoryFixture({ id: 1, name: 'Salary', category_type: 'income' }),
        ],
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    expect(
      await screen.findByText(
        'Create an active expense category before adding budgets.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create budget' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Create budget' }))
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('rejects a missing category before any network call and preserves values', async () => {
    const mock = installFetchMock(authenticatedBudgetsHandler(() => jsonResponse([])))
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, { month: '2026-09', budgeted: '300.00' })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    const categorySelect = screen.getByLabelText('New budget category')
    expect(categorySelect).toHaveAttribute('aria-invalid', 'true')
    expect(categorySelect).toHaveAttribute(
      'aria-describedby',
      'create-budget-category-error',
    )
    expect(screen.getByLabelText('Month')).toHaveValue('2026-09')
    expect(screen.getByLabelText('Budgeted amount')).toHaveValue('300.00')
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('rejects an empty month before any network call and preserves values', async () => {
    const mock = installFetchMock(authenticatedBudgetsHandler(() => jsonResponse([])))
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      budgeted: '300.00',
    })
    expect(screen.getByLabelText('Month')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(screen.getByLabelText('Month')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByLabelText('New budget category')).toHaveValue('2')
    expect(screen.getByLabelText('Budgeted amount')).toHaveValue('300.00')
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it.each([
    ['empty', ''],
    ['zero', '0.00'],
    ['double-zero', '00.00'],
    ['negative', '-12.50'],
    ['exponent', '1e3'],
    ['one decimal', '12.5'],
    ['three decimals', '12.345'],
    ['thirteen digits', '12345678901.23'],
    ['leading space', ' 12.50'],
    ['trailing space', '12.50 '],
  ])('rejects an invalid %s budgeted value before any network call', async (_label, budgeted) => {
    const mock = installFetchMock(authenticatedBudgetsHandler(() => jsonResponse([])))
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
    })
    fireEvent.change(screen.getByLabelText('Budgeted amount'), {
      target: { value: budgeted },
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    const budgetedInput = await screen.findByLabelText('Budgeted amount')
    expect(budgetedInput).toHaveAttribute('aria-invalid', 'true')
    expect(budgetedInput).toHaveAttribute(
      'aria-describedby',
      'create-budget-budgeted-error',
    )
    expect(budgetedInput).toHaveValue(budgeted)
    expect(screen.getByLabelText('New budget category')).toHaveValue('2')
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('clears only the edited field error while preserving unrelated errors and values', async () => {
    const mock = installFetchMock(authenticatedBudgetsHandler(() => jsonResponse([])))
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    await userEvent.click(screen.getByRole('button', { name: 'Create budget' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    const categorySelect = screen.getByLabelText('New budget category')
    const monthInput = screen.getByLabelText('Month')
    const budgetedInput = screen.getByLabelText('Budgeted amount')
    expect(categorySelect).toHaveAttribute('aria-invalid', 'true')
    expect(monthInput).toHaveAttribute('aria-invalid', 'true')
    expect(budgetedInput).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(categorySelect, { target: { value: '2' } })
    expect(categorySelect).toHaveAttribute('aria-invalid', 'false')
    expect(categorySelect).toHaveValue('2')
    expect(
      document.getElementById('create-budget-category-error'),
    ).not.toBeInTheDocument()
    expect(monthInput).toHaveAttribute('aria-invalid', 'true')
    expect(budgetedInput).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(0)
  })

  it('submits exactly category, month, and budgeted with CSRF ordering and accepts a 201', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          budgetFixture({
            id: 11,
            category: 2,
            month: '2026-09-01',
            budgeted: '300.00',
            spent: '0.00',
            remaining: '300.00',
          }),
          201,
        )
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByText('Budget created.')).toBeInTheDocument()
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/categories/',
      'GET /api/budgets/',
      'GET /api/auth/csrf/',
      'POST /api/budgets/',
      expect.stringMatching(/^GET \/api\/budgets\/$/),
    ])
    const posts = calls(mock, '/api/budgets/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/budgets/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    const body = JSON.parse(String(init?.body))
    expect(Object.keys(body).sort()).toEqual(
      ['budgeted', 'category', 'month'].sort(),
    )
    expect(body).toEqual({
      category: 2,
      month: '2026-09-01',
      budgeted: '300.00',
    })
  })

  it('announces pending status, disables controls, and prevents a same-tick double submit', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return pending.promise
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    const form = screen
      .getByRole('button', { name: 'Create budget' })
      .closest('form') as HTMLFormElement
    await act(async () => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })

    await waitFor(() =>
      expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1),
    )
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Creating budget…',
    )
    expect(screen.getByLabelText('New budget category')).toBeDisabled()
    expect(screen.getByLabelText('Month')).toBeDisabled()
    expect(screen.getByLabelText('Budgeted amount')).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Creating budget…' }),
    ).toBeDisabled()

    await act(async () => {
      pending.resolve(
        jsonResponse(
          budgetFixture({
            id: 12,
            category: 2,
            month: '2026-09-01',
            budgeted: '300.00',
            spent: '0.00',
            remaining: '300.00',
          }),
          201,
        ),
      )
    })
    expect(await screen.findByText('Budget created.')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
  })

  it('issues a distinct refresh request per create so a stale in-flight refresh cannot overwrite the authoritative list', async () => {
    const firstRefresh = deferred<Response>()
    const secondRefresh = deferred<Response>()
    let getCalls = 0
    let postCalls = 0
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          postCalls += 1
          return jsonResponse(
            budgetFixture({
              id: 40 + postCalls,
              category: 2,
              month: postCalls === 1 ? '2026-09-01' : '2026-10-01',
              budgeted: '10.00',
              spent: '0.00',
              remaining: '10.00',
            }),
            201,
          )
        }
        getCalls += 1
        if (getCalls === 1) return jsonResponse([])
        if (getCalls === 2) return firstRefresh.promise
        return secondRefresh.promise
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '10.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))
    expect(await screen.findByText('Budget created.')).toBeInTheDocument()
    await waitFor(() => expect(calls(mock, '/api/budgets/')).toHaveLength(2))

    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-10',
      budgeted: '10.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))
    await waitFor(() => expect(calls(mock, '/api/budgets/')).toHaveLength(3))
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(2)

    await act(async () => {
      firstRefresh.resolve(
        jsonResponse([
          budgetFixture({
            id: 99,
            category: 2,
            month: '2030-01-01',
            budgeted: '999.99',
            spent: '0.00',
            remaining: '999.99',
          }),
        ]),
      )
    })
    expect(screen.queryByText('January 2030')).not.toBeInTheDocument()
    expect(screen.queryByText('$999.99')).not.toBeInTheDocument()
    expect(screen.getByText(/no budgets exist yet/i)).toBeInTheDocument()

    await act(async () => {
      secondRefresh.resolve(
        jsonResponse([
          budgetFixture({
            id: 41,
            category: 2,
            month: '2026-09-01',
            budgeted: '10.00',
            spent: '0.00',
            remaining: '10.00',
          }),
          budgetFixture({
            id: 42,
            category: 2,
            month: '2026-10-01',
            budgeted: '10.00',
            spent: '0.00',
            remaining: '10.00',
          }),
        ]),
      )
    })

    expect(await screen.findByText('September 2026')).toBeInTheDocument()
    expect(screen.getByText('October 2026')).toBeInTheDocument()
    expect(screen.queryByText('January 2030')).not.toBeInTheDocument()
    expect(screen.queryByText('$999.99')).not.toBeInTheDocument()
    expect(screen.queryByText(/no budgets exist yet/i)).not.toBeInTheDocument()
    expect(calls(mock, '/api/budgets/')).toHaveLength(3)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(2)
  })

  it('clears the created notice when the follow-up refresh fails, and Retry recovers the list', async () => {
    const created = budgetFixture({
      id: 14,
      category: 2,
      month: '2026-09-01',
      budgeted: '300.00',
      spent: '10.00',
      remaining: '290.00',
    })
    const refreshFailure = deferred<Response>()
    let getCalls = 0
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return jsonResponse(created, 201)
        }
        getCalls += 1
        if (getCalls === 1) return jsonResponse([])
        if (getCalls === 2) return refreshFailure.promise
        return jsonResponse([created])
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByText('Budget created.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => {
      refreshFailure.resolve(jsonResponse({ detail: 'Server exploded.' }, 500))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your budget change was saved, but the current budget list could not be refreshed. Try again.',
    )
    expect(screen.queryByText('Server exploded.')).not.toBeInTheDocument()
    expect(screen.queryByText('Budget created.')).not.toBeInTheDocument()
    expect(screen.queryByText('Budget updated.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create budget' })).toBeEnabled()
    expect(calls(mock, '/api/budgets/')).toHaveLength(2)

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('September 2026')).toBeInTheDocument()
    expect(screen.getByText('$290.00')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(calls(mock, '/api/budgets/')).toHaveLength(3)
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
  })
})

describe('budget creation backend errors', () => {
  it('renders backend 400 field errors at their fields and keeps values', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          {
            category: ['Bad category.'],
            month: ['Bad month.'],
            budgeted: ['Bad budgeted.', 'Second budgeted message.'],
            non_field_errors: ['A budget for this month already exists.'],
          },
          400,
        )
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByText('Bad category.')).toBeInTheDocument()
    expect(screen.getByText('Bad month.')).toBeInTheDocument()
    expect(screen.getByText('Bad budgeted.')).toBeInTheDocument()
    expect(screen.getByText('Second budgeted message.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A budget for this month already exists.',
    )
    for (const label of [
      'New budget category',
      'Month',
      'Budgeted amount',
    ]) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        'aria-invalid',
        'true',
      )
    }
    expect(screen.getByLabelText('New budget category')).toHaveValue('2')
    expect(screen.getByLabelText('Month')).toHaveValue('2026-09')
    expect(screen.getByLabelText('Budgeted amount')).toHaveValue('300.00')
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
    expect(screen.queryByText('Budget created.')).not.toBeInTheDocument()
  })

  it('shows a generic alert for unknown-only 400 payloads without exposing contents', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse({ mystery: ['boom-exposed'] }, 400)
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(screen.queryByText('boom-exposed')).not.toBeInTheDocument()
    expect(screen.queryByText('mystery')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Budgeted amount')).toHaveValue('300.00')
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
  })

  it('shows a non-field-only 400 message in the alert with no field errors and no extra request', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          { non_field_errors: ['A budget for this month already exists.'] },
          400,
        )
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A budget for this month already exists.',
    )
    expect(screen.queryByText('Something went wrong.')).not.toBeInTheDocument()
    for (const label of [
      'New budget category',
      'Month',
      'Budgeted amount',
    ]) {
      expect(screen.getByLabelText(label)).toHaveAttribute(
        'aria-invalid',
        'false',
      )
    }
    expect(screen.getByLabelText('New budget category')).toHaveValue('2')
    expect(screen.getByLabelText('Month')).toHaveValue('2026-09')
    expect(screen.getByLabelText('Budgeted amount')).toHaveValue('300.00')
    expect(screen.queryByText('Budget created.')).not.toBeInTheDocument()
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/budgets/')).toHaveLength(1)
  })

  it.each([
    ['forbidden', 403, { detail: 'No permission here.' }, 'No permission here.'],
    ['missing', 404, { detail: 'Not found.' }, 'Not found.'],
    ['server error', 500, { detail: 'Server exploded.' }, 'Server exploded.'],
  ])(
    'shows a safe retryable error and preserves values on %s',
    async (_label, status, body, message) => {
      const mock = installFetchMock(
        authenticatedBudgetsHandler((_url, init) => {
          if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
          return jsonResponse(body, status)
        }),
      )
      renderApp('/budgets')
      await screen.findByText(/no budgets exist yet/i)

      const user = userEvent.setup()
      await fillValidCreateForm(user, {
        category: '2',
        month: '2026-09',
        budgeted: '300.00',
      })
      await user.click(screen.getByRole('button', { name: 'Create budget' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.getByLabelText('New budget category')).toHaveValue('2')
      expect(screen.getByLabelText('Month')).toHaveValue('2026-09')
      expect(screen.getByLabelText('Budgeted amount')).toHaveValue('300.00')
      expect(screen.getByRole('button', { name: 'Create budget' })).toBeEnabled()
      expect(screen.queryByText('Budget created.')).not.toBeInTheDocument()
      expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
    },
  )

  it('shows a safe retryable error and preserves values on a network failure', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        throw new TypeError('Failed to fetch')
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server.',
    )
    expect(screen.getByLabelText('Budgeted amount')).toHaveValue('300.00')
    expect(screen.getByRole('button', { name: 'Create budget' })).toBeEnabled()
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
  })
})

describe('budget creation session expiry', () => {
  it('clears only in-memory session and returns to login on POST 401', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('keeps a live observer on accounts when a late create 401 arrives after navigating away', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return pending.promise
      }),
    )
    renderApp('/budgets')
    await screen.findByText(/no budgets exist yet/i)

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-09',
      budgeted: '300.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Creating budget…',
    )

    await user.click(screen.getByRole('link', { name: 'Accounts' }))
    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
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
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('budget inline editing controls', () => {
  function editList() {
    return [
      budgetFixture({
        id: 10,
        category: 2,
        month: '2026-09-01',
        budgeted: '300.00',
        spent: '125.50',
        remaining: '174.50',
      }),
      budgetFixture({
        id: 20,
        category: 4,
        month: '2026-08-01',
        budgeted: '9999999999.99',
        spent: '0.00',
        remaining: '9999999999.99',
      }),
    ]
  }

  async function openEdit(user: ReturnType<typeof userEvent.setup>, id: number) {
    await user.click(screen.getByRole('button', { name: `Edit budget ${id}` }))
  }

  it('offers an Edit action on every row including archived-linked rows', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(editList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    expect(
      screen.getByRole('button', { name: 'Edit budget 10' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Edit budget 20' }),
    ).toBeInTheDocument()
  })

  it('prefills category, month, and budgeted exactly with active plus current-archived options', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(editList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await openEdit(user, 20)

    expect(screen.getByLabelText('Edit budget category')).toHaveValue('4')
    expect(screen.getByLabelText('Edit budget month')).toHaveValue('2026-08')
    expect(screen.getByLabelText('Edit budget budgeted amount')).toHaveValue(
      '9999999999.99',
    )
    const options = within(
      screen.getByLabelText('Edit budget category'),
    ).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Food',
      'Transport',
      'Old Hobby (archived, current)',
    ])
    expect(
      within(screen.getByLabelText('Edit budget category')).queryByText(
        'Salary',
      ),
    ).not.toBeInTheDocument()
  })

  it('prefills an active row with only active expense options', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(editList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await openEdit(user, 10)

    expect(screen.getByLabelText('Edit budget category')).toHaveValue('2')
    expect(screen.getByLabelText('Edit budget month')).toHaveValue('2026-09')
    expect(screen.getByLabelText('Edit budget budgeted amount')).toHaveValue(
      '300.00',
    )
    const options = within(
      screen.getByLabelText('Edit budget category'),
    ).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'Food',
      'Transport',
    ])
  })

  it('allows only one editor and locks Create with a visible hint', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(editList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await openEdit(user, 10)

    expect(screen.getByLabelText('Edit budget category')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Edit budget 20' }),
    ).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create budget' })).toBeDisabled()
    expect(
      screen.getByText(
        'Finish or cancel your edit before creating another budget.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Edit budget 10' }),
    ).not.toBeInTheDocument()
  })

  it('moves focus into the editor on open and returns focus on cancel with zero requests', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(editList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await openEdit(user, 10)

    const first = screen.getByLabelText('Edit budget category')
    expect(first).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      screen.getByRole('button', { name: 'Edit budget 10' }),
    ).toHaveFocus()
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })
})

describe('budget edit PATCH bodies', () => {
  function singleBudget() {
    return [
      budgetFixture({
        id: 10,
        category: 2,
        month: '2026-09-01',
        budgeted: '300.00',
        spent: '10.00',
        remaining: '290.00',
      }),
    ]
  }

  async function setupEdit(mockHandler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const mock = installFetchMock(mockHandler)
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    return { mock, user }
  }

  function patchCalls(mock: ReturnType<typeof installFetchMock>) {
    return calls(mock, '/api/budgets/10/', 'PATCH')
  }

  it('sends an exact category-only PATCH body', async () => {
    let resolveRefresh!: (v: Response | Promise<Response>) => void
    let getCalls = 0
    const refreshGate = new Promise<Response>((res) => {
      resolveRefresh = res as unknown as (v: Response | Promise<Response>) => void
    })
    const { mock, user } = await setupEdit(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(
            budgetFixture({
              id: 10,
              category: 3,
              month: '2026-09-01',
              budgeted: '300.00',
              spent: '10.00',
              remaining: '290.00',
            }),
          )
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(singleBudget())
          return refreshGate
        }
        if (url === '/api/budgets/') return jsonResponse(singleBudget())
        return jsonResponse({}, 404)
      }, { categories: defaultCategories() }),
    )
    await user.selectOptions(
      screen.getByLabelText('Edit budget category'),
      '3',
    )
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(patchCalls(mock)).toHaveLength(1))
    const [, init] = patchCalls(mock)[0]
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ category: 3 })
    expect(Object.keys(body).sort()).toEqual(['category'])
    expect('spent' in body).toBe(false)
    expect('remaining' in body).toBe(false)
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    const log = requestLog(mock)
    expect(log.indexOf('GET /api/auth/csrf/')).toBeGreaterThanOrEqual(0)
    expect(log.indexOf('GET /api/auth/csrf/')).toBeLessThan(
      log.indexOf('PATCH /api/budgets/10/'),
    )
    await act(async () => {
      resolveRefresh(jsonResponse(singleBudget()))
    })
  })

  it('sends an exact month-only PATCH body as first-of-month', async () => {
    let resolveRefresh!: (v: Response) => void
    let getCalls = 0
    const refreshGate = new Promise<Response>((res) => {
      resolveRefresh = res
    })
    const { mock, user } = await setupEdit(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(
            budgetFixture({ id: 10, month: '2026-10-01' }),
          )
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(singleBudget())
          return refreshGate
        }
        return jsonResponse({}, 404)
      }, { categories: defaultCategories() }),
    )
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(patchCalls(mock)).toHaveLength(1))
    const [, init] = patchCalls(mock)[0]
    expect(JSON.parse(String(init?.body))).toEqual({ month: '2026-10-01' })
    await act(async () => {
      resolveRefresh(jsonResponse(singleBudget()))
    })
  })

  it('sends an exact budgeted-only PATCH body', async () => {
    let resolveRefresh!: (v: Response) => void
    let getCalls = 0
    const refreshGate = new Promise<Response>((res) => {
      resolveRefresh = res
    })
    const { mock, user } = await setupEdit(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(budgetFixture({ id: 10, budgeted: '450.00' }))
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(singleBudget())
          return refreshGate
        }
        return jsonResponse({}, 404)
      }, { categories: defaultCategories() }),
    )
    const input = screen.getByLabelText('Edit budget budgeted amount')
    await user.clear(input)
    await user.type(input, '450.00')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(patchCalls(mock)).toHaveLength(1))
    const [, init] = patchCalls(mock)[0]
    expect(JSON.parse(String(init?.body))).toEqual({ budgeted: '450.00' })
    await act(async () => {
      resolveRefresh(jsonResponse(singleBudget()))
    })
  })

  it('sends an exact all-three PATCH body without spent or remaining', async () => {
    let resolveRefresh!: (v: Response) => void
    let getCalls = 0
    const refreshGate = new Promise<Response>((res) => {
      resolveRefresh = res
    })
    const { mock, user } = await setupEdit(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(
            budgetFixture({
              id: 10,
              category: 3,
              month: '2026-10-01',
              budgeted: '450.00',
            }),
          )
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(singleBudget())
          return refreshGate
        }
        return jsonResponse({}, 404)
      }, { categories: defaultCategories() }),
    )
    await user.selectOptions(
      screen.getByLabelText('Edit budget category'),
      '3',
    )
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    const input = screen.getByLabelText('Edit budget budgeted amount')
    await user.clear(input)
    await user.type(input, '450.00')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(patchCalls(mock)).toHaveLength(1))
    const [, init] = patchCalls(mock)[0]
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({ category: 3, month: '2026-10-01', budgeted: '450.00' })
    expect('spent' in body).toBe(false)
    expect('remaining' in body).toBe(false)
    await act(async () => {
      resolveRefresh(jsonResponse(singleBudget()))
    })
  })

  it('omits an untouched archived category on a budgeted-only PATCH', async () => {
    let resolveRefresh!: (v: Response) => void
    let getCalls = 0
    const refreshGate = new Promise<Response>((res) => {
      resolveRefresh = res
    })
    const archivedList = [
      budgetFixture({
        id: 20,
        category: 4,
        month: '2026-08-01',
        budgeted: '9999999999.99',
        spent: '0.00',
        remaining: '9999999999.99',
      }),
    ]
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/20/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(budgetFixture({ id: 20, category: 4, month: '2026-08-01', budgeted: '100.00' }))
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(archivedList)
          return refreshGate
        }
        return jsonResponse({}, 404)
      }, { categories: categoriesWithArchived() }),
    )
    renderApp('/budgets')
    await screen.findByText('August 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 20' }))
    const input = screen.getByLabelText('Edit budget budgeted amount')
    await user.clear(input)
    await user.type(input, '100.00')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(calls(mock, '/api/budgets/20/', 'PATCH')).toHaveLength(1),
    )
    const [, init] = calls(mock, '/api/budgets/20/', 'PATCH')[0]
    expect(JSON.parse(String(init?.body))).toEqual({ budgeted: '100.00' })
    await act(async () => {
      resolveRefresh(jsonResponse(archivedList))
    })
  })

  it('blocks a changed-away-and-back archived reassignment with zero network', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([
        budgetFixture({ id: 20, category: 4, month: '2026-08-01', budgeted: '9999999999.99' }),
      ]), { categories: categoriesWithArchived() }),
    )
    renderApp('/budgets')
    await screen.findByText('August 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 20' }))
    const select = screen.getByLabelText('Edit budget category')
    await user.selectOptions(select, '2')
    await user.selectOptions(select, '4')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(select).toHaveAttribute('aria-invalid', 'true')
    expect(calls(mock, '/api/budgets/20/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(screen.getByLabelText('Edit budget budgeted amount')).toHaveValue(
      '9999999999.99',
    )
  })

  it('keeps the editor open on a no-op save with zero network', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([
        budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
      ])),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Make at least one change before saving.')).toBeInTheDocument()
    expect(screen.getByLabelText('Edit budget category')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })
})

describe('budget edit validation', () => {
  it.each([
    ['empty month', ''],
    ['bad shape', '2026-13'],
    ['zero year', '0000-01'],
  ])('rejects an invalid %s with zero network and preserved values', async (_label, month) => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([
        budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
      ])),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: month },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText('Edit budget month')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByLabelText('Edit budget budgeted amount')).toHaveValue('300.00')
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it.each([
    ['empty', ''],
    ['zero', '0.00'],
    ['negative', '-12.50'],
    ['one decimal', '12.5'],
    ['three decimals', '12.345'],
    ['thirteen digits', '12345678901.23'],
  ])('rejects an invalid %s budgeted value with zero network', async (_label, budgeted) => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([
        budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
      ])),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget budgeted amount'), {
      target: { value: budgeted },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText('Edit budget budgeted amount')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(screen.getByLabelText('Edit budget budgeted amount')).toHaveValue(budgeted)
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('rejects an empty category with zero network', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse([
        budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
      ])),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget category'), {
      target: { value: '' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText('Edit budget category')).toHaveAttribute(
      'aria-invalid',
      'true',
    )
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })
})

describe('budget edit backend errors', () => {
  function oneBudget() {
    return [budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' })]
  }

  async function openAndSaveInvalid(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
  }

  it('maps backend 400 field errors and preserves values', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(
            {
              category: ['Bad category.'],
              month: ['Bad month.'],
              budgeted: ['Bad budgeted.'],
              non_field_errors: ['A budget for this month already exists.'],
            },
            400,
          )
        }
        return jsonResponse(oneBudget())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    await openAndSaveInvalid(user)

    expect(await screen.findByText('Bad category.')).toBeInTheDocument()
    expect(screen.getByText('Bad month.')).toBeInTheDocument()
    expect(screen.getByText('Bad budgeted.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'A budget for this month already exists.',
    )
    expect(screen.getByLabelText('Edit budget month')).toHaveValue('2026-10')
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(1)
    expect(screen.getByLabelText('Edit budget category')).toBeInTheDocument()
  })

  it('shows a non-field-only duplicate message safely', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(
            { non_field_errors: ['A budget for this month already exists.'] },
            400,
          )
        }
        return jsonResponse(oneBudget())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A budget for this month already exists.',
    )
    expect(screen.getByLabelText('Edit budget category')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(1)
  })

  it('shows the generic message for unknown-only 400 bodies without exposing contents', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse({ mystery: ['boom-exposed'] }, 400)
        }
        return jsonResponse(oneBudget())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(screen.queryByText('boom-exposed')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Edit budget category')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(1)
  })

  it.each([
    ['forbidden', 403, { detail: 'No permission here.' }, 'No permission here.'],
    ['missing', 404, { detail: 'Not found.' }, 'Not found.'],
    ['server error', 500, { detail: 'Server exploded.' }, 'Server exploded.'],
  ])('keeps the editor open for retry on %s', async (_label, status, body, message) => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(body, status)
        }
        return jsonResponse(oneBudget())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByLabelText('Edit budget month')).toHaveValue('2026-10')
    expect(screen.getByLabelText('Edit budget category')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(1)
  })

  it('keeps the editor open on a network failure', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          throw new TypeError('Failed to fetch')
        }
        return jsonResponse(oneBudget())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server.',
    )
    expect(screen.getByLabelText('Edit budget category')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(1)
  })
})

describe('budget edit session and submit guards', () => {
  it('clears only in-memory session and returns to login on PATCH 401', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        }
        return jsonResponse([
          budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
        ])
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('leaves a live observer on Accounts when a late edit 401 arrives after navigating away', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return pending.promise
        }
        if (url.startsWith('/api/budgets/')) {
          return jsonResponse([
            budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
          ])
        }
        if (url === '/api/accounts/') return jsonResponse([])
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }),
    )
    // Prime the accounts route handler through the shared budgets handler path
    void mock
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Updating budget',
    )

    await user.click(screen.getByRole('link', { name: 'Accounts' }))
    expect(
      await screen.findByRole('heading', { name: 'Accounts' }),
    ).toBeInTheDocument()
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
    expect(screen.getByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('produces exactly one PATCH on a same-tick double submit', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return pending.promise
        }
        return jsonResponse([
          budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
        ])
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    await userEvent.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    const form = screen
      .getByRole('button', { name: 'Save changes' })
      .closest('form') as HTMLFormElement
    await act(async () => {
      fireEvent.submit(form)
      fireEvent.submit(form)
    })

    await waitFor(() =>
      expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(1),
    )
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Updating budget',
    )
    await act(async () => {
      pending.resolve(jsonResponse(budgetFixture({ id: 10, month: '2026-10-01' })))
    })
  })
})

describe('budget edit success and refresh', () => {
  it('closes the editor, announces, reorders from the server, uses recomputed values, and refetches budgets only', async () => {
    let getCalls = 0
    const refreshGate = deferred<Response>()
    let refreshed = false
    const initial = [
      budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00', spent: '10.00', remaining: '290.00' }),
      budgetFixture({ id: 30, category: 3, month: '2026-10-01', budgeted: '150.00', spent: '20.00', remaining: '130.00' }),
    ]
    const authoritative = [
      budgetFixture({ id: 30, category: 3, month: '2026-10-01', budgeted: '150.00', spent: '20.00', remaining: '130.00' }),
      budgetFixture({ id: 10, category: 2, month: '2026-11-01', budgeted: '300.00', spent: '99.99', remaining: '200.01' }),
    ]
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          const body = JSON.parse(String(init?.body))
          expect(body).toEqual({ month: '2026-11-01' })
          return jsonResponse(authoritative[1])
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(initial)
          if (!refreshed) {
            refreshed = true
            return refreshGate.promise
          }
          return jsonResponse(authoritative)
        }
        return jsonResponse({}, 404)
      }, { categories: defaultCategories() }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-11' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Updating budgets…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Edit budget category')).not.toBeInTheDocument()
    expect(screen.getByText('Budget updated.')).toBeInTheDocument()

    await act(async () => {
      refreshGate.resolve(jsonResponse(authoritative))
    })

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByText('October 2026')).toBeInTheDocument()
    expect(within(items[1]).getByText('November 2026')).toBeInTheDocument()
    expect(screen.getByText('$200.01')).toBeInTheDocument()
    expect(screen.getByText('$99.99')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/')).toHaveLength(2)
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(1)
  })

  it('drops a stale older list response after a post-update refetch', async () => {
    const firstRefresh = deferred<Response>()
    const secondRefresh = deferred<Response>()
    let getCalls = 0
    let postCalls = 0
    const initial = [
      budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
    ]
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if ((init?.method ?? 'GET') === 'POST' && url === '/api/budgets/') {
          postCalls += 1
          return jsonResponse(budgetFixture({ id: 41, category: 2, month: '2026-10-01', budgeted: '10.00' }), 201)
        }
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(budgetFixture({ id: 10, category: 2, month: '2026-11-01', budgeted: '300.00' }))
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(initial)
          if (getCalls === 2) return firstRefresh.promise
          return secondRefresh.promise
        }
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-11' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Updating budgets…')).toBeInTheDocument()
    await waitFor(() => expect(calls(mock, '/api/budgets/')).toHaveLength(2))

    await fillValidCreateForm(user, { category: '2', month: '2026-10', budgeted: '10.00' })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))
    await waitFor(() => expect(calls(mock, '/api/budgets/')).toHaveLength(3))

    await act(async () => {
      firstRefresh.resolve(
        jsonResponse([budgetFixture({ id: 99, category: 2, month: '2030-01-01', budgeted: '999.99' })]),
      )
    })
    expect(screen.queryByText('January 2030')).not.toBeInTheDocument()

    await act(async () => {
      secondRefresh.resolve(
        jsonResponse([
          budgetFixture({ id: 10, category: 2, month: '2026-11-01', budgeted: '300.00' }),
          budgetFixture({ id: 41, category: 2, month: '2026-10-01', budgeted: '10.00' }),
        ]),
      )
    })
    expect(await screen.findByText('November 2026')).toBeInTheDocument()
    expect(screen.getByText('October 2026')).toBeInTheDocument()
    expect(screen.queryByText('January 2030')).not.toBeInTheDocument()
    expect(postCalls).toBe(1)
  })

  it('clears success when the post-update refresh fails and Retry recovers', async () => {
    let getCalls = 0
    const refreshFailure = deferred<Response>()
    const updated = budgetFixture({ id: 10, category: 2, month: '2026-10-01', budgeted: '300.00', spent: '5.00', remaining: '295.00' })
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(updated)
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) {
            return jsonResponse([budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' })])
          }
          if (getCalls === 2) return refreshFailure.promise
          return jsonResponse([updated])
        }
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Budget updated.')).toBeInTheDocument()

    await act(async () => {
      refreshFailure.resolve(jsonResponse({ detail: 'Server exploded.' }, 500))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your budget change was saved, but the current budget list could not be refreshed. Try again.',
    )
    expect(screen.queryByText('Server exploded.')).not.toBeInTheDocument()
    expect(screen.queryByText('Budget updated.')).not.toBeInTheDocument()
    expect(screen.queryByText('Budget created.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('October 2026')).toBeInTheDocument()
    expect(screen.getByText('$295.00')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/')).toHaveLength(3)
  })

  it('disables every Edit action while the authoritative refresh is pending', async () => {
    const refreshGate = deferred<Response>()
    let getCalls = 0
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(budgetFixture({ id: 10, month: '2026-10-01' }))
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) {
            return jsonResponse([
              budgetFixture({ id: 10, month: '2026-09-01' }),
              budgetFixture({ id: 11, category: 3, month: '2026-09-01' }),
            ])
          }
          return refreshGate.promise
        }
        return jsonResponse({}, 404)
      }),
    )
    void mock
    renderApp('/budgets')
    expect((await screen.findAllByText('September 2026'))).toHaveLength(2)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Updating budgets…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit budget 10' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit budget 11' })).toBeDisabled()

    await act(async () => {
      refreshGate.resolve(
        jsonResponse([
          budgetFixture({ id: 10, month: '2026-10-01' }),
          budgetFixture({ id: 11, category: 3, month: '2026-09-01' }),
        ]),
      )
    })
    expect(await screen.findByText('October 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit budget 10' })).toBeEnabled()
  })

  it('returns focus to the moved row after a reordered refresh', async () => {
    const refreshGate = deferred<Response>()
    let getCalls = 0
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(budgetFixture({ id: 10, month: '2026-11-01' }))
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) {
            return jsonResponse([
              budgetFixture({ id: 10, month: '2026-09-01' }),
              budgetFixture({ id: 30, category: 3, month: '2026-10-01' }),
            ])
          }
          return refreshGate.promise
        }
        return jsonResponse({}, 404)
      }),
    )
    void mock
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-11' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Updating budgets…')

    await act(async () => {
      refreshGate.resolve(
        jsonResponse([
          budgetFixture({ id: 30, category: 3, month: '2026-10-01' }),
          budgetFixture({ id: 10, month: '2026-11-01' }),
        ]),
      )
    })

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit budget 10' })).toHaveFocus(),
    )
  })

  it('focuses the Budgets heading when the refetch omits the updated row', async () => {
    const refreshGate = deferred<Response>()
    let getCalls = 0
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(budgetFixture({ id: 10, month: '2026-10-01' }))
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) {
            return jsonResponse([budgetFixture({ id: 10, month: '2026-09-01' })])
          }
          return refreshGate.promise
        }
        return jsonResponse({}, 404)
      }),
    )
    void mock
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByText('Updating budgets…')

    await act(async () => {
      refreshGate.resolve(jsonResponse([]))
    })

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Budgets' })).toHaveFocus(),
    )
  })
})

describe('budget permanent deletion', () => {
  function deleteList() {
    return [
      budgetFixture({
        id: 10,
        category: 2,
        month: '2026-09-01',
        budgeted: '300.00',
        spent: '125.50',
        remaining: '174.50',
      }),
      budgetFixture({
        id: 20,
        category: 4,
        month: '2026-08-01',
        budgeted: '9999999999.99',
        spent: '0.00',
        remaining: '9999999999.99',
      }),
    ]
  }

  it('offers a Delete control on every row including archived-linked rows with zero network on open', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(deleteList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    expect(
      screen.getByRole('button', { name: 'Delete budget 10' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Delete budget 20' }),
    ).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    expect(
      await screen.findByRole('button', { name: 'Keep budget' }),
    ).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('opens a two-step confirmation naming month, category, and budgeted with permanence and scope', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(deleteList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))

    const confirm = await screen.findByRole('button', {
      name: 'Delete budget',
    })
    expect(confirm).toBeInTheDocument()
    const group = await screen.findByRole('group', {
      name: 'Delete budget 10 confirmation',
    })
    expect(group).toContainElement(confirm)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(within(group).getByText('September 2026')).toBeInTheDocument()
    expect(within(group).getByText('Food')).toBeInTheDocument()
    expect(within(group).getByText('$300.00')).toBeInTheDocument()
    expect(within(group).getByText(/permanent/i)).toBeInTheDocument()
    expect(within(group).getByText(/cannot be undone/i)).toBeInTheDocument()
    const scopeText = (group.textContent ?? '').toLowerCase()
    expect(scopeText).toMatch(/does not delete the category/)
    expect(scopeText).toMatch(/transactions/)
  })

  it('names an archived-category row with its resolved archived name', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(deleteList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('August 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 20' }))

    const group = await screen.findByRole('group', {
      name: 'Delete budget 20 confirmation',
    })
    expect(within(group).getByText('August 2026')).toBeInTheDocument()
    expect(within(group).getByText('Old Hobby')).toBeInTheDocument()
    expect(within(group).getByText('$9,999,999,999.99')).toBeInTheDocument()
  })

  it('moves focus to safe Keep budget and keeps it before destructive Delete budget', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(deleteList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))

    const keep = await screen.findByRole('button', { name: 'Keep budget' })
    const confirm = screen.getByRole('button', { name: 'Delete budget' })
    expect(keep).toHaveFocus()
    expect(confirm).not.toHaveFocus()
    expect(
      keep.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('styles safe primary and destructive outline with permanence aria linkage', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(deleteList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))

    const keep = await screen.findByRole('button', { name: 'Keep budget' })
    const confirm = screen.getByRole('button', { name: 'Delete budget' })
    expect(keep.classList.contains('btn')).toBe(true)
    expect(keep.classList.contains('btn-danger')).toBe(false)
    expect(confirm.classList.contains('btn-danger')).toBe(true)
    const describedBy = confirm.getAttribute('aria-describedby') ?? ''
    expect(describedBy).not.toBe('')
    const warning = document.getElementById(describedBy)
    expect(warning).not.toBeNull()
    expect(warning).toHaveTextContent(/permanent/i)
    expect(warning).toHaveTextContent(/cannot be undone/i)
  })

  it('cancel sends no request and returns focus to that row Delete button', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(deleteList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    expect(
      await screen.findByRole('button', { name: 'Keep budget' }),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Keep budget' }))

    expect(screen.queryByRole('button', { name: 'Keep budget' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete budget' })).not.toBeInTheDocument()
    expect(await screen.findByText('September 2026')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(0)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(
      screen.getByRole('button', { name: 'Delete budget 10' }),
    ).toHaveFocus()
  })

  it('sends exactly one DELETE to the budget detail URL with CSRF ordering and header', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return emptyResponse(204)
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))

    await waitFor(() =>
      expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1),
    )
    const [input, init] = calls(mock, '/api/budgets/10/', 'DELETE')[0]
    expect(String(input)).toBe('/api/budgets/10/')
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    const log = requestLog(mock)
    expect(log.indexOf('GET /api/auth/csrf/')).toBeGreaterThanOrEqual(0)
    expect(log.indexOf('GET /api/auth/csrf/')).toBeLessThan(
      log.indexOf('DELETE /api/budgets/10/'),
    )
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
  })

  it('pending announces Deleting budget, disables confirm and cancel, and dedups same-tick double confirm', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return pending.promise
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    const confirm = await screen.findByRole('button', { name: 'Delete budget' })
    await act(async () => {
      fireEvent.click(confirm)
      fireEvent.click(confirm)
    })

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleting budget…',
    )
    expect(screen.getByRole('button', { name: 'Delete budget' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Keep budget' })).toBeDisabled()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)

    await act(async () => {
      pending.resolve(emptyResponse(204))
    })
    expect(await screen.findByText('Budget deleted.')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
  })

  it('locks edits, other deletes, and create while a delete confirmation is open', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(deleteList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await screen.findByRole('button', { name: 'Keep budget' })

    expect(screen.getByRole('button', { name: 'Edit budget 20' })).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Edit budget 10' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete budget 20' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create budget' })).toBeDisabled()
    expect(
      screen.getByText(/finish or cancel your deletion/i),
    ).toBeInTheDocument()

    const listsBefore = calls(mock, '/api/budgets/').length
    const form = screen
      .getByRole('button', { name: 'Create budget' })
      .closest('form') as HTMLFormElement
    await act(async () => {
      fireEvent.submit(form)
    })
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/budgets/')).toHaveLength(listsBefore)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
  })

  it('disables every Delete control while an editor is open', async () => {
    installFetchMock(
      authenticatedBudgetsHandler(() => jsonResponse(deleteList()), {
        categories: categoriesWithArchived(),
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))

    expect(screen.getByRole('button', { name: 'Delete budget 20' })).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Delete budget 10' }),
    ).not.toBeInTheDocument()
  })

  it('disables all row actions while the authoritative refresh is pending', async () => {
    const refreshGate = deferred<Response>()
    let getCalls = 0
    installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(budgetFixture({ id: 10, month: '2026-10-01' }))
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(deleteList())
          return refreshGate.promise
        }
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Updating budgets…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete budget 10' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete budget 20' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit budget 10' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit budget 20' })).toBeDisabled()

    await act(async () => {
      refreshGate.resolve(jsonResponse(deleteList()))
    })
  })

  it('success removes only the target in place with zero refetch, keeps server order, announces, and focuses heading', async () => {
    const ordered = [
      budgetFixture({
        id: 30,
        category: 3,
        month: '2026-10-01',
        budgeted: '150.00',
        spent: '20.00',
        remaining: '130.00',
      }),
      budgetFixture({
        id: 10,
        category: 2,
        month: '2026-09-01',
        budgeted: '300.00',
        spent: '125.50',
        remaining: '174.50',
      }),
      budgetFixture({
        id: 20,
        category: 4,
        month: '2026-08-01',
        budgeted: '9999999999.99',
        spent: '0.00',
        remaining: '9999999999.99',
      }),
    ]
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return emptyResponse(204)
        }
        return jsonResponse(ordered)
      }, { categories: categoriesWithArchived() }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const listsBefore = calls(mock, '/api/budgets/').length
    const categoriesBefore = calls(mock, '/api/categories/').length

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))

    expect(await screen.findByText('Budget deleted.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Budget deleted.')
    expect(screen.queryByText('September 2026')).not.toBeInTheDocument()
    expect(screen.getByText('October 2026')).toBeInTheDocument()
    expect(screen.getByText('August 2026')).toBeInTheDocument()
    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]).getByText('October 2026')).toBeInTheDocument()
    expect(within(items[1]).getByText('August 2026')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/')).toHaveLength(listsBefore)
    expect(calls(mock, '/api/categories/')).toHaveLength(categoriesBefore)
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Budgets' })).toHaveFocus()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('shows the empty state after deleting the last budget', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return emptyResponse(204)
        }
        return jsonResponse([
          budgetFixture({ id: 10, category: 2, month: '2026-09-01', budgeted: '300.00' }),
        ])
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))

    expect(await screen.findByText('Budget deleted.')).toBeInTheDocument()
    expect(screen.getByText(/no budgets exist yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
  })

  it('clears a stale updated notice when opening a deletion', async () => {
    let getCalls = 0
    let resolveRefresh!: (value: Response) => void
    const refreshGate = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })
    installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'PATCH') {
          return jsonResponse(budgetFixture({ id: 10, month: '2026-10-01' }))
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(deleteList())
          if (getCalls === 2) return refreshGate
          return jsonResponse(deleteList())
        }
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    fireEvent.change(screen.getByLabelText('Edit budget month'), {
      target: { value: '2026-10' },
    })
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Budget updated.')).toBeInTheDocument()
    await act(async () => {
      resolveRefresh(jsonResponse(deleteList()))
    })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Delete budget 10' })).toBeEnabled(),
    )

    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    expect(await screen.findByRole('button', { name: 'Keep budget' })).toBeInTheDocument()
    expect(screen.queryByText('Budget updated.')).not.toBeInTheDocument()
  })

  it.each([
    ['forbidden', 403, { detail: 'No permission here.' }, 'No permission here.'],
    ['missing', 404, { detail: 'Not found.' }, 'Not found.'],
    ['server error', 500, { detail: 'Server exploded.' }, 'Server exploded.'],
  ])('keeps confirmation and list with a safe alert on delete %s', async (_label, status, body, message) => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return jsonResponse(body, status)
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('button', { name: 'Delete budget' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Keep budget' })).toBeEnabled()
    expect(screen.getByText('September 2026')).toBeInTheDocument()
    expect(screen.getByText('August 2026')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
    expect(screen.queryByText('Budget deleted.')).not.toBeInTheDocument()
  })

  it('keeps confirmation and list with a safe alert on delete network failure', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          throw new TypeError('Failed to fetch')
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server.',
    )
    expect(screen.getByRole('button', { name: 'Delete budget' })).toBeEnabled()
    expect(screen.getByText('September 2026')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
  })

  it('clears only in-memory session and returns to login on delete 401 without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  // With the budgets screen gone, only the intact destination screen and the
  // absence of an escaped error can be honestly observed.
  it('late delete success after navigating away leaves accounts intact with no escaped notice', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return pending.promise
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleting budget…',
    )

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    await user.click(within(nav).getByRole('link', { name: 'Accounts' }))
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/accounts')
    expect(screen.queryByRole('heading', { name: 'Budgets' })).not.toBeInTheDocument()

    await act(async () => {
      pending.resolve(emptyResponse(204))
    })

    expect(window.location.pathname).toBe('/accounts')
    expect(await screen.findByRole('heading', { name: 'Accounts' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Budget deleted.')).not.toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  // Same observability note as above: with the screen gone, only the intact
  // destination screen and the absence of an escaped error can be observed.
  it('late delete error after navigating away leaves accounts intact with no escaped alert', async () => {
    const pending = deferred<Response>()
    installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return pending.promise
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleting budget…',
    )

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
    expect(screen.queryByText('Budget deleted.')).not.toBeInTheDocument()
  })

  it('late delete 401 after navigating away stays on accounts without logout or storage writes', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return pending.promise
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleting budget…',
    )

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

  it('disables every row action while a create POST is in flight and re-enables after the refresh settles', async () => {
    const postGate = deferred<Response>()
    const refreshGate = deferred<Response>()
    const created = budgetFixture({
      id: 11,
      category: 2,
      month: '2026-11-01',
      budgeted: '50.00',
      spent: '0.00',
      remaining: '50.00',
    })
    let getCalls = 0
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'POST') {
          return postGate.promise
        }
        if (url === '/api/budgets/' && (init?.method ?? 'GET') === 'GET') {
          getCalls += 1
          if (getCalls === 1) return jsonResponse(deleteList())
          return refreshGate.promise
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await fillValidCreateForm(user, {
      category: '2',
      month: '2026-11',
      budgeted: '50.00',
    })
    await user.click(screen.getByRole('button', { name: 'Create budget' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Creating budget…',
    )
    expect(screen.getByRole('button', { name: 'Edit budget 10' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit budget 20' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Delete budget 10' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Delete budget 20' }),
    ).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Edit budget 10' }))
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    expect(screen.queryByLabelText('Edit budget category')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Keep budget' })).not.toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(0)
    expect(calls(mock, '/api/budgets/20/', 'DELETE')).toHaveLength(0)
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(0)
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)

    await act(async () => {
      postGate.resolve(jsonResponse(created, 201))
    })
    expect(await screen.findByText('Budget created.')).toBeInTheDocument()
    expect(await screen.findByText('Updating budgets…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit budget 10' })).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Delete budget 20' }),
    ).toBeDisabled()

    await act(async () => {
      refreshGate.resolve(jsonResponse([...deleteList(), created]))
    })

    expect(await screen.findByText('November 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit budget 10' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Edit budget 20' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete budget 10' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Delete budget 20' })).toBeEnabled()
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(0)
    expect(calls(mock, '/api/budgets/10/', 'PATCH')).toHaveLength(0)
  })

  it('locks create, other edits, and other deletes while DELETE is pending and recovers controls on retryable error', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedBudgetsHandler((url, init) => {
        if (url === '/api/budgets/10/' && (init?.method ?? 'GET') === 'DELETE') {
          return pending.promise
        }
        return jsonResponse(deleteList())
      }),
    )
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Deleting budget…',
    )

    expect(screen.getByRole('button', { name: 'Create budget' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit budget 20' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete budget 20' })).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Edit budget 10' }),
    ).not.toBeInTheDocument()

    const listsBefore = calls(mock, '/api/budgets/').length
    const form = screen
      .getByRole('button', { name: 'Create budget' })
      .closest('form') as HTMLFormElement
    await act(async () => {
      fireEvent.submit(form)
    })
    expect(calls(mock, '/api/budgets/', 'POST')).toHaveLength(0)
    expect(calls(mock, '/api/budgets/')).toHaveLength(listsBefore)

    await act(async () => {
      pending.resolve(jsonResponse({ detail: 'Server exploded.' }, 500))
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Server exploded.',
    )
    expect(screen.getByRole('button', { name: 'Delete budget' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Keep budget' })).toBeEnabled()
    expect(screen.getByText('September 2026')).toBeInTheDocument()
    expect(screen.getByText('August 2026')).toBeInTheDocument()
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(1)
    expect(calls(mock, '/api/budgets/')).toHaveLength(listsBefore)
    expect(screen.queryByText('Budget deleted.')).not.toBeInTheDocument()
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('keeps confirmation and list with a safe alert when CSRF bootstrap yields no usable token', async () => {
    const mock = installFetchMock((url: string) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/auth/csrf/') {
        return jsonResponse({ detail: 'CSRF cookie set.' })
      }
      if (url === '/api/accounts/') {
        return jsonResponse([])
      }
      if (url === '/api/categories/') {
        return jsonResponse(defaultCategories())
      }
      if (url.startsWith('/api/budgets/')) {
        return jsonResponse(deleteList())
      }
      return jsonResponse({}, 404)
    })
    renderApp('/budgets')
    await screen.findByText('September 2026')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Delete budget 10' }))
    await user.click(await screen.findByRole('button', { name: 'Delete budget' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Missing CSRF token.',
    )
    expect(screen.getByRole('button', { name: 'Delete budget' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Keep budget' })).toBeEnabled()
    expect(screen.getByText('September 2026')).toBeInTheDocument()
    expect(screen.getByText('August 2026')).toBeInTheDocument()
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/budgets/10/', 'DELETE')).toHaveLength(0)
    expect(screen.queryByText('Budget deleted.')).not.toBeInTheDocument()
    expect(
      mock.mock.calls.some(([input]) =>
        String(input).includes('/api/auth/logout/'),
      ),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
