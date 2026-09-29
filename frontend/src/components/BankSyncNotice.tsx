import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  fetchPlaidConnections,
  type PlaidConnection,
} from '../api/plaid'
import { ApiError } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatSyncTime, isConnectionStale } from '../format/bankSync'

const LOADING_MESSAGE = 'Checking bank sync status…'
const UNAVAILABLE_MESSAGE = 'Bank sync status unavailable.'
const HEALTHY_MESSAGE = 'Bank sync recorded in the last 24 hours.'
const ATTENTION_MESSAGE = 'Some bank data may be out of date.'
const PENDING_MESSAGE = 'Bank updates are incomplete.'
const CONNECTION_ERROR_MESSAGE = 'Bank connection needs attention.'
const SAVED_TRANSACTIONS_MESSAGE =
  'Figures reflect last saved transactions, not live balances.'
const CONNECTIONS_LINK_LABEL = 'Review connections'

type BankSyncState =
  | { status: 'loading' }
  | { status: 'hidden' }
  | { status: 'unavailable' }
  | { status: 'attention'; message: string; connectionCount: number; oldestSyncedAt: string | null }
  | {
      status: 'healthy'
      connectionCount: number
      oldestSyncedAt: string
    }

function isConnectionHealthy(connection: PlaidConnection, now: number): boolean {
  if (connection.status !== 'active') return false
  if (connection.sync_pending) return false
  if (connection.linked_accounts.some((account) => account.sync_pending)) {
    return false
  }
  if (connection.last_synced_at === null) return false
  return !isConnectionStale(connection.last_synced_at, now)
}

function oldestSuccessfulSync(connections: PlaidConnection[]): string | null {
  let oldest: string | null = null
  for (const connection of connections) {
    const syncedAt = connection.last_synced_at
    if (syncedAt === null) continue
    if (oldest === null || Date.parse(syncedAt) < Date.parse(oldest)) {
      oldest = syncedAt
    }
  }
  return oldest
}

function classify(connections: PlaidConnection[], now: number): BankSyncState {
  if (connections.length === 0) return { status: 'hidden' }
  const healthy = connections.every((connection) =>
    isConnectionHealthy(connection, now),
  )
  const oldest = oldestSuccessfulSync(connections)
  if (healthy && oldest !== null) {
    return {
      status: 'healthy',
      connectionCount: connections.length,
      oldestSyncedAt: oldest,
    }
  }
  const message = connections.some((connection) => connection.status !== 'active')
    ? CONNECTION_ERROR_MESSAGE
    : connections.some(
          (connection) =>
            connection.sync_pending ||
            connection.linked_accounts.some((account) => account.sync_pending),
        )
      ? PENDING_MESSAGE
      : ATTENTION_MESSAGE
  return {
    status: 'attention',
    message,
    connectionCount: connections.length,
    oldestSyncedAt: oldest,
  }
}

export function BankSyncNotice() {
  const { clearSession } = useAuth()
  const [state, setState] = useState<BankSyncState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    let interval: number | undefined
    void fetchPlaidConnections()
      .then((connections) => {
        if (cancelled) return
        setState(classify(connections, Date.now()))
        if (connections.length > 0) {
          interval = window.setInterval(() => {
            setState(classify(connections, Date.now()))
          }, 60_000)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof ApiError && error.status === 401) {
          clearSession()
          return
        }
        setState({ status: 'unavailable' })
      })
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [clearSession, attempt])

  if (state.status === 'hidden') return null

  return (
    <section
      className="bank-sync-notice"
      aria-label="Bank sync status"
      aria-live="polite"
    >
      {state.status === 'loading' ? (
        <p>{LOADING_MESSAGE}</p>
      ) : (
        <>
          <p>
            {state.status === 'unavailable'
              ? UNAVAILABLE_MESSAGE
              : state.status === 'attention'
                ? state.message
                : HEALTHY_MESSAGE}
          </p>
          {(state.status === 'attention' || state.status === 'healthy') &&
            state.oldestSyncedAt !== null && (
              <p className="bank-sync-notice-detail">
                {state.connectionCount > 1 ? 'Oldest' : 'Last'} bank sync:{' '}
                {formatSyncTime(state.oldestSyncedAt)}.
              </p>
            )}
          <p className="bank-sync-notice-detail">{SAVED_TRANSACTIONS_MESSAGE}</p>
          {state.status === 'unavailable' && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setState({ status: 'loading' })
                setAttempt((current) => current + 1)
              }}
            >
              Retry bank status
            </button>
          )}
          <Link className="bank-sync-notice-link" to="/connections">
            {CONNECTIONS_LINK_LABEL}
          </Link>
        </>
      )}
    </section>
  )
}
