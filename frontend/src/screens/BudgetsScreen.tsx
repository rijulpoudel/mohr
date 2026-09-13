import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createBudget,
  fetchBudgets,
  resetBudgetsRequest,
  type Budget,
} from '../api/budgets'
import { fetchCategories, type Category } from '../api/categories'
import { ApiError, userMessage, type FieldErrors } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatMonthLabel, isValidBudgetMonth } from '../format/month'
import { formatMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const FIELD_ERROR_SUMMARY = 'Please check the highlighted fields.'

const AMOUNT_PATTERN = /^\d+\.\d{2}$/
const ZERO_AMOUNT_PATTERN = /^0+\.00$/
const SIGNED_ZERO_AMOUNT_PATTERN = /^-0+\.00$/

const CREATE_CATEGORY_REQUIRED = 'Choose a category.'
const CREATE_CATEGORY_INVALID = 'Choose an active expense category.'
const CREATE_MONTH_ERROR = 'Enter a real month in YYYY-MM format.'
const CREATE_BUDGETED_ERROR =
  'Enter an amount with exactly 2 decimals and at most 12 digits.'
const NO_ACTIVE_CATEGORIES_MESSAGE =
  'Create an active expense category before adding budgets.'

const KNOWN_CREATE_FIELDS = ['category', 'month', 'budgeted'] as const

type BudgetsState =
  | { status: 'loading' }
  | { status: 'ready'; budgets: Budget[] }
  | { status: 'error'; message: string }

function isValidCreateBudgeted(value: string): boolean {
  if (!AMOUNT_PATTERN.test(value)) return false
  if (ZERO_AMOUNT_PATTERN.test(value)) return false
  return value.length - 1 <= 12
}

function validateCreateFields(
  category: string,
  month: string,
  budgeted: string,
  categories: Category[],
): FieldErrors {
  const errors: FieldErrors = {}
  if (category === '') {
    errors.category = [CREATE_CATEGORY_REQUIRED]
  } else {
    const selected = categories.find((item) => String(item.id) === category)
    if (
      selected === undefined ||
      selected.is_archived ||
      selected.category_type !== 'expense'
    ) {
      errors.category = [CREATE_CATEGORY_INVALID]
    }
  }
  if (!isValidBudgetMonth(month)) {
    errors.month = [CREATE_MONTH_ERROR]
  }
  if (!isValidCreateBudgeted(budgeted)) {
    errors.budgeted = [CREATE_BUDGETED_ERROR]
  }
  return errors
}

function isOverspent(remaining: string): boolean {
  return (
    remaining.startsWith('-') && !SIGNED_ZERO_AMOUNT_PATTERN.test(remaining)
  )
}
function firstCreateError(
  fieldErrors: FieldErrors | null,
  field: string,
): string | null {
  const messages = fieldErrors?.[field]
  return messages !== undefined && messages.length > 0 ? messages[0] : null
}

function BudgetItem({
  budget,
  categoryName,
}: {
  budget: Budget
  categoryName: string | undefined
}) {
  const overspent = isOverspent(budget.remaining)
  return (
    <li className="budget-item">
      <div className="budget-main">
        <time dateTime={budget.month} className="budget-month">
          {formatMonthLabel(budget.month)}
        </time>
        {categoryName !== undefined && (
          <span className="budget-category">{categoryName}</span>
        )}
      </div>
      <dl className="budget-amounts">
        <div className="budget-amount">
          <dt>Budgeted</dt>
          <dd>{formatMoney(budget.budgeted)}</dd>
        </div>
        <div className="budget-amount">
          <dt>Spent</dt>
          <dd>{formatMoney(budget.spent)}</dd>
        </div>
        <div className="budget-amount">
          <dt>Remaining</dt>
          <dd>
            {formatMoney(budget.remaining)}{' '}
            {overspent && <span className="budget-overspent">Overspent</span>}
          </dd>
        </div>
      </dl>
    </li>
  )
}

function CreateBudgetForm({
  categories,
  created,
  onCreateStart,
  onCreated,
}: {
  categories: Category[]
  created: boolean
  onCreateStart: () => void
  onCreated: () => void
}) {
  const { clearSession } = useAuth()
  const [category, setCategory] = useState('')
  const [month, setMonth] = useState('')
  const [budgeted, setBudgeted] = useState('')
  const [pending, setPending] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
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

  const activeExpenseCategories = categories.filter(
    (item) => !item.is_archived && item.category_type === 'expense',
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submittingRef.current) return
    if (pending) return
    setSubmitError(null)
    onCreateStart()

    const clientErrors = validateCreateFields(
      category,
      month,
      budgeted,
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
      await createBudget({
        category: Number(category),
        month: `${month}-01`,
        budgeted,
      })
      if (mountedRef.current) {
        setCategory('')
        setMonth('')
        setBudgeted('')
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

  const categoryError = firstCreateError(fieldErrors, 'category')
  const monthError = firstCreateError(fieldErrors, 'month')
  const budgetedError = firstCreateError(fieldErrors, 'budgeted')
  const hasFieldErrors =
    categoryError !== null || monthError !== null || budgetedError !== null
  const summary = submitError ?? (hasFieldErrors ? FIELD_ERROR_SUMMARY : null)
  const hasActiveExpenseCategories = activeExpenseCategories.length > 0
  const submitDisabled = pending || !hasActiveExpenseCategories

  return (
    <section className="budget-create" aria-labelledby="budget-create-heading">
      <h3 id="budget-create-heading">Add budget</h3>
      {created && (
        <p role="status" className="notice">
          Budget created.
        </p>
      )}
      {pending && (
        <p role="status" className="notice">
          Creating budget…
        </p>
      )}
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      {!hasActiveExpenseCategories && (
        <p className="notice">{NO_ACTIVE_CATEGORIES_MESSAGE}</p>
      )}
      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor="create-budget-category">New budget category</label>
          <select
            id="create-budget-category"
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
              categoryError !== null ? 'create-budget-category-error' : undefined
            }
          >
            <option value="">Select a category</option>
            {activeExpenseCategories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {categoryError !== null && (
            <ul id="create-budget-category-error" className="field-errors">
              {fieldErrors?.category?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-budget-month">Month</label>
          <input
            id="create-budget-month"
            className="input"
            type="month"
            name="month"
            autoComplete="off"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value)
              clearCreateFieldError('month')
            }}
            disabled={pending}
            required
            aria-invalid={monthError !== null}
            aria-describedby={
              monthError !== null ? 'create-budget-month-error' : undefined
            }
          />
          {monthError !== null && (
            <ul id="create-budget-month-error" className="field-errors">
              {fieldErrors?.month?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-budget-budgeted">Budgeted amount</label>
          <input
            id="create-budget-budgeted"
            className="input"
            type="text"
            inputMode="decimal"
            name="budgeted"
            autoComplete="off"
            value={budgeted}
            onChange={(event) => {
              setBudgeted(event.target.value)
              clearCreateFieldError('budgeted')
            }}
            disabled={pending}
            required
            aria-invalid={budgetedError !== null}
            aria-describedby={
              budgetedError !== null
                ? 'create-budget-budgeted-error'
                : undefined
            }
          />
          {budgetedError !== null && (
            <ul id="create-budget-budgeted-error" className="field-errors">
              {fieldErrors?.budgeted?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn" disabled={submitDisabled}>
          {pending ? 'Creating budget…' : 'Create budget'}
        </button>
      </form>
    </section>
  )
}

export function BudgetsScreen() {
  const { clearSession } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<BudgetsState>({ status: 'loading' })
  const [categories, setCategories] = useState<Category[]>([])
  const [createdNotice, setCreatedNotice] = useState(false)
  const metaPromiseRef = useRef<Promise<Category[]> | null>(null)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const seq = requestSeqRef.current + 1
    requestSeqRef.current = seq
    let metaPromise = metaPromiseRef.current
    if (metaPromise === null) {
      const created = fetchCategories()
      metaPromiseRef.current = created
      void created.catch(() => {
        if (metaPromiseRef.current === created) {
          metaPromiseRef.current = null
        }
      })
      metaPromise = created
    }
    void Promise.all([fetchBudgets(), metaPromise])
      .then(([budgets, loadedCategories]) => {
        if (cancelled || seq !== requestSeqRef.current) {
          return
        }
        setCategories(loadedCategories)
        setState({ status: 'ready', budgets })
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) {
          return
        }
        setCreatedNotice(false)
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

  const handleRetry = useCallback(() => {
    setCreatedNotice(false)
    setState({ status: 'loading' })
    setAttempt((current) => current + 1)
  }, [])

  const handleCreateStart = useCallback(() => {
    setCreatedNotice(false)
  }, [])

  const handleBudgetCreated = useCallback(() => {
    setCreatedNotice(true)
    requestSeqRef.current += 1
    resetBudgetsRequest()
    setAttempt((current) => current + 1)
  }, [])

  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  )

  return (
    <div className="screen">
      <h2>Budgets</h2>
      <CreateBudgetForm
        categories={categories}
        created={createdNotice}
        onCreateStart={handleCreateStart}
        onCreated={handleBudgetCreated}
      />
      {state.status === 'loading' && <p role="status">Loading your budgets…</p>}
      {state.status === 'error' && (
        <div className="error-summary" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.budgets.length === 0 ? (
          <p className="empty-state">
            No budgets exist yet. Budgets you create will appear here.
          </p>
        ) : (
          <ul className="budget-list">
            {state.budgets.map((budget) => (
              <BudgetItem
                key={budget.id}
                budget={budget}
                categoryName={categoryById.get(budget.category)?.name}
              />
            ))}
          </ul>
        ))}
    </div>
  )
}
