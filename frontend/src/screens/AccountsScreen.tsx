import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createAccount,
  fetchAccounts,
  updateAccount,
  type Account,
  type AccountType,
} from '../api/accounts'
import { ApiError, userMessage, type FieldErrors } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { isDecimalString, formatMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const FIELD_ERROR_SUMMARY = 'Please check the highlighted fields.'

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit card',
}

const ACCOUNT_TYPES: ReadonlySet<string> = new Set(Object.keys(ACCOUNT_TYPE_LABELS))

const NAME_ERROR_BLANK = 'Enter a name for this account.'
const NAME_ERROR_LONG = 'Name must be 100 characters or fewer.'
const ACCOUNT_TYPE_ERROR = 'Choose an account type.'
const OPENING_ERROR =
  'Enter an amount with exactly 2 decimals and at most 10 integer digits.'

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
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession()
        return
      }
      if (!mountedRef.current) return
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
    <div className="account-edit">
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
        <div className="account-edit-actions">
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

function AccountItem({
  account,
  editing,
  onEdit,
  onUpdated,
  onCancelled,
}: {
  account: Account
  editing: boolean
  onEdit: () => void
  onUpdated: (account: Account) => void
  onCancelled: () => void
}) {
  if (editing) {
    return (
      <li className="account-item">
        <EditAccountForm
          account={account}
          onUpdated={onUpdated}
          onCancelled={onCancelled}
        />
      </li>
    )
  }
  return (
    <li className="account-item">
      <div className="account-main">
        <h3 className="account-name">{account.name}</h3>
        <span className="account-status">
          {account.is_archived ? 'Archived' : 'Active'}
        </span>
      </div>
      <p className="account-type">{ACCOUNT_TYPE_LABELS[account.account_type]}</p>
      <dl className="account-balances">
        <div className="account-balance">
          <dt>Current balance</dt>
          <dd>{formatMoney(account.current_balance)}</dd>
        </div>
        <div className="account-balance">
          <dt>Opening balance</dt>
          <dd>{formatMoney(account.opening_balance)}</dd>
        </div>
      </dl>
      <div className="account-actions">
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={`Edit ${account.name}`}
          onClick={onEdit}
        >
          Edit
        </button>
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
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession()
        return
      }
      if (!mountedRef.current) return
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
    <section className="account-create" aria-labelledby="account-create-heading">
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

export function AccountsScreen() {
  const { clearSession } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<AccountsState>({ status: 'loading' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [updatedNotice, setUpdatedNotice] = useState(false)

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
    setUpdatedNotice(false)
  }, [])

  const handleCancelled = useCallback(() => {
    setEditingId(null)
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

  return (
    <div className="screen">
      <h2>Accounts</h2>
      <CreateAccountForm onCreated={handleCreated} />
      {updatedNotice && (
        <p role="status" className="notice">
          Account updated.
        </p>
      )}
      {state.accounts.length === 0 ? (
        <p className="empty-state">
          No accounts yet. Accounts you create will appear here.
        </p>
      ) : (
        <ul className="account-list">
          {state.accounts.map((account) => (
            <AccountItem
              key={account.id}
              account={account}
              editing={editingId === account.id}
              onEdit={() => handleEdit(account.id)}
              onUpdated={handleUpdated}
              onCancelled={handleCancelled}
            />
          ))}
        </ul>
      )}
    </div>
  )
}