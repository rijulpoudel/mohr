import { useEffect, useState } from 'react'
import { type AccountType } from '../api/accounts'
import {
  fetchPlaidConnections,
  type PlaidConnection,
  type PlaidConnectionStatus,
} from '../api/plaid'
import { ApiError, userMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'

export const CONNECTION_STALE_AFTER_MS = 24 * 60 * 60 * 1000

const CONNECTION_STATUS_LABELS: Record<PlaidConnectionStatus, string> = {
  active: 'Connected',
  updating: 'Reconnect required',
  error: 'Attention needed',
  revoked: 'Access revoked',
  disconnected: 'Disconnected',
}

const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit card',
}

const INITIAL_IMPORT_MESSAGE =
  'Balances are temporarily excluded while transaction history finishes and the opening balance is anchored.'

type ConnectionsState =
  | { status: 'loading' }
  | { status: 'ready'; connections: PlaidConnection[] }
  | { status: 'error'; message: string }

function isConnectionStale(lastSyncedAt: string, now: number): boolean {
  return now - Date.parse(lastSyncedAt) > CONNECTION_STALE_AFTER_MS
}

function connectionSyncStatus(
  connection: PlaidConnection,
  now: number,
): string | null {
  if (connection.status === 'disconnected') {
    return 'Not syncing while disconnected.'
  }
  if (connection.status !== 'active') {
    return null
  }
  if (connection.linked_accounts.some((account) => account.sync_pending)) {
    return 'Initial import in progress'
  }
  if (connection.sync_pending) {
    return 'Bank updates are waiting to sync.'
  }
  if (connection.last_synced_at === null) {
    return null
  }
  return isConnectionStale(connection.last_synced_at, now)
    ? 'Data may be stale'
    : 'Up to date'
}

function formatSyncTime(iso: string): string {
  const date = new Date(iso)
  const formatted = date.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  })
  return `${formatted} UTC`
}

function ConnectionCard({
  connection,
  now,
}: {
  connection: PlaidConnection
  now: number
}) {
  const syncStatus = connectionSyncStatus(connection, now)
  const accountPending = connection.linked_accounts.some(
    (account) => account.sync_pending,
  )
  return (
    <li className="connection-item">
      <div className="connection-main">
        <h3 className="connection-name">{connection.institution_name}</h3>
        <span className="connection-status">
          {CONNECTION_STATUS_LABELS[connection.status]}
        </span>
      </div>
      <dl className="connection-details">
        <div className="connection-detail">
          <dt>Last sync</dt>
          <dd>
            {connection.last_synced_at === null ? (
              'Not synced yet'
            ) : (
              <time dateTime={connection.last_synced_at}>
                {formatSyncTime(connection.last_synced_at)}
              </time>
            )}
          </dd>
        </div>
        {syncStatus !== null && (
          <div className="connection-detail">
            <dt>Sync status</dt>
            <dd>{syncStatus}</dd>
          </div>
        )}
      </dl>
      {connection.status === 'active' && accountPending && (
        <p className="connection-note">{INITIAL_IMPORT_MESSAGE}</p>
      )}
      {connection.linked_accounts.length > 0 && (
        <ul
          className="connection-accounts"
          aria-label={`Accounts linked to ${connection.institution_name}`}
        >
          {connection.linked_accounts.map((account) => (
            <li key={account.id} className="connection-account">
              <span className="connection-account-name">{account.name}</span>
              <span className="connection-account-meta">
                {ACCOUNT_TYPE_LABELS[account.account_type]}
              </span>
              {account.mask !== '' && (
                <span className="connection-account-meta">
                  Ending in {account.mask}
                </span>
              )}
              {account.sync_pending && (
                <span className="connection-account-meta connection-account-pending">
                  Balance pending
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

export function ConnectionsScreen() {
  const { clearSession } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ConnectionsState>({ status: 'loading' })
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 60_000)
    return () => {
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void fetchPlaidConnections()
      .then((connections) => {
        if (cancelled) return
        setState({ status: 'ready', connections })
        setNow(Date.now())
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

  const handleRetry = () => {
    setState({ status: 'loading' })
    setAttempt((current) => current + 1)
  }

  if (state.status === 'loading') {
    return (
      <div className="screen">
        <h2>Connections</h2>
        <p role="status">Loading your connections…</p>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="screen">
        <h2>Connections</h2>
        <div className="error-summary" role="alert">
          <p>{state.message}</p>
          <button type="button" className="btn" onClick={handleRetry}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <h2>Connections</h2>
      {state.connections.length === 0 ? (
        <p className="empty-state">
          No bank connections yet. Connections you add will appear here.
        </p>
      ) : (
        <ul className="connection-list" aria-label="Bank connections">
          {state.connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              now={now}
            />
          ))}
        </ul>
      )}
    </div>
  )
}