import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchDashboardSummary,
  type DashboardSummary,
  type DashboardTransaction,
} from '../api/dashboard'
import { ApiError, userMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { BankSyncNotice } from '../components/BankSyncNotice'
import { GoogleSignInButton } from '../components/GoogleSignInButton'
import { MetricCard } from '../components/arc/MetricCard'
import {
  clampedPercent,
  decimalToCents,
  formatMoney,
  formatSignedMoney,
} from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const LOGOUT_ERROR_MESSAGE = 'Could not sign out. Please try again.'

const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

type MetricKey = keyof Pick<
  DashboardSummary,
  | 'total_balance'
  | 'current_month_income'
  | 'current_month_expenses'
  | 'remaining_budget'
>

const METRIC_FIELDS: ReadonlyArray<{ key: MetricKey; label: string }> = [
  { key: 'total_balance', label: 'Total balance' },
  { key: 'current_month_income', label: 'Income this month' },
  { key: 'current_month_expenses', label: 'Spending this month' },
  { key: 'remaining_budget', label: 'Budget remaining' },
]

type SummaryState =
  | { status: 'loading' }
  | { status: 'ready'; summary: DashboardSummary }
  | { status: 'error'; message: string }

function metricCardClassName(key: MetricKey): string {
  return key === 'total_balance'
    ? 'dashboard-metric-card dashboard-metric-card-total'
    : 'dashboard-metric-card'
}

function metricValueClassName(
  key: MetricKey,
  remainingBudget: string,
): string | undefined {
  switch (key) {
    case 'current_month_income':
      return 'dashboard-metric-value-income'
    case 'current_month_expenses':
      return 'dashboard-metric-value-expense'
    case 'remaining_budget':
      return remainingBudget.startsWith('-')
        ? 'dashboard-metric-value-remaining'
        : undefined
    default:
      return undefined
  }
}

function formatUtcDate(date: string): string {
  const [year, month, day] = date.split('-')
  const monthIndex = Number(month) - 1
  return `${MONTH_ABBREVIATIONS[monthIndex]} ${Number(day)}, ${year}`
}

function TransactionItem({
  transaction,
}: {
  transaction: DashboardTransaction
}) {
  const typeLabel = transaction.is_transfer
    ? 'Transfer'
    : transaction.transaction_type === 'income'
      ? 'Income'
      : 'Expense'
  const hasNote = transaction.note !== ''
  return (
    <li className="transaction-item">
      <div className="transaction-main">
        <span className="transaction-mark" aria-hidden="true">
          {transaction.transaction_type === 'income' ? '↑' : '↓'}
        </span>
        <span className="transaction-body">
          {hasNote ? (
            <span className="transaction-title">{transaction.note}</span>
          ) : (
            <span className="transaction-type">{typeLabel}</span>
          )}
          <span className="transaction-meta">
            {hasNote && <span className="transaction-type">{typeLabel}</span>}
            <time dateTime={transaction.date}>
              {formatUtcDate(transaction.date)}
            </time>
            {transaction.is_transfer && <span>Other side unverified</span>}
          </span>
        </span>
        <span className="transaction-amount">
          {formatSignedMoney(transaction.amount, transaction.transaction_type)}
        </span>
      </div>
    </li>
  )
}

function compareFillClassName(value: string): string {
  return decimalToCents(value) > 0n
    ? 'dashboard-compare-column-fill dashboard-compare-column-fill-positive'
    : 'dashboard-compare-column-fill'
}

function ComparisonCard({
  income,
  expenses,
}: {
  income: string
  expenses: string
}) {
  const larger =
    decimalToCents(income) >= decimalToCents(expenses) ? income : expenses
  const incomeHeight = clampedPercent(income, larger)
  const expenseHeight = clampedPercent(expenses, larger)
  return (
    <section
      className="dashboard-card dashboard-compare-card"
      aria-labelledby="compare-heading"
    >
      <h3 id="compare-heading">Income vs spending this month</h3>
      <dl className="dashboard-compare-chart">
        <div className="dashboard-compare-column dashboard-compare-column-income">
          <dt>Money in</dt>
          <dd className="dashboard-compare-value">{formatMoney(income)}</dd>
          <dd className="dashboard-compare-column-track" aria-hidden="true">
            <span
              className={compareFillClassName(income)}
              style={{ height: `${incomeHeight}%` }}
            />
          </dd>
        </div>
        <div className="dashboard-compare-column dashboard-compare-column-expense">
          <dt>Money out</dt>
          <dd className="dashboard-compare-value">{formatMoney(expenses)}</dd>
          <dd className="dashboard-compare-column-track" aria-hidden="true">
            <span
              className={compareFillClassName(expenses)}
              style={{ height: `${expenseHeight}%` }}
            />
          </dd>
        </div>
      </dl>
    </section>
  )
}

function BudgetCard({
  budgeted,
  remaining,
}: {
  budgeted: string
  remaining: string
}) {
  const remainingPercent = clampedPercent(remaining, budgeted)
  return (
    <section
      className="dashboard-card budget-card"
      aria-labelledby="budget-heading"
    >
      <h3 id="budget-heading">Monthly budget</h3>
      <dl className="dashboard-budget-amounts">
        <div className="dashboard-budget-amount dashboard-budget-amount-primary">
          <dt>Remaining budget</dt>
          <dd>{formatMoney(remaining)}</dd>
        </div>
        <div className="dashboard-budget-amount dashboard-budget-amount-secondary">
          <dt>Budgeted this month</dt>
          <dd>{formatMoney(budgeted)}</dd>
        </div>
      </dl>
      {decimalToCents(budgeted) > 0n ? (
        <div
          className="dashboard-budget-progress"
          role="progressbar"
          aria-label="Remaining budget"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remainingPercent}
          aria-valuetext={`Remaining ${formatMoney(remaining)} of ${formatMoney(budgeted)} budgeted`}
        >
          <span className="dashboard-budget-progress-track" aria-hidden="true">
            <span
              className="dashboard-budget-progress-fill"
              style={{ width: `${remainingPercent}%` }}
            />
          </span>
        </div>
      ) : (
        <p className="dashboard-budget-none">No budget set for this month.</p>
      )}
    </section>
  )
}

