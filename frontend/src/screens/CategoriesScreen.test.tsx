import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
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

function authenticatedCategoriesHandler(
  categories: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url === '/api/auth/csrf/') {
      setCsrfCookie()
      return jsonResponse({ detail: 'CSRF cookie set.' })
    }
    if (url.startsWith('/api/categories/')) return categories(url, init)
    return jsonResponse({}, 404)
  }
}

function groupedCategories() {
  return [
    categoryFixture({ id: 1, name: 'Food', category_type: 'expense' }),
    categoryFixture({ id: 2, name: 'Salary', category_type: 'income' }),
    categoryFixture({
      id: 3,
      name: 'Old Hobby',
      category_type: 'expense',
      is_archived: true,
    }),
    categoryFixture({ id: 4, name: 'Rent', category_type: 'expense' }),
  ]
}

function categoryItem(name: string): HTMLElement {
  const item = screen
    .getAllByRole('listitem')
    .find((node) => node.textContent?.includes(name))
  if (item === undefined) throw new Error(`No list item for ${name}`)
  return item
}

async function openRenameEditor(
  user: ReturnType<typeof userEvent.setup>,
  categoryName: string,
) {
  const item = categoryItem(categoryName)
  await user.click(
    within(item).getByRole('button', { name: `Rename ${categoryName}` }),
  )
  return screen.getByRole('form', { name: 'Rename category' })
}

async function openArchiveConfirm(
  user: ReturnType<typeof userEvent.setup>,
  categoryName: string,
) {
  const item = categoryItem(categoryName)
  await user.click(
    within(item).getByRole('button', { name: `Archive ${categoryName}` }),
  )
  return screen.getByRole('group', { name: 'Archive category' })
}

async function fillCreateForm(
  user: ReturnType<typeof userEvent.setup>,
  name = 'Transport',
  categoryType = 'expense',
) {
  await user.type(screen.getByLabelText('Name'), name)
  await user.selectOptions(screen.getByLabelText('Category type'), categoryType)
}

describe('categories navigation', () => {
  it('shows Categories nav after Accounts with current-page state when authenticated', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const accountsLink = within(nav).getByRole('link', { name: 'Accounts' })
    const categoriesLink = within(nav).getByRole('link', { name: 'Categories' })
    expect(categoriesLink).toHaveAttribute('href', '/categories')
    expect(categoriesLink).toHaveAttribute('aria-current', 'page')
    expect(accountsLink).not.toHaveAttribute('aria-current', 'page')
    expect(
      accountsLink.compareDocumentPosition(categoriesLink) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      within(nav).getByRole('link', { name: 'Dashboard' }),
    ).toBeInTheDocument()
  })

  it('keeps the guest shell brand-only without the Categories link', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/login')

    expect(await screen.findByRole('link', { name: 'Mohr' })).toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: 'Categories' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', { name: 'Primary' }),
    ).not.toBeInTheDocument()
  })

  it('protects /categories for guests by redirecting to login', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/me/') return jsonResponse({}, 401)
      return jsonResponse({}, 404)
    })
    renderApp('/categories')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
  })
})

