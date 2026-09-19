import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  archiveAccount,
  createAccount,
  fetchAccounts,
  updateAccount,
  type Account,
  type AccountType,
} from '../api/accounts'
import { ApiError, userMessage, type FieldErrors } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatMoney, isDecimalString, sumMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const FIELD_ERROR_SUMMARY = 'Please check the highlighted fields.'

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit card',
}

const ACCOUNT_TYPE_MARKS: Record<AccountType, string> = {
  checking: 'CK',
  savings: 'SV',
  cash: '$',
  credit_card: 'CC',
}

const ACCOUNT_TYPES: ReadonlySet<string> = new Set(Object.keys(ACCOUNT_TYPE_LABELS))

const NAME_ERROR_BLANK = 'Enter a name for this account.'
const NAME_ERROR_LONG = 'Name must be 100 characters or fewer.'
const ACCOUNT_TYPE_ERROR = 'Choose an account type.'
const OPENING_ERROR =
  'Enter an amount with exactly 2 decimals and at most 10 integer digits.'
// A synced account with an unanchored link reports 0.00 for both balances as a
// placeholder: the current balance is forced to zero, and the opening balance is
// only derived once the anchor is applied. Showing those zeros would present a
// fabricated balance as a real one, so the figures are replaced by a word that
// cannot be mistaken for money.
const PENDING_BALANCE_TEXT = 'Pending'

const STATUS_ACTIVE = 'Active'
const STATUS_BALANCE_PENDING = 'Balance pending'
const STATUS_ARCHIVED = 'Archived'

type AccountsState =
  | { status: 'loading' }
  | { status: 'ready'; accounts: Account[] }
  | { status: 'error'; message: string }

function isAccountType(value: string): value is AccountType {
  return ACCOUNT_TYPES.has(value)
}

function isValidOpeningBalance(value: string): boolean {
  if (!isDecimalString(value)) return false
  const integerPart = value.replace(/^-/, '').split('.')[0]
  return integerPart.length <= 10
}

function validateAccountFields(
  name: string,
  accountType: string,
  opening: string,
): FieldErrors {
  const errors: FieldErrors = {}
  if (name === '') {
    errors.name = [NAME_ERROR_BLANK]
  } else if (name.length > 100) {
    errors.name = [NAME_ERROR_LONG]
  }
  if (!isAccountType(accountType)) {
    errors.account_type = [ACCOUNT_TYPE_ERROR]
  }
  if (!isValidOpeningBalance(opening)) {
    errors.opening_balance = [OPENING_ERROR]
  }
  return errors
}

const KNOWN_FIELDS = ['name', 'account_type', 'opening_balance'] as const

function firstKnownFieldError(fieldErrors: FieldErrors): string | null {
  for (const field of KNOWN_FIELDS) {
    const messages = fieldErrors[field]
    if (messages !== undefined && messages.length > 0) return messages[0]
  }
  return null
}

function firstError(fieldErrors: FieldErrors | null, field: string): string | null {
  const messages = fieldErrors?.[field]
  return messages !== undefined && messages.length > 0 ? messages[0] : null
}

// Every loaded account belongs to exactly one partition. Archived wins over
// pending, and both are mutually exclusive with ready.
function accountStatus(account: Account): string {
  if (account.is_archived) return STATUS_ARCHIVED
  if (account.sync_pending) return STATUS_BALANCE_PENDING
  return STATUS_ACTIVE
}

function isNegative(value: string): boolean {
  return value.startsWith('-')
}

function sectionCountLabel(count: number): string {
  return count === 1 ? '1 account' : `${count} accounts`
}

