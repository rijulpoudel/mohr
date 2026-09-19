import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchCashFlowSummary,
  type CashFlowCategory,
  type CashFlowSummary,
} from '../api/cashFlow'
import { ApiError, userMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatMonthLabel } from '../format/month'
import { clampedPercent, decimalToCents, formatMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'

const PENDING_NOTE =
  'Only settled transactions count. Pending or still-importing bank transactions are excluded from these figures.'

type SummaryState =
  | { status: 'loading' }
  | { status: 'idle' }
  | { status: 'ready'; summary: CashFlowSummary }
  | { status: 'error'; message: string }

function currentLocalMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function netValueClassName(net: string): string | undefined {
  const cents = decimalToCents(net)
  if (cents < 0n) return 'cash-flow-metric-value-negative'
  if (cents > 0n) return 'cash-flow-metric-value-positive'
  return undefined
}

function MetricGrid({ summary }: { summary: CashFlowSummary }) {
  return (
    <dl className="cash-flow-metrics-grid">
      <div className="cash-flow-metric-card">
        <dt>Money in</dt>
        <dd className="cash-flow-metric-value-positive">
          {formatMoney(summary.income)}
        </dd>
      </div>
      <div className="cash-flow-metric-card">
        <dt>Money out</dt>
        <dd>{formatMoney(summary.expenses)}</dd>
      </div>
      <div className="cash-flow-metric-card">
        <dt>Net flow</dt>
        <dd className={netValueClassName(summary.net)}>
          {formatMoney(summary.net)}
        </dd>
      </div>
    </dl>
  )
}

function ComparisonRegion({
  income,
  expenses,
}: {
  income: string
  expenses: string
}) {
  const larger =
    decimalToCents(income) >= decimalToCents(expenses) ? income : expenses
  const incomeWidth = clampedPercent(income, larger)
  const expenseWidth = clampedPercent(expenses, larger)
  return (
    <section
      className="cash-flow-card cash-flow-compare"
      aria-labelledby="cash-flow-compare-heading"
    >
      <h3 id="cash-flow-compare-heading">Money in vs money out</h3>
      <dl className="cash-flow-compare-rows">
        <div className="cash-flow-compare-row cash-flow-compare-row-income">
          <dt>Money in</dt>
          <dd className="cash-flow-compare-value">
            {formatMoney(income)}
          </dd>
          <dd className="cash-flow-compare-bar" aria-hidden="true">
            <span
              className="cash-flow-compare-fill"
              style={{ width: `${incomeWidth}%` }}
            />
          </dd>
        </div>
        <div className="cash-flow-compare-row cash-flow-compare-row-expense">
          <dt>Money out</dt>
          <dd className="cash-flow-compare-value">
            {formatMoney(expenses)}
          </dd>
          <dd className="cash-flow-compare-bar" aria-hidden="true">
            <span
              className="cash-flow-compare-fill"
              style={{ width: `${expenseWidth}%` }}
            />
          </dd>
        </div>
      </dl>
    </section>
  )
}

function transactionWord(count: number): string {
  return count === 1 ? 'transaction' : 'transactions'
}

function CategoryBreakdown({
  headingId,
  title,
  percentLabel,
  emptyMessage,
  items,
  sideTotal,
}: {
  headingId: string
  title: string
  percentLabel: string
  emptyMessage: string
  items: CashFlowCategory[]
  sideTotal: string
}) {
  return (
    <section
      className="cash-flow-card cash-flow-categories"
      aria-labelledby={headingId}
    >
      <h3 id={headingId}>{title}</h3>
      {items.length === 0 ? (
        <p className="cash-flow-categories-empty">{emptyMessage}</p>
      ) : (
        <ul className="cash-flow-category-list">
          {items.map((item) => {
            const percent = clampedPercent(item.amount, sideTotal)
            return (
              <li className="cash-flow-category-row" key={item.category_id}>
                <div className="cash-flow-category-main">
                  <span className="cash-flow-category-name">
                    {item.category_name}
                  </span>
                  <span className="cash-flow-category-amount">
                    {formatMoney(item.amount)}
                  </span>
                </div>
                <div className="cash-flow-category-meta">
                  <span className="cash-flow-category-count">
                    {item.transaction_count} {transactionWord(item.transaction_count)}
                  </span>
                  <span className="cash-flow-category-percent">
                    {percent}% of {percentLabel}
                  </span>
                </div>
                <div className="cash-flow-category-bar" aria-hidden="true">
                  <span
                    className="cash-flow-category-fill"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function CashFlowSummaryPanel({ summary }: { summary: CashFlowSummary }) {
  const hasActivity = summary.transaction_count > 0
  const monthLabel = formatMonthLabel(summary.month)
  return (
    <>
      <MetricGrid summary={summary} />
      {hasActivity ? (
        <>
          <ComparisonRegion
            income={summary.income}
            expenses={summary.expenses}
          />
          <div className="cash-flow-category-grid">
            <CategoryBreakdown
              headingId="cash-flow-income-categories-heading"
              title="Money in by category"
              percentLabel="money in"
              emptyMessage="No income recorded this month."
              items={summary.income_categories}
              sideTotal={summary.income}
            />
            <CategoryBreakdown
              headingId="cash-flow-expense-categories-heading"
              title="Money out by category"
              percentLabel="money out"
              emptyMessage="No spending recorded this month."
              items={summary.expense_categories}
              sideTotal={summary.expenses}
            />
          </div>
        </>
      ) : (
        <p className="cash-flow-empty-state">
          No settled activity in {monthLabel} yet.
        </p>
      )}
    </>
  )
}

export function CashFlowScreen() {
  const { clearSession } = useAuth()
  const [month, setMonth] = useState(currentLocalMonth)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<SummaryState>({ status: 'loading' })

  useEffect(() => {
    if (month === '') return
    let cancelled = false
    void fetchCashFlowSummary(month)
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
            error instanceof ApiError
              ? userMessage(error)
              : GENERIC_ERROR_MESSAGE,
        })
      })
    return () => {
      cancelled = true
    }
  }, [month, attempt, clearSession])

  function handleMonthChange(value: string): void {
    setMonth(value)
    if (value === '') {
      if (state.status === 'loading' || state.status === 'error') {
        setState({ status: 'idle' })
      }
      return
    }
    if (value !== month) {
      setState({ status: 'loading' })
    }
  }

  function handleRetry(): void {
    if (month === '') return
    setState({ status: 'loading' })
    setAttempt((current) => current + 1)
  }

  return (
    <div className="screen">
      <h2>Cash Flow</h2>
      {state.status === 'ready' && (
        <p className="cash-flow-period">
          {formatMonthLabel(state.summary.month)}
        </p>
      )}
      <div className="cash-flow-month-control">
        <label htmlFor="cash-flow-month">Month</label>
        <input
          id="cash-flow-month"
          className="input"
          type="month"
          value={month}
          onChange={(event) => {
            handleMonthChange(event.target.value)
          }}
        />
      </div>
      {state.status === 'loading' && (
        <div className="cash-flow-status" role="status">
          <p>Loading cash flow…</p>
        </div>
      )}
      {state.status === 'error' && (
        <div className="cash-flow-status cash-flow-error" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      {state.status === 'idle' && (
        <p className="cash-flow-empty-state">
          Choose a month to see its cash flow.
        </p>
      )}
      {state.status === 'ready' && (
        <CashFlowSummaryPanel summary={state.summary} />
      )}
      <p className="cash-flow-note">{PENDING_NOTE}</p>
      <Link to="/transactions" className="cash-flow-ledger-link">
        Open the full ledger
      </Link>
    </div>
  )
}