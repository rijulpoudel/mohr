const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export function formatMonthLabel(month: string): string {
  const year = month.slice(0, 4)
  const index = Number(month.slice(5, 7)) - 1
  const name = MONTH_NAMES[index]
  if (name === undefined) return month
  return `${name} ${year}`
}

// Month input values become `${month}-01` on submit, and stored dates
// support years from 1 to 9999, so a four-digit year of 0000 can never
// become a real first-of-month date.
export function isValidBudgetMonth(value: string): boolean {
  if (!MONTH_PATTERN.test(value)) return false
  return Number(value.slice(0, 4)) >= 1
}
