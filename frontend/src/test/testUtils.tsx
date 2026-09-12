import { StrictMode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'
import { resetRestoreRequest } from '../api/auth'
import { resetAccountsRequest } from '../api/accounts'
import { resetDashboardRequest } from '../api/dashboard'
import App from '../App'

export const CSRF_TOKEN = 'test-csrf-token'

export type FetchHandler = (
  url: string,
  init?: RequestInit,
) => Response | Promise<Response>

export type FetchMock = ReturnType<typeof installFetchMock>

export function installFetchMock(handler: FetchHandler) {
  const mock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init),
  )
  vi.stubGlobal('fetch', mock)
  return mock
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function emptyResponse(status = 204) {
  return new Response(null, { status })
}

export function setCsrfCookie(value = CSRF_TOKEN) {
  document.cookie = `csrftoken=${value}; Path=/`
}

export function clearCookies() {
  document.cookie = 'csrftoken=; Max-Age=0; Path=/'
}

export function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function calls(mock: FetchMock, url: string, method = 'GET') {
  return mock.mock.calls.filter(
    ([input, init]) =>
      String(input) === url && (init?.method ?? 'GET') === method,
  )
}

export function requestLog(mock: FetchMock): string[] {
  return mock.mock.calls.map(
    ([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`,
  )
}

export function renderApp(path = '/') {
  window.history.replaceState(null, '', path)
  return render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

beforeEach(() => {
  resetRestoreRequest()
  resetDashboardRequest()
  resetAccountsRequest()
  clearCookies()
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})