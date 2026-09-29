export const CONNECTION_STALE_AFTER_MS = 24 * 60 * 60 * 1000

export function isConnectionStale(lastSyncedAt: string, now: number): boolean {
  return now - Date.parse(lastSyncedAt) > CONNECTION_STALE_AFTER_MS
}

export function formatSyncTime(iso: string): string {
  const date = new Date(iso)
  const formatted = date.toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  })
  return `${formatted} UTC`
}
