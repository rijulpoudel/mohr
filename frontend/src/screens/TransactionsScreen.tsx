import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { fetchAccounts, type Account } from '../api/accounts'
import { fetchCategories, type Category } from '../api/categories'
import {
  createTransaction,
  deleteTransaction,
  fetchTransactions,
  resetTransactionsRequest,
  updateTransaction,
  type Transaction,
  type TransactionFilters,
  type TransactionPatch,
  type TransactionType,
} from '../api/transactions'
import { ApiError, userMessage, type FieldErrors } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatSignedMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const FIELD_ERROR_SUMMARY = 'Please check the highlighted fields.'
const REVERSED_RANGE_MESSAGE = 'Start date must not be after end date.'
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const AMOUNT_PATTERN = /^\d+\.\d{2}$/
const ZERO_AMOUNT_PATTERN = /^0+\.00$/

const CREATE_ACCOUNT_REQUIRED = 'Choose an account.'
const CREATE_ACCOUNT_INVALID = 'Choose an active account.'
const CREATE_CATEGORY_REQUIRED = 'Choose a category.'
const CREATE_CATEGORY_INVALID =
  'Choose an active category matching the transaction type.'
const CREATE_TYPE_REQUIRED = 'Choose a transaction type.'
const CREATE_AMOUNT_ERROR =
  'Enter an amount with exactly 2 decimals and at most 12 digits.'
const CREATE_DATE_ERROR = 'Enter a real date in YYYY-MM-DD format.'
const NO_ACTIVE_ACCOUNTS_MESSAGE =
  'Create an active account before adding transactions.'
const NO_ACTIVE_CATEGORIES_MESSAGE =
  'Create an active category for this type before adding transactions.'

const NO_CHANGES_MESSAGE = 'Make at least one change before saving.'

const KNOWN_CREATE_FIELDS = [
  'account',
  'category',
  'transaction_type',
  'amount',
  'date',
  'note',
] as const

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

