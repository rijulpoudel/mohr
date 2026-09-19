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

export function decimalToCents(value: string): bigint {
  if (!isDecimalString(value)) {
    throw new Error('decimalToCents requires a decimal string with two places.')
  }
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction] = unsigned.split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction)
  return negative ? -cents : cents
}

export function sumMoney(values: readonly string[]): string {
  let total = 0n
  for (const value of values) {
    total += decimalToCents(value)
  }
  const negative = total < 0n
  const absolute = negative ? -total : total
  const whole = absolute / 100n
  const fraction = (absolute % 100n).toString().padStart(2, '0')
  return `${negative ? '-' : ''}${whole}.${fraction}`
}

export function clampedPercent(value: string, maximum: string): number {
  const numerator = decimalToCents(value)
  const denominator = decimalToCents(maximum)
  if (denominator <= 0n) return 0
  if (numerator <= 0n) return 0
  if (numerator >= denominator) return 100
  const rounded = (numerator * 100n + denominator / 2n) / denominator
  return Number(rounded)
}
