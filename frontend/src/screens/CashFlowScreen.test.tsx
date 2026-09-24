import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  calls,
  deferred,
  installFetchMock,
  jsonResponse,
  renderApp,
} from '../test/testUtils'

function categoryFixture(overrides: Record<string, unknown> = {}) {
  return {
    category_id: 1,
    category_name: 'Salary',
    amount: '1500.00',
    transaction_count: 2,
    ...overrides,
  }
}

function cashFlowFixture(overrides: Record<string, unknown> = {}) {
  return {
    month: '2026-09',
    income: '2000.00',
    expenses: '500.00',
    net: '1500.00',
    transaction_count: 8,
    income_categories: [categoryFixture()],
    expense_categories: [
      categoryFixture({
        category_id: 3,
        category_name: 'Groceries',
        amount: '300.00',
        transaction_count: 3,
      }),
      categoryFixture({
        category_id: 4,
        category_name: 'Transport',
        amount: '200.00',
        transaction_count: 2,
      }),
    ],
    ...overrides,
  }
}

function septemberLocalDate() {
  const yearSpy = vi.spyOn(Date.prototype, 'getFullYear').mockReturnValue(2026)
  const monthSpy = vi.spyOn(Date.prototype, 'getMonth').mockReturnValue(8)
  return {
    restore() {
      yearSpy.mockRestore()
      monthSpy.mockRestore()
    },
  }
}

function authenticatedHandler(
  cashFlow: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/me/') {
      return jsonResponse({ id: 1, email: 'student@example.com' })
    }
    if (url.startsWith('/api/cash-flow/summary/')) return cashFlow(url, init)
    return jsonResponse({}, 404)
  }
}

function cashFlowForMonth(payloads: Record<string, unknown>) {
  return (url: string) => {
    const month =
      new URL(url, 'http://localhost').searchParams.get('month') ?? ''
    const payload = payloads[month]
    if (payload === undefined) return jsonResponse({}, 404)
    return jsonResponse(payload)
  }
}

function metricCard(label: string): HTMLElement {
  const term = screen.getByText(label, {
    selector: '.cash-flow-metrics-grid dt',
  })
  const card = term.closest('div')
  if (card === null) throw new Error(`No metric card found for ${label}`)
  return card
}

function metricValue(label: string): string {
  return metricCard(label).textContent ?? ''
}

