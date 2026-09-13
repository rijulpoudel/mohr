import { describe, expect, it } from 'vitest'
import { formatMonthLabel, isValidBudgetMonth } from './month'

describe('formatMonthLabel', () => {
  it('formats a normal month without timezone math', () => {
    expect(formatMonthLabel('2026-09-01')).toBe('September 2026')
  })

  it('falls back to the raw value for an unknown month number', () => {
    expect(formatMonthLabel('2026-13-01')).toBe('2026-13-01')
  })
})

describe('isValidBudgetMonth', () => {
  it('accepts a valid month', () => {
    expect(isValidBudgetMonth('2026-09')).toBe(true)
  })

  it('accepts the smallest supported year', () => {
    expect(isValidBudgetMonth('0001-01')).toBe(true)
  })

  it('rejects a month number of zero', () => {
    expect(isValidBudgetMonth('2026-00')).toBe(false)
  })

  it('rejects a month number above twelve', () => {
    expect(isValidBudgetMonth('2026-13')).toBe(false)
  })

  it('rejects an out-of-range year', () => {
    expect(isValidBudgetMonth('0000-09')).toBe(false)
  })

  it('rejects an empty value', () => {
    expect(isValidBudgetMonth('')).toBe(false)
  })
})
