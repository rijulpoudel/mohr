import { useEffect, useState } from 'react'
import {
  fetchDashboardSummary,
  type DashboardSummary,
  type DashboardTransaction,
} from '../api/dashboard'
import { ApiError, userMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatMoney, formatSignedMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const LOGOUT_ERROR_MESSAGE = 'Could not sign out. Please try again.'

type SummaryKey = keyof Pick<
  DashboardSummary,
  | 'total_balance'
  | 'current_month_income'
  | 'current_month_expenses'
  | 'total_budgeted'
  | 'remaining_budget'
>

const SUMMARY_FIELDS: ReadonlyArray<{ key: SummaryKey; label: string }> = [
  { key: 'total_balance', label: 'Total balance' },
  { key: 'current_month_income', label: 'Income this month' },
  { key: 'current_month_expenses', label: 'Spending this month' },
  { key: 'total_budgeted', label: 'Budgeted this month' },
  { key: 'remaining_budget', label: 'Remaining budget' },
]

type SummaryState =
  | { status: 'loading' }
  | { status: 'ready'; summary: DashboardSummary }
  | { status: 'error'; message: string }

function TransactionItem({
  transaction,
}: {
  transaction: DashboardTransaction
}) {
  return (
    <li className="transaction-item">
      <div className="transaction-main">
        <span className="transaction-type">
          {transaction.transaction_type === 'income' ? 'Income' : 'Expense'}
        </span>
        <span className="transaction-amount">
          {formatSignedMoney(transaction.amount, transaction.transaction_type)}
        </span>
      </div>
      <div className="transaction-meta">
        <time dateTime={transaction.date}>{transaction.date}</time>
      </div>
      {transaction.note !== '' && (
        <p className="transaction-note">{transaction.note}</p>
      )}
    </li>
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
    return <p role="status">Loading your dashboard…</p>
  }

  if (state.status === 'error') {
    return (
      <div className="error-summary" role="alert">
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <>
      <dl className="summary-grid">
        {SUMMARY_FIELDS.map(({ key, label }) => (
          <div className="summary-item" key={key}>
            <dt>{label}</dt>
            <dd>{formatMoney(state.summary[key])}</dd>
          </div>
        ))}
      </dl>
      <section className="recent" aria-labelledby="recent-transactions-heading">
        <h3 id="recent-transactions-heading">Recent transactions</h3>
        {state.summary.recent_transactions.length === 0 ? (
          <p className="empty-state">
            No transactions yet. Your five most recent transactions will appear
            here.
          </p>
        ) : (
          <ul className="transaction-list">
            {state.summary.recent_transactions.map((transaction) => (
              <TransactionItem key={transaction.id} transaction={transaction} />
            ))}
          </ul>
        )}
      </section>
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
          <p className="dashboard-user">Signed in as {user?.email}</p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={handleLogout}
          disabled={pending}
        >
          {pending ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
      {logoutError !== null && (
        <div className="error-summary" role="alert">
          {logoutError}
        </div>
      )}
      <DashboardSummaryPanel
        key={attempt}
        onRetry={() => setAttempt((current) => current + 1)}
      />
    </div>
  )
}