describe('categories list', () => {
  it('renders categories in server order grouped by Active and Archived with counts and friendly labels', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const active = screen.getByRole('region', { name: 'Active (3)' })
    const archived = screen.getByRole('region', { name: 'Archived (1)' })
    const activeItems = within(active).getAllByRole('listitem')
    expect(activeItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Food'),
      expect.stringContaining('Salary'),
      expect.stringContaining('Rent'),
    ])
    const archivedItems = within(archived).getAllByRole('listitem')
    expect(archivedItems).toHaveLength(1)
    expect(archivedItems[0]).toHaveTextContent('Old Hobby')

    const salaryItem = categoryItem('Salary')
    expect(within(salaryItem).getByText('Income')).toBeInTheDocument()
    expect(within(categoryItem('Food')).getByText('Expense')).toBeInTheDocument()
    expect(screen.queryByText('2')).not.toBeInTheDocument()
  })

  it('shows an accessible loading status while categories are pending', async () => {
    const pending = deferred<Response>()
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return pending.promise
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')

    expect(await screen.findByText('Loading your categories…')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Loading your categories',
    )

    await act(async () => {
      pending.resolve(jsonResponse([categoryFixture()]))
    })
    expect(await screen.findByText('Food')).toBeInTheDocument()
  })

  it('shows meaningful empty text without a list', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')

    expect(
      await screen.findByText(/No categories yet/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it('retries a failed request and clears the stale error', async () => {
    let categoryCalls = 0
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        categoryCalls += 1
        if ((init?.method ?? 'GET') !== 'GET') return jsonResponse({}, 404)
        if (categoryCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse([categoryFixture()])
      }),
    )
    renderApp('/categories')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('Food')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('issues exactly one categories request under StrictMode', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')

    await screen.findByRole('heading', { name: 'Active (3)' })
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
  })

  it('ignores a late list 401 after navigating to dashboard', async () => {
    const pending = deferred<Response>()
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
      if (url === '/api/categories/' && (init?.method ?? 'GET') === 'GET') {
        return pending.promise
      }
      return jsonResponse({}, 404)
    })
    renderApp('/categories')

    expect(
      await screen.findByText('Loading your categories…'),
    ).toBeInTheDocument()
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
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })

  it('clears session and redirects to login on a 401 list without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        }
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('never writes auth values to web storage', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')

    await screen.findByRole('heading', { name: 'Active (3)' })
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('category creation form', () => {
  it('renders a form above the list with a name input and type select defaulting to expense', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByText(/No categories yet/)

    expect(
      screen.getByRole('heading', { name: 'Add category' }),
    ).toBeInTheDocument()
    const nameInput = screen.getByLabelText('Name')
    expect(nameInput).toHaveAttribute('type', 'text')
    expect(nameInput).toHaveAttribute('maxlength', '100')
    expect(nameInput).toHaveValue('')
    const typeSelect = screen.getByLabelText('Category type')
    expect(typeSelect).toHaveValue('expense')
    const options = within(typeSelect).getAllByRole('option')
    expect(options.map((option) => option.getAttribute('value'))).toEqual([
      'income',
      'expense',
    ])
    expect(options.map((option) => option.textContent)).toEqual([
      'Income',
      'Expense',
    ])
    expect(
      screen.getByRole('button', { name: 'Create category' }),
    ).toBeInTheDocument()
  })

  it('creates with exact CSRF order and body, appends once, resets, and announces on an empty list', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          categoryFixture({ id: 5, name: 'Transport', category_type: 'expense' }),
          201,
        )
      }),
    )
    renderApp('/categories')
    await screen.findByText(/No categories yet/)

    const user = userEvent.setup()
    await fillCreateForm(user, 'Transport', 'expense')
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByText('Category created.')).toBeInTheDocument()
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/categories/',
      'GET /api/auth/csrf/',
      'POST /api/categories/',
    ])
    const posts = calls(mock, '/api/categories/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/categories/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Transport',
      category_type: 'expense',
    })

    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Category type')).toHaveValue('expense')
    expect(screen.queryByText(/No categories yet/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Active (1)' })).getByText('Transport')).toBeInTheDocument()
    expect(screen.queryByText('5')).not.toBeInTheDocument()
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
  })

  it('appends a created category after existing ones without refetching or reordering', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse([categoryFixture({ id: 1, name: 'Food' })])
        }
        return jsonResponse(
          categoryFixture({ id: 6, name: 'Rent', category_type: 'expense' }),
          201,
        )
      }),
    )
    renderApp('/categories')
    await screen.findByText('Food')

    const user = userEvent.setup()
    await fillCreateForm(user, 'Rent', 'expense')
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    await screen.findByText('Category created.')
    const items = within(screen.getByRole('region', { name: 'Active (2)' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Food'),
      expect.stringContaining('Rent'),
    ])
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)
  })

  it.each([
    ['a blank name', '   ', 'Enter a name for this category.'],
  ])('rejects %s before any network call', async (_label, name, message) => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(categoryFixture(), 201)
      }),
    )
    renderApp('/categories')
    await screen.findByText(/No categories yet/)

    const user = userEvent.setup()
    const nameInput = screen.getByLabelText('Name')
    await user.type(nameInput, name)
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    expect(nameInput).toHaveAttribute(
      'aria-describedby',
      'create-category-name-error',
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(nameInput).toHaveValue(name)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(0)
  })

  it('rejects a 101-character name typed via change events before any network call', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(categoryFixture(), 201)
      }),
    )
    renderApp('/categories')
    await screen.findByText(/No categories yet/)

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'x'.repeat(101) },
    })
    await userEvent.click(screen.getByRole('button', { name: 'Create category' }))

    expect(
      await screen.findByText('Name must be 100 characters or fewer.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(screen.getByLabelText('Name')).toHaveValue('x'.repeat(101))
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(0)
  })

  it('renders backend field errors inline and preserves values', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          { name: ['A category with this name and type already exists.'] },
          400,
        )
      }),
    )
    renderApp('/categories')
    await screen.findByText(/No categories yet/)

    const user = userEvent.setup()
    await fillCreateForm(user, 'Food', 'expense')
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    expect(
      await screen.findByText(
        'A category with this name and type already exists.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(screen.getByLabelText('Name')).toHaveValue('Food')
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)
  })

  it('keeps values and the list on a network failure', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return jsonResponse([categoryFixture({ id: 1, name: 'Food' })])
        }
        throw new TypeError('Failed to fetch')
      }),
    )
    renderApp('/categories')
    await screen.findByText('Food')

    const user = userEvent.setup()
    await fillCreateForm(user, 'Transport', 'expense')
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not reach the server.',
    )
    expect(screen.getByLabelText('Name')).toHaveValue('Transport')
    expect(screen.getByText('Food')).toBeInTheDocument()
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)
  })

  it('is duplicate-safe while pending and disables the form controls', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return pending.promise
      }),
    )
    renderApp('/categories')
    await screen.findByText(/No categories yet/)

    const user = userEvent.setup()
    await fillCreateForm(user)
    const submitButton = screen.getByRole('button', { name: 'Create category' })
    await user.click(submitButton)

    const pendingButton = await screen.findByRole('button', {
      name: 'Creating category…',
    })
    expect(pendingButton).toBeDisabled()
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.getByLabelText('Category type')).toBeDisabled()

    await user.click(pendingButton)
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)

    await act(async () => {
      pending.resolve(
        jsonResponse(
          categoryFixture({ id: 9, name: 'Transport', category_type: 'expense' }),
          201,
        ),
      )
    })
    expect(await screen.findByText('Category created.')).toBeInTheDocument()
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)
  })

  it('clears session and redirects to login on a 401 create without logout or storage', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }),
    )
    renderApp('/categories')
    await screen.findByText(/No categories yet/)

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create category' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

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
      if (url === '/api/categories/') {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse([])
        return pendingCreate.promise
      }
      return jsonResponse({}, 404)
    })
    renderApp('/categories')
    await screen.findByText(/No categories yet/)

    const user = userEvent.setup()
    await fillCreateForm(user)
    await user.click(screen.getByRole('button', { name: 'Create category' }))
    await screen.findByRole('button', { name: 'Creating category…' })
    await waitFor(() =>
      expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1),
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
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })
})