function getLocalToday(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isValidCreateAmount(value: string): boolean {
  if (!AMOUNT_PATTERN.test(value)) return false
  if (ZERO_AMOUNT_PATTERN.test(value)) return false
  return value.length - 1 <= 12
}

function validateCreateFields(
  account: string,
  category: string,
  transactionType: string,
  amount: string,
  date: string,
  accounts: Account[],
  categories: Category[],
): FieldErrors {
  const errors: FieldErrors = {}
  if (account === '') {
    errors.account = [CREATE_ACCOUNT_REQUIRED]
  } else {
    const selected = accounts.find((item) => String(item.id) === account)
    if (selected === undefined || selected.is_archived) {
      errors.account = [CREATE_ACCOUNT_INVALID]
    }
  }
  if (
    transactionType !== 'income' &&
    transactionType !== 'expense'
  ) {
    errors.transaction_type = [CREATE_TYPE_REQUIRED]
  }
  if (category === '') {
    errors.category = [CREATE_CATEGORY_REQUIRED]
  } else {
    const selected = categories.find((item) => String(item.id) === category)
    if (
      selected === undefined ||
      selected.is_archived ||
      (transactionType === 'income' || transactionType === 'expense'
        ? selected.category_type !== transactionType
        : true)
    ) {
      errors.category = [CREATE_CATEGORY_INVALID]
    }
  }
  if (!isValidCreateAmount(amount)) {
    errors.amount = [CREATE_AMOUNT_ERROR]
  }
  if (!isStrictDate(date)) {
    errors.date = [CREATE_DATE_ERROR]
  }
  return errors
}

function firstCreateError(
  fieldErrors: FieldErrors | null,
  field: string,
): string | null {
  const messages = fieldErrors?.[field]
  return messages !== undefined && messages.length > 0 ? messages[0] : null
}

function validateEditFields(
  account: string,
  category: string,
  transactionType: string,
  amount: string,
  date: string,
  accounts: Account[],
  categories: Category[],
  original: Transaction,
  accountDirty = false,
  categoryDirty = false,
): FieldErrors {
  const errors: FieldErrors = {}
  if (account === '') {
    errors.account = [CREATE_ACCOUNT_REQUIRED]
  } else if (account !== String(original.account)) {
    const selected = accounts.find((item) => String(item.id) === account)
    if (selected === undefined || selected.is_archived) {
      errors.account = [CREATE_ACCOUNT_INVALID]
    }
  } else if (accountDirty) {
    const selected = accounts.find((item) => String(item.id) === account)
    if (selected === undefined || selected.is_archived) {
      errors.account = [CREATE_ACCOUNT_INVALID]
    }
  }
  if (transactionType !== 'income' && transactionType !== 'expense') {
    errors.transaction_type = [CREATE_TYPE_REQUIRED]
  }
  if (category === '') {
    errors.category = [CREATE_CATEGORY_REQUIRED]
  } else if (
    category !== String(original.category) ||
    transactionType !== original.transaction_type
  ) {
    const selected = categories.find((item) => String(item.id) === category)
    if (
      selected === undefined ||
      selected.is_archived ||
      (transactionType === 'income' || transactionType === 'expense'
        ? selected.category_type !== transactionType
        : true)
    ) {
      errors.category = [CREATE_CATEGORY_INVALID]
    }
  } else if (categoryDirty) {
    const selected = categories.find((item) => String(item.id) === category)
    if (
      selected === undefined ||
      selected.is_archived ||
      (transactionType === 'income' || transactionType === 'expense'
        ? selected.category_type !== transactionType
        : true)
    ) {
      errors.category = [CREATE_CATEGORY_INVALID]
    }
  }
  if (!isValidCreateAmount(amount)) {
    errors.amount = [CREATE_AMOUNT_ERROR]
  }
  if (!isStrictDate(date)) {
    errors.date = [CREATE_DATE_ERROR]
  }
  return errors
}

function buildEditPatch(
  original: Transaction,
  account: string,
  category: string,
  transactionType: string,
  amount: string,
  date: string,
  note: string,
): TransactionPatch {
  const patch: TransactionPatch = {}
  if (account !== String(original.account)) {
    patch.account = Number(account)
  }
  if (category !== String(original.category)) {
    patch.category = Number(category)
  }
  if (transactionType !== original.transaction_type) {
    patch.transaction_type = transactionType as TransactionType
  }
  if (amount !== original.amount) {
    patch.amount = amount
  }
  if (date !== original.date) {
    patch.date = date
  }
  if (note !== original.note) {
    patch.note = note
  }
  return patch
}

function transactionMatchesFilters(
  transaction: Transaction,
  filters: TransactionFilters,
): boolean {
  if (filters.account !== undefined && transaction.account !== filters.account) {
    return false
  }
  if (filters.category !== undefined && transaction.category !== filters.category) {
    return false
  }
  if (
    filters.transaction_type !== undefined &&
    transaction.transaction_type !== filters.transaction_type
  ) {
    return false
  }
  if (filters.start_date !== undefined && transaction.date < filters.start_date) {
    return false
  }
  if (filters.end_date !== undefined && transaction.date > filters.end_date) {
    return false
  }
  return true
}

function TransactionItem({
  transaction,
  accountById,
  categoryById,
  editDisabled,
  deleteDisabled,
  onEdit,
  onDelete,
}: {
  transaction: Transaction
  accountById: Map<number, Account>
  categoryById: Map<number, Category>
  editDisabled: boolean
  deleteDisabled: boolean
  onEdit: () => void
  onDelete: () => void
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
        {transaction.source === 'plaid' && (
          <span className="transaction-source">From your bank</span>
        )}
        {/* provider_name holds the bank's own description of the transaction
            (Plaid's transaction name), which is usually a merchant or payee, not
            the institution. It is therefore labelled as a description and never
            phrased as the source of the data. */}
        {transaction.provider_name.trim() !== '' && (
          <span>Bank description: {transaction.provider_name}</span>
        )}
        {transaction.is_pending && (
          <span className="transaction-source">Pending</span>
        )}
        {transaction.is_pending_initial_import && (
          <span className="transaction-source">History still importing</span>
        )}
      </div>
      {transaction.note !== '' && (
        <p className="transaction-note">{transaction.note}</p>
      )}
      <div className="transaction-actions">
        <button
          type="button"
          className="btn-edit"
          aria-label={`Edit transaction ${transaction.id}`}
          onClick={onEdit}
          disabled={editDisabled}
        >
          Edit
        </button>
        {transaction.source !== 'plaid' && (
          <button
            type="button"
            className="btn-delete"
            aria-label={`Delete transaction ${transaction.id}`}
            onClick={onDelete}
            disabled={deleteDisabled}
          >
            Delete
          </button>
        )}
      </div>
    </li>
  )
}

function DeleteTransactionConfirm({
  transaction,
  accountName,
  categoryName,
  onCancel,
  onDeleted,
  onPendingChange,
}: {
  transaction: Transaction
  accountName: string | undefined
  categoryName: string | undefined
  onCancel: () => void
  onDeleted: (id: number) => void
  onPendingChange: (pending: boolean) => void
}) {
  const { clearSession } = useAuth()
  const [pending, setPending] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const submittingRef = useRef(false)
  const keepRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    mountedRef.current = true
    keepRef.current?.focus()
    return () => {
      mountedRef.current = false
      onPendingChange(false)
    }
  }, [onPendingChange])

  async function handleConfirm() {
    if (submittingRef.current) return
    if (pending) return
    setSubmitError(null)
    submittingRef.current = true
    setPending(true)
    onPendingChange(true)
    try {
      await deleteTransaction(transaction.id)
      if (mountedRef.current) {
        onDeleted(transaction.id)
      }
    } catch (caught) {
      if (!mountedRef.current) return
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession()
        return
      }
      if (caught instanceof ApiError) {
        setSubmitError(userMessage(caught))
        return
      }
      setSubmitError(GENERIC_ERROR_MESSAGE)
    } finally {
      if (mountedRef.current) {
        submittingRef.current = false
        setPending(false)
        onPendingChange(false)
      }
    }
  }

  const permanenceId = `delete-permanence-${transaction.id}`

  return (
    <li className="transaction-item transaction-delete">
      {pending && (
        <p role="status" className="notice">
          Deleting transaction…
        </p>
      )}
      {submitError !== null && (
        <div className="error-summary" role="alert">
          {submitError}
        </div>
      )}
      <div
        role="group"
        aria-label={`Delete transaction ${transaction.id} confirmation`}
      >
        <div className="transaction-meta">
          <time dateTime={transaction.date}>{transaction.date}</time>
          <span>
            {formatSignedMoney(transaction.amount, transaction.transaction_type)}
          </span>
          {accountName !== undefined && <span>{accountName}</span>}
          {categoryName !== undefined && <span>{categoryName}</span>}
        </div>
        <p id={permanenceId}>Deleting is permanent and cannot be undone.</p>
        <div className="transaction-delete-actions">
          <button
            type="button"
            className="btn"
            ref={keepRef}
            onClick={onCancel}
            disabled={pending}
          >
            Keep transaction
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleConfirm}
            disabled={pending}
            aria-describedby={permanenceId}
          >
            Delete transaction
          </button>
        </div>
      </div>
    </li>
  )
}

