import { describe, expect, it } from 'vitest'
import {
  clampedPercent,
  decimalToCents,
  formatMoney,
  formatSignedMoney,
  isDecimalString,
} from './money'

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

describe('decimalToCents', () => {
  it('converts validated decimal strings to exact integer cents', () => {
    expect(decimalToCents('0.00')).toBe(0n)
    expect(decimalToCents('1500.00')).toBe(150000n)
    expect(decimalToCents('765.44')).toBe(76544n)
    expect(decimalToCents('-100.10')).toBe(-10010n)
    expect(decimalToCents('123456789012345678.90')).toBe(
      12345678901234567890n,
    )
  })

  it.each(['12.3', '12', '1,234.56', 'abc', '', '12.345', '+12.34'])(
    'throws for the malformed value %s',
    (value) => {
      expect(() => decimalToCents(value)).toThrow()
    },
  )
})

describe('clampedPercent', () => {
  it('returns the expected rounded whole percent for a proportional pair', () => {
    expect(clampedPercent('765.44', '2000.00')).toBe(38)
    expect(clampedPercent('333.35', '1000.00')).toBe(33)
    expect(clampedPercent('666.75', '1000.00')).toBe(67)
  })

  it('clamps a negative numerator to zero', () => {
    expect(clampedPercent('-100.10', '1500.00')).toBe(0)
  })

  it('clamps a value above the positive maximum to 100', () => {
    expect(clampedPercent('2000.00', '1500.00')).toBe(100)
  })

  it('returns 100 when the value equals the maximum', () => {
    expect(clampedPercent('1500.00', '1500.00')).toBe(100)
  })

  it('returns 0 for a zero or negative maximum', () => {
    expect(clampedPercent('10.00', '0.00')).toBe(0)
    expect(clampedPercent('10.00', '-5.00')).toBe(0)
  })

  it('computes large values exactly without floating point', () => {
    expect(clampedPercent('123456789012345678.90', '999999999999999999.99')).toBe(
      12,
    )
  })

  it.each(['12.3', '12', 'abc', '', '+12.34', '1,234.56'])(
    'throws for the malformed value %s',
    (value) => {
      expect(() => clampedPercent(value, '100.00')).toThrow()
      expect(() => clampedPercent('100.00', value)).toThrow()
    },
  )

  it('rejects non-string inputs consistently with the money helpers', () => {
    expect(() => clampedPercent(12.34 as unknown as string, '100.00')).toThrow()
    expect(() => clampedPercent('100.00', null as unknown as string)).toThrow()
  })
})
