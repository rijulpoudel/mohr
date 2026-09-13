import { describe, expect, it } from 'vitest'
import { formatMoney, formatSignedMoney, isDecimalString } from './money'

describe('formatMoney', () => {
  it('formats zero', () => {
    expect(formatMoney('0.00')).toBe('$0.00')
  })

  it('formats a positive amount with comma grouping', () => {
    expect(formatMoney('1234567.89')).toBe('$1,234,567.89')
  })

  it('formats a negative amount', () => {
    expect(formatMoney('-1234.50')).toBe('-$1,234.50')
  })

  it('formats a very large amount exactly', () => {
    expect(formatMoney('123456789012345678.90')).toBe(
      '$123,456,789,012,345,678.90',
    )
  })

  it('keeps exact cents without floating point rounding', () => {
    expect(formatMoney('0.01')).toBe('$0.01')
    expect(formatMoney('0.10')).toBe('$0.10')
    expect(formatMoney('99999999999999999999999999.99')).toBe(
      '$99,999,999,999,999,999,999,999,999.99',
    )
  })

  it('normalizes negative zero', () => {
    expect(formatMoney('-0.00')).toBe('$0.00')
  })

  it.each(['12.3', '12', '1,234.56', 'abc', '', '12.345', '+12.34'])(
    'rejects the malformed value %s',
    (value) => {
      expect(() => formatMoney(value)).toThrow()
    },
  )
})

describe('formatSignedMoney', () => {
  it('prefixes income with a plus', () => {
    expect(formatSignedMoney('25.50', 'income')).toBe('+$25.50')
  })

  it('prefixes expenses with a minus', () => {
    expect(formatSignedMoney('25.50', 'expense')).toBe('-$25.50')
  })

  it('keeps grouping and exact cents', () => {
    expect(formatSignedMoney('1234.00', 'income')).toBe('+$1,234.00')
  })
})

describe('isDecimalString', () => {
  it.each(['0.00', '-0.00', '10.01', '-99.99', '123456789012345678.90'])(
    'accepts the backend decimal %s',
    (value) => {
      expect(isDecimalString(value)).toBe(true)
    },
  )

  it.each(['12.3', '12', '1,234.56', 'abc', '', '12.345', '+12.34', '1e3'])(
    'rejects the malformed value %s',
    (value) => {
      expect(isDecimalString(value)).toBe(false)
    },
  )

  it.each([null, undefined, 12.34, ['1.00']])(
    'rejects the non-string value %s',
    (value) => {
      expect(isDecimalString(value)).toBe(false)
    },
  )
})