function RecentTransactionsCard({
  transactions,
}: {
  transactions: DashboardTransaction[]
}) {
  return (
    <section
      className="dashboard-card dashboard-recent-card"
      aria-labelledby="recent-transactions-heading"
    >
      <div className="dashboard-card-heading-row">
        <h3 id="recent-transactions-heading">Recent transactions</h3>
        <Link to="/transactions" className="dashboard-card-link">
          Manage transactions
        </Link>
      </div>
      {transactions.length === 0 ? (
        <p className="empty-state">
          No transactions yet. Your five most recent transactions will appear
          here.
        </p>
      ) : (
        <ul className="transaction-list">
          {transactions.map((transaction) => (
            <TransactionItem key={transaction.id} transaction={transaction} />
          ))}
        </ul>
      )}
    </section>
  )
}

function DashboardSummaryPanel({ onRetry }: { onRetry: () => void }) {
  const { clearSession } = useAuth()
  const [state, setState] = useState<SummaryState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    void fetchDashboardSummary()
      .then((summary) => {
        if (cancelled) return
        setState({ status: 'ready', summary })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          clearSession()
          return
        }
        setState({
          status: 'error',
          message:
            error instanceof ApiError ? userMessage(error) : GENERIC_ERROR_MESSAGE,
        })
      })
    return () => {
      cancelled = true
    }
  }, [clearSession])

  if (state.status === 'loading') {
    return (
      <div className="dashboard-card dashboard-status" role="status">
        <p>Loading your dashboard…</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div
        className="dashboard-card dashboard-status dashboard-error"
        role="alert"
      >
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <>
      <dl className="dashboard-metrics-grid" aria-label="Financial summary">
        {METRIC_FIELDS.map(({ key, label }) => (
          <MetricCard
            key={key}
            label={label}
            value={formatMoney(state.summary[key])}
            className={metricCardClassName(key)}
            valueClassName={metricValueClassName(
              key,
              state.summary.remaining_budget,
            )}
          />
        ))}
      </dl>
      <div className="dashboard-secondary-grid">
        <ComparisonCard
          income={state.summary.current_month_income}
          expenses={state.summary.current_month_expenses}
        />
        <BudgetCard
          budgeted={state.summary.total_budgeted}
          remaining={state.summary.remaining_budget}
        />
      </div>
      <RecentTransactionsCard
        transactions={state.summary.recent_transactions}
      />
    </>
  )
}

export function DashboardScreen() {
  const { user, logout } = useAuth()
  const [pending, setPending] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  async function handleLogout() {
    if (pending) return
    setLogoutError(null)
    setPending(true)
    try {
      await logout()
    } catch {
      setLogoutError(LOGOUT_ERROR_MESSAGE)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="screen">
      <div className="dashboard-header">
        <div>
          <h2>Overview</h2>
          <p className="dashboard-subtitle">
            Your money this month, without the noise.
          </p>
          <p className="dashboard-user">Signed in as {user?.email}</p>
        </div>
        <div className="dashboard-header-actions">
          <GoogleSignInButton intent="link" next="/" />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleLogout}
            disabled={pending}
          >
            {pending ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </div>
      {logoutError !== null && (
        <div className="error-summary" role="alert">
          {logoutError}
        </div>
      )}
      <BankSyncNotice />
      <DashboardSummaryPanel
        key={attempt}
        onRetry={() => setAttempt((current) => current + 1)}
      />
    </div>
  )
}
