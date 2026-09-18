import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlaidLink, type PlaidLinkError } from 'react-plaid-link'
import {
  createPlaidLinkToken,
  exchangePlaidPublicToken,
  syncPlaidConnection,
} from '../api/plaid'
import { ApiError, userMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const INVALID_LINK_TOKEN_MESSAGE =
  'Your bank connection link expired. Please try again.'
const LINK_EXIT_ERROR_MESSAGE =
  'The bank connection could not be completed. Please try again.'
const LINK_LOAD_ERROR_MESSAGE =
  'We could not start the bank connection. Please try again.'
const CONNECT_LABEL = 'Connect a bank'
const PREPARING_LABEL = 'Preparing your bank connection…'
const PREPARING_MESSAGE = 'Preparing a secure connection to your bank…'
const IMPORTING_MESSAGE = 'Importing your bank data. This may take a few minutes.'
const STILL_IMPORTING_MESSAGE =
  'Still importing. Your bank connection will appear once the first import finishes.'

type ConnectFlowStatus =
  | 'idle'
  | 'preparing'
  | 'linking'
  | 'exchanging'
  | 'syncing'
  | 'done'
  | 'processing'
  | 'error'

interface SyncSummary {
  added: number
  modified: number
  removed: number
}

const IN_FLIGHT_STATUSES: ReadonlySet<ConnectFlowStatus> = new Set([
  'preparing',
  'linking',
  'exchanging',
  'syncing',
])

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

export function ConnectBankButton({
  onConnectionAdded,
}: {
  onConnectionAdded: () => void
}) {
  const { clearSession } = useAuth()
  const [flowStatus, setFlowStatus] = useState<ConnectFlowStatus>('idle')
  const [summary, setSummary] = useState<SyncSummary | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [linkToken, setLinkToken] = useState<string | null>(null)
  const flowStatusRef = useRef<ConnectFlowStatus>('idle')
  const exchangeHandleRef = useRef<string | null>(null)
  const openedTokenRef = useRef<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const updateFlowStatus = useCallback((next: ConnectFlowStatus) => {
    flowStatusRef.current = next
    setFlowStatus(next)
  }, [])

  const clearTokenState = useCallback(() => {
    exchangeHandleRef.current = null
    openedTokenRef.current = null
    setLinkToken(null)
  }, [])

  const handleSessionExpired = useCallback(() => {
    clearTokenState()
    updateFlowStatus('idle')
    clearSession()
  }, [clearSession, clearTokenState, updateFlowStatus])

  const failFlow = useCallback(
    (caught: unknown) => {
      clearTokenState()
      updateFlowStatus('error')
      setErrorMessage(
        caught instanceof ApiError ? userMessage(caught) : GENERIC_ERROR_MESSAGE,
      )
    },
    [clearTokenState, updateFlowStatus],
  )

  const prepareLinkToken = useCallback(async () => {
    try {
      const tokenInfo = await createPlaidLinkToken()
      if (!mountedRef.current || flowStatusRef.current !== 'preparing') return
      exchangeHandleRef.current = tokenInfo.exchange_handle
      setLinkToken(tokenInfo.link_token)
      updateFlowStatus('linking')
    } catch (caught) {
      if (!mountedRef.current) return
      if (caught instanceof ApiError && caught.status === 401) {
        handleSessionExpired()
        return
      }
      failFlow(caught)
    }
  }, [failFlow, handleSessionExpired, updateFlowStatus])

  const runFirstSync = useCallback(
    async (connectionId: number) => {
      try {
        const result = await syncPlaidConnection(connectionId)
        if (!mountedRef.current || flowStatusRef.current !== 'syncing') return
        if (result.status === 'processing') {
          updateFlowStatus('processing')
        } else {
          setSummary({
            added: result.added,
            modified: result.modified,
            removed: result.removed,
          })
          updateFlowStatus('done')
        }
        clearTokenState()
        onConnectionAdded()
      } catch (caught) {
        if (!mountedRef.current) return
        if (caught instanceof ApiError && caught.status === 401) {
          handleSessionExpired()
          return
        }
        failFlow(caught)
      }
    },
    [
      clearTokenState,
      failFlow,
      handleSessionExpired,
      onConnectionAdded,
      updateFlowStatus,
    ],
  )

  const runExchange = useCallback(
    async (publicToken: string) => {
      const exchangeHandle = exchangeHandleRef.current
      if (exchangeHandle === null) {
        failFlow(new Error('Missing exchange handle'))
        return
      }
      updateFlowStatus('exchanging')
      try {
        const result = await exchangePlaidPublicToken(
          publicToken,
          exchangeHandle,
        )
        if (!mountedRef.current || flowStatusRef.current !== 'exchanging') return
        updateFlowStatus('syncing')
        void runFirstSync(result.connection.id)
      } catch (caught) {
        if (!mountedRef.current) return
        if (caught instanceof ApiError && caught.status === 401) {
          handleSessionExpired()
          return
        }
        failFlow(caught)
      }
    },
    [failFlow, handleSessionExpired, runFirstSync, updateFlowStatus],
  )

  const handleSuccess = useCallback(
    (publicToken: string | null) => {
      if (flowStatusRef.current !== 'linking') return
      if (publicToken === null) {
        failFlow(new Error('No bank connection was returned.'))
        return
      }
      void runExchange(publicToken)
    },
    [failFlow, runExchange],
  )

  const handleExit = useCallback(
    (error: PlaidLinkError | null) => {
      if (flowStatusRef.current !== 'linking') return
      clearTokenState()
      if (error === null) {
        updateFlowStatus('idle')
        return
      }
      updateFlowStatus('error')
      setErrorMessage(
        error.error_code === 'INVALID_LINK_TOKEN'
          ? INVALID_LINK_TOKEN_MESSAGE
          : LINK_EXIT_ERROR_MESSAGE,
      )
    },
    [clearTokenState, updateFlowStatus],
  )

  const startConnect = useCallback(() => {
    if (IN_FLIGHT_STATUSES.has(flowStatusRef.current)) return
    clearTokenState()
    setErrorMessage(null)
    setSummary(null)
    updateFlowStatus('preparing')
    void prepareLinkToken()
  }, [clearTokenState, prepareLinkToken, updateFlowStatus])

  const { open, ready, error } = usePlaidLink({
    token: linkToken,
    onSuccess: handleSuccess,
    onExit: handleExit,
  })

  useEffect(() => {
    if (flowStatus !== 'linking') return
    if (error === null) return
    // The Plaid script failed to load: fail the flow with a retryable message
    // instead of leaving the button stuck disabled. The state transition runs
    // in a microtask callback, the same shape as a subscription callback, so
    // the effect stays free of synchronous setState calls. The ref is
    // re-checked inside the callback because every other continuation in this
    // component re-validates the live flow before writing state, and a newer
    // flow must not be clobbered by this one. That re-check is defensive: no
    // test can observe it, because a load failure leaves the flow unable to
    // advance on its own.
    queueMicrotask(() => {
      if (!mountedRef.current) return
      if (flowStatusRef.current !== 'linking') return
      clearTokenState()
      updateFlowStatus('error')
      setErrorMessage(LINK_LOAD_ERROR_MESSAGE)
    })
  }, [clearTokenState, error, flowStatus, updateFlowStatus])

  useEffect(() => {
    if (flowStatus !== 'linking') return
    if (linkToken === null) return
    if (!ready) return
    if (openedTokenRef.current === linkToken) return
    openedTokenRef.current = linkToken
    open()
  }, [flowStatus, linkToken, open, ready])

  // A still-processing first import intentionally leaves the connect button
  // enabled: the user may connect another bank, and the pending connection
  // reports its own import status on its card.
  const inFlight = IN_FLIGHT_STATUSES.has(flowStatus)

  return (
    <div className="connect-bank">
      <button
        type="button"
        className="btn"
        onClick={startConnect}
        disabled={inFlight}
      >
        {flowStatus === 'preparing' ? PREPARING_LABEL : CONNECT_LABEL}
      </button>
      {flowStatus === 'preparing' && (
        <p role="status" className="notice">
          {PREPARING_MESSAGE}
        </p>
      )}
      {flowStatus === 'syncing' && (
        <p role="status" className="notice">
          {IMPORTING_MESSAGE}
        </p>
      )}
      {flowStatus === 'processing' && (
        <p role="status" className="notice">
          {STILL_IMPORTING_MESSAGE}
        </p>
      )}
      {flowStatus === 'done' && summary !== null && (
        <p role="status" className="notice">
          Bank connected. {syncSummaryMessage(summary)}
        </p>
      )}
      {flowStatus === 'error' && errorMessage !== null && (
        <div className="error-summary" role="alert">
          <p>{errorMessage}</p>
          <button type="button" className="btn" onClick={startConnect}>
            Retry
          </button>
        </div>
      )}
    </div>
  )
}