describe('cash flow navigation', () => {
  it('shows the Cash Flow link directly after Dashboard with aria-current on /cash-flow', async () => {
    installFetchMock(
      authenticatedHandler(() => jsonResponse(cashFlowFixture())),
    )
    renderApp('/cash-flow')

    const nav = await screen.findByRole('navigation', { name: 'Primary' })
    const links = within(nav).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([
      'Dashboard',
      'Cash Flow',
      'Accounts',
      'Connections',
      'Categories',
      'Transactions',
      'Budgets',
    ])
    expect(within(nav).getByRole('link', { name: 'Cash Flow' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(
      within(nav).getByRole('link', { name: 'Dashboard' }),
    ).not.toHaveAttribute('aria-current', 'page')
  })
})

describe('cash flow screen states', () => {
  it('initialises the month control to the client month and shows the period caption beneath the screen title', async () => {
    const spy = septemberLocalDate()
    try {
      const mock = installFetchMock(
        authenticatedHandler(() => jsonResponse(cashFlowFixture())),
      )
      renderApp('/cash-flow')

      const monthInput = await screen.findByLabelText('Month')
      expect(monthInput).toHaveAttribute('type', 'month')
      expect(monthInput).toHaveValue('2026-09')

      const title = await screen.findByRole('heading', {
        level: 2,
        name: 'Cash Flow',
      })
      const caption = screen.getByText('September 2026')
      expect(
        title.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      expect(
        calls(mock, '/api/cash-flow/summary/?month=2026-09'),
      ).toHaveLength(1)
    } finally {
      spy.restore()
    }
  })

  it('renders the three metrics, comparison, categories, note, and ledger link from the payload', async () => {
    installFetchMock(
      authenticatedHandler(() => jsonResponse(cashFlowFixture())),
    )
    renderApp('/cash-flow')

    await screen.findByRole('region', { name: 'Money in vs money out' })
    expect(metricValue('Money in')).toContain('$2,000.00')
    expect(metricValue('Money out')).toContain('$500.00')
    expect(metricValue('Net flow')).toContain('$1,500.00')

    const compare = screen.getByRole('region', { name: 'Money in vs money out' })
    within(compare).getByText('$2,000.00')
    within(compare).getByText('$500.00')
    const fills = compare.querySelectorAll('.cash-flow-compare-fill')
    expect((fills[0] as HTMLElement).style.width).toBe('100%')
    expect((fills[1] as HTMLElement).style.width).toBe('25%')
    expect(fills[0].closest('[aria-hidden="true"]')).not.toBeNull()
    expect(fills[1].closest('[aria-hidden="true"]')).not.toBeNull()

    const incomeRegion = screen.getByRole('region', {
      name: 'Money in by category',
    })
    within(incomeRegion).getByText('Salary')
    within(incomeRegion).getByText('$1,500.00')
    within(incomeRegion).getByText('2 transactions')
    within(incomeRegion).getByText('75% of money in')

    const incomeBars = incomeRegion.querySelectorAll('.cash-flow-category-bar')
    expect(incomeBars).toHaveLength(1)
    expect(incomeBars[0].closest('[aria-hidden="true"]')).not.toBeNull()

    const expenseRegion = screen.getByRole('region', {
      name: 'Money out by category',
    })
    within(expenseRegion).getByText('Groceries')
    within(expenseRegion).getByText('$300.00')
    within(expenseRegion).getByText('Transport')
    within(expenseRegion).getByText('$200.00')
    within(expenseRegion).getByText('3 transactions · 60% of money out')
    within(expenseRegion).getByText('2 transactions · 40% of money out')

    const strip = expenseRegion.querySelector('.cash-flow-composition-strip')
    expect(strip).not.toBeNull()
    expect(strip?.getAttribute('aria-hidden')).toBe('true')
    const segments = expenseRegion.querySelectorAll(
      '.cash-flow-composition-segment',
    )
    expect(segments).toHaveLength(2)
    expect((segments[0] as HTMLElement).style.width).toBe('60%')
    expect((segments[1] as HTMLElement).style.width).toBe('40%')

    expect(
      screen.queryByText(/Only settled transactions count/),
    ).not.toBeInTheDocument()
    const ledger = screen.getByRole('link', { name: 'Open the full ledger' })
    expect(ledger).toHaveAttribute('href', '/transactions')
  })

  it('keeps the settled-only empty state without the verbose exclusion paragraph', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            income: '0.00',
            expenses: '0.00',
            net: '0.00',
            transaction_count: 0,
            income_categories: [],
            expense_categories: [],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    expect(
      await screen.findByText('No settled activity in September 2026 yet.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Pending or still-importing bank transactions/),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Only settled transactions count/)).not.toBeInTheDocument()
  })

  it('renders the exact category order the server returned without re-sorting', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            income_categories: [
              categoryFixture({
                category_id: 2,
                category_name: 'Interest',
                amount: '500.00',
                transaction_count: 1,
              }),
              categoryFixture({ category_id: 1, category_name: 'Salary' }),
            ],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const incomeRegion = await screen.findByRole('region', {
      name: 'Money in by category',
    })
    const names = within(incomeRegion)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(names[0]).toContain('Interest')
    expect(names[1]).toContain('Salary')
  })

  it('marks a negative net with the negative treatment and a positive net with the positive treatment', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            income: '800.00',
            expenses: '1000.00',
            net: '-200.00',
            transaction_count: 5,
            income_categories: [
              categoryFixture({ amount: '800.00', transaction_count: 2 }),
            ],
            expense_categories: [
              categoryFixture({
                category_id: 3,
                category_name: 'Groceries',
                amount: '1000.00',
                transaction_count: 3,
              }),
            ],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    expect(await screen.findByText('-$200.00')).toBeInTheDocument()
    const net = metricCard('Net flow')
    expect(net.querySelector('dd')).toHaveClass(
      'cash-flow-metric-value-negative',
    )
    const income = metricCard('Money in')
    expect(income.querySelector('dd')).toHaveClass(
      'cash-flow-metric-value-positive',
    )
    const moneyOut = metricCard('Money out')
    expect(moneyOut.querySelector('dd')).not.toHaveClass(
      'cash-flow-metric-value-negative',
    )
  })

  it('leaves a zero net neutral without a semantic class', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            income: '0.00',
            expenses: '0.00',
            net: '0.00',
            transaction_count: 0,
            income_categories: [],
            expense_categories: [],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    await screen.findByText('No settled activity in September 2026 yet.')
    const net = metricCard('Net flow')
    expect(net.querySelector('dd')).not.toHaveClass(
      'cash-flow-metric-value-negative',
    )
    expect(net.querySelector('dd')).not.toHaveClass(
      'cash-flow-metric-value-positive',
    )
    expect(net.querySelector('dd')).toHaveTextContent('$0.00')
  })

  it('shows the no-activity state with the empty message and zero metrics', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            income: '0.00',
            expenses: '0.00',
            net: '0.00',
            transaction_count: 0,
            income_categories: [],
            expense_categories: [],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    expect(
      await screen.findByText('No settled activity in September 2026 yet.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Money in')).toBeInTheDocument()
    expect(screen.queryByText('Money in by category')).not.toBeInTheDocument()
  })

  it('shows an income-only month without implying spending', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            income: '1000.00',
            expenses: '0.00',
            net: '1000.00',
            transaction_count: 1,
            income_categories: [
              categoryFixture({ amount: '1000.00', transaction_count: 1 }),
            ],
            expense_categories: [],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    await screen.findByRole('region', { name: 'Money in by category' })
    expect(metricValue('Money out')).toContain('$0.00')
    const expenseRegion = screen.getByRole('region', {
      name: 'Money out by category',
    })
    expect(
      within(expenseRegion).getByText('No spending recorded this month.'),
    ).toBeInTheDocument()
  })

  it('shows an expense-only month without implying income', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            income: '0.00',
            expenses: '250.00',
            net: '-250.00',
            transaction_count: 2,
            income_categories: [],
            expense_categories: [
              categoryFixture({
                category_id: 3,
                category_name: 'Groceries',
                amount: '250.00',
                transaction_count: 2,
              }),
            ],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    await screen.findByRole('region', { name: 'Money out by category' })
    expect(metricValue('Money in')).toContain('$0.00')
    const incomeRegion = screen.getByRole('region', {
      name: 'Money in by category',
    })
    expect(
      within(incomeRegion).getByText('No income recorded this month.'),
    ).toBeInTheDocument()
  })

  it('shows an accessible loading status while the summary is pending', async () => {
    const pending = deferred<Response>()
    installFetchMock(authenticatedHandler(() => pending.promise))
    renderApp('/cash-flow')

    expect(await screen.findByText('Loading cash flow…')).toBeInTheDocument()
    expect(screen.getByText('Loading cash flow…').closest('[role="status"]')).not.toBeNull()

    await act(async () => {
      pending.resolve(jsonResponse(cashFlowFixture()))
    })
    await screen.findByRole('region', { name: 'Money in vs money out' })
    expect(screen.queryByText('Loading cash flow…')).not.toBeInTheDocument()
  })

  it('shows an API error with a Retry control that refetches and renders', async () => {
    let cashFlowCalls = 0
    const mock = installFetchMock(
      authenticatedHandler(() => {
        cashFlowCalls += 1
        if (cashFlowCalls === 1) return new Response(null, { status: 500 })
        return jsonResponse(cashFlowFixture())
      }),
    )
    renderApp('/cash-flow')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(
      screen.getByRole('button', { name: 'Retry' }),
    ).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    await screen.findByRole('region', { name: 'Money in vs money out' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-09'),
    ).toHaveLength(2)
  })

  it('clears the session on a 401 and redirects to login without storage writes', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      ),
    )
    renderApp('/cash-flow')

    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-09'),
    ).toHaveLength(1)
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('cash flow money-out composition', () => {
  it('renders two ordinary expense categories as a keyed strip and legend with exact amounts and shares', async () => {
    installFetchMock(
      authenticatedHandler(() => jsonResponse(cashFlowFixture())),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    const segments = expenseRegion.querySelectorAll(
      '.cash-flow-composition-segment',
    )
    expect(segments).toHaveLength(2)
    expect(segments[0]).toHaveClass('cash-flow-seg-0')
    expect(segments[1]).toHaveClass('cash-flow-seg-1')
    expect((segments[0] as HTMLElement).style.width).toBe('60%')
    expect((segments[1] as HTMLElement).style.width).toBe('40%')

    const items = within(expenseRegion).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Groceries')
    expect(items[0]).toHaveTextContent('$300.00')
    expect(items[0]).toHaveTextContent('60% of money out')
    expect(items[1]).toHaveTextContent('Transport')
    expect(items[1]).toHaveTextContent('$200.00')
    expect(items[1]).toHaveTextContent('40% of money out')
    expect(expenseRegion.querySelectorAll('.cash-flow-composition-swatch')).toHaveLength(2)
    expect(within(expenseRegion).getByText('$500.00')).toBeInTheDocument()
  })

  it('bounds more than five expense categories into four keyed segments plus a truthful Other aggregate', async () => {
    const amounts = ['700.00', '600.00', '500.00', '400.00', '300.00', '200.00', '150.00']
    const names = [
      'Rent',
      'Groceries',
      'Transport',
      'Utilities',
      'Dining',
      'Coffee',
      'Books',
    ]
    const expenseCategories = amounts.map((amount, index) =>
      categoryFixture({
        category_id: 10 + index,
        category_name: names[index],
        amount,
        transaction_count: index + 1,
      }),
    )
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            expenses: '2850.00',
            net: '-850.00',
            expense_categories: expenseCategories,
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    const segments = expenseRegion.querySelectorAll(
      '.cash-flow-composition-segment',
    )
    expect(segments).toHaveLength(5)

    const items = within(expenseRegion).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items[0]).toHaveTextContent('Rent')
    expect(items[1]).toHaveTextContent('Groceries')
    expect(items[2]).toHaveTextContent('Transport')
    expect(items[3]).toHaveTextContent('Utilities')
    expect(items[4]).toHaveTextContent('Other (3)')
    expect(items[4]).toHaveTextContent('$650.00')
    expect(
      expenseRegion.querySelectorAll('.cash-flow-composition-swatch'),
    ).toHaveLength(5)
    expect(within(expenseRegion).queryByText('Dining')).not.toBeInTheDocument()
    expect(within(expenseRegion).queryByText('Coffee')).not.toBeInTheDocument()
    expect(within(expenseRegion).queryByText('Books')).not.toBeInTheDocument()
    expect(within(expenseRegion).getByText('$2,850.00')).toBeInTheDocument()

    const widths = Array.from(segments).map((segment) =>
      Number.parseFloat((segment as HTMLElement).style.width),
    )
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 1)
  })

  it('keeps a tiny positive category visible and labelled below one percent without inflating it', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            expenses: '100000.01',
            net: '-98000.01',
            expense_categories: [
              categoryFixture({
                category_id: 3,
                category_name: 'Rent',
                amount: '100000.00',
                transaction_count: 1,
              }),
              categoryFixture({
                category_id: 4,
                category_name: 'Gum',
                amount: '0.01',
                transaction_count: 1,
              }),
            ],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    within(expenseRegion).getByText('<1% of money out', { exact: false })
    within(expenseRegion).getByText('>99% of money out', { exact: false })
    const segments = expenseRegion.querySelectorAll(
      '.cash-flow-composition-segment',
    )
    expect((segments[1] as HTMLElement).style.width).toBe('0%')
    expect(segments[1]).toHaveClass('cash-flow-composition-segment-positive')
    expect(
      Number.parseFloat((segments[0] as HTMLElement).style.width),
    ).toBeCloseTo(100, 3)
    within(expenseRegion).getByText('$0.01')
  })

  it('renders a zero-value category at 0% without a positive sliver', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            income: '10.00',
            expenses: '0.00',
            net: '10.00',
            transaction_count: 1,
            income_categories: [
              categoryFixture({ amount: '10.00', transaction_count: 1 }),
            ],
            expense_categories: [
              categoryFixture({
                category_id: 3,
                category_name: 'Refunded',
                amount: '0.00',
                transaction_count: 1,
              }),
            ],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    const segments = expenseRegion.querySelectorAll(
      '.cash-flow-composition-segment',
    )
    expect(segments).toHaveLength(1)
    expect((segments[0] as HTMLElement).style.width).toBe('0%')
    expect(segments[0]).not.toHaveClass(
      'cash-flow-composition-segment-positive',
    )
    expect(
      within(expenseRegion).getByText('0% of money out', { exact: false }),
    ).toBeInTheDocument()
  })

  it('renders a long expense category label without hiding it or its exact amount', async () => {
    const longName = 'A very long household category name that keeps going for a while'
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            expenses: '10.00',
            net: '1990.00',
            expense_categories: [
              categoryFixture({
                category_id: 9,
                category_name: longName,
                amount: '10.00',
                transaction_count: 1,
              }),
            ],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    expect(within(expenseRegion).getByText(longName)).toBeInTheDocument()
    const items = within(expenseRegion).getAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent('$10.00')
    expect(items[0]).toHaveTextContent('100% of money out')
  })

  it('uses the overall expense total, not the category sum, as the displayed Total and denominator', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            expenses: '600.00',
            net: '1400.00',
            expense_categories: [
              categoryFixture({
                category_id: 3,
                category_name: 'Groceries',
                amount: '300.00',
                transaction_count: 3,
              }),
              categoryFixture({
                category_id: 4,
                category_name: 'Transport',
                amount: '200.00',
                transaction_count: 2,
              }),
            ],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    expect(within(expenseRegion).getByText('$600.00')).toBeInTheDocument()
    expect(within(expenseRegion).queryByText('$500.00')).not.toBeInTheDocument()

    const items = within(expenseRegion).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('50% of money out')
    expect(items[1]).toHaveTextContent('33% of money out')

    const segments = expenseRegion.querySelectorAll(
      '.cash-flow-composition-segment',
    )
    expect((segments[0] as HTMLElement).style.width).toBe('50%')
    expect(
      Number.parseFloat((segments[1] as HTMLElement).style.width),
    ).toBeCloseTo(33.3333, 3)
  })

  it('labels a zero-value category as 0% beside a non-zero total instead of below one percent', async () => {
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            expenses: '100.00',
            net: '1900.00',
            expense_categories: [
              categoryFixture({
                category_id: 3,
                category_name: 'Rent',
                amount: '100.00',
                transaction_count: 1,
              }),
              categoryFixture({
                category_id: 4,
                category_name: 'Refunded',
                amount: '0.00',
                transaction_count: 1,
              }),
            ],
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    const items = within(expenseRegion).getAllByRole('listitem')
    expect(items[1]).toHaveTextContent('0% of money out')
    expect(items[1]).not.toHaveTextContent('<1% of money out')
  })

  it('shows all five categories without an Other aggregate at exactly five', async () => {
    const amounts = ['900.00', '800.00', '700.00', '600.00', '500.00']
    const expenseCategories = amounts.map((amount, index) =>
      categoryFixture({
        category_id: 20 + index,
        category_name: `Category ${index + 1}`,
        amount,
        transaction_count: index + 1,
      }),
    )
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            expenses: '3500.00',
            net: '-1500.00',
            expense_categories: expenseCategories,
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    const items = within(expenseRegion).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items[0]).toHaveTextContent('Category 1')
    expect(items[4]).toHaveTextContent('Category 5')
    expect(
      expenseRegion.querySelectorAll('.cash-flow-composition-segment'),
    ).toHaveLength(5)
    expect(within(expenseRegion).queryByText(/Other \(/)).not.toBeInTheDocument()
  })

  it('aggregates exactly the two smallest categories into Other (2) with its exact sum and aggregate share', async () => {
    const amounts = ['600.00', '500.00', '400.00', '300.00', '200.00', '100.00']
    const expenseCategories = amounts.map((amount, index) =>
      categoryFixture({
        category_id: 30 + index,
        category_name: `Category ${index + 1}`,
        amount,
        transaction_count: index + 1,
      }),
    )
    installFetchMock(
      authenticatedHandler(() =>
        jsonResponse(
          cashFlowFixture({
            expenses: '2100.00',
            net: '-100.00',
            expense_categories: expenseCategories,
          }),
        ),
      ),
    )
    renderApp('/cash-flow')

    const expenseRegion = await screen.findByRole('region', {
      name: 'Money out by category',
    })
    const items = within(expenseRegion).getAllByRole('listitem')
    expect(items).toHaveLength(5)
    expect(items[4]).toHaveTextContent('Other (2)')
    expect(items[4]).toHaveTextContent('$300.00')
    expect(items[4]).toHaveTextContent('11 transactions')
    expect(items[4]).toHaveTextContent('14% of money out')

    const segments = expenseRegion.querySelectorAll(
      '.cash-flow-composition-segment',
    )
    expect(segments).toHaveLength(5)
    expect(
      Number.parseFloat((segments[4] as HTMLElement).style.width),
    ).toBeCloseTo(14.2857, 3)
  })
})

