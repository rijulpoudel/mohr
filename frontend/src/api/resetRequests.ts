import { resetRestoreRequest } from './auth'
import { resetAccountsRequest } from './accounts'
import { resetBudgetsRequest } from './budgets'
import { resetCashFlowRequest } from './cashFlow'
import { resetCategoriesRequest } from './categories'
import { resetDashboardRequest } from './dashboard'
import { resetPlaidConnectionsRequest } from './plaid'
import { resetTransactionsRequest } from './transactions'

export function resetApiRequests(): void {
  resetRestoreRequest()
  resetAccountsRequest()
  resetBudgetsRequest()
  resetCashFlowRequest()
  resetCategoriesRequest()
  resetDashboardRequest()
  resetPlaidConnectionsRequest()
  resetTransactionsRequest()
}