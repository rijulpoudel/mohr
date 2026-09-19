import { describe, expect, it, vi } from 'vitest'

vi.mock('./auth', () => ({ resetRestoreRequest: vi.fn() }))
vi.mock('./accounts', () => ({ resetAccountsRequest: vi.fn() }))
vi.mock('./budgets', () => ({ resetBudgetsRequest: vi.fn() }))
vi.mock('./cashFlow', () => ({ resetCashFlowRequest: vi.fn() }))
vi.mock('./categories', () => ({ resetCategoriesRequest: vi.fn() }))
vi.mock('./dashboard', () => ({ resetDashboardRequest: vi.fn() }))
vi.mock('./plaid', () => ({ resetPlaidConnectionsRequest: vi.fn() }))
vi.mock('./transactions', () => ({ resetTransactionsRequest: vi.fn() }))

import { resetRestoreRequest } from './auth'
import { resetAccountsRequest } from './accounts'
import { resetBudgetsRequest } from './budgets'
import { resetCashFlowRequest } from './cashFlow'
import { resetCategoriesRequest } from './categories'
import { resetDashboardRequest } from './dashboard'
import { resetPlaidConnectionsRequest } from './plaid'
import { resetTransactionsRequest } from './transactions'
import { resetApiRequests } from './resetRequests'

describe('resetApiRequests', () => {
  it('calls every in-flight request reset exactly once', () => {
    resetApiRequests()

    expect(resetRestoreRequest).toHaveBeenCalledTimes(1)
    expect(resetAccountsRequest).toHaveBeenCalledTimes(1)
    expect(resetBudgetsRequest).toHaveBeenCalledTimes(1)
    expect(resetCashFlowRequest).toHaveBeenCalledTimes(1)
    expect(resetCategoriesRequest).toHaveBeenCalledTimes(1)
    expect(resetDashboardRequest).toHaveBeenCalledTimes(1)
    expect(resetPlaidConnectionsRequest).toHaveBeenCalledTimes(1)
    expect(resetTransactionsRequest).toHaveBeenCalledTimes(1)
  })
})