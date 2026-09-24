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
import {
  clampedPercent,
  decimalToCents,
  formatMoney,
  sumMoney,
} from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'

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

// The money-out composition keeps a bounded number of segments so the palette
// and legend stay readable. When a month has more than five categories the
// four largest keep their own segment and the remainder are aggregated into a
// single truthful "Other (N)" segment whose exact sum is preserved. The API
// returns categories sorted by descending amount.
const MAX_COMPOSITION_SEGMENTS = 5

type CompositionSegment = {
  key: string
  label: string
  amount: string
  cents: bigint
  transactionCount: number
  index: number
}

function buildCompositionSegments(
  categories: CashFlowCategory[],
): CompositionSegment[] {
  const toSegment = (
    category: CashFlowCategory,
    index: number,
  ): CompositionSegment => ({
    key: `category-${category.category_id}`,
    label: category.category_name,
    amount: category.amount,
    cents: decimalToCents(category.amount),
    transactionCount: category.transaction_count,
    index,
  })
  if (categories.length <= MAX_COMPOSITION_SEGMENTS) {
    return categories.map(toSegment)
  }
  const head = categories.slice(0, MAX_COMPOSITION_SEGMENTS - 1)
  const rest = categories.slice(MAX_COMPOSITION_SEGMENTS - 1)
  const other: CompositionSegment = {
    key: 'other',
    label: `Other (${rest.length})`,
    amount: sumMoney(rest.map((category) => category.amount)),
    cents: rest.reduce(
      (sum, category) => sum + decimalToCents(category.amount),
      0n,
    ),
    transactionCount: rest.reduce(
      (sum, category) => sum + category.transaction_count,
      0,
    ),
    index: MAX_COMPOSITION_SEGMENTS - 1,
  }
  return [...head.map(toSegment), other]
}

// Rounds the exact bigint share to a whole percent while keeping the edges
// honest: a strictly positive share never reads 0%, and a share among siblings
// never claims the whole 100%.
function compositionPercentLabel(
  cents: bigint,
  totalCents: bigint,
  hasSiblings: boolean,
): string {
  if (cents <= 0n || totalCents <= 0n) return '0%'
  const percent = (cents * 100n + totalCents / 2n) / totalCents
  if (percent <= 0n) return '<1%'
  if (hasSiblings && percent >= 100n) return '>99%'
  return `${percent}%`
}

// Money and ratios stay in bigint cents; this float is only the bounded visual
// width for the decorative strip.
function compositionWidthPercent(cents: bigint, totalCents: bigint): number {
  if (totalCents <= 0n) return 0
  return Number((cents * 1_000_000n) / totalCents) / 10_000
}

function compositionSegmentClassName(segment: CompositionSegment): string {
  const base = `cash-flow-composition-segment cash-flow-seg-${segment.index}`
  return segment.cents > 0n
    ? `${base} cash-flow-composition-segment-positive`
    : base
}

function ExpenseComposition({
  headingId,
  items,
  total,
}: {
  headingId: string
  items: CashFlowCategory[]
  total: string
}) {
  const segments = buildCompositionSegments(items)
  // The overall expense total is authoritative: it is what the metrics and the
  // comparison report, so it is both the displayed Total and the denominator
  // for shares. The aggregated "Other" segment still keeps its own exact sum.
  const totalCents = decimalToCents(total)
  const hasSiblings = segments.length > 1
  return (
    <section
      className="cash-flow-card cash-flow-categories"
      aria-labelledby={headingId}
    >
      <h3 id={headingId}>Money out by category</h3>
      {segments.length === 0 ? (
        <p className="cash-flow-categories-empty">
          No spending recorded this month.
        </p>
      ) : (
        <>
          <p className="cash-flow-composition-total">
            Total{' '}
            <span className="cash-flow-composition-total-value">
              {formatMoney(total)}
            </span>
          </p>
          <div className="cash-flow-composition-strip" aria-hidden="true">
            {segments.map((segment) => (
              <span
                key={segment.key}
                className={compositionSegmentClassName(segment)}
                style={{
                  width: `${compositionWidthPercent(segment.cents, totalCents)}%`,
                }}
              />
            ))}
          </div>
          <ul className="cash-flow-composition-legend">
            {segments.map((segment) => (
              <li className="cash-flow-composition-item" key={segment.key}>
                <span
                  className={`cash-flow-composition-swatch cash-flow-seg-${segment.index}`}
                  aria-hidden="true"
                />
                <span className="cash-flow-composition-name">
                  {segment.label}
                </span>
                <span className="cash-flow-composition-amount">
                  {formatMoney(segment.amount)}
                </span>
                <span className="cash-flow-composition-meta">
                  {`${segment.transactionCount} ${transactionWord(
                    segment.transactionCount,
                  )} · ${compositionPercentLabel(
                    segment.cents,
                    totalCents,
                    hasSiblings,
                  )} of money out`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
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
            <ExpenseComposition
              headingId="cash-flow-expense-categories-heading"
              items={summary.expense_categories}
              total={summary.expenses}
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
      <Link to="/transactions" className="cash-flow-ledger-link">
        Open the full ledger
      </Link>
    </div>
  )
}