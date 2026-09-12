import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import {
  archiveCategory,
  createCategory,
  fetchCategories,
  renameCategory,
  type Category,
  type CategoryType,
} from '../api/categories'
import { ApiError, userMessage, type FieldErrors } from '../api/types'
import { useAuth } from '../auth/AuthContext'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const FIELD_ERROR_SUMMARY = 'Please check the highlighted fields.'

const CATEGORY_TYPE_LABELS: Record<CategoryType, string> = {
  income: 'Income',
  expense: 'Expense',
}

const CATEGORY_TYPES: ReadonlySet<string> = new Set(Object.keys(CATEGORY_TYPE_LABELS))

const NAME_ERROR_BLANK = 'Enter a name for this category.'
const NAME_ERROR_LONG = 'Name must be 100 characters or fewer.'
const CATEGORY_TYPE_ERROR = 'Choose a category type.'

type CategoriesState =
  | { status: 'loading' }
  | { status: 'ready'; categories: Category[] }
  | { status: 'error'; message: string }

function isCategoryType(value: string): value is CategoryType {
  return CATEGORY_TYPES.has(value)
}

function validateCategoryFields(name: string, categoryType: string): FieldErrors {
  const errors: FieldErrors = {}
  if (name === '') {
    errors.name = [NAME_ERROR_BLANK]
  } else if (name.length > 100) {
    errors.name = [NAME_ERROR_LONG]
  }
  if (!isCategoryType(categoryType)) {
    errors.category_type = [CATEGORY_TYPE_ERROR]
  }
  return errors
}

function firstKnownFieldError(fieldErrors: FieldErrors): string | null {
  for (const field of ['name', 'category_type'] as const) {
    const messages = fieldErrors[field]
    if (messages !== undefined && messages.length > 0) return messages[0]
  }
  return null
}

function firstError(fieldErrors: FieldErrors | null, field: string): string | null {
  const messages = fieldErrors?.[field]
  return messages !== undefined && messages.length > 0 ? messages[0] : null
}

