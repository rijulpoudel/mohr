import { useCallback, useEffect, useRef, useState } from 'react'
import { type AccountType } from '../api/accounts'
import {
  fetchPlaidConnections,
  syncPlaidConnection,
  type PlaidConnection,
  type PlaidConnectionStatus,
} from '../api/plaid'
import { ApiError, userMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { ConnectBankButton } from './ConnectBankButton'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const STILL_IMPORTING_MESSAGE =
  'Still importing. Transaction history is still being fetched.'

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

type SyncNotice =
  | { status: 'in-flight'; connectionId: number }
  | {
      status: 'done'
      connectionId: number
      added: number
      modified: number
      removed: number
    }
  | { status: 'processing'; connectionId: number }
  | { status: 'error'; connectionId: number; message: string }

interface SyncSummary {
  added: number
  modified: number
  removed: number
}

function syncSummaryMessage(summary: SyncSummary): string {
  const parts: string[] = []
  if (summary.added > 0) {
    parts.push(`${summary.added} added`)
  }
  if (summary.modified > 0) {
    parts.push(`${summary.modified} updated`)
  }
  if (summary.removed > 0) {
    parts.push(`${summary.removed} removed`)
  }
  if (parts.length === 0) return 'No changes were found.'
  return `${parts.join(', ')}.`
}

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
  syncNotice,
  onSync,
}: {
  connection: PlaidConnection
  now: number
  syncNotice: SyncNotice | null
  onSync: (connectionId: number) => void
}) {
  const syncStatus = connectionSyncStatus(connection, now)
  const accountPending = connection.linked_accounts.some(
    (account) => account.sync_pending,
  )
  const syncInFlight = syncNotice !== null && syncNotice.status === 'in-flight'
  const noticeForConnection =
    syncNotice !== null && syncNotice.connectionId === connection.id
      ? syncNotice
      : null
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
      {connection.status === 'active' && (
        <div className="connection-sync">
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={`Sync now for ${connection.institution_name}`}
            disabled={syncInFlight}
            onClick={() => onSync(connection.id)}
          >
            Sync now
          </button>
          {noticeForConnection?.status === 'in-flight' && (
            <p role="status" className="connection-note">
              Syncing {connection.institution_name}…
            </p>
          )}
          {noticeForConnection?.status === 'done' && (
            <p role="status" className="connection-note">
              {syncSummaryMessage({
                added: noticeForConnection.added,
                modified: noticeForConnection.modified,
                removed: noticeForConnection.removed,
              })}
            </p>
          )}
          {noticeForConnection?.status === 'processing' && (
            <p role="status" className="connection-note">
              {STILL_IMPORTING_MESSAGE}
            </p>
          )}
          {noticeForConnection?.status === 'error' && (
            <div className="error-summary" role="alert">
              <p>{noticeForConnection.message}</p>
              <button
                type="button"
                className="btn"
                aria-label={`Retry sync for ${connection.institution_name}`}
                onClick={() => onSync(connection.id)}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
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
  // One synchronization notice at a time, owned by the connection it describes.
  // A pending notice is replaced when that sync settles, and a settled result
  // stays readable until another sync replaces it or the user retries the list.
  // The sync's own refetch deliberately does not clear it: that refetch lands
  // within moments of the result, so clearing there would make the counts the
  // user just asked for effectively invisible.
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null)
  const syncInFlightRef = useRef<number | null>(null)

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

  const startSync = useCallback(
    (connectionId: number) => {
      if (syncInFlightRef.current !== null) return
      syncInFlightRef.current = connectionId
      setSyncNotice({ status: 'in-flight', connectionId })
      void syncPlaidConnection(connectionId)
        .then((result) => {
          if (syncInFlightRef.current !== connectionId) return
          syncInFlightRef.current = null
          if (result.status === 'processing') {
            setSyncNotice({ status: 'processing', connectionId })
          } else {
            setSyncNotice({
              status: 'done',
              connectionId,
              added: result.added,
              modified: result.modified,
              removed: result.removed,
            })
          }
          setAttempt((current) => current + 1)
        })
        .catch((caught: unknown) => {
          if (syncInFlightRef.current !== connectionId) return
          syncInFlightRef.current = null
          if (caught instanceof ApiError && caught.status === 401) {
            setSyncNotice(null)
            clearSession()
            return
          }
          setSyncNotice({
            status: 'error',
            connectionId,
            message:
              caught instanceof ApiError
                ? userMessage(caught)
                : GENERIC_ERROR_MESSAGE,
          })
        })
    },
    [clearSession],
  )

  const handleRetry = () => {
    setSyncNotice(null)
    setState({ status: 'loading' })
    setAttempt((current) => current + 1)
  }

  const handleConnectionAdded = useCallback(() => {
    setAttempt((current) => current + 1)
  }, [])

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
      <ConnectBankButton onConnectionAdded={handleConnectionAdded} />
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
              syncNotice={syncNotice}
              onSync={startSync}
            />
          ))}
        </ul>
      )}
    </div>
  )
}