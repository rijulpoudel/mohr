import { useEffect, useState } from 'react'
import { fetchAccounts, type Account } from '../api/accounts'
import { ApiError, userMessage } from '../api/types'
import { useAuth } from '../auth/AuthContext'
import { formatMoney } from '../format/money'

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.'

const ACCOUNT_TYPE_LABELS: Record<Account['account_type'], string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit card',
}

type AccountsState =
  | { status: 'loading' }
  | { status: 'ready'; accounts: Account[] }
  | { status: 'error'; message: string }

function AccountItem({ account }: { account: Account }) {
  return (
    <li className="account-item">
      <div className="account-main">
        <h3 className="account-name">{account.name}</h3>
        <span className="account-status">
          {account.is_archived ? 'Archived' : 'Active'}
        </span>
      </div>
      <p className="account-type">{ACCOUNT_TYPE_LABELS[account.account_type]}</p>
      <dl className="account-balances">
        <div className="account-balance">
          <dt>Current balance</dt>
          <dd>{formatMoney(account.current_balance)}</dd>
        </div>
        <div className="account-balance">
          <dt>Opening balance</dt>
          <dd>{formatMoney(account.opening_balance)}</dd>
        </div>
      </dl>
    </li>
  )
}

function AccountsPanel({ onRetry }: { onRetry: () => void }) {
  const { clearSession } = useAuth()
  const [state, setState] = useState<AccountsState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    void fetchAccounts()
      .then((accounts) => {
        if (cancelled) return
        setState({ status: 'ready', accounts })
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
  }, [clearSession])

  if (state.status === 'loading') {
    return <p role="status">Loading your accounts…</p>
  }

  if (state.status === 'error') {
    return (
      <div className="error-summary" role="alert">
        <p>{state.message}</p>
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      </div>
    )
  }

  if (state.accounts.length === 0) {
    return (
      <p className="empty-state">
        No accounts yet. Accounts you create will appear here.
      </p>
    )
  }

  return (
    <ul className="account-list">
      {state.accounts.map((account) => (
        <AccountItem key={account.id} account={account} />
      ))}
    </ul>
  )
}

export function AccountsScreen() {
  const [attempt, setAttempt] = useState(0)

  return (
    <div className="screen">
      <h2>Accounts</h2>
      <AccountsPanel
        key={attempt}
        onRetry={() => setAttempt((current) => current + 1)}
      />
    </div>
  )
}