function CreateCategoryForm({ onCreated }: { onCreated: (category: Category) => void }) {
  const { clearSession } = useAuth()
  const [name, setName] = useState('')
  const [categoryType, setCategoryType] = useState<CategoryType>('expense')
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
    const clientErrors = validateCategoryFields(trimmedName, categoryType)
    if (Object.keys(clientErrors).length > 0) {
      setFieldErrors(clientErrors)
      return
    }

    setFieldErrors(null)
    setPending(true)
    try {
      const category = await createCategory(trimmedName, categoryType)
      if (mountedRef.current) {
        onCreated(category)
        setName('')
        setCategoryType('expense')
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
  const categoryTypeError = firstError(fieldErrors, 'category_type')
  const hasFieldErrors = nameError !== null || categoryTypeError !== null
  const summary =
    submitError ?? (hasFieldErrors ? FIELD_ERROR_SUMMARY : null)

  return (
    <section
      className="category-create"
      aria-labelledby="add-category-heading"
    >
      <h3 id="add-category-heading">Add category</h3>
      {created && (
        <p role="status" className="notice">
          Category created.
        </p>
      )}
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      <form
        className="form"
        aria-labelledby="add-category-heading"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="form-field">
          <label htmlFor="create-category-name">Name</label>
          <input
            id="create-category-name"
            className="input"
            type="text"
            name="name"
            autoComplete="off"
            maxLength={100}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            aria-invalid={nameError !== null}
            aria-describedby={
              nameError !== null ? 'create-category-name-error' : undefined
            }
          />
          {nameError !== null && (
            <ul id="create-category-name-error" className="field-errors">
              {fieldErrors?.name.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="create-category-type">Category type</label>
          <select
            id="create-category-type"
            className="select"
            name="category_type"
            value={categoryType}
            onChange={(event) => setCategoryType(event.target.value as CategoryType)}
            disabled={pending}
            aria-invalid={categoryTypeError !== null}
            aria-describedby={
              categoryTypeError !== null ? 'create-category-type-error' : undefined
            }
          >
            {Object.keys(CATEGORY_TYPE_LABELS).map((type) => (
              <option key={type} value={type}>
                {CATEGORY_TYPE_LABELS[type as CategoryType]}
              </option>
            ))}
          </select>
          {categoryTypeError !== null && (
            <ul id="create-category-type-error" className="field-errors">
              {fieldErrors?.category_type.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? 'Creating category…' : 'Create category'}
        </button>
      </form>
    </section>
  )
}

function RenameCategoryForm({
  category,
  onUpdated,
  onCancelled,
}: {
  category: Category
  onUpdated: (category: Category) => void
  onCancelled: () => void
}) {
  const { clearSession } = useAuth()
  const [name, setName] = useState(category.name)
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
    if (trimmedName === '') {
      setFieldErrors({ name: [NAME_ERROR_BLANK] })
      return
    }
    if (trimmedName.length > 100) {
      setFieldErrors({ name: [NAME_ERROR_LONG] })
      return
    }

    setFieldErrors(null)
    setPending(true)
    try {
      const updated = await renameCategory(category.id, trimmedName)
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
  const summary =
    submitError ?? (nameError !== null ? FIELD_ERROR_SUMMARY : null)

  return (
    <div className="category-edit">
      <h3 id="rename-category-heading">Rename category</h3>
      {summary !== null && (
        <div className="error-summary" role="alert">
          {summary}
        </div>
      )}
      <form
        className="form"
        aria-labelledby="rename-category-heading"
        onSubmit={handleSubmit}
        noValidate
      >
        <div className="form-field">
          <label htmlFor="rename-category-name">Name</label>
          <input
            id="rename-category-name"
            className="input"
            type="text"
            name="name"
            autoComplete="off"
            maxLength={100}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            aria-invalid={nameError !== null}
            aria-describedby={
              nameError !== null ? 'rename-category-name-error' : undefined
            }
          />
          {nameError !== null && (
            <ul id="rename-category-name-error" className="field-errors">
              {fieldErrors?.name.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="category-edit-actions">
          <button type="submit" className="btn" disabled={pending}>
            {pending ? 'Saving category…' : 'Save'}
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

function ArchiveCategoryConfirm({
  category,
  onArchived,
  onCancelled,
}: {
  category: Category
  onArchived: (categoryId: number) => void
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
      await archiveCategory(category.id)
      if (mountedRef.current) {
        onArchived(category.id)
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        clearSession()
        return
      }
      if (!mountedRef.current) return
      setErrorMessage(
        caught instanceof ApiError ? userMessage(caught) : GENERIC_ERROR_MESSAGE,
      )
    } finally {
      if (mountedRef.current) setPending(false)
    }
  }

  return (
    <div
      className="category-archive"
      role="group"
      aria-labelledby="archive-category-heading"
    >
      <h3 id="archive-category-heading">Archive category</h3>
      <p>{category.name} will be archived, not deleted.</p>
      <p>Historical transactions remain available.</p>
      {pending && (
        <p role="status" className="notice">
          Archiving category…
        </p>
      )}
      {errorMessage !== null && (
        <div className="error-summary" role="alert">
          {errorMessage}
        </div>
      )}
      <div className="category-archive-actions">
        <button
          type="button"
          className="btn"
          aria-label={`Confirm archive ${category.name}`}
          onClick={handleConfirm}
          disabled={pending}
        >
          {pending ? 'Archiving category…' : 'Archive'}
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

function CategoryItem({
  category,
  editing,
  archiving,
  onRename,
  onArchiveRequest,
  onUpdated,
  onCancelled,
  onArchived,
  onArchiveCancelled,
}: {
  category: Category
  editing: boolean
  archiving: boolean
  onRename: () => void
  onArchiveRequest: () => void
  onUpdated: (category: Category) => void
  onCancelled: () => void
  onArchived: (categoryId: number) => void
  onArchiveCancelled: () => void
}) {
  if (editing) {
    return (
      <li className="category-item">
        <RenameCategoryForm
          category={category}
          onUpdated={onUpdated}
          onCancelled={onCancelled}
        />
      </li>
    )
  }
  if (archiving) {
    return (
      <li className="category-item">
        <ArchiveCategoryConfirm
          category={category}
          onArchived={onArchived}
          onCancelled={onArchiveCancelled}
        />
      </li>
    )
  }
  return (
    <li className="category-item">
      <div className="category-main">
        <h4 className="category-name">{category.name}</h4>
        <span className="category-type">
          {CATEGORY_TYPE_LABELS[category.category_type]}
        </span>
      </div>
      <div className="category-actions">
        <button
          type="button"
          className="btn btn-secondary"
          aria-label={`Rename ${category.name}`}
          onClick={onRename}
        >
          Rename
        </button>
        {!category.is_archived && (
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={`Archive ${category.name}`}
            onClick={onArchiveRequest}
          >
            Archive
          </button>
        )}
      </div>
    </li>
  )
}

export function CategoriesScreen() {
  const { clearSession } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<CategoriesState>({ status: 'loading' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [archivingId, setArchivingId] = useState<number | null>(null)
  const [updatedNotice, setUpdatedNotice] = useState(false)
  const [archivedNotice, setArchivedNotice] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchCategories()
      .then((categories) => {
        if (cancelled) return
        setState({ status: 'ready', categories })
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

  const handleCreated = useCallback((category: Category) => {
    setState((current) => {
      if (current.status === 'ready') {
        return { status: 'ready', categories: [...current.categories, category] }
      }
      if (current.status === 'loading') {
        return { status: 'ready', categories: [category] }
      }
      return current
    })
  }, [])

  const handleRename = useCallback((categoryId: number) => {
    setEditingId(categoryId)
    setArchivingId(null)
    setUpdatedNotice(false)
    setArchivedNotice(false)
  }, [])

  const handleCancelled = useCallback(() => {
    setEditingId(null)
  }, [])

  const handleArchiveRequest = useCallback((categoryId: number) => {
    setArchivingId(categoryId)
    setEditingId(null)
    setUpdatedNotice(false)
    setArchivedNotice(false)
  }, [])

  const handleArchiveCancelled = useCallback(() => {
    setArchivingId(null)
  }, [])

  const handleUpdated = useCallback((updated: Category) => {
    setState((current) => {
      if (current.status !== 'ready') return current
      const index = current.categories.findIndex(
        (category) => category.id === updated.id,
      )
      if (index === -1) return current
      const categories = [...current.categories]
      categories[index] = updated
      return { status: 'ready', categories }
    })
    setEditingId(null)
    setUpdatedNotice(true)
  }, [])

  const handleArchived = useCallback((categoryId: number) => {
    setState((current) => {
      if (current.status !== 'ready') return current
      const index = current.categories.findIndex(
        (category) => category.id === categoryId,
      )
      if (index === -1) return current
      const categories = [...current.categories]
      categories[index] = { ...categories[index], is_archived: true }
      return { status: 'ready', categories }
    })
    setArchivingId(null)
    setArchivedNotice(true)
  }, [])

  const handleRetry = useCallback(() => {
    setState({ status: 'loading' })
    setAttempt((current) => current + 1)
  }, [])

  if (state.status === 'loading') {
    return (
      <div className="screen">
        <h2>Categories</h2>
        <p role="status">Loading your categories…</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="screen">
        <h2>Categories</h2>
        <div className="error-summary" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={handleRetry}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  const active = state.categories.filter((category) => !category.is_archived)
  const archived = state.categories.filter((category) => category.is_archived)

  return (
    <div className="screen">
      <h2>Categories</h2>
      <CreateCategoryForm onCreated={handleCreated} />
      {updatedNotice && (
        <p role="status" className="notice">
          Category updated.
        </p>
      )}
      {archivedNotice && (
        <p role="status" className="notice">
          Category archived.
        </p>
      )}
      {state.categories.length === 0 ? (
        <p className="empty-state">
          No categories yet. Categories you create will appear here.
        </p>
      ) : (
        <div className="category-groups">
          {active.length > 0 && (
            <section
              className="category-group"
              aria-labelledby="category-active-heading"
            >
              <h3 id="category-active-heading">Active ({active.length})</h3>
              <ul className="category-list">
                {active.map((category) => (
                  <CategoryItem
                    key={category.id}
                    category={category}
                    editing={editingId === category.id}
                    archiving={archivingId === category.id}
                    onRename={() => handleRename(category.id)}
                    onArchiveRequest={() => handleArchiveRequest(category.id)}
                    onUpdated={handleUpdated}
                    onCancelled={handleCancelled}
                    onArchived={handleArchived}
                    onArchiveCancelled={handleArchiveCancelled}
                  />
                ))}
              </ul>
            </section>
          )}
          {archived.length > 0 && (
            <section
              className="category-group"
              aria-labelledby="category-archived-heading"
            >
              <h3 id="category-archived-heading">Archived ({archived.length})</h3>
              <ul className="category-list">
                {archived.map((category) => (
                  <CategoryItem
                    key={category.id}
                    category={category}
                    editing={editingId === category.id}
                    archiving={archivingId === category.id}
                    onRename={() => handleRename(category.id)}
                    onArchiveRequest={() => handleArchiveRequest(category.id)}
                    onUpdated={handleUpdated}
                    onCancelled={handleCancelled}
                    onArchived={handleArchived}
                    onArchiveCancelled={handleArchiveCancelled}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  )
}