function EditAccountForm({
  account,
  onUpdated,
  onCancelled,
}: {
  account: Account
  onUpdated: (account: Account) => void
  onCancelled: () => void
}) {
  const { clearSession } = useAuth()
  const [name, setName] = useState(account.name)
  const [accountType, setAccountType] = useState<AccountType>(account.account_type)
  const [opening, setOpening] = useState(account.opening_balance)
  const [pending, setPending] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setSubmitError(null)

    const trimmedName = name.trim()
    const clientErrors = validateAccountFields(trimmedName, accountType, opening)
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      return
    }

    setFieldErrors(null)
    setPending(true)
    try {
      const updated = await updateAccount(account.id, {
        name: trimmedName,
        account_type: accountType,
        opening_balance: opening,
      })
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
        if (Object.keys(caught.fieldErrors).length > 0) {
          setFieldErrors(caught.fieldErrors)
          if (firstKnownFieldError(caught.fieldErrors) === null) {
            const nonFieldMessage = caught.fieldErrors.non_field_errors?.[0]
            setSubmitError(nonFieldMessage ?? GENERIC_ERROR_MESSAGE)
          }
        } else {
          setSubmitError(userMessage(caught))
        }
      } else {
        setSubmitError(GENERIC_ERROR_MESSAGE)
      }
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  const nameError = firstError(fieldErrors, 'name')
  const accountTypeError = firstError(fieldErrors, 'account_type')
  const openingError = firstError(fieldErrors, 'opening_balance')
  const hasFieldErrors =
    nameError !== null || accountTypeError !== null || openingError !== null
  const summary =
    submitError ?? (hasFieldErrors ? FIELD_ERROR_SUMMARY : null)

  return (
    <div className="accounts-edit">
      <h3 id="edit-account-heading">Edit account</h3>
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      <form
        className="form"
        aria-labelledby="edit-account-heading"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="form-field">
          <label htmlFor="edit-account-name">Name</label>
          <input
            id="edit-account-name"
            className="input"
            type="text"
            name="name"
            autoComplete="off"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            aria-invalid={nameError !== null}
            aria-describedby={
              nameError !== null ? 'edit-account-name-error' : undefined
            }
          />
          {nameError !== null && (
            <ul id="edit-account-name-error" className="field-errors">
              {fieldErrors?.name.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="edit-account-type">Account type</label>
          <select
            id="edit-account-type"
            className="select"
            name="account_type"
            value={accountType}
            onChange={(event) => setAccountType(event.target.value as AccountType)}
            disabled={pending}
            aria-invalid={accountTypeError !== null}
            aria-describedby={
              accountTypeError !== null ? 'edit-account-type-error' : undefined
            }
          >
            {Object.keys(ACCOUNT_TYPE_LABELS).map((type) => (
              <option key={type} value={type}>
                {ACCOUNT_TYPE_LABELS[type as AccountType]}
              </option>
            ))}
          </select>
          {accountTypeError !== null && (
            <ul id="edit-account-type-error" className="field-errors">
              {fieldErrors?.account_type.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="edit-account-opening">Opening balance</label>
          <input
            id="edit-account-opening"
            className="input"
            type="text"
            inputMode="decimal"
            name="opening_balance"
            autoComplete="off"
            value={opening}
            onChange={(event) => setOpening(event.target.value)}
            disabled={pending}
            aria-invalid={openingError !== null}
            aria-describedby={
              openingError !== null ? 'edit-account-opening-error' : undefined
            }
          />
          {openingError !== null && (
            <ul id="edit-account-opening-error" className="field-errors">
              {fieldErrors?.opening_balance.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="accounts-edit-actions">
          <button type="submit" className="btn" disabled={pending}>
            {pending ? 'Saving account…' : 'Save'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onCancelled}
            disabled={pending}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}

function ArchiveAccountConfirm({
  account,
  onArchived,
  onCancelled,
}: {
  account: Account
  onArchived: (accountId: number) => void
  onCancelled: () => void
}) {
  const { clearSession } = useAuth()
  const [pending, setPending] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function handleConfirm() {
    if (pending) return
    setErrorMessage(null)
    setPending(true)
    try {
      await archiveAccount(account.id)
      if (mountedRef.current) {
        onArchived(account.id)
      }
    } catch (caught) {
      if (!mountedRef.current) return
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession()
        return
      }
      setErrorMessage(
        caught instanceof ApiError ? userMessage(caught) : GENERIC_ERROR_MESSAGE,
      )
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  return (
    <div
      className="accounts-archive"
      role="group"
      aria-labelledby="archive-account-heading"
    >
      <h3 id="archive-account-heading">Archive account</h3>
      <p>{account.name} will be archived, not deleted.</p>
      <p>Historical transactions remain available.</p>
      {pending && (
        <p role="status" className="notice">
          Archiving account…
        </p>
      )}
      {errorMessage !== null && (
        <div className="error-summary" role="alert">
          {errorMessage}
        </div>
      )}
      <div className="accounts-archive-actions">
        <button
          type="button"
          className="btn"
          aria-label={`Confirm archive ${account.name}`}
          onClick={handleConfirm}
          disabled={pending}
        >
          {pending ? 'Archiving account…' : 'Archive'}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onCancelled}
          disabled={pending}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function AccountItem({
  account,
  editing,
  archiving,
  onEdit,
  onArchiveRequest,
  onUpdated,
  onCancelled,
  onArchived,
  onArchiveCancelled,
}: {
  account: Account
  editing: boolean
  archiving: boolean
  onEdit: () => void
  onArchiveRequest: () => void
  onUpdated: (account: Account) => void
  onCancelled: () => void
  onArchived: (accountId: number) => void
  onArchiveCancelled: () => void
}) {
  if (editing) {
    return (
      <li className="accounts-item" id={`account-${account.id}`}>
        <EditAccountForm
          account={account}
          onUpdated={onUpdated}
          onCancelled={onCancelled}
        />
      </li>
    )
  }
  if (archiving) {
    return (
      <li className="accounts-item" id={`account-${account.id}`}>
        <ArchiveAccountConfirm
          account={account}
          onArchived={onArchived}
          onCancelled={onArchiveCancelled}
        />
      </li>
    )
  }
  const status = accountStatus(account)
  return (
    <li className="accounts-item" id={`account-${account.id}`}>
      <div className="accounts-card">
        <div className="accounts-card-head">
          <span className="accounts-type-mark" aria-hidden="true">
            {ACCOUNT_TYPE_MARKS[account.account_type]}
          </span>
          <div className="accounts-identity">
            <h4 className="accounts-name">{account.name}</h4>
            <p className="accounts-meta">
              <span className="accounts-type">
                {ACCOUNT_TYPE_LABELS[account.account_type]}
              </span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  status === STATUS_BALANCE_PENDING
                    ? 'accounts-status accounts-status-pending'
                    : 'accounts-status'
                }
              >
                {status}
              </span>
            </p>
          </div>
        </div>
        <dl className="accounts-balances">
          <div className="accounts-balance">
            <dt>Current balance</dt>
            <dd
              className={
                !account.sync_pending && isNegative(account.current_balance)
                  ? 'accounts-balance-value accounts-balance-value-negative'
                  : 'accounts-balance-value'
              }
            >
              {account.sync_pending
                ? PENDING_BALANCE_TEXT
                : formatMoney(account.current_balance)}
            </dd>
          </div>
          <div className="accounts-balance">
            <dt>Opening balance</dt>
            <dd
              className={
                !account.sync_pending && isNegative(account.opening_balance)
                  ? 'accounts-balance-value accounts-balance-value-negative'
                  : 'accounts-balance-value'
              }
            >
              {account.sync_pending
                ? PENDING_BALANCE_TEXT
                : formatMoney(account.opening_balance)}
            </dd>
          </div>
        </dl>
        {account.sync_pending && (
          <p
            id={`account-balance-pending-${account.id}`}
            className="accounts-pending-note"
          >
            Balances are temporarily excluded while transaction history
            finishes and the opening balance is anchored.
          </p>
        )}
        <div className="accounts-actions">
          <button
            type="button"
            className="btn btn-secondary"
            data-account-edit
            aria-label={`Edit ${account.name}`}
            aria-describedby={
              account.sync_pending
                ? `account-balance-pending-${account.id}`
                : undefined
            }
            disabled={account.sync_pending}
            onClick={onEdit}
          >
            Edit
          </button>
          {!account.is_archived && (
            <button
              type="button"
              className="btn btn-secondary"
              aria-label={`Archive ${account.name}`}
              onClick={onArchiveRequest}
            >
              Archive
            </button>
          )}
        </div>
      </div>
    </li>
  )
}

function CreateAccountForm({ onCreated }: { onCreated: (account: Account) => void }) {
  const { clearSession } = useAuth()
  const [name, setName] = useState('')
  const [accountType, setAccountType] = useState<AccountType>('checking')
  const [opening, setOpening] = useState('0.00')
  const [pending, setPending] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [created, setCreated] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setSubmitError(null)
    setCreated(false)

    const trimmedName = name.trim()
    const clientErrors = validateAccountFields(trimmedName, accountType, opening)
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      return
    }

    setFieldErrors(null)
    setPending(true)
    try {
      const account = await createAccount(trimmedName, accountType, opening)
      if (mountedRef.current) {
        onCreated(account)
        setName('')
        setAccountType('checking')
        setOpening('0.00')
        setCreated(true)
      }
    } catch (caught) {
      if (!mountedRef.current) return
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession()
        return
      }
      if (caught instanceof ApiError) {
        if (Object.keys(caught.fieldErrors).length > 0) {
          setFieldErrors(caught.fieldErrors)
          if (firstKnownFieldError(caught.fieldErrors) === null) {
            const nonFieldMessage = caught.fieldErrors.non_field_errors?.[0]
            setSubmitError(nonFieldMessage ?? GENERIC_ERROR_MESSAGE)
          }
        } else {
          setSubmitError(userMessage(caught))
        }
      } else {
        setSubmitError(GENERIC_ERROR_MESSAGE)
      }
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  const nameError = firstError(fieldErrors, 'name')
  const accountTypeError = firstError(fieldErrors, 'account_type')
  const openingError = firstError(fieldErrors, 'opening_balance')
  const hasFieldErrors =
    nameError !== null || accountTypeError !== null || openingError !== null
  const summary =
    submitError ?? (hasFieldErrors ? FIELD_ERROR_SUMMARY : null)

  return (
    <section
      className="accounts-create-card"
      id="account-create"
      aria-labelledby="account-create-heading"
    >
      <h3 id="account-create-heading">Add account</h3>
      {created && (
        <p role="status" className="notice">
          Account created.
        </p>
      )}
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor="create-account-name">Name</label>
          <input
            id="create-account-name"
            className="input"
            type="text"
            name="name"
            autoComplete="off"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            aria-invalid={nameError !== null}
            aria-describedby={
              nameError !== null ? 'create-account-name-error' : undefined
            }
          />
          {nameError !== null && (
            <ul id="create-account-name-error" className="field-errors">
              {fieldErrors?.name.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-account-type">Account type</label>
          <select
            id="create-account-type"
            className="select"
            name="account_type"
            value={accountType}
            onChange={(event) => setAccountType(event.target.value as AccountType)}
            disabled={pending}
            aria-invalid={accountTypeError !== null}
            aria-describedby={
              accountTypeError !== null ? 'create-account-type-error' : undefined
            }
          >
            {Object.keys(ACCOUNT_TYPE_LABELS).map((type) => (
              <option key={type} value={type}>
                {ACCOUNT_TYPE_LABELS[type as AccountType]}
              </option>
            ))}
          </select>
          {accountTypeError !== null && (
            <ul id="create-account-type-error" className="field-errors">
              {fieldErrors?.account_type.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-account-opening">Opening balance</label>
          <input
            id="create-account-opening"
            className="input"
            type="text"
            inputMode="decimal"
            name="opening_balance"
            autoComplete="off"
            value={opening}
            onChange={(event) => setOpening(event.target.value)}
            disabled={pending}
            aria-invalid={openingError !== null}
            aria-describedby={
              openingError !== null ? 'create-account-opening-error' : undefined
            }
          />
          {openingError !== null && (
            <ul id="create-account-opening-error" className="field-errors">
              {fieldErrors?.opening_balance.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </section>
  )
}

function AccountsSummary({
  accounts,
}: {
  accounts: Account[]
}) {
  const ready = accounts.filter((account) => !account.is_archived && !account.sync_pending)
  const pending = accounts.filter((account) => !account.is_archived && account.sync_pending)
  const archived = accounts.filter((account) => account.is_archived)
  const activeBalance = sumMoney(ready.map((account) => account.current_balance))
  return (
    <section
      className="accounts-summary"
      aria-labelledby="accounts-summary-heading"
    >
      <h2 id="accounts-summary-heading" className="accounts-summary-heading">
        Summary
      </h2>
      <dl className="accounts-summary-grid">
        <div className="accounts-summary-total">
          <dt>Active balance</dt>
          <dd
            className={
              isNegative(activeBalance)
                ? 'accounts-summary-total-value accounts-summary-total-value-negative'
                : 'accounts-summary-total-value'
            }
          >
            {formatMoney(activeBalance)}
          </dd>
          <dd className="accounts-summary-note">
            Excludes archived and pending accounts.
          </dd>
        </div>
        <div className="accounts-summary-count">
          <dt>Ready count</dt>
          <dd className="accounts-summary-count-value">{ready.length}</dd>
        </div>
        <div className="accounts-summary-count">
          <dt>Pending count</dt>
          <dd className="accounts-summary-count-value">{pending.length}</dd>
        </div>
        <div className="accounts-summary-count">
          <dt>Archived count</dt>
          <dd className="accounts-summary-count-value">{archived.length}</dd>
        </div>
      </dl>
    </section>
  )
}

function AccountList({
  accounts,
  editingId,
  archivingId,
  onEdit,
  onArchiveRequest,
  onUpdated,
  onCancelled,
  onArchived,
  onArchiveCancelled,
}: {
  accounts: Account[]
  editingId: number | null
  archivingId: number | null
  onEdit: (accountId: number) => void
  onArchiveRequest: (accountId: number) => void
  onUpdated: (account: Account) => void
  onCancelled: () => void
  onArchived: (accountId: number) => void
  onArchiveCancelled: () => void
}) {
  return (
    <ul className="accounts-list">
      {accounts.map((account) => (
        <AccountItem
          key={account.id}
          account={account}
          editing={editingId === account.id}
          archiving={archivingId === account.id}
          onEdit={() => onEdit(account.id)}
          onArchiveRequest={() => onArchiveRequest(account.id)}
          onUpdated={onUpdated}
          onCancelled={onCancelled}
          onArchived={onArchived}
          onArchiveCancelled={onArchiveCancelled}
        />
      ))}
    </ul>
  )
}

export function AccountsScreen() {
  const { clearSession } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<AccountsState>({ status: 'loading' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [archivingId, setArchivingId] = useState<number | null>(null)
  const [updatedNotice, setUpdatedNotice] = useState(false)
  const [archivedNotice, setArchivedNotice] = useState(false)
  const [focusAfterArchiveId, setFocusAfterArchiveId] = useState<number | null>(null)

  useEffect(() => {
    if (focusAfterArchiveId === null) return
    const archivedRow = document.getElementById(`account-${focusAfterArchiveId}`)
    archivedRow?.querySelector<HTMLButtonElement>('[data-account-edit]')?.focus()
  }, [focusAfterArchiveId])

  useEffect(() => {
    let cancelled = false
    void fetchAccounts()
      .then((accounts) => {
        if (cancelled) return
        setState({ status: 'ready', accounts })
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
  }, [attempt, clearSession])

  const handleCreated = useCallback((account: Account) => {
    setState((current) => {
      if (current.status === 'ready') {
        return { status: 'ready', accounts: [...current.accounts, account] }
      }
      if (current.status === 'loading') {
        return { status: 'ready', accounts: [account] }
      }
      return current
    })
  }, [])

  const handleEdit = useCallback((accountId: number) => {
    setEditingId(accountId)
    setArchivingId(null)
    setUpdatedNotice(false)
    setArchivedNotice(false)
  }, [])

  const handleCancelled = useCallback(() => {
    setEditingId(null)
  }, [])

  const handleArchiveRequest = useCallback((accountId: number) => {
    setArchivingId(accountId)
    setEditingId(null)
    setUpdatedNotice(false)
    setArchivedNotice(false)
  }, [])

  const handleArchiveCancelled = useCallback(() => {
    setArchivingId(null)
  }, [])

  const handleArchived = useCallback((accountId: number) => {
    setState((current) => {
      if (current.status !== 'ready') return current
      const index = current.accounts.findIndex(
        (account) => account.id === accountId,
      )
      if (index === -1) return current
      const accounts = [...current.accounts]
      accounts[index] = { ...accounts[index], is_archived: true }
      return { status: 'ready', accounts }
    })
    setArchivingId(null)
    setArchivedNotice(true)
    setFocusAfterArchiveId(accountId)
  }, [])

  const handleUpdated = useCallback((updated: Account) => {
    setState((current) => {
      if (current.status !== 'ready') return current
      const index = current.accounts.findIndex((account) => account.id === updated.id)
      if (index === -1) return current
      const accounts = [...current.accounts]
      accounts[index] = updated
      return { status: 'ready', accounts }
    })
    setEditingId(null)
    setUpdatedNotice(true)
  }, [])

  const handleRetry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((current) => current + 1)
  }, [])

  if (state.status === 'loading') {
    return (
      <div className="screen">
        <h2>Accounts</h2>
        <p role="status">Loading your accounts…</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="screen">
        <h2>Accounts</h2>
        <div className="error-summary" role="alert">
          <p>{state.message}</p>
          <button
            type="button"
            className="btn"
            onClick={handleRetry}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  const { accounts } = state
  const collectionAccounts = accounts.filter((account) => !account.is_archived)
  const archived = accounts.filter((account) => account.is_archived)

  return (
    <div className="screen">
      <header className="accounts-header">
        <p className="accounts-eyebrow">ACCOUNTS</p>
        <h2>Accounts</h2>
        <p className="accounts-subtitle">
          Your current balances, without the guesswork.
        </p>
        <a className="btn accounts-add-link" href="#account-create">
          Add account
        </a>
      </header>
      <AccountsSummary accounts={accounts} />
      {updatedNotice && (
        <p role="status" className="notice">
          Account updated.
        </p>
      )}
      {archivedNotice && (
        <p role="status" className="notice">
          Account archived.
        </p>
      )}
      <div className="accounts-layout">
        <div className="accounts-collection">
          {accounts.length === 0 ? (
            <p className="accounts-empty">
              No accounts yet. Accounts you create will appear here.
            </p>
          ) : (
            <>
              <section
                className="accounts-section"
                aria-labelledby="active-accounts-heading"
              >
                <div className="accounts-section-head">
                  <h3 id="active-accounts-heading">Active accounts</h3>
                  <p className="accounts-section-count">
                    {sectionCountLabel(collectionAccounts.length)}
                  </p>
                </div>
                {collectionAccounts.length === 0 ? (
                  <p className="accounts-empty-inline">
                    No active accounts yet.
                  </p>
                ) : (
                  <AccountList
                    accounts={collectionAccounts}
                    editingId={editingId}
                    archivingId={archivingId}
                    onEdit={handleEdit}
                    onArchiveRequest={handleArchiveRequest}
                    onUpdated={handleUpdated}
                    onCancelled={handleCancelled}
                    onArchived={handleArchived}
                    onArchiveCancelled={handleArchiveCancelled}
                  />
                )}
              </section>
              {archived.length > 0 && (
                <section
                  className="accounts-section"
                  aria-labelledby="archived-accounts-heading"
                >
                  <div className="accounts-section-head">
                    <h3 id="archived-accounts-heading">Archived accounts</h3>
                    <p className="accounts-section-count">
                      {sectionCountLabel(archived.length)}
                    </p>
                  </div>
                  <AccountList
                    accounts={archived}
                    editingId={editingId}
                    archivingId={archivingId}
                    onEdit={handleEdit}
                    onArchiveRequest={handleArchiveRequest}
                    onUpdated={handleUpdated}
                    onCancelled={handleCancelled}
                    onArchived={handleArchived}
                    onArchiveCancelled={handleArchiveCancelled}
                  />
                </section>
              )}
            </>
          )}
        </div>
        <CreateAccountForm onCreated={handleCreated} />
      </div>
    </div>
  )
}