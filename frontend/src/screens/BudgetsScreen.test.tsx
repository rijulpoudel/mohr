import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { resetBudgetsRequest } from '../api/budgets'
import { resetCategoriesRequest } from '../api/categories'
import {
  CSRF_TOKEN,
  calls,
  deferred,
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
      'Server exploded.',
    )
    expect(screen.queryByText('Budget created.')).not.toBeInTheDocument()
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