describe('category renaming', () => {
  it('prefills the editor with the exact name and cancel sends nothing and restores the row', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Food')
    const nameInput = within(editor).getByLabelText('Name')
    expect(nameInput).toHaveValue('Food')
    await user.clear(nameInput)
    await user.type(nameInput, 'Groceries')
    await user.click(within(editor).getByRole('button', { name: 'Cancel' }))

    expect(
      screen.queryByRole('form', { name: 'Rename category' }),
    ).not.toBeInTheDocument()
    expect(within(categoryItem('Food')).getByText('Food')).toBeInTheDocument()
    expect(screen.queryByText('Category updated.')).not.toBeInTheDocument()
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/categories/1/', 'PATCH')).toHaveLength(0)
  })

  it('saves only the name via exact CSRF-bootstrapped PATCH and replaces the row in place', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse(
          categoryFixture({ id: 2, name: 'Wages', category_type: 'income' }),
          200,
        )
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Salary')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Wages')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Category updated.')).toBeInTheDocument()
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/categories/',
      'GET /api/auth/csrf/',
      'PATCH /api/categories/2/',
    ])
    const patches = calls(mock, '/api/categories/2/', 'PATCH')
    expect(patches).toHaveLength(1)
    const [input, init] = patches[0]
    expect(String(input)).toBe('/api/categories/2/')
    expect(init?.method).toBe('PATCH')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Wages' })

    expect(
      screen.queryByRole('form', { name: 'Rename category' }),
    ).not.toBeInTheDocument()
    const items = within(screen.getByRole('region', { name: 'Active (3)' })).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Food'),
      expect.stringContaining('Wages'),
      expect.stringContaining('Rent'),
    ])
    expect(within(items[1]).getByText('Income')).toBeInTheDocument()
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
    expect(screen.queryByText('2')).not.toBeInTheDocument()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('renders a duplicate-name backend error inline and preserves values and list', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse(
          { name: ['A category with this name and type already exists.'] },
          400,
        )
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Food')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Salary')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(
      await screen.findByText(
        'A category with this name and type already exists.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Please check the highlighted fields.',
    )
    expect(nameInput).toHaveAttribute('aria-invalid', 'true')
    expect(nameInput).toHaveValue('Salary')
    expect(
      screen.getByRole('form', { name: 'Rename category' }),
    ).toBeInTheDocument()
    expect(within(categoryItem('Rent')).getByText('Rent')).toBeInTheDocument()
    expect(calls(mock, '/api/categories/1/', 'PATCH')).toHaveLength(1)
  })

  it('shows a safe alert for backend non-field errors', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({ non_field_errors: ['Unable to rename category.'] }, 400)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Food')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Groceries')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to rename category.',
    )
    expect(nameInput).toHaveValue('Groceries')
  })

  it('shows a generic safe alert for unknown backend error keys only', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({ server_note: ['unexpected'] }, 400)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Food')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Groceries')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(screen.queryByText('unexpected')).not.toBeInTheDocument()
  })

  it('keeps values and the list on a 500 failure', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return new Response(null, { status: 500 })
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Food')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Groceries')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(nameInput).toHaveValue('Groceries')
    expect(within(categoryItem('Rent')).getByText('Rent')).toBeInTheDocument()
    expect(screen.queryByText('Category updated.')).not.toBeInTheDocument()
    expect(calls(mock, '/api/categories/1/', 'PATCH')).toHaveLength(1)
  })

  it('lets an archived row be renamed', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse(
          categoryFixture({
            id: 3,
            name: 'Old Hobby Renamed',
            category_type: 'expense',
            is_archived: true,
          }),
          200,
        )
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Archived (1)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Old Hobby')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Old Hobby Renamed')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    await screen.findByText('Category updated.')
    const archived = screen.getByRole('region', { name: 'Archived (1)' })
    expect(within(archived).getByText('Old Hobby Renamed')).toBeInTheDocument()
  })

  it('clears session and redirects to login on a 401 rename', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Food')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Groceries')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(
      requestLog(mock).some((entry) => entry.includes('/api/auth/logout/')),
    ).toBe(false)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })

  it('ignores a late rename 401 after navigating to dashboard', async () => {
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
      if (url === '/api/categories/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(groupedCategories())
      }
      if (url === '/api/categories/1/' && init?.method === 'PATCH') {
        return pendingPatch.promise
      }
      return jsonResponse({}, 404)
    })
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const editor = await openRenameEditor(user, 'Food')
    const nameInput = within(editor).getByLabelText('Name')
    await user.clear(nameInput)
    await user.type(nameInput, 'Groceries')
    await user.click(within(editor).getByRole('button', { name: 'Save' }))
    await screen.findByRole('button', { name: 'Saving category…' })
    await waitFor(() =>
      expect(calls(mock, '/api/categories/1/', 'PATCH')).toHaveLength(1),
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
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/1/', 'PATCH')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })
})

