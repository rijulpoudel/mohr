import { afterEach, describe, expect, it } from 'vitest'
import {
  archiveCategory,
  createCategory,
  fetchCategories,
  renameCategory,
  resetCategoriesRequest,
} from './categories'
import { ApiError } from './types'
import {
  calls,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  requestLog,
  setCsrfCookie,
} from '../test/testUtils'

const CSRF_RESPONSE = { detail: 'CSRF cookie set.' }

function categoryFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'Food',
    category_type: 'expense',
    is_archived: false,
    created_at: '2026-09-11T16:08:00.000000Z',
    updated_at: '2026-09-11T16:08:00.000000Z',
    ...overrides,
  }
}

function withoutKey(record: Record<string, unknown>, key: string) {
  const copy = { ...record }
  delete copy[key]
  return copy
}

function mutationHandler(
  onMutation: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  return (url: string, init?: RequestInit) => {
    if (url === '/api/auth/csrf/') {
      setCsrfCookie('create-csrf-token')
      return jsonResponse(CSRF_RESPONSE)
    }
    return onMutation(url, init)
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (caught) {
    return caught
  }
  throw new Error('Expected the promise to reject.')
}

describe('fetchCategories', () => {
  it('parses the category list in server order with exact fields', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/categories/') {
        return jsonResponse([
          categoryFixture({ id: 1, name: 'Food' }),
          categoryFixture({ id: 2, name: 'Salary', category_type: 'income' }),
          categoryFixture({
            id: 3,
            name: 'Old Hobby',
            is_archived: true,
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          }),
        ])
      }
      return jsonResponse({}, 404)
    })

    const categories = await fetchCategories()

    expect(requestLog(mock)).toEqual(['GET /api/categories/'])
    expect(categories).toHaveLength(3)
    expect(categories[0].name).toBe('Food')
    expect(categories[1].name).toBe('Salary')
    expect(categories[1].category_type).toBe('income')
    expect(categories[2].is_archived).toBe(true)
    expect(categories[2].created_at).toBe('2025-01-01T00:00:00Z')
    expect(categories[2].updated_at).toBe('2025-01-01T00:00:00Z')
  })

  it('shares a single in-flight request and clears it on settle', async () => {
    let callsCount = 0
    const mock = installFetchMock((url) => {
      if (url === '/api/categories/') {
        callsCount += 1
        return jsonResponse([categoryFixture()])
      }
      return jsonResponse({}, 404)
    })

    const first = fetchCategories()
    const second = fetchCategories()
    expect(await first).toHaveLength(1)
    expect(await second).toHaveLength(1)
    expect(callsCount).toBe(1)

    await fetchCategories()
    expect(callsCount).toBe(2)
    expect(calls(mock, '/api/categories/')).toHaveLength(2)
  })

  const malformedVariants: Array<[string, unknown]> = [
    ['a null payload', null],
    ['an object payload', { id: 1 }],
    ['a string payload', 'nope'],
    ['a missing key', [withoutKey(categoryFixture(), 'is_archived')]],
    ['an extra key', [{ ...categoryFixture(), user: 1 }]],
    ['a zero id', [categoryFixture({ id: 0 })]],
    ['a negative id', [categoryFixture({ id: -3 })]],
    ['a fractional id', [categoryFixture({ id: 1.5 })]],
    ['a string id', [categoryFixture({ id: '1' })]],
    ['an unsafe id', [categoryFixture({ id: 9007199254740992 })]],
    ['an empty name', [categoryFixture({ name: '' })]],
    ['a whitespace name', [categoryFixture({ name: '   ' })]],
    ['a 101-character name', [categoryFixture({ name: 'x'.repeat(101) })]],
    ['a bad category type', [categoryFixture({ category_type: 'savings' })]],
    ['a string archived flag', [categoryFixture({ is_archived: 'false' })]],
    ['an impossible created_at date', [categoryFixture({ created_at: '2026-02-30T12:00:00Z' })]],
    ['a date-only created_at', [categoryFixture({ created_at: '2026-09-11' })]],
    ['an impossible updated_at date', [categoryFixture({ updated_at: '2026-02-30T12:00:00Z' })]],
    ['a missing updated_at', [withoutKey(categoryFixture(), 'updated_at')]],
  ]

  it.each(malformedVariants)('rejects %s safely with the real status', async (_label, payload) => {
    installFetchMock((url) => {
      if (url === '/api/categories/') return jsonResponse(payload, 200)
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchCategories())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('rejects a 204 response safely with the real status', async () => {
    installFetchMock((url) => {
      if (url === '/api/categories/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchCategories())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('rejects a structurally valid list at 201 safely', async () => {
    installFetchMock((url) => {
      if (url === '/api/categories/') {
        return jsonResponse([categoryFixture({ id: 1 })], 201)
      }
      return jsonResponse({}, 404)
    })

    const error = await rejection(fetchCategories())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('preserves a 401 status and safe network failures', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/categories/') {
        return jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        )
      }
      return jsonResponse({}, 404)
    })
    const error = await rejection(fetchCategories())
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(401)
      expect(error.detail).toBe('Authentication credentials were not provided.')
    }

    installFetchMock((url) => {
      if (url === '/api/categories/') throw new TypeError('Failed to fetch')
      return jsonResponse({}, 404)
    })
    const networkError = await rejection(fetchCategories())
    expect(networkError).toBeInstanceOf(ApiError)
    if (networkError instanceof ApiError) {
      expect(networkError.status).toBeNull()
      expect(networkError.message).toBe('Could not reach the server.')
    }
    expect(calls(mock, '/api/categories/')).toHaveLength(1)
  })

  it('never writes to local or session storage', async () => {
    installFetchMock((url) => {
      if (url === '/api/categories/') return jsonResponse([categoryFixture()])
      return jsonResponse({}, 404)
    })

    await fetchCategories()

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('createCategory', () => {
  it('bootstraps CSRF then POSTs exactly two fields and parses the 201 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/') {
          return jsonResponse(categoryFixture({ id: 5, name: 'Salary', category_type: 'income' }), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const category = await createCategory('Salary', 'income')

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'POST /api/categories/',
    ])
    const posts = calls(mock, '/api/categories/', 'POST')
    expect(posts).toHaveLength(1)
    const [input, init] = posts[0]
    expect(String(input)).toBe('/api/categories/')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBe(JSON.stringify({ name: 'Salary', category_type: 'income' }))
    expect(category.id).toBe(5)
    expect(category.name).toBe('Salary')
    expect(category.category_type).toBe('income')
    expect(category.is_archived).toBe(false)
    expect(category.created_at).toBe('2026-09-11T16:08:00.000000Z')
  })

  it('rejects a 200 response even with a valid Category payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/') return jsonResponse(categoryFixture(), 200)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createCategory('Food', 'expense'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)
  })

  it('rejects a 204 response even for an exact create', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createCategory('Food', 'expense'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)
  })

  it('rejects a malformed 201 response safely', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/') return jsonResponse({ id: 1 }, 201)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createCategory('Food', 'expense'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
    }
  })

  it('aborts before POST when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/categories/') return jsonResponse(categoryFixture(), 201)
      return jsonResponse({}, 404)
    })

    const error = await rejection(createCategory('Food', 'expense'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(0)
  })

  it('preserves backend field errors from a 400 response', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/') {
          return jsonResponse(
            {
              name: ['A category with this name and type already exists.'],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(createCategory('Food', 'expense'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.name).toEqual([
        'A category with this name and type already exists.',
      ])
    }
  })

  const failureStatusCases: Array<[string, () => Response, number]> = [
    [
      'a 401 response',
      () =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      401,
    ],
    [
      'a 403 response',
      () => jsonResponse({ detail: 'CSRF Failed: CSRF token missing.' }, 403),
      403,
    ],
    [
      'a 404 response',
      () => jsonResponse({ detail: 'No Category matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/categories/') return respond()
          return jsonResponse({}, 404)
        }),
      )
      const error = await rejection(createCategory('Food', 'expense'))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/categories/', 'POST')).toHaveLength(1)
    },
  )

  it('throws a safe network error when the server cannot be reached', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse(CSRF_RESPONSE)
      }
      throw new TypeError('Failed to fetch')
    })

    const error = await rejection(createCategory('Food', 'expense'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/') return jsonResponse(categoryFixture(), 201)
        return jsonResponse({}, 404)
      }),
    )

    await createCategory('Food', 'expense')

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('renameCategory', () => {
  it('bootstraps CSRF then PATCHes only the name and parses the 200 response', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') {
          return jsonResponse(categoryFixture({ id: 7, name: 'Groceries' }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const category = await renameCategory(7, 'Groceries')

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'PATCH /api/categories/7/',
    ])
    const patches = calls(mock, '/api/categories/7/', 'PATCH')
    expect(patches).toHaveLength(1)
    const [input, init] = patches[0]
    expect(String(input)).toBe('/api/categories/7/')
    expect(init?.method).toBe('PATCH')
    const headers = init?.headers as Headers
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'Groceries' })
    expect(category.id).toBe(7)
    expect(category.name).toBe('Groceries')
    expect(category.category_type).toBe('expense')
    expect(category.is_archived).toBe(false)
  })

  it('rejects a 201 response even with a valid matching Category payload', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') {
          return jsonResponse(categoryFixture({ id: 7 }), 201)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(renameCategory(7, 'Groceries'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(201)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/categories/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a 204 response even for an exact rename', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(renameCategory(7, 'Groceries'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(204)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.detail).toBeNull()
      expect(error.fieldErrors).toEqual({})
    }
    expect(calls(mock, '/api/categories/7/', 'PATCH')).toHaveLength(1)
  })

  it('rejects a 200 response whose id does not match the requested category id', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') {
          return jsonResponse(categoryFixture({ id: 8, name: 'Intruder' }), 200)
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(renameCategory(7, 'Intruder'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, categoryId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(renameCategory(categoryId as number, 'X'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid category id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('aborts before PATCH when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/categories/7/') return jsonResponse(categoryFixture(), 200)
      return jsonResponse({}, 404)
    })

    const error = await rejection(renameCategory(7, 'X'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/categories/7/', 'PATCH')).toHaveLength(0)
  })

  it('preserves backend field errors from a 400 response', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') {
          return jsonResponse(
            {
              name: ['A category with this name and type already exists.'],
            },
            400,
          )
        }
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(renameCategory(7, 'Food'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(400)
      expect(error.fieldErrors.name).toEqual([
        'A category with this name and type already exists.',
      ])
    }
  })

  const failureStatusCases: Array<[string, () => Response, number]> = [
    [
      'a 401 response',
      () =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      401,
    ],
    [
      'a 403 response',
      () => jsonResponse({ detail: 'CSRF Failed: CSRF token missing.' }, 403),
      403,
    ],
    [
      'a 404 response',
      () => jsonResponse({ detail: 'No Category matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/categories/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )
      const error = await rejection(renameCategory(7, 'X'))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/categories/7/', 'PATCH')).toHaveLength(1)
    },
  )

  it('throws a safe network error when the server cannot be reached', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse(CSRF_RESPONSE)
      }
      throw new TypeError('Failed to fetch')
    })

    const error = await rejection(renameCategory(7, 'X'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') return jsonResponse(categoryFixture({ id: 7 }), 200)
        return jsonResponse({}, 404)
      }),
    )

    await renameCategory(7, 'X')

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

describe('archiveCategory', () => {
  it('bootstraps CSRF then DELETEs the category path and resolves on an empty 204', async () => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    await expect(archiveCategory(7)).resolves.toBeUndefined()

    expect(requestLog(mock)).toEqual([
      'GET /api/auth/csrf/',
      'DELETE /api/categories/7/',
    ])
    const deletes = calls(mock, '/api/categories/7/', 'DELETE')
    expect(deletes).toHaveLength(1)
    const [input, init] = deletes[0]
    expect(String(input)).toBe('/api/categories/7/')
    expect(init?.method).toBe('DELETE')
    const headers = init?.headers as Headers
    expect(headers.get('X-CSRFToken')).toBe('create-csrf-token')
    expect(init?.body).toBeUndefined()
  })

  it.each([
    ['a 200 response with a JSON body', () => jsonResponse(categoryFixture(), 200)],
    ['a 200 response with an empty body', () => new Response(null, { status: 200 })],
  ])('rejects unexpected success on %s safely', async (_label, respond) => {
    const mock = installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') return respond()
        return jsonResponse({}, 404)
      }),
    )

    const error = await rejection(archiveCategory(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
    }
    expect(calls(mock, '/api/categories/7/', 'DELETE')).toHaveLength(1)
  })

  it.each([
    ['a zero id', 0],
    ['a negative id', -4],
    ['a fractional id', 2.5],
    ['an unsafe id', 9007199254740992],
    ['a string id', '7'],
    ['NaN', Number.NaN],
  ])('rejects %s before any network call', async (_label, categoryId) => {
    const mock = installFetchMock(() => jsonResponse({}, 404))

    const error = await rejection(archiveCategory(categoryId as number))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Invalid category id.')
    }
    expect(requestLog(mock)).toEqual([])
  })

  it('aborts before DELETE when no CSRF cookie is present', async () => {
    const mock = installFetchMock((url) => {
      if (url === '/api/auth/csrf/') return jsonResponse(CSRF_RESPONSE)
      if (url === '/api/categories/7/') return emptyResponse(204)
      return jsonResponse({}, 404)
    })

    const error = await rejection(archiveCategory(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) expect(error.message).toBe('Missing CSRF token.')
    expect(calls(mock, '/api/categories/7/', 'DELETE')).toHaveLength(0)
  })

  const failureStatusCases: Array<[string, () => Response, number]> = [
    [
      'a 401 response',
      () =>
        jsonResponse(
          { detail: 'Authentication credentials were not provided.' },
          401,
        ),
      401,
    ],
    [
      'a 403 response',
      () => jsonResponse({ detail: 'CSRF Failed: CSRF token missing.' }, 403),
      403,
    ],
    [
      'a 404 response',
      () => jsonResponse({ detail: 'No Category matches the given query.' }, 404),
      404,
    ],
  ]

  it.each(failureStatusCases)(
    'preserves %s',
    async (_label, respond, status) => {
      const mock = installFetchMock(
        mutationHandler((url) => {
          if (url === '/api/categories/7/') return respond()
          return jsonResponse({}, 404)
        }),
      )
      const error = await rejection(archiveCategory(7))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) expect(error.status).toBe(status)
      expect(calls(mock, '/api/categories/7/', 'DELETE')).toHaveLength(1)
    },
  )

  it('throws a safe network error when the server cannot be reached', async () => {
    installFetchMock((url) => {
      if (url === '/api/auth/csrf/') {
        setCsrfCookie()
        return jsonResponse(CSRF_RESPONSE)
      }
      throw new TypeError('Failed to fetch')
    })

    const error = await rejection(archiveCategory(7))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBeNull()
      expect(error.message).toBe('Could not reach the server.')
    }
  })

  it('never writes to local or session storage', async () => {
    installFetchMock(
      mutationHandler((url) => {
        if (url === '/api/categories/7/') return emptyResponse(204)
        return jsonResponse({}, 404)
      }),
    )

    await archiveCategory(7)

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

afterEach(() => {
  resetCategoriesRequest()
})
