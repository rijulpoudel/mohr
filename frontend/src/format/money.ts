const DECIMAL_PATTERN = /^-?\d+\.\d{2}$/
const GROUP_PATTERN = /\B(?=(\d{3})+(?!\d))/g

export function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL_PATTERN.test(value)
}

export function formatMoney(value: string): string {
  if (!isDecimalString(value)) {
    throw new Error('formatMoney requires a decimal string with two places.')
  }
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction] = unsigned.split('.')
  const grouped = whole.replace(GROUP_PATTERN, ',')
  const zero = /^0+$/.test(whole) && /^0+$/.test(fraction)
  const sign = negative && !zero ? '-' : ''
  return `${sign}$${grouped}.${fraction}`
}

export function formatSignedMoney(
  amount: string,
  transactionType: 'income' | 'expense',
): string {
  const formatted = formatMoney(amount)
  if (formatted.startsWith('-') || formatted === '$0.00') return formatted
  return `${transactionType === 'income' ? '+' : '-'}${formatted}`
}
