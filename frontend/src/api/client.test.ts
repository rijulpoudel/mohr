import { describe, expect, it, vi } from 'vitest'
import { apiFetch, decodeNoContent } from './client'
import { ApiError } from './types'
import { emptyResponse, installFetchMock, jsonResponse } from '../test/testUtils'

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

describe('apiFetch timeout', () => {
  it('rejects with the timeout error at 15,000 ms when fetch never settles, even if it ignores the signal', async () => {
    vi.useFakeTimers()
    try {
      let received: AbortSignal | null | undefined
      installFetchMock((_url, init) => {
        received = init?.signal
        return new Promise<Response>(() => {})
      })
      const observed = apiFetch('/api/slow/').then(
        () => null,
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(15_000)
      const error = await observed
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe(
          'The server took too long to respond. Please try again.',
        )
        expect(error.status).toBeNull()
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
      expect(received?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects with the timeout error when the response body never settles', async () => {
    vi.useFakeTimers()
    try {
      const stalledBody = {
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {}),
      } as unknown as Response
      installFetchMock(() => stalledBody)
      const observed = apiFetch('/api/slow-body/').then(
        () => null,
        (error: unknown) => error,
      )
      await vi.advanceTimersByTimeAsync(15_000)
      const error = await observed
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe(
          'The server took too long to respond. Please try again.',
        )
        expect(error.status).toBeNull()
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('is still pending at 14,999 ms', async () => {
    vi.useFakeTimers()
    try {
      installFetchMock(() => new Promise<Response>(() => {}))
      const observed = apiFetch('/api/slow/').then(
        () => ({ state: 'fulfilled' as const }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      )
      let settled = false
      void observed.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(14_999)
      await Promise.resolve()
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const result = await observed
      expect(result.state).toBe('rejected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the deadline after success so advancing timers never aborts its signal', async () => {
    vi.useFakeTimers()
    try {
      let received: AbortSignal | null | undefined
      installFetchMock((_url, init) => {
        received = init?.signal
        return jsonResponse({ ok: true })
      })
      await expect(apiFetch('/api/ok/')).resolves.toEqual({ ok: true })
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(received?.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the deadline and keeps the network error when fetch rejects', async () => {
    vi.useFakeTimers()
    try {
      installFetchMock(() => Promise.reject(new TypeError('Failed to fetch')))
      const error = await rejection(apiFetch('/api/down/'))
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe('Could not reach the server.')
        expect(error.status).toBeNull()
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(15_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards an already-aborted caller signal to fetch', async () => {
    vi.useFakeTimers()
    try {
      const caller = new AbortController()
      caller.abort()
      let received: AbortSignal | null | undefined
      installFetchMock((_url, init) => {
        received = init?.signal
        return new Promise<Response>(() => {})
      })
      const error = await rejection(
        apiFetch('/api/cancelled/', { signal: caller.signal }),
      )
      expect(received?.aborted).toBe(true)
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe('Could not reach the server.')
        expect(error.status).toBeNull()
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards a later caller abort and rejects with the network error, not the timeout', async () => {
    vi.useFakeTimers()
    try {
      const caller = new AbortController()
      let received: AbortSignal | null | undefined
      installFetchMock((_url, init) => {
        received = init?.signal
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      })
      const observed = apiFetch('/api/cancelled/', {
        signal: caller.signal,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      await Promise.resolve()
      expect(received?.aborted).toBe(false)
      caller.abort()
      const error = await observed
      expect(received?.aborted).toBe(true)
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe('Could not reach the server.')
        expect(error.status).toBeNull()
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(15_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the network error when a caller abort strikes while the body is reading', async () => {
    vi.useFakeTimers()
    try {
      const caller = new AbortController()
      let received: AbortSignal | null | undefined
      installFetchMock((_url, init) => {
        received = init?.signal
        return {
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('Aborted', 'AbortError'))
              })
            }),
        } as unknown as Response
      })
      const observed = apiFetch('/api/slow-body/', {
        signal: caller.signal,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      await Promise.resolve()
      caller.abort()
      const error = await observed
      expect(received?.aborted).toBe(true)
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe('Could not reach the server.')
        expect(error.status).toBeNull()
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects immediately with the network error when a caller abort is ignored while the body is reading', async () => {
    vi.useFakeTimers()
    try {
      const caller = new AbortController()
      let received: AbortSignal | null | undefined
      installFetchMock((_url, init) => {
        received = init?.signal
        return {
          ok: true,
          status: 200,
          text: () => new Promise<string>(() => {}),
        } as unknown as Response
      })
      const observed = apiFetch('/api/slow-body/', {
        signal: caller.signal,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      await Promise.resolve()
      caller.abort()
      const error = await observed
      expect(received?.aborted).toBe(true)
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe('Could not reach the server.')
        expect(error.status).toBeNull()
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects immediately with the network error when a caller abort is ignored by fetch', async () => {
    vi.useFakeTimers()
    try {
      const caller = new AbortController()
      let received: AbortSignal | null | undefined
      installFetchMock((_url, init) => {
        received = init?.signal
        return new Promise<Response>(() => {})
      })
      const observed = apiFetch('/api/cancelled/', {
        signal: caller.signal,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      await Promise.resolve()
      caller.abort()
      const error = await observed
      expect(received?.aborted).toBe(true)
      expect(error).toBeInstanceOf(ApiError)
      if (error instanceof ApiError) {
        expect(error.message).toBe('Could not reach the server.')
        expect(error.status).toBeNull()
        expect(error.detail).toBeNull()
        expect(error.fieldErrors).toEqual({})
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
