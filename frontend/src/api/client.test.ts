import { describe, expect, it } from 'vitest'
import { apiFetch, decodeNoContent } from './client'
import { ApiError } from './types'
import { emptyResponse, installFetchMock } from '../test/testUtils'

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (caught) {
    return caught
  }
  throw new Error('Expected the promise to reject.')
}

describe('decodeNoContent', () => {
  it('accepts exactly an empty 204 response and resolves undefined', () => {
    expect(decodeNoContent(null, 204)).toBeUndefined()
  })

  it.each([
    ['a 200 status', null, 200],
    ['a 201 status', null, 201],
    ['a 204 status with a body', {}, 204],
  ])('rejects %s with the safe malformed error', (_label, payload, status) => {
    let caught: unknown
    try {
      decodeNoContent(payload, status)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ApiError)
    if (caught instanceof ApiError) {
      expect(caught.status).toBe(status)
      expect(caught.message).toBe('Unexpected server response.')
      expect(caught.fieldErrors).toEqual({})
    }
  })
})

describe('apiFetch empty-body handling', () => {
  it('resolves undefined for an empty 204 without a decoder', async () => {
    installFetchMock(() => emptyResponse(204))
    await expect(apiFetch('/api/no-content/')).resolves.toBeUndefined()
  })

  it('rejects an empty 200 body without a decoder as malformed', async () => {
    installFetchMock(() => new Response(null, { status: 200 }))
    const error = await rejection(apiFetch('/api/empty/'))
    expect(error).toBeInstanceOf(ApiError)
    if (error instanceof ApiError) {
      expect(error.status).toBe(200)
      expect(error.message).toBe('Unexpected server response.')
      expect(error.fieldErrors).toEqual({})
    }
  })

  it('passes null body and the real status to the decoder for 204', async () => {
    installFetchMock(() => emptyResponse(204))
    await expect(
      apiFetch('/api/no-content/', {}, (body, status) => ({ body, status })),
    ).resolves.toEqual({ body: null, status: 204 })
  })
})
