import { useState, type ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SegmentedControl from './SegmentedControl'

const motionSpy = vi.hoisted(() => ({
  reduced: false,
  animatedSpanRenders: 0,
}))

// Keep the real layout renderer and only force the reduced-motion branch; the
// spy records whether the animated (projection) selection branch rendered.
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>()
  const RealSpan = actual.motion.span
  return {
    ...actual,
    useReducedMotion: () => motionSpy.reduced,
    motion: new Proxy(actual.motion, {
      get(target, property, receiver) {
        if (property === 'span') {
          return function AnimatedSpan(props: ComponentProps<typeof RealSpan>) {
            motionSpy.animatedSpanRenders += 1
            return <RealSpan {...props} />
          }
        }
        return Reflect.get(target, property, receiver)
      },
    }),
  }
})

const OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'income', label: 'Income' },
  { value: 'expense', label: 'Expense' },
]

function Controlled({
  initial = 'all',
  label = 'Transaction type',
  disabled = false,
  onChange = () => {},
}: {
  initial?: string
  label?: string
  disabled?: boolean
  onChange?: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <SegmentedControl
      options={OPTIONS}
      value={value}
      onValueChange={(next) => {
        onChange(next)
        setValue(next)
      }}
      label={label}
      disabled={disabled}
    />
  )
}

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  motionSpy.reduced = false
  motionSpy.animatedSpanRenders = 0
})

describe('SegmentedControl', () => {
  it('reports a clicked value and reflects controlled pressed state', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    const group = screen.getByRole('group', { name: 'Transaction type' })
    const all = within(group).getByRole('button', { name: 'All' })
    const income = within(group).getByRole('button', { name: 'Income' })

    expect(all).toHaveAttribute('aria-pressed', 'true')
    expect(income).toHaveAttribute('aria-pressed', 'false')

    await user.click(income)

    expect(onChange).toHaveBeenCalledWith('income')
    expect(income).toHaveAttribute('aria-pressed', 'true')
    expect(all).toHaveAttribute('aria-pressed', 'false')
    expect(motionSpy.animatedSpanRenders).toBeGreaterThan(0)
  })

  it('keeps a single selected tab stop as the controlled value changes', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    const group = screen.getByRole('group', { name: 'Transaction type' })
    const all = within(group).getByRole('button', { name: 'All' })
    const income = within(group).getByRole('button', { name: 'Income' })
    const expense = within(group).getByRole('button', { name: 'Expense' })

    expect(all).toHaveAttribute('tabindex', '0')
    expect(income).toHaveAttribute('tabindex', '-1')
    expect(expense).toHaveAttribute('tabindex', '-1')

    await user.click(expense)

    expect(all).toHaveAttribute('tabindex', '-1')
    expect(income).toHaveAttribute('tabindex', '-1')
    expect(expense).toHaveAttribute('tabindex', '0')
  })

  it('keeps its first option tabbable when the controlled value matches no option', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <SegmentedControl
        options={OPTIONS}
        value="stale"
        onValueChange={onChange}
        label="Transaction type"
      />,
    )

    const group = screen.getByRole('group', { name: 'Transaction type' })
    const all = within(group).getByRole('button', { name: 'All' })
    const income = within(group).getByRole('button', { name: 'Income' })

    // No option is pressed, but the widget still exposes one keyboard entry point.
    for (const button of within(group).getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false')
    }
    expect(all).toHaveAttribute('tabindex', '0')
    expect(income).toHaveAttribute('tabindex', '-1')

    all.focus()
    await user.keyboard('{ArrowRight}')

    expect(onChange).toHaveBeenCalledWith('income')
    expect(income).toHaveFocus()
  })

  it('moves selection with arrow keys and wraps at both ends, focusing the chosen option', async () => {
    const user = userEvent.setup()
    render(<Controlled />)

    const group = screen.getByRole('group', { name: 'Transaction type' })
    within(group).getByRole('button', { name: 'All' }).focus()

    await user.keyboard('{ArrowRight}')
    expect(within(group).getByRole('button', { name: 'Income' })).toHaveFocus()
    expect(
      within(group).getByRole('button', { name: 'Income' }),
    ).toHaveAttribute('aria-pressed', 'true')

    await user.keyboard('{ArrowDown}')
    expect(
      within(group).getByRole('button', { name: 'Expense' }),
    ).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(within(group).getByRole('button', { name: 'All' })).toHaveFocus()

    await user.keyboard('{ArrowLeft}')
    expect(
      within(group).getByRole('button', { name: 'Expense' }),
    ).toHaveFocus()

    await user.keyboard('{ArrowUp}')
    expect(
      within(group).getByRole('button', { name: 'Income' }),
    ).toHaveFocus()
  })

  it('selects and focuses the first and last options with Home and End', async () => {
    const user = userEvent.setup()
    render(<Controlled initial="income" />)

    const group = screen.getByRole('group', { name: 'Transaction type' })
    within(group).getByRole('button', { name: 'Income' }).focus()

    await user.keyboard('{Home}')
    const all = within(group).getByRole('button', { name: 'All' })
    expect(all).toHaveFocus()
    expect(all).toHaveAttribute('aria-pressed', 'true')

    await user.keyboard('{End}')
    const expense = within(group).getByRole('button', { name: 'Expense' })
    expect(expense).toHaveFocus()
    expect(expense).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps each rendered control selected option independent', async () => {
    const user = userEvent.setup()
    render(<Controlled label="Primary" />)
    render(<Controlled label="Secondary" initial="income" />)

    const primary = screen.getByRole('group', { name: 'Primary' })
    const secondary = screen.getByRole('group', { name: 'Secondary' })

    expect(primary.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
    expect(secondary.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)

    await user.click(within(primary).getByRole('button', { name: 'Expense' }))

    expect(
      within(primary).getByRole('button', { name: 'Expense' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(secondary).getByRole('button', { name: 'Income' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(
      within(secondary).getByRole('button', { name: 'Expense' }),
    ).toHaveAttribute('aria-pressed', 'false')
  })

  it('disables every native button and ignores click and key-driven input when disabled', async () => {
    const onChange = vi.fn()
    render(<Controlled disabled onChange={onChange} />)

    const group = screen.getByRole('group', { name: 'Transaction type' })
    expect(group).toHaveAttribute('data-disabled')

    const buttons = within(group).getAllByRole('button')
    expect(buttons).toHaveLength(3)
    for (const button of buttons) {
      expect(button).toBeDisabled()
    }

    const income = within(group).getByRole('button', { name: 'Income' })
    fireEvent.click(income)
    fireEvent.keyDown(income, { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('updates pressed state and keeps the static selection under reduced motion', async () => {
    motionSpy.reduced = true
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    const group = screen.getByRole('group', { name: 'Transaction type' })
    const income = within(group).getByRole('button', { name: 'Income' })

    expect(motionSpy.animatedSpanRenders).toBe(0)

    await user.click(income)

    expect(onChange).toHaveBeenCalledWith('income')
    expect(income).toHaveAttribute('aria-pressed', 'true')
    expect(group.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
    expect(motionSpy.animatedSpanRenders).toBe(0)
  })
})
