import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SegmentedControl from './SegmentedControl'

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

function installReducedMotion() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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

  it('disables every native button and blocks click and keyboard input when disabled', async () => {
    const user = userEvent.setup()
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
    expect(onChange).not.toHaveBeenCalled()

    buttons[0].focus()
    await user.keyboard('{ArrowRight}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('updates pressed state and selection under a reduced-motion preference', async () => {
    installReducedMotion()
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Controlled onChange={onChange} />)

    const group = screen.getByRole('group', { name: 'Transaction type' })
    const income = within(group).getByRole('button', { name: 'Income' })

    await user.click(income)

    expect(onChange).toHaveBeenCalledWith('income')
    expect(income).toHaveAttribute('aria-pressed', 'true')
    expect(group.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1)
  })
})
