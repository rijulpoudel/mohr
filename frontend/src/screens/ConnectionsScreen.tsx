import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlaidLink, type PlaidLinkError } from 'react-plaid-link'
import { type AccountType } from '../api/accounts'
import {
  completePlaidUpdate,
  createPlaidUpdateLinkToken,
  disconnectPlaidConnection,
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
const INVALID_LINK_TOKEN_MESSAGE =
  'Your bank connection link expired. Please try again.'
const LINK_EXIT_ERROR_MESSAGE =
  'The bank connection could not be completed. Please try again.'
const LINK_LOAD_ERROR_MESSAGE =
  'We could not start the bank connection. Please try again.'
const VERIFYING_REPAIRED_MESSAGE = 'Verifying the repaired connection…'

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

// One mutation at a time across sync, reconnect, and disconnect together. The
// ref is the synchronous guard; the state drives the disabled attributes.
type Mutation =
  | { kind: 'sync'; connectionId: number }
  | { kind: 'reconnect'; connectionId: number }
  | { kind: 'disconnect'; connectionId: number }

type ReconnectStatus = 'idle' | 'preparing' | 'linking' | 'completing' | 'error'

type ReconnectNotice =
  | { status: 'preparing'; connectionId: number }
  | { status: 'linking'; connectionId: number }
  | { status: 'completing'; connectionId: number }
  | { status: 'error'; connectionId: number; message: string }

type DisconnectNotice =
  | { status: 'in-flight'; connectionId: number }
  | { status: 'error'; connectionId: number; message: string }

interface SyncSummary {
  added: number
  modified: number
  removed: number
}

function canReconnect(status: PlaidConnectionStatus): boolean {
  return status === 'updating' || status === 'error' || status === 'revoked'
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
  reconnectNotice,
  disconnectNotice,
  confirmingDisconnect,
  mutationInFlight,
  confirmationOpen,
  onSync,
  onReconnect,
  onOpenDisconnect,
  onCancelDisconnect,
  onConfirmDisconnect,
  onRetryDisconnect,
}: {
  connection: PlaidConnection
  now: number
  syncNotice: SyncNotice | null
  reconnectNotice: ReconnectNotice | null
  disconnectNotice: DisconnectNotice | null
  confirmingDisconnect: boolean
  mutationInFlight: Mutation | null
  confirmationOpen: boolean
  onSync: (connectionId: number) => void
  onReconnect: (connectionId: number) => void
  onOpenDisconnect: (connectionId: number) => void
  onCancelDisconnect: (connectionId: number) => void
  onConfirmDisconnect: (connectionId: number) => void
  onRetryDisconnect: (connectionId: number) => void
}) {
  const syncStatus = connectionSyncStatus(connection, now)
  const accountPending = connection.linked_accounts.some(
    (account) => account.sync_pending,
  )
  const noticeForConnection =
    syncNotice !== null && syncNotice.connectionId === connection.id
      ? syncNotice
      : null
  const reconnectNoticeForConnection =
    reconnectNotice !== null && reconnectNotice.connectionId === connection.id
      ? reconnectNotice
      : null
  const disconnectNoticeForConnection =
    disconnectNotice !== null && disconnectNotice.connectionId === connection.id
      ? disconnectNotice
      : null
  // A pending mutation or an open confirmation locks every mutation control.
  const locked = mutationInFlight !== null || confirmationOpen
  const cancelRef = useRef<HTMLButtonElement>(null)
  const disconnectButtonRef = useRef<HTMLButtonElement>(null)
  const wasConfirmingRef = useRef(false)

  useEffect(() => {
    if (confirmingDisconnect) {
      cancelRef.current?.focus()
    } else if (wasConfirmingRef.current) {
      disconnectButtonRef.current?.focus()
    }
    wasConfirmingRef.current = confirmingDisconnect
  }, [confirmingDisconnect])

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
            disabled={locked}
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
                disabled={locked}
                onClick={() => onSync(connection.id)}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
      {canReconnect(connection.status) && (
        <div className="connection-sync">
          <button
            type="button"
            className="btn btn-secondary"
            aria-label={`Reconnect ${connection.institution_name}`}
            disabled={locked}
            onClick={() => onReconnect(connection.id)}
          >
            Reconnect
          </button>
          {reconnectNoticeForConnection?.status === 'preparing' && (
            <p role="status" className="connection-note">
              Preparing {connection.institution_name} for reconnection…
            </p>
          )}
          {reconnectNoticeForConnection?.status === 'linking' && (
            <p role="status" className="connection-note">
              Complete the reconnection for {connection.institution_name} in the
              bank window…
            </p>
          )}
          {reconnectNoticeForConnection?.status === 'completing' && (
            <p role="status" className="connection-note">
              {VERIFYING_REPAIRED_MESSAGE}
            </p>
          )}
          {reconnectNoticeForConnection?.status === 'error' && (
            <div className="error-summary" role="alert">
              <p>{reconnectNoticeForConnection.message}</p>
              <button
                type="button"
                className="btn"
                aria-label={`Retry reconnect for ${connection.institution_name}`}
                disabled={locked}
                onClick={() => onReconnect(connection.id)}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      )}
      {connection.status !== 'disconnected' &&
        (confirmingDisconnect ? (
          <div
            role="group"
            aria-label={`Disconnect ${connection.institution_name} confirmation`}
            className="connection-confirm"
          >
            <p>
              Disconnect {connection.institution_name}? Linked Mohr accounts will
              be archived. Imported history is kept. This connection will stop
              syncing.
            </p>
            {disconnectNoticeForConnection?.status === 'in-flight' && (
              <p role="status" className="connection-note">
                Disconnecting {connection.institution_name}…
              </p>
            )}
            {disconnectNoticeForConnection?.status === 'error' && (
              <div className="error-summary" role="alert">
                <p>{disconnectNoticeForConnection.message}</p>
                <button
                  type="button"
                  className="btn"
                  aria-label={`Retry disconnect for ${connection.institution_name}`}
                  disabled={mutationInFlight !== null}
                  onClick={() => onRetryDisconnect(connection.id)}
                >
                  Retry
                </button>
              </div>
            )}
            <div className="connection-confirm-actions">
              <button
                type="button"
                className="btn"
                ref={cancelRef}
                disabled={mutationInFlight !== null}
                onClick={() => onCancelDisconnect(connection.id)}
              >
                Cancel
              </button>
<button
                type="button"
                className="btn btn-danger"
                disabled={mutationInFlight !== null}
                onClick={() => onConfirmDisconnect(connection.id)}
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="connection-sync">
            <button
              type="button"
              className="btn btn-secondary"
              aria-label={`Disconnect ${connection.institution_name}`}
              ref={disconnectButtonRef}
              disabled={locked}
              onClick={() => onOpenDisconnect(connection.id)}
            >
              Disconnect
            </button>
          </div>
        ))}
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
  const [reconnectNotice, setReconnectNotice] = useState<ReconnectNotice | null>(
    null,
  )
  const [disconnectNotice, setDisconnectNotice] =
    useState<DisconnectNotice | null>(null)
  const [confirmingId, setConfirmingId] = useState<number | null>(null)
  const [mutationInFlight, setMutationInFlight] = useState<Mutation | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const mutationInFlightRef = useRef<Mutation | null>(null)
  const reconnectStatusRef = useRef<ReconnectStatus>('idle')
  const openedTokenRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const settleReconnect = useCallback(() => {
    mutationInFlightRef.current = null
    setMutationInFlight(null)
    setLinkToken(null)
    openedTokenRef.current = null
  }, [])

  const finishReconnect = useCallback(() => {
    settleReconnect()
    reconnectStatusRef.current = 'idle'
    setReconnectNotice(null)
    setAttempt((current) => current + 1)
  }, [settleReconnect])

  const handleReconnectSuccess = useCallback(() => {
    if (reconnectStatusRef.current !== 'linking') return
    const mutation = mutationInFlightRef.current
    if (mutation === null || mutation.kind !== 'reconnect') return
    // Update mode never exchanges a public token: the permanent access token
    // stays stored server-side, so the browser's onSuccess payload carries no
    // credential that should be stored, logged, or sent anywhere. The repair
    // finishes with the authenticated completion handshake.
    reconnectStatusRef.current = 'completing'
    setReconnectNotice({ status: 'completing', connectionId: mutation.connectionId })
    void completePlaidUpdate(mutation.connectionId)
      .then(() => {
        if (!mountedRef.current) return
        if (mutationInFlightRef.current !== mutation) return
        if (reconnectStatusRef.current !== 'completing') return
        finishReconnect()
      })
      .catch((caught: unknown) => {
        if (!mountedRef.current) return
        if (mutationInFlightRef.current !== mutation) return
        if (caught instanceof ApiError && caught.status === 401) {
          settleReconnect()
          reconnectStatusRef.current = 'idle'
          setReconnectNotice(null)
          clearSession()
          return
        }
        settleReconnect()
        reconnectStatusRef.current = 'error'
        setReconnectNotice({
          status: 'error',
          connectionId: mutation.connectionId,
          message:
            caught instanceof ApiError
              ? userMessage(caught)
              : GENERIC_ERROR_MESSAGE,
        })
      })
  }, [clearSession, finishReconnect, settleReconnect])

  const handleReconnectExit = useCallback(
    (error: PlaidLinkError | null) => {
      if (reconnectStatusRef.current !== 'linking') return
      const mutation = mutationInFlightRef.current
      if (mutation === null || mutation.kind !== 'reconnect') return
      settleReconnect()
      if (error === null) {
        reconnectStatusRef.current = 'idle'
        setReconnectNotice(null)
        setAttempt((current) => current + 1)
        return
      }
      reconnectStatusRef.current = 'error'
      setReconnectNotice({
        status: 'error',
        connectionId: mutation.connectionId,
        message:
          error.error_code === 'INVALID_LINK_TOKEN'
            ? INVALID_LINK_TOKEN_MESSAGE
            : LINK_EXIT_ERROR_MESSAGE,
      })
    },
    [settleReconnect],
  )

  const { open, ready, error } = usePlaidLink({
    token: linkToken,
    onSuccess: handleReconnectSuccess,
    onExit: handleReconnectExit,
  })

  const startReconnect = useCallback(
    (connectionId: number) => {
      if (mutationInFlightRef.current !== null) return
      const mutation: Mutation = { kind: 'reconnect', connectionId }
      mutationInFlightRef.current = mutation
      setMutationInFlight(mutation)
      reconnectStatusRef.current = 'preparing'
      setReconnectNotice({ status: 'preparing', connectionId })
      void createPlaidUpdateLinkToken(connectionId)
        .then((tokenInfo) => {
          if (!mountedRef.current) return
          if (mutationInFlightRef.current !== mutation) return
          if (reconnectStatusRef.current !== 'preparing') return
          reconnectStatusRef.current = 'linking'
          setReconnectNotice({ status: 'linking', connectionId })
          setLinkToken(tokenInfo.link_token)
        })
        .catch((caught: unknown) => {
          if (!mountedRef.current) return
          if (mutationInFlightRef.current !== mutation) return
          if (caught instanceof ApiError && caught.status === 401) {
            settleReconnect()
            reconnectStatusRef.current = 'idle'
            setReconnectNotice(null)
            clearSession()
            return
          }
          settleReconnect()
          reconnectStatusRef.current = 'error'
          setReconnectNotice({
            status: 'error',
            connectionId,
            message:
              caught instanceof ApiError
                ? userMessage(caught)
                : GENERIC_ERROR_MESSAGE,
          })
        })
    },
    [clearSession, settleReconnect],
  )

  useEffect(() => {
    if (reconnectNotice?.status !== 'linking') return
    if (linkToken === null) return
    if (!ready) return
    if (openedTokenRef.current === linkToken) return
    openedTokenRef.current = linkToken
    open()
  }, [linkToken, open, ready, reconnectNotice])

  useEffect(() => {
    if (reconnectNotice?.status !== 'linking') return
    if (error === null) return
    // The Plaid script failed to load: fail the flow with a retryable message
    // instead of leaving the control stuck disabled. The state transition runs
    // in a microtask callback so the effect stays free of synchronous setState
    // calls, matching the connect flow's load-failure handling.
    queueMicrotask(() => {
      if (!mountedRef.current) return
      if (reconnectStatusRef.current !== 'linking') return
      const mutation = mutationInFlightRef.current
      if (mutation === null || mutation.kind !== 'reconnect') return
      settleReconnect()
      reconnectStatusRef.current = 'error'
      setReconnectNotice({
        status: 'error',
        connectionId: mutation.connectionId,
        message: LINK_LOAD_ERROR_MESSAGE,
      })
    })
  }, [error, reconnectNotice, settleReconnect])

  const openDisconnect = useCallback((connectionId: number) => {
    setConfirmingId(connectionId)
  }, [])

  const cancelDisconnect = useCallback(() => {
    setConfirmingId(null)
    setDisconnectNotice(null)
  }, [])

  const confirmDisconnect = useCallback(
    (connectionId: number) => {
      if (mutationInFlightRef.current !== null) return
      const mutation: Mutation = { kind: 'disconnect', connectionId }
      mutationInFlightRef.current = mutation
      setMutationInFlight(mutation)
      setDisconnectNotice({ status: 'in-flight', connectionId })
      void disconnectPlaidConnection(connectionId)
        .then(() => {
          if (!mountedRef.current) return
          if (mutationInFlightRef.current !== mutation) return
          mutationInFlightRef.current = null
          setMutationInFlight(null)
          setDisconnectNotice(null)
          setConfirmingId(null)
          setAttempt((current) => current + 1)
        })
        .catch((caught: unknown) => {
          if (!mountedRef.current) return
          if (mutationInFlightRef.current !== mutation) return
          mutationInFlightRef.current = null
          setMutationInFlight(null)
          if (caught instanceof ApiError && caught.status === 401) {
            setDisconnectNotice(null)
            setConfirmingId(null)
            clearSession()
            return
          }
          setDisconnectNotice({
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
      if (mutationInFlightRef.current !== null) return
      const mutation: Mutation = { kind: 'sync', connectionId }
      mutationInFlightRef.current = mutation
      setMutationInFlight(mutation)
      setSyncNotice({ status: 'in-flight', connectionId })
      void syncPlaidConnection(connectionId)
        .then((result) => {
          if (!mountedRef.current) return
          if (mutationInFlightRef.current !== mutation) return
          mutationInFlightRef.current = null
          setMutationInFlight(null)
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
          if (!mountedRef.current) return
          if (mutationInFlightRef.current !== mutation) return
          mutationInFlightRef.current = null
          setMutationInFlight(null)
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
              reconnectNotice={reconnectNotice}
              disconnectNotice={disconnectNotice}
              confirmingDisconnect={confirmingId === connection.id}
              mutationInFlight={mutationInFlight}
              confirmationOpen={confirmingId !== null}
              onSync={startSync}
              onReconnect={startReconnect}
              onOpenDisconnect={openDisconnect}
              onCancelDisconnect={cancelDisconnect}
              onConfirmDisconnect={confirmDisconnect}
              onRetryDisconnect={confirmDisconnect}
            />
          ))}
        </ul>
      )}
    </div>
  )
}