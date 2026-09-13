import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchAccounts, type Account } from '../api/accounts'
import { fetchCategories, type Category } from '../api/categories'
import {
  fetchTransactions,
  type Transaction,
  type TransactionFilters,
  type TransactionType,
} from '../api/transactions'
import { ApiError, userMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatSignedMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const REVERSED_RANGE_MESSAGE = 'Start date must not be after end date.'
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

type TransactionsState =
  | { status: 'loading' }
  | { status: 'ready'; transactions: Transaction[] }
  | { status: 'error'; message: string }

interface FilterDraft {
  account: string
  category: string
  type: string
  start: string
  end: string
}

const EMPTY_DRAFT: FilterDraft = {
  account: '',
  category: '',
  type: '',
  start: '',
  end: '',
}

function isStrictDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function hasActiveFilters(draft: FilterDraft): boolean {
  return (
    draft.account !== '' ||
    draft.category !== '' ||
    draft.type !== '' ||
    draft.start !== '' ||
    draft.end !== ''
  )
}

function TransactionItem({
  transaction,
  accountById,
  categoryById,
}: {
  transaction: Transaction
  accountById: Map<number, Account>
  categoryById: Map<number, Category>
}) {
  const accountName = accountById.get(transaction.account)?.name
  const categoryName = categoryById.get(transaction.category)?.name
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
        {accountName !== undefined && <span>{accountName}</span>}
        {categoryName !== undefined && <span>{categoryName}</span>}
      </div>
      {transaction.note !== '' && (
        <p className="transaction-note">{transaction.note}</p>
      )}
    </li>
  )
}

export function TransactionsScreen() {
  const { clearSession } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<TransactionsState>({ status: 'loading' })
  const [accounts, setAccounts] = useState<Account[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT)
  const [dateError, setDateError] = useState<string | null>(null)
  const [filters, setFilters] = useState<TransactionFilters>({})
  const metaPromiseRef = useRef<Promise<[Account[], Category[]]> | null>(null)
  const requestSeqRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const seq = requestSeqRef.current + 1
    requestSeqRef.current = seq
    let metaPromise = metaPromiseRef.current
    if (metaPromise === null) {
      const created = Promise.all([fetchAccounts(), fetchCategories()])
      metaPromiseRef.current = created
      void created.catch(() => {
        if (metaPromiseRef.current === created) {
          metaPromiseRef.current = null
        }
      })
      metaPromise = created
    }
    void Promise.all([fetchTransactions(filters), metaPromise])
      .then(([transactions, meta]) => {
        if (cancelled || !mountedRef.current || seq !== requestSeqRef.current) {
          return
        }
        const [loadedAccounts, loadedCategories] = meta
        setAccounts(loadedAccounts)
        setCategories(loadedCategories)
        setState({ status: 'ready', transactions })
      })
      .catch((error: unknown) => {
        if (cancelled || !mountedRef.current || seq !== requestSeqRef.current) {
          return
        }
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
  }, [attempt, filters, clearSession])

  function handleDraftChange(patch: Partial<FilterDraft>): void {
    const nextDraft = { ...draft, ...patch }
    setDraft(nextDraft)
    if (nextDraft.start !== '' && !isStrictDate(nextDraft.start)) return
    if (nextDraft.end !== '' && !isStrictDate(nextDraft.end)) return

    const next: TransactionFilters = {}
    if (nextDraft.account !== '') next.account = Number(nextDraft.account)
    if (nextDraft.category !== '') next.category = Number(nextDraft.category)
    if (nextDraft.type !== '') {
      next.transaction_type = nextDraft.type as TransactionType
    }
    if (nextDraft.start !== '') next.start_date = nextDraft.start
    if (nextDraft.end !== '') next.end_date = nextDraft.end

    if (
      next.start_date !== undefined &&
      next.end_date !== undefined &&
      next.start_date > next.end_date
    ) {
      setDateError(REVERSED_RANGE_MESSAGE)
      return
    }
    setDateError(null)
    setState({ status: 'loading' })
    setFilters(next)
  }

  const handleRetry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((current) => current + 1)
  }, [])

  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  )

  return (
    <div className="screen">
      <h2>Transactions</h2>
      <section className="transaction-filters">
        <div className="form-field">
          <label htmlFor="transactions-account">Account</label>
          <select
            id="transactions-account"
            className="select"
            name="account"
            value={draft.account}
            onChange={(event) => handleDraftChange({ account: event.target.value })}
          >
            <option value="">All</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="transactions-category">Category</label>
          <select
            id="transactions-category"
            className="select"
            name="category"
            value={draft.category}
            onChange={(event) =>
              handleDraftChange({ category: event.target.value })
            }
          >
            <option value="">All</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="transactions-type">Transaction type</label>
          <select
            id="transactions-type"
            className="select"
            name="transaction_type"
            value={draft.type}
            onChange={(event) => handleDraftChange({ type: event.target.value })}
          >
            <option value="">All</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="transactions-start">Start date</label>
          <input
            id="transactions-start"
            className="input"
            type="date"
            name="start_date"
            value={draft.start}
            onChange={(event) => handleDraftChange({ start: event.target.value })}
          />
        </div>
        <div className="form-field">
          <label htmlFor="transactions-end">End date</label>
          <input
            id="transactions-end"
            className="input"
            type="date"
            name="end_date"
            value={draft.end}
            onChange={(event) => handleDraftChange({ end: event.target.value })}
            aria-invalid={dateError !== null}
            aria-describedby={
              dateError !== null ? 'transactions-end-date-error' : undefined
            }
          />
          {dateError !== null && (
            <p id="transactions-end-date-error" className="field-errors" role="alert">
              {dateError}
            </p>
          )}
        </div>
      </section>
      {state.status === 'loading' && (
        <p role="status">Loading your transactions…</p>
      )}
      {state.status === 'error' && (
        <div className="error-summary" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.transactions.length === 0 ? (
          hasActiveFilters(draft) ? (
            <p className="empty-state">
              No matches for these filters. Try clearing or changing a filter.
            </p>
          ) : (
            <p className="empty-state">
              No transactions yet. Transactions you add will appear here.
            </p>
          )
        ) : (
          <ul className="transaction-list">
            {state.transactions.map((transaction) => (
              <TransactionItem
                key={transaction.id}
                transaction={transaction}
                accountById={accountById}
                categoryById={categoryById}
              />
            ))}
          </ul>
        ))}
    </div>
  )
}