describe('cash flow month selection', () => {
  it('refetches when the month changes and updates the heading', async () => {
    const mock = installFetchMock(
      authenticatedHandler(
        cashFlowForMonth({
          '2026-09': cashFlowFixture(),
          '2026-10': cashFlowFixture({
            month: '2026-10',
            income: '3000.00',
            expenses: '1200.00',
            net: '1800.00',
            transaction_count: 6,
            income_categories: [
              categoryFixture({
                category_id: 5,
                category_name: 'Bonus',
                amount: '3000.00',
                transaction_count: 1,
              }),
            ],
            expense_categories: [
              categoryFixture({
                category_id: 6,
                category_name: 'Rent',
                amount: '1200.00',
                transaction_count: 1,
              }),
            ],
          }),
        }),
      ),
    )
    renderApp('/cash-flow')

    expect(await screen.findByText('Salary')).toBeInTheDocument()
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-09'),
    ).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Month'), {
      target: { value: '2026-10' },
    })

    expect(await screen.findByText('Bonus')).toBeInTheDocument()
    expect(metricValue('Money in')).toContain('$3,000.00')
    expect(metricValue('Money out')).toContain('$1,200.00')
    expect(
      screen.getByRole('heading', { level: 2, name: 'Cash Flow' }),
    ).toBeInTheDocument()
    expect(screen.getByText('October 2026')).toBeInTheDocument()
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-10'),
    ).toHaveLength(1)
    expect(screen.queryByText('Salary')).not.toBeInTheDocument()
  })

  it('does not fetch, blank shown data, or move to the error state when the month is cleared', async () => {
    const mock = installFetchMock(
      authenticatedHandler(() => jsonResponse(cashFlowFixture())),
    )
    renderApp('/cash-flow')

    expect(await screen.findByText('Salary')).toBeInTheDocument()
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-09'),
    ).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Month'), {
      target: { value: '' },
    })
    await act(async () => {})

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('Salary')).toBeInTheDocument()
    expect(metricValue('Money in')).toContain('$2,000.00')
    expect(screen.getByText('September 2026')).toBeInTheDocument()
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-09'),
    ).toHaveLength(1)
  })

  it('shows a neutral prompt instead of a stuck spinner when the month is cleared mid-flight', async () => {
    const pending = deferred<Response>()
    const mock = installFetchMock(authenticatedHandler(() => pending.promise))
    renderApp('/cash-flow')

    expect(await screen.findByText('Loading cash flow…')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Month'), {
      target: { value: '' },
    })
    await act(async () => {})

    expect(screen.queryByText('Loading cash flow…')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(
      screen.getByText('Choose a month to see its cash flow.'),
    ).toBeInTheDocument()

    await act(async () => {
      pending.resolve(jsonResponse(cashFlowFixture()))
    })
    await act(async () => {})

    expect(screen.queryByText('Loading cash flow…')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('$2,000.00')).not.toBeInTheDocument()
    expect(
      screen.getByText('Choose a month to see its cash flow.'),
    ).toBeInTheDocument()
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-09'),
    ).toHaveLength(1)
  })

  it('ignores a late response for the previous month', async () => {
    const september = deferred<Response>()
    const october = deferred<Response>()
    const mock = installFetchMock((url: string) => {
      if (url === '/api/auth/me/') {
        return jsonResponse({ id: 1, email: 'student@example.com' })
      }
      if (url === '/api/cash-flow/summary/?month=2026-09') {
        return september.promise
      }
      if (url === '/api/cash-flow/summary/?month=2026-10') {
        return october.promise
      }
      return jsonResponse({}, 404)
    })
    renderApp('/cash-flow')

    expect(await screen.findByText('Loading cash flow…')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Month'), {
      target: { value: '2026-10' },
    })

    await act(async () => {
      september.resolve(
        jsonResponse(
          cashFlowFixture({
            income: '9999.00',
            expenses: '1.00',
            net: '9998.00',
          }),
        ),
      )
    })
    expect(screen.queryByText('$9,999.00')).not.toBeInTheDocument()

    await act(async () => {
      october.resolve(
        jsonResponse(
          cashFlowFixture({
            month: '2026-10',
            income: '3000.00',
            expenses: '1200.00',
            net: '1800.00',
            transaction_count: 6,
            income_categories: [
              categoryFixture({
                category_id: 5,
                category_name: 'Bonus',
                amount: '3000.00',
                transaction_count: 1,
              }),
            ],
            expense_categories: [
              categoryFixture({
                category_id: 6,
                category_name: 'Rent',
                amount: '1200.00',
                transaction_count: 1,
              }),
            ],
          }),
        ),
      )
    })

    expect(await screen.findByText('Bonus')).toBeInTheDocument()
    expect(metricValue('Money in')).toContain('$3,000.00')
    expect(metricValue('Money out')).toContain('$1,200.00')
    expect(screen.queryByText('$9,999.00')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 2, name: 'Cash Flow' }),
    ).toBeInTheDocument()
    expect(screen.getByText('October 2026')).toBeInTheDocument()
    expect(screen.queryByText('September 2026')).not.toBeInTheDocument()
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-09'),
    ).toHaveLength(1)
    expect(
      calls(mock, '/api/cash-flow/summary/?month=2026-10'),
    ).toHaveLength(1)
  })
})