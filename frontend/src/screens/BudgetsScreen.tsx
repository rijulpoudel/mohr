import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  createBudget,
  deleteBudget,
  fetchBudgets,
  resetBudgetsRequest,
  updateBudget,
  type Budget,
  type BudgetPatch,
} from '../api/budgets'
import { fetchCategories, type Category } from '../api/categories'
import { ApiError, userMessage, type FieldErrors } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatMonthLabel, isValidBudgetMonth } from '../format/month'
import { formatMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const FIELD_ERROR_SUMMARY = 'Please check the highlighted fields.'
const NO_CHANGES_MESSAGE = 'Make at least one change before saving.'

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
const EDIT_LOCKED_HINT =
  'Finish or cancel your edit before creating another budget.'
const DELETE_LOCKED_HINT =
  'Finish or cancel your deletion before creating another budget.'
const REFRESH_AFTER_SAVE_MESSAGE =
  'Your budget change was saved, but the current budget list could not be refreshed. Try again.'

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

function validateEditFields(
  category: string,
  month: string,
  budgeted: string,
  categories: Category[],
  original: Budget,
  categoryDirty = false,
): FieldErrors {
  const errors: FieldErrors = {}
  if (category === '') {
    errors.category = [CREATE_CATEGORY_REQUIRED]
  } else if (category !== String(original.category) || categoryDirty) {
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

function buildEditPatch(
  original: Budget,
  category: string,
  month: string,
  budgeted: string,
): BudgetPatch {
  const patch: BudgetPatch = {}
  if (category !== String(original.category)) {
    patch.category = Number(category)
  }
  if (month !== original.month.slice(0, 7)) {
    patch.month = `${month}-01`
  }
  if (budgeted !== original.budgeted) {
    patch.budgeted = budgeted
  }
  return patch
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
  editDisabled,
  deleteDisabled,
  onEdit,
  onDelete,
}: {
  budget: Budget
  categoryName: string | undefined
  editDisabled: boolean
  deleteDisabled: boolean
  onEdit: () => void
  onDelete: () => void
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
      <div className="budget-actions">
        <button
          type="button"
          className="btn-edit"
          aria-label={`Edit budget ${budget.id}`}
          onClick={onEdit}
          disabled={editDisabled}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn-delete"
          aria-label={`Delete budget ${budget.id}`}
          onClick={onDelete}
          disabled={deleteDisabled}
        >
          Delete
        </button>
      </div>
    </li>
  )
}

function DeleteBudgetConfirm({
  budget,
  categoryName,
  onCancel,
  onDeleted,
  onPendingChange,
}: {
  budget: Budget
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
      await deleteBudget(budget.id)
      if (mountedRef.current) {
        onDeleted(budget.id)
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

  const permanenceId = `delete-budget-permanence-${budget.id}`

  return (
    <li className="budget-item budget-delete">
      {pending && (
        <p role="status" className="notice">
          Deleting budget…
        </p>
      )}
      {submitError !== null && (
        <div className="error-summary" role="alert">
          {submitError}
        </div>
      )}
      <div role="group" aria-label={`Delete budget ${budget.id} confirmation`}>
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
        </dl>
        <p id={permanenceId}>
          Deleting is permanent and cannot be undone. It does not delete the
          category or any transactions.
        </p>
        <div className="budget-delete-actions">
          <button
            type="button"
            className="btn"
            ref={keepRef}
            onClick={onCancel}
            disabled={pending}
          >
            Keep budget
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={handleConfirm}
            disabled={pending}
            aria-describedby={permanenceId}
          >
            Delete budget
          </button>
        </div>
      </div>
    </li>
  )
}

function EditBudgetForm({
  budget,
  categories,
  onCancel,
  onUpdated,
  onPendingChange,
}: {
  budget: Budget
  categories: Category[]
  onCancel: () => void
  onUpdated: (updated: Budget) => void
  onPendingChange: (pending: boolean) => void
}) {
  const { clearSession } = useAuth()
  const [category, setCategory] = useState(String(budget.category))
  const [month, setMonth] = useState(budget.month.slice(0, 7))
  const [budgeted, setBudgeted] = useState(budget.budgeted)
  const [pending, setPending] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const submittingRef = useRef(false)
  const initialCategoryRef = useRef(String(budget.category))
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

  const activeExpenseCategories = categories.filter(
    (item) => !item.is_archived && item.category_type === 'expense',
  )
  const originalCategory = categories.find((item) => item.id === budget.category)
  const visibleCategories = [...activeExpenseCategories]
  if (
    originalCategory !== undefined &&
    originalCategory.is_archived &&
    originalCategory.category_type === 'expense' &&
    !visibleCategories.some((item) => item.id === originalCategory.id)
  ) {
    visibleCategories.push(originalCategory)
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
      category,
      month,
      budgeted,
      categories,
      budget,
      categoryDirtyRef.current,
    )
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      return
    }

    setFieldErrors(null)
    const patch = buildEditPatch(budget, category, month, budgeted)
    if (Object.keys(patch).length === 0) {
      setSubmitError(NO_CHANGES_MESSAGE)
      return
    }
    submittingRef.current = true
    setPending(true)
    onPendingChange(true)
    try {
      const updated = await updateBudget(budget.id, patch)
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

  const categoryError = firstCreateError(fieldErrors, 'category')
  const monthError = firstCreateError(fieldErrors, 'month')
  const budgetedError = firstCreateError(fieldErrors, 'budgeted')
  const hasFieldErrors =
    categoryError !== null || monthError !== null || budgetedError !== null
  const summary = submitError ?? (hasFieldErrors ? FIELD_ERROR_SUMMARY : null)
  const base = `edit-budget-${budget.id}`

  return (
    <li className="budget-item budget-edit">
      {pending && (
        <p role="status" className="notice">
          Updating budget…
        </p>
      )}
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      <form className="form" onSubmit={handleSubmit} noValidate>
        <div className="form-field">
          <label htmlFor={`${base}-category`}>Edit budget category</label>
          <select
            id={`${base}-category`}
            ref={firstFieldRef}
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
            {category === '' && <option value="">Select a category</option>}
            {visibleCategories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.is_archived
                  ? `${item.name} (archived, current)`
                  : item.name}
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
          <label htmlFor={`${base}-month`}>Edit budget month</label>
          <input
            id={`${base}-month`}
            className="input"
            type="month"
            name="month"
            autoComplete="off"
            value={month}
            onChange={(event) => {
              setMonth(event.target.value)
              clearEditFieldError('month')
            }}
            disabled={pending}
            required
            aria-invalid={monthError !== null}
            aria-describedby={
              monthError !== null ? `${base}-month-error` : undefined
            }
          />
          {monthError !== null && (
            <ul id={`${base}-month-error`} className="field-errors">
              {fieldErrors?.month?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor={`${base}-budgeted`}>Edit budget budgeted amount</label>
          <input
            id={`${base}-budgeted`}
            className="input"
            type="text"
            inputMode="decimal"
            name="budgeted"
            autoComplete="off"
            value={budgeted}
            onChange={(event) => {
              setBudgeted(event.target.value)
              clearEditFieldError('budgeted')
            }}
            disabled={pending}
            required
            aria-invalid={budgetedError !== null}
            aria-describedby={
              budgetedError !== null ? `${base}-budgeted-error` : undefined
            }
          />
          {budgetedError !== null && (
            <ul id={`${base}-budgeted-error`} className="field-errors">
              {fieldErrors?.budgeted?.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="budget-edit-actions">
          <button type="submit" className="btn" disabled={pending}>
            {pending ? 'Updating budget…' : 'Save changes'}
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

function CreateBudgetForm({
  categories,
  created,
  submitLocked,
  deleteLocked,
  onCreateStart,
  onCreated,
  onPendingChange,
}: {
  categories: Category[]
  created: boolean
  submitLocked: boolean
  deleteLocked: boolean
  onCreateStart: () => void
  onCreated: () => void
  onPendingChange: (pending: boolean) => void
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
      onPendingChange(false)
    }
  }, [onPendingChange])

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
    if (submitLocked) return
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
    onPendingChange(true)
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
        onPendingChange(false)
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
  const submitDisabled =
    pending || submitLocked || !hasActiveExpenseCategories

  return (
    <section
      className="budget-create"
      aria-labelledby="budget-create-heading"
      aria-describedby={submitLocked ? 'budget-create-locked-hint' : undefined}
    >
      <h3 id="budget-create-heading">Add budget</h3>
      {submitLocked && (
        <p id="budget-create-locked-hint" className="notice">
          {deleteLocked ? DELETE_LOCKED_HINT : EDIT_LOCKED_HINT}
        </p>
      )}
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
  const [updateNotice, setUpdateNotice] = useState(false)
  const [deletedNotice, setDeletedNotice] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editPending, setEditPending] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [createPending, setCreatePending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const metaPromiseRef = useRef<Promise<Category[]> | null>(null)
  const requestSeqRef = useRef(0)
  const mutationSeqRef = useRef<number | null>(null)
  const stateRef = useRef<BudgetsState>({ status: 'loading' })
  type ReturnFocusTarget =
    | { kind: 'edit'; id: number }
    | { kind: 'delete'; id: number }
    | { kind: 'heading' }
  const returnFocusRef = useRef<ReturnFocusTarget | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    if (editingId !== null) return
    if (deletingId !== null) return
    if (refreshing) return
    if (returnFocusRef.current === null) return
    const target = returnFocusRef.current
    returnFocusRef.current = null
    if (target.kind === 'heading') {
      headingRef.current?.focus()
      return
    }
    const label =
      target.kind === 'edit'
        ? `Edit budget ${target.id}`
        : `Delete budget ${target.id}`
    const element = document.querySelector(`[aria-label="${label}"]`)
    if (element instanceof HTMLElement) {
      element.focus()
    } else {
      headingRef.current?.focus()
    }
  }, [editingId, deletingId, refreshing, state])

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
        if (mutationSeqRef.current === seq) {
          mutationSeqRef.current = null
        }
        setCategories(loadedCategories)
        setState({ status: 'ready', budgets })
        setRefreshing(false)
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) {
          return
        }
        setCreatedNotice(false)
        setUpdateNotice(false)
        setDeletedNotice(false)
        if (error instanceof ApiError && error.status === 401) {
          if (mutationSeqRef.current === seq) {
            mutationSeqRef.current = null
          }
          clearSession()
          return
        }
        const followedMutation = mutationSeqRef.current === seq
        if (followedMutation) {
          mutationSeqRef.current = null
        }
        setRefreshing(false)
        if (followedMutation) {
          setState({ status: 'error', message: REFRESH_AFTER_SAVE_MESSAGE })
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
    setUpdateNotice(false)
    setDeletedNotice(false)
    mutationSeqRef.current = null
    if (stateRef.current.status === 'ready') {
      setRefreshing(true)
    } else {
      setState({ status: 'loading' })
    }
    setAttempt((current) => current + 1)
  }, [])

  const handleCreateStart = useCallback(() => {
    setCreatedNotice(false)
    setUpdateNotice(false)
    setDeletedNotice(false)
  }, [])

  const handleCreatePendingChange = useCallback((pending: boolean) => {
    setCreatePending(pending)
  }, [])

  const handleBudgetCreated = useCallback(() => {
    setCreatedNotice(true)
    setUpdateNotice(false)
    setDeletedNotice(false)
    if (stateRef.current.status === 'ready') {
      setRefreshing(true)
    }
    requestSeqRef.current += 1
    mutationSeqRef.current = requestSeqRef.current + 1
    resetBudgetsRequest()
    setAttempt((current) => current + 1)
  }, [])

  const handleEditOpen = useCallback((id: number) => {
    setCreatedNotice(false)
    setUpdateNotice(false)
    setDeletedNotice(false)
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

  const handleEditUpdated = useCallback((updated: Budget) => {
    setEditingId(null)
    setEditPending(false)
    returnFocusRef.current = { kind: 'edit', id: updated.id }
    setCreatedNotice(false)
    setUpdateNotice(true)
    setDeletedNotice(false)
    if (stateRef.current.status === 'ready') {
      setRefreshing(true)
    }
    requestSeqRef.current += 1
    mutationSeqRef.current = requestSeqRef.current + 1
    resetBudgetsRequest()
    setAttempt((current) => current + 1)
  }, [])

  const handleDeleteOpen = useCallback((id: number) => {
    setCreatedNotice(false)
    setUpdateNotice(false)
    setDeletedNotice(false)
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
        budgets: current.budgets.filter((item) => item.id !== id),
      }
    })
    setDeletingId(null)
    setDeletePending(false)
    returnFocusRef.current = { kind: 'heading' }
    setCreatedNotice(false)
    setUpdateNotice(false)
    setDeletedNotice(true)
  }, [])

  const categoryById = new Map(
    categories.map((category) => [category.id, category]),
  )
  const rowLocked =
    editPending ||
    deletePending ||
    createPending ||
    refreshing ||
    editingId !== null ||
    deletingId !== null

  return (
    <div className="screen">
      <h2 ref={headingRef} tabIndex={-1}>
        Budgets
      </h2>
      <CreateBudgetForm
        categories={categories}
        created={createdNotice}
        submitLocked={
          editingId !== null ||
          editPending ||
          deletingId !== null ||
          deletePending
        }
        deleteLocked={deletingId !== null || deletePending}
        onCreateStart={handleCreateStart}
        onCreated={handleBudgetCreated}
        onPendingChange={handleCreatePendingChange}
      />
      {updateNotice && state.status !== 'error' && (
        <p role="status" className="notice">
          Budget updated.
        </p>
      )}
      {deletedNotice && state.status !== 'error' && (
        <p role="status" className="notice">
          Budget deleted.
        </p>
      )}
      {state.status === 'loading' && <p role="status">Loading your budgets…</p>}
      {refreshing && state.status === 'ready' && (
        <p role="status">Updating budgets…</p>
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
        (state.budgets.length === 0 ? (
          <p className="empty-state">
            No budgets exist yet. Budgets you create will appear here.
          </p>
        ) : (
          <ul className="budget-list">
            {state.budgets.map((budget) =>
              editingId === budget.id ? (
                <EditBudgetForm
                  key={budget.id}
                  budget={budget}
                  categories={categories}
                  onCancel={() => handleEditCancel(budget.id)}
                  onUpdated={handleEditUpdated}
                  onPendingChange={handleEditPendingChange}
                />
              ) : deletingId === budget.id ? (
                <DeleteBudgetConfirm
                  key={budget.id}
                  budget={budget}
                  categoryName={categoryById.get(budget.category)?.name}
                  onCancel={() => handleDeleteCancel(budget.id)}
                  onDeleted={handleDeleteDeleted}
                  onPendingChange={handleDeletePendingChange}
                />
              ) : (
                <BudgetItem
                  key={budget.id}
                  budget={budget}
                  categoryName={categoryById.get(budget.category)?.name}
                  editDisabled={rowLocked}
                  deleteDisabled={rowLocked}
                  onEdit={() => handleEditOpen(budget.id)}
                  onDelete={() => handleDeleteOpen(budget.id)}
                />
              ),
            )}
          </ul>
        ))}
    </div>
  )
}