describe('category archiving', () => {
  it('shows Archive only on active rows and keeps Rename on archived rows', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    expect(
      within(categoryItem('Food')).getByRole('button', {
        name: 'Archive Food',
      }),
    ).toBeInTheDocument()
    expect(
      within(categoryItem('Old Hobby')).queryByRole('button', {
        name: 'Archive Old Hobby',
      }),
    ).not.toBeInTheDocument()
    expect(
      within(categoryItem('Old Hobby')).getByRole('button', {
        name: 'Rename Old Hobby',
      }),
    ).toBeInTheDocument()
  })

  it('opens a confirmation naming the category and explaining archive semantics; cancel sends nothing', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Food')
    expect(
      within(confirm).getByText('Food will be archived, not deleted.'),
    ).toBeInTheDocument()
    expect(
      within(confirm).getByText('Historical transactions remain available.'),
    ).toBeInTheDocument()
    const confirmButton = within(confirm).getByRole('button', {
      name: 'Confirm archive Food',
    })
    expect(confirmButton).toHaveTextContent('Archive')
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))

    expect(
      screen.queryByRole('group', { name: 'Archive category' }),
    ).not.toBeInTheDocument()
    expect(within(categoryItem('Food')).getByText('Food')).toBeInTheDocument()
    expect(screen.queryByText('Category archived.')).not.toBeInTheDocument()
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(0)
    expect(calls(mock, '/api/categories/1/', 'DELETE')).toHaveLength(0)
  })

  it('sends an exact CSRF-bootstrapped DELETE and flips the row in place on 204', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        if ((init?.method ?? 'GET') === 'DELETE') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Food')
    await user.click(
      within(confirm).getByRole('button', { name: 'Confirm archive Food' }),
    )

    expect(await screen.findByText('Category archived.')).toBeInTheDocument()
    expect(requestLog(mock)).toEqual([
      'GET /api/auth/me/',
      'GET /api/categories/',
      'GET /api/auth/csrf/',
      'DELETE /api/categories/1/',
    ])
    const deletes = calls(mock, '/api/categories/1/', 'DELETE')
    expect(deletes).toHaveLength(1)
    const [input, init] = deletes[0]
    expect(String(input)).toBe('/api/categories/1/')
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe(CSRF_TOKEN)
    expect(init?.body).toBeUndefined()

    const active = screen.getByRole('region', { name: 'Active (2)' })
    const activeItems = within(active).getAllByRole('listitem')
    expect(activeItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Salary'),
      expect.stringContaining('Rent'),
    ])
    const archived = screen.getByRole('region', { name: 'Archived (2)' })
    const archivedItems = within(archived).getAllByRole('listitem')
    expect(archivedItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Food'),
      expect.stringContaining('Old Hobby'),
    ])
    expect(
      within(categoryItem('Food')).getByRole('button', {
        name: 'Rename Food',
      }),
    ).toBeInTheDocument()
    expect(
      within(categoryItem('Food')).queryByRole('button', {
        name: 'Archive Food',
      }),
    ).not.toBeInTheDocument()
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  it('keeps the confirmation and list intact on failures and allows retry then success', async () => {
    let deleteCalls = 0
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        if ((init?.method ?? 'GET') === 'DELETE') {
          deleteCalls += 1
          if (deleteCalls === 1) return new Response(null, { status: 500 })
          return emptyResponse(204)
        }
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Food')
    const confirmButton = within(confirm).getByRole('button', {
      name: 'Confirm archive Food',
    })
    await user.click(confirmButton)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(
      screen.getByRole('group', { name: 'Archive category' }),
    ).toBeInTheDocument()
    expect(confirmButton).not.toBeDisabled()
    expect(within(categoryItem('Rent')).getByText('Rent')).toBeInTheDocument()

    await user.click(confirmButton)
    expect(await screen.findByText('Category archived.')).toBeInTheDocument()
    expect(within(categoryItem('Food')).getByText('Food')).toBeInTheDocument()
    expect(calls(mock, '/api/categories/1/', 'DELETE')).toHaveLength(2)
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
  })

  it('clears session and redirects to login on a 401 archive', async () => {
    const mock = installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        if ((init?.method ?? 'GET') === 'DELETE') {
          return jsonResponse(
            { detail: 'Authentication credentials were not provided.' },
            401,
          )
        }
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Food')
    await user.click(
      within(confirm).getByRole('button', { name: 'Confirm archive Food' }),
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
      if (url === '/api/categories/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(groupedCategories())
      }
      return jsonResponse({}, 404)
    })
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Food')
    await user.click(
      within(confirm).getByRole('button', { name: 'Confirm archive Food' }),
    )

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(calls(mock, '/api/categories/1/', 'DELETE')).toHaveLength(0)
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
      if (url === '/api/categories/' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(groupedCategories())
      }
      if (url === '/api/categories/1/' && init?.method === 'DELETE') {
        return pendingDelete.promise
      }
      return jsonResponse({}, 404)
    })
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    const confirm = await openArchiveConfirm(user, 'Food')
    await user.click(
      within(confirm).getByRole('button', { name: 'Confirm archive Food' }),
    )
    await screen.findByRole('status')
    await waitFor(() =>
      expect(calls(mock, '/api/categories/1/', 'DELETE')).toHaveLength(1),
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
    expect(calls(mock, '/api/categories/', 'GET')).toHaveLength(1)
    expect(calls(mock, '/api/auth/csrf/')).toHaveLength(1)
    expect(calls(mock, '/api/categories/1/', 'DELETE')).toHaveLength(1)
    expect(calls(mock, '/api/dashboard/summary/')).toHaveLength(1)
  })
})

describe('category interaction exclusivity', () => {
  it('opens only one editor or confirmation at a time in both directions', async () => {
    installFetchMock(
      authenticatedCategoriesHandler((_url, init) => {
        if ((init?.method ?? 'GET') === 'GET') return jsonResponse(groupedCategories())
        return jsonResponse({}, 404)
      }),
    )
    renderApp('/categories')
    await screen.findByRole('heading', { name: 'Active (3)' })

    const user = userEvent.setup()
    await openArchiveConfirm(user, 'Food')
    expect(
      screen.getByRole('group', { name: 'Archive category' }),
    ).toBeInTheDocument()

    const editor = await openRenameEditor(user, 'Rent')
    expect(
      screen.queryByRole('group', { name: 'Archive category' }),
    ).not.toBeInTheDocument()
    expect(within(editor).getByLabelText('Name')).toHaveValue('Rent')

    await openArchiveConfirm(user, 'Salary')
    expect(
      screen.queryByRole('form', { name: 'Rename category' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: 'Archive category' }),
    ).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Archive category' })).getByText(
        'Salary will be archived, not deleted.',
      ),
    ).toBeInTheDocument()
  })
})

afterEach(() => {
  resetCategoriesRequest()
})