function EditTransactionForm({
  transaction,
  accounts,
  categories,
  onCancel,
  onUpdated,
  onPendingChange,
}: {
  transaction: Transaction
  accounts: Account[]
  categories: Category[]
  onCancel: () => void
  onUpdated: (updated: Transaction) => void
  onPendingChange: (pending: boolean) => void
}) {
  const { clearSession } = useAuth()
  const [account, setAccount] = useState(String(transaction.account))
  const [category, setCategory] = useState(String(transaction.category))
  const [transactionType, setTransactionType] = useState<string>(
    transaction.transaction_type,
  )
  const [amount, setAmount] = useState(transaction.amount)
  const [date, setDate] = useState(transaction.date)
  const [note, setNote] = useState(transaction.note)
  const [pending, setPending] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const submittingRef = useRef(false)
  const initialAccountRef = useRef(String(transaction.account))
  const initialCategoryRef = useRef(String(transaction.category))
  const initialTypeRef = useRef(transaction.transaction_type)
  const accountDirtyRef = useRef(false)
  const categoryDirtyRef = useRef(false)
  const firstFieldRef = useRef<HTMLSelectElement>(null)

  useEffect(() => {
    mountedRef.current = true
    firstFieldRef.current?.focus()
    return () => {
      mountedRef.current = false
      onPendingChange(false)
    }
  }, [onPendingChange])

  function clearEditFieldError(field: string): void {
    setFieldErrors((current) => {
      if (current === null || current[field] === undefined) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  const activeAccounts = accounts.filter((item) => !item.is_archived)
  const originalAccount = accounts.find((item) => item.id === transaction.account)
  const accountOptions =
    originalAccount !== undefined && originalAccount.is_archived
      ? [...activeAccounts, originalAccount]
      : activeAccounts
  const originalCategory = categories.find(
    (item) => item.id === transaction.category,
  )
  const visibleCategories = categories.filter(
    (item) => !item.is_archived && item.category_type === transactionType,
  )
  if (
    originalCategory !== undefined &&
    originalCategory.is_archived &&
    originalCategory.category_type === transactionType &&
    !visibleCategories.some((item) => item.id === originalCategory.id)
  ) {
    visibleCategories.push(originalCategory)
  }

  function handleTypeChange(value: string): void {
    if (value !== initialTypeRef.current) {
      categoryDirtyRef.current = true
    }
    setTransactionType(value)
    clearEditFieldError('transaction_type')
    clearEditFieldError('category')
    setCategory((current) => {
      if (current === '') return current
      const selected = categories.find((item) => String(item.id) === current)
      if (selected !== undefined && selected.category_type !== value) return ''
      return current
    })
  }

  function handleAccountChange(value: string): void {
    if (value !== initialAccountRef.current) {
      accountDirtyRef.current = true
    }
    setAccount(value)
    clearEditFieldError('account')
  }

  function handleCategoryChange(value: string): void {
    if (value !== initialCategoryRef.current) {
      categoryDirtyRef.current = true
    }
    setCategory(value)
    clearEditFieldError('category')
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submittingRef.current) return
    if (pending) return
    setSubmitError(null)

    const clientErrors = validateEditFields(
      account,
      category,
      transactionType,
      amount,
      date,
      accounts,
      categories,
      transaction,
      accountDirtyRef.current,
      categoryDirtyRef.current,
    )
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      return
    }

    setFieldErrors(null)
    const patch = buildEditPatch(
      transaction,
      account,
      category,
      transactionType,
      amount,
      date,
      note,
    )
    if (Object.keys(patch).length === 0) {
      setSubmitError(NO_CHANGES_MESSAGE)
      return
    }
    submittingRef.current = true
    setPending(true)
    onPendingChange(true)
    try {
      const updated = await updateTransaction(transaction.id, patch)
      if (mountedRef.current) {
        onUpdated(updated)
      }
    } catch (caught) {
      if (!mountedRef.current) return
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession()
        return
      }
      if (caught instanceof ApiError) {
        const backendFields = caught.fieldErrors ?? {}
        const known: FieldErrors = {}
        for (const field of KNOWN_CREATE_FIELDS) {
          const messages = backendFields[field]
          if (messages !== undefined && messages.length > 0) {
            known[field] = [...messages]
          }
        }
        const nonFieldMessage = backendFields.non_field_errors?.[0]
        if (Object.keys(known).length > 0 || nonFieldMessage !== undefined) {
          setFieldErrors(Object.keys(known).length > 0 ? known : null)
          setSubmitError(nonFieldMessage ?? null)
          return
        }
        setSubmitError(userMessage(caught))
        return
      }
      setSubmitError(GENERIC_ERROR_MESSAGE)
    } finally {
      if (mountedRef.current) {
        submittingRef.current = false
        setPending(false)
        onPendingChange(false)
      }
    }
  }

  const accountError = firstCreateError(fieldErrors, 'account')
  const categoryError = firstCreateError(fieldErrors, 'category')
  const typeError = firstCreateError(fieldErrors, 'transaction_type')
  const amountError = firstCreateError(fieldErrors, 'amount')
  const dateError = firstCreateError(fieldErrors, 'date')
  const noteError = firstCreateError(fieldErrors, 'note')
  const hasFieldErrors =
    accountError !== null ||
    categoryError !== null ||
    typeError !== null ||
    amountError !== null ||
    dateError !== null ||
    noteError !== null
  const summary = submitError ?? (hasFieldErrors ? FIELD_ERROR_SUMMARY : null)
  const base = `edit-transaction-${transaction.id}`

  return (
    <li className="transaction-item transaction-edit">
      {pending && (
        <p role="status" className="notice">
          Updating transaction…
        </p>
      )}
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor={`${base}-account`}>Edit transaction account</label>
          <select
            id={`${base}-account`}
            ref={firstFieldRef}
            className="select"
            name="account"
            value={account}
            onChange={(event) => {
              handleAccountChange(event.target.value)
            }}
            disabled={pending}
            required
            aria-invalid={accountError !== null}
            aria-describedby={
              accountError !== null ? `${base}-account-error` : undefined
            }
          >
            {accountOptions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.is_archived ? `${item.name} (archived, current)` : item.name}
              </option>
            ))}
          </select>
          {accountError !== null && (
            <ul id={`${base}-account-error`} className="field-errors">
              {fieldErrors?.account?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor={`${base}-type`}>Edit transaction type</label>
          <select
            id={`${base}-type`}
            className="select"
            name="transaction_type"
            value={transactionType}
            onChange={(event) => handleTypeChange(event.target.value)}
            disabled={pending}
            required
            aria-invalid={typeError !== null}
            aria-describedby={
              typeError !== null ? `${base}-type-error` : undefined
            }
          >
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
          {typeError !== null && (
            <ul id={`${base}-type-error`} className="field-errors">
              {fieldErrors?.transaction_type?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor={`${base}-category`}>Edit transaction category</label>
          <select
            id={`${base}-category`}
            className="select"
            name="category"
            value={category}
            onChange={(event) => {
              handleCategoryChange(event.target.value)
            }}
            disabled={pending}
            required
            aria-invalid={categoryError !== null}
            aria-describedby={
              categoryError !== null ? `${base}-category-error` : undefined
            }
          >
            <option value="">Select a category</option>
            {visibleCategories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.is_archived ? `${item.name} (archived, current)` : item.name}
              </option>
            ))}
          </select>
          {categoryError !== null && (
            <ul id={`${base}-category-error`} className="field-errors">
              {fieldErrors?.category?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor={`${base}-amount`}>Edit transaction amount</label>
          <input
            id={`${base}-amount`}
            className="input"
            type="text"
            inputMode="decimal"
            name="amount"
            autoComplete="off"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value)
              clearEditFieldError('amount')
            }}
            disabled={pending}
            required
            aria-invalid={amountError !== null}
            aria-describedby={
              amountError !== null ? `${base}-amount-error` : undefined
            }
          />
          {amountError !== null && (
            <ul id={`${base}-amount-error`} className="field-errors">
              {fieldErrors?.amount?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor={`${base}-date`}>Edit transaction date</label>
          <input
            id={`${base}-date`}
            className="input"
            type="date"
            name="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value)
              clearEditFieldError('date')
            }}
            disabled={pending}
            required
            aria-invalid={dateError !== null}
            aria-describedby={
              dateError !== null ? `${base}-date-error` : undefined
            }
          />
          {dateError !== null && (
            <ul id={`${base}-date-error`} className="field-errors">
              {fieldErrors?.date?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor={`${base}-note`}>Edit transaction note</label>
          <input
            id={`${base}-note`}
            className="input"
            type="text"
            name="note"
            autoComplete="off"
            value={note}
            onChange={(event) => {
              setNote(event.target.value)
              clearEditFieldError('note')
            }}
            disabled={pending}
            aria-invalid={noteError !== null}
            aria-describedby={
              noteError !== null ? `${base}-note-error` : undefined
            }
          />
          {noteError !== null && (
            <ul id={`${base}-note-error`} className="field-errors">
              {fieldErrors?.note?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="transaction-edit-actions">
          <button type="submit" className="btn" disabled={pending}>
            {pending ? 'Updating transaction…' : 'Save changes'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </button>
        </div>
      </form>
    </li>
  )
}

function CreateTransactionForm({
  accounts,
  categories,
  onCreated,
  submitLocked,
}: {
  accounts: Account[]
  categories: Category[]
  onCreated: () => void
  submitLocked: boolean
}) {
  const { clearSession } = useAuth()
  const [account, setAccount] = useState('')
  const [category, setCategory] = useState('')
  const [transactionType, setTransactionType] =
    useState<TransactionType>('expense')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(() => getLocalToday())
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [created, setCreated] = useState(false)
  const mountedRef = useRef(true)
  const submittingRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  function clearCreateFieldError(field: string): void {
    setFieldErrors((current) => {
      if (current === null || current[field] === undefined) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  const activeAccounts = accounts.filter((item) => !item.is_archived)
  const visibleCategories = categories.filter(
    (item) => !item.is_archived && item.category_type === transactionType,
  )

  function handleTypeChange(value: string): void {
    const next = value as TransactionType
    setTransactionType(next)
    clearCreateFieldError('transaction_type')
    clearCreateFieldError('category')
    setCategory((current) => {
      if (current === '') return current
      const selected = categories.find((item) => String(item.id) === current)
      if (selected !== undefined && selected.category_type !== next) return ''
      return current
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitLocked) return
    if (submittingRef.current) return
    if (pending) return
    setSubmitError(null)
    setCreated(false)

    const clientErrors = validateCreateFields(
      account,
      category,
      transactionType,
      amount,
      date,
      accounts,
      categories,
    )
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      return
    }

    setFieldErrors(null)
    submittingRef.current = true
    setPending(true)
    try {
      await createTransaction({
        account: Number(account),
        category: Number(category),
        transaction_type: transactionType as TransactionType,
        amount,
        date,
        note,
      })
      if (mountedRef.current) {
        setAccount('')
        setCategory('')
        setTransactionType('expense')
        setAmount('')
        setDate(getLocalToday())
        setNote('')
        setCreated(true)
        onCreated()
      }
    } catch (caught) {
      if (!mountedRef.current) return
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession()
        return
      }
      if (caught instanceof ApiError) {
        const backendFields = caught.fieldErrors ?? {}
        const known: FieldErrors = {}
        for (const field of KNOWN_CREATE_FIELDS) {
          const messages = backendFields[field]
          if (messages !== undefined && messages.length > 0) {
            known[field] = [...messages]
          }
        }
        const nonFieldMessage = backendFields.non_field_errors?.[0]
        if (Object.keys(known).length > 0 || nonFieldMessage !== undefined) {
          setFieldErrors(Object.keys(known).length > 0 ? known : null)
          setSubmitError(nonFieldMessage ?? null)
          return
        }
        setSubmitError(userMessage(caught))
        return
      }
      setSubmitError(GENERIC_ERROR_MESSAGE)
    } finally {
      if (mountedRef.current) {
        submittingRef.current = false
        setPending(false)
      }
    }
  }

  const accountError = firstCreateError(fieldErrors, 'account')
  const categoryError = firstCreateError(fieldErrors, 'category')
  const typeError = firstCreateError(fieldErrors, 'transaction_type')
  const amountError = firstCreateError(fieldErrors, 'amount')
  const dateError = firstCreateError(fieldErrors, 'date')
  const noteError = firstCreateError(fieldErrors, 'note')
  const hasFieldErrors =
    accountError !== null ||
    categoryError !== null ||
    typeError !== null ||
    amountError !== null ||
    dateError !== null ||
    noteError !== null
  const summary = submitError ?? (hasFieldErrors ? FIELD_ERROR_SUMMARY : null)
  const hasActiveAccounts = activeAccounts.length > 0
  const hasVisibleCategories = visibleCategories.length > 0
  const submitDisabled =
    pending || submitLocked || !hasActiveAccounts || !hasVisibleCategories

  return (
    <section
      className="transaction-create"
      aria-labelledby="transaction-create-heading"
    >
      <h3 id="transaction-create-heading">Add transaction</h3>
      {created && (
        <p role="status" className="notice">
          Transaction created.
        </p>
      )}
      {pending && (
        <p role="status" className="notice">
          Creating transaction…
        </p>
      )}
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      {!hasActiveAccounts && (
        <p className="notice">{NO_ACTIVE_ACCOUNTS_MESSAGE}</p>
      )}
      {hasActiveAccounts && !hasVisibleCategories && (
        <p className="notice">{NO_ACTIVE_CATEGORIES_MESSAGE}</p>
      )}
      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor="create-transaction-account">
            New transaction account
          </label>
          <select
            id="create-transaction-account"
            className="select"
            name="account"
            value={account}
            onChange={(event) => {
              setAccount(event.target.value)
              clearCreateFieldError('account')
            }}
            disabled={pending}
            required
            aria-invalid={accountError !== null}
            aria-describedby={
              accountError !== null
                ? 'create-transaction-account-error'
                : undefined
            }
          >
            <option value="">Select an account</option>
            {activeAccounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {accountError !== null && (
            <ul id="create-transaction-account-error" className="field-errors">
              {fieldErrors?.account?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-transaction-type">New transaction type</label>
          <select
            id="create-transaction-type"
            className="select"
            name="transaction_type"
            value={transactionType}
            onChange={(event) => handleTypeChange(event.target.value)}
            disabled={pending}
            required
            aria-invalid={typeError !== null}
            aria-describedby={
              typeError !== null ? 'create-transaction-type-error' : undefined
            }
          >
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
          {typeError !== null && (
            <ul id="create-transaction-type-error" className="field-errors">
              {fieldErrors?.transaction_type?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-transaction-category">
            New transaction category
          </label>
          <select
            id="create-transaction-category"
            className="select"
            name="category"
            value={category}
            onChange={(event) => {
              setCategory(event.target.value)
              clearCreateFieldError('category')
            }}
            disabled={pending}
            required
            aria-invalid={categoryError !== null}
            aria-describedby={
              categoryError !== null
                ? 'create-transaction-category-error'
                : undefined
            }
          >
            <option value="">Select a category</option>
            {visibleCategories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {categoryError !== null && (
            <ul id="create-transaction-category-error" className="field-errors">
              {fieldErrors?.category?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-transaction-amount">Amount</label>
          <input
            id="create-transaction-amount"
            className="input"
            type="text"
            inputMode="decimal"
            name="amount"
            autoComplete="off"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value)
              clearCreateFieldError('amount')
            }}
            disabled={pending}
            required
            aria-invalid={amountError !== null}
            aria-describedby={
              amountError !== null
                ? 'create-transaction-amount-error'
                : undefined
            }
          />
          {amountError !== null && (
            <ul id="create-transaction-amount-error" className="field-errors">
              {fieldErrors?.amount?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-transaction-date">Date</label>
          <input
            id="create-transaction-date"
            className="input"
            type="date"
            name="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value)
              clearCreateFieldError('date')
            }}
            disabled={pending}
            required
            aria-invalid={dateError !== null}
            aria-describedby={
              dateError !== null ? 'create-transaction-date-error' : undefined
            }
          />
          {dateError !== null && (
            <ul id="create-transaction-date-error" className="field-errors">
              {fieldErrors?.date?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-transaction-note">Note</label>
          <input
            id="create-transaction-note"
            className="input"
            type="text"
            name="note"
            autoComplete="off"
            value={note}
            onChange={(event) => {
              setNote(event.target.value)
              clearCreateFieldError('note')
            }}
            disabled={pending}
            aria-invalid={noteError !== null}
            aria-describedby={
              noteError !== null ? 'create-transaction-note-error' : undefined
            }
          />
          {noteError !== null && (
            <ul id="create-transaction-note-error" className="field-errors">
              {fieldErrors?.note?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn" disabled={submitDisabled}>
          {pending ? 'Creating transaction…' : 'Create transaction'}
        </button>
      </form>
    </section>
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
  const [editingId, setEditingId] = useState<number | null>(null)
  const [updateNotice, setUpdateNotice] = useState<string | null>(null)
  const [editPending, setEditPending] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const metaPromiseRef = useRef<Promise<[Account[], Category[]]> | null>(null)
  const requestSeqRef = useRef(0)
  const mountedRef = useRef(true)
  const filtersRef = useRef<TransactionFilters>({})
  const editingIdRef = useRef<number | null>(null)
  const stateRef = useRef<TransactionsState>({ status: 'loading' })
  type ReturnFocusTarget =
    | { kind: 'edit'; id: number }
    | { kind: 'delete'; id: number }
    | { kind: 'heading' }
  const returnFocusRef = useRef<ReturnFocusTarget | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    filtersRef.current = filters
  }, [filters])
  useEffect(() => {
    editingIdRef.current = editingId
  }, [editingId])
  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (
      editingId === null &&
      deletingId === null &&
      returnFocusRef.current !== null
    ) {
      const target = returnFocusRef.current
      returnFocusRef.current = null
      if (target.kind === 'heading') {
        headingRef.current?.focus()
        return
      }
      const label =
        target.kind === 'edit'
          ? `Edit transaction ${target.id}`
          : `Delete transaction ${target.id}`
      const element = document.querySelector(`[aria-label="${label}"]`)
      if (element instanceof HTMLElement) {
        element.focus()
      }
    }
  }, [editingId, deletingId])

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
        setRefreshing(false)
        const currentEditingId = editingIdRef.current
        if (
          currentEditingId !== null &&
          !transactions.some((item) => item.id === currentEditingId)
        ) {
          editingIdRef.current = null
          setEditingId(null)
          setEditPending(false)
        }
      })
      .catch((error: unknown) => {
        if (cancelled || !mountedRef.current || seq !== requestSeqRef.current) {
          return
        }
        if (error instanceof ApiError && error.status === 401) {
          clearSession()
          return
        }
        setRefreshing(false)
        setUpdateNotice(null)
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
    setUpdateNotice(null)
    if (stateRef.current.status === 'ready') {
      setRefreshing(true)
    } else {
      setState({ status: 'loading' })
    }
    filtersRef.current = next
    setFilters(next)
  }

  const handleRetry = useCallback(() => {
    setUpdateNotice(null)
    if (stateRef.current.status === 'ready') {
      setRefreshing(true)
    } else {
      setState({ status: 'loading' })
    }
    setAttempt((current) => current + 1)
  }, [])

  const handleTransactionCreated = useCallback(() => {
    setUpdateNotice(null)
    if (stateRef.current.status === 'ready') {
      setRefreshing(true)
    }
    requestSeqRef.current += 1
    resetTransactionsRequest()
    setAttempt((current) => current + 1)
  }, [])

  const handleEditOpen = useCallback((id: number) => {
    setEditingId(id)
  }, [])

  const handleEditCancel = useCallback((id: number) => {
    returnFocusRef.current = { kind: 'edit', id }
    setEditingId(null)
    setEditPending(false)
  }, [])

  const handleEditPendingChange = useCallback((pending: boolean) => {
    setEditPending(pending)
  }, [])

  const handleDeleteOpen = useCallback((id: number) => {
    setDeletingId(id)
  }, [])

  const handleDeleteCancel = useCallback((id: number) => {
    returnFocusRef.current = { kind: 'delete', id }
    setDeletingId(null)
    setDeletePending(false)
  }, [])

  const handleDeletePendingChange = useCallback((pending: boolean) => {
    setDeletePending(pending)
  }, [])

  const handleDeleteDeleted = useCallback((id: number) => {
    setState((current) => {
      if (current.status !== 'ready') return current
      return {
        status: 'ready',
        transactions: current.transactions.filter((item) => item.id !== id),
      }
    })
    setDeletingId(null)
    setDeletePending(false)
    returnFocusRef.current = { kind: 'heading' }
    setUpdateNotice('Transaction deleted.')
  }, [])

  const handleEditUpdated = useCallback((updated: Transaction) => {
    const currentFilters = filtersRef.current
    const matches = transactionMatchesFilters(updated, currentFilters)
    setState((current) => {
      if (current.status !== 'ready') return current
      if (!matches) {
        return {
          status: 'ready',
          transactions: current.transactions.filter(
            (item) => item.id !== updated.id,
          ),
        }
      }
      return {
        status: 'ready',
        transactions: current.transactions.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      }
    })
    setEditingId(null)
    setEditPending(false)
    returnFocusRef.current = matches
      ? { kind: 'edit', id: updated.id }
      : { kind: 'heading' }
    setUpdateNotice('Transaction updated.')
  }, [])

  const accountById = new Map(accounts.map((account) => [account.id, account]))
  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  )
  const hasSyncedTransactions =
    state.status === 'ready' &&
    state.transactions.some((transaction) => transaction.source === 'plaid')
  const filtersLocked =
    editPending || editingId !== null || deletePending || deletingId !== null
  const rowLocked =
    editPending ||
    deletePending ||
    refreshing ||
    editingId !== null ||
    deletingId !== null

  return (
    <div className="screen">
      <h2 ref={headingRef} tabIndex={-1}>
        Transactions
      </h2>
      <CreateTransactionForm
        accounts={accounts}
        categories={categories}
        onCreated={handleTransactionCreated}
        submitLocked={filtersLocked}
      />
      <section
        className="transaction-filters"
        aria-describedby={
          editingId !== null || deletingId !== null
            ? 'transactions-filters-locked-hint'
            : undefined
        }
      >
        {editingId !== null && (
          <p id="transactions-filters-locked-hint" className="notice">
            Finish or cancel your edit to change filters.
          </p>
        )}
        {editingId === null && deletingId !== null && (
          <p id="transactions-filters-locked-hint" className="notice">
            Finish or cancel your deletion to change filters.
          </p>
        )}
        <div className="form-field">
          <label htmlFor="transactions-account">Account</label>
          <select
            id="transactions-account"
            className="select"
            name="account"
            value={draft.account}
            onChange={(event) => handleDraftChange({ account: event.target.value })}
            disabled={filtersLocked}
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
            disabled={filtersLocked}
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
            disabled={filtersLocked}
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
            disabled={filtersLocked}
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
            disabled={filtersLocked}
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
      {refreshing && state.status === 'ready' && (
        <p role="status">Updating results…</p>
      )}
      {state.status === 'error' && (
        <div className="error-summary" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      {updateNotice !== null && state.status === 'ready' && (
        <p role="status" className="notice">
          {updateNotice}
        </p>
      )}
      {hasSyncedTransactions && (
        <p className="transaction-retention-note">
          Bank-synced transactions are kept for the audit trail and cannot be
          deleted.
        </p>
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
            {state.transactions.map((transaction) =>
              editingId === transaction.id ? (
                <EditTransactionForm
                  key={transaction.id}
                  transaction={transaction}
                  accounts={accounts}
                  categories={categories}
                  onCancel={() => handleEditCancel(transaction.id)}
                  onUpdated={handleEditUpdated}
                  onPendingChange={handleEditPendingChange}
                />
              ) : deletingId === transaction.id ? (
                <DeleteTransactionConfirm
                  key={transaction.id}
                  transaction={transaction}
                  accountName={accountById.get(transaction.account)?.name}
                  categoryName={categoryById.get(transaction.category)?.name}
                  onCancel={() => handleDeleteCancel(transaction.id)}
                  onDeleted={handleDeleteDeleted}
                  onPendingChange={handleDeletePendingChange}
                />
              ) : (
                <TransactionItem
                  key={transaction.id}
                  transaction={transaction}
                  accountById={accountById}
                  categoryById={categoryById}
                  editDisabled={rowLocked}
                  deleteDisabled={rowLocked}
                  onEdit={() => handleEditOpen(transaction.id)}
                  onDelete={() => handleDeleteOpen(transaction.id)}
                />
              ),
            )}
          </ul>
        ))}
    </div>
  )
}