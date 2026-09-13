import { getCsrfToken } from './auth'
import { apiFetch, decodeNoContent } from './client'
import { ApiError } from './types'

const MALFORMED_RESPONSE_MESSAGE = 'Unexpected server response.'
const INVALID_CATEGORY_ID_MESSAGE = 'Invalid category id.'

export type CategoryType = 'income' | 'expense'

export interface Category {
  id: number
  name: string
  category_type: CategoryType
  is_archived: boolean
  created_at: string
  updated_at: string
}

const CATEGORY_KEYS = [
  'id',
  'name',
  'category_type',
  'is_archived',
  'created_at',
  'updated_at',
] as const

const CATEGORY_TYPES: ReadonlySet<string> = new Set(['income', 'expense'])

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const present = Object.keys(record)
  if (present.length !== keys.length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) return false
  if (!isCalendarDate(value.slice(0, 10))) return false
  return !isNaN(new Date(value).getTime())
}

function parseCategory(value: unknown): Category | null {
  if (!isRecord(value) || !hasExactKeys(value, CATEGORY_KEYS)) return null
  const { id, name, category_type, is_archived, created_at, updated_at } = value
  if (!isPositiveInteger(id)) return null
  if (typeof name !== 'string' || name.length === 0 || name.length > 100) {
    return null
  }
  if (name.trim().length === 0) return null
  if (typeof category_type !== 'string' || !CATEGORY_TYPES.has(category_type)) {
    return null
  }
  if (typeof is_archived !== 'boolean') return null
  if (!isTimestamp(created_at) || !isTimestamp(updated_at)) return null
  return {
    id,
    name,
    category_type: category_type as CategoryType,
    is_archived,
    created_at,
    updated_at,
  }
}

function parseCategories(payload: unknown, status: number): Category[] {
  const malformed = () =>
    new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
  if (status !== 200) throw malformed()
  if (!Array.isArray(payload)) throw malformed()
  const categories: Category[] = []
  for (const item of payload) {
    const category = parseCategory(item)
    if (category === null) throw malformed()
    categories.push(category)
  }
  return categories
}

let inFlightCategories: Promise<Category[]> | null = null

function requestCategories(): Promise<Category[]> {
  return apiFetch('/api/categories/', {}, parseCategories)
}

export function fetchCategories(): Promise<Category[]> {
  if (inFlightCategories === null) {
    inFlightCategories = requestCategories().finally(() => {
      inFlightCategories = null
    })
  }
  return inFlightCategories
}

export function resetCategoriesRequest(): void {
  inFlightCategories = null
}

function parseCategoryWithStatus(
  expectedStatus: number,
): (payload: unknown, status: number) => Category {
  return (payload, status) => {
    if (status !== expectedStatus) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const category = parseCategory(payload)
    if (category === null) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return category
  }
}

function parseRenamedCategory(
  categoryId: number,
): (payload: unknown, status: number) => Category {
  return (payload, status) => {
    if (status !== 200) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    const category = parseCategory(payload)
    if (category === null || category.id !== categoryId) {
      throw new ApiError(MALFORMED_RESPONSE_MESSAGE, status, null, {})
    }
    return category
  }
}

function assertValidCategoryId(categoryId: number): void {
  if (!isPositiveInteger(categoryId)) {
    throw new ApiError(INVALID_CATEGORY_ID_MESSAGE, null, null, {})
  }
}

export async function createCategory(
  name: string,
  categoryType: CategoryType,
): Promise<Category> {
  const token = await getCsrfToken()
  const body = JSON.stringify({
    name,
    category_type: categoryType,
  })
  return apiFetch(
    '/api/categories/',
    { method: 'POST', headers: { 'X-CSRFToken': token }, body },
    parseCategoryWithStatus(201),
  )
}

export async function renameCategory(
  categoryId: number,
  name: string,
): Promise<Category> {
  assertValidCategoryId(categoryId)
  const token = await getCsrfToken()
  const body = JSON.stringify({ name })
  return apiFetch(
    `/api/categories/${categoryId}/`,
    {
      method: 'PATCH',
      headers: { 'X-CSRFToken': token },
      body,
    },
    parseRenamedCategory(categoryId),
  )
}

export async function archiveCategory(categoryId: number): Promise<void> {
  assertValidCategoryId(categoryId)
  const token = await getCsrfToken()
  await apiFetch(
    `/api/categories/${categoryId}/`,
    { method: 'DELETE', headers: { 'X-CSRFToken': token } },
    decodeNoContent,
  )
}
