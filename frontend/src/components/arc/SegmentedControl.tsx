import { useId, useRef, type KeyboardEvent } from 'react'
import { LayoutGroup, motion, useReducedMotion } from 'motion/react'
import styles from './SegmentedControl.module.css'

export interface SegmentOption {
  value: string
  label: string
}

export interface SegmentedControlProps {
  options: readonly SegmentOption[]
  value: string
  onValueChange: (value: string) => void
  label: string
  disabled?: boolean
  className?: string
}

const MORPH_SPRING = { type: 'spring', visualDuration: 0.42, bounce: 0.16 } as const

export default function SegmentedControl({
  options,
  value,
  onValueChange,
  label,
  disabled = false,
  className,
}: SegmentedControlProps) {
  const id = useId()
  const reduced = useReducedMotion()
  const buttons = useRef<Array<HTMLButtonElement | null>>([])

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || options.length === 0) return
    const last = options.length - 1
    const target =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? selectedIndex === last
          ? 0
          : selectedIndex + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? selectedIndex === 0
            ? last
            : selectedIndex - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : -1
    if (target < 0 || !options[target]) return
    event.preventDefault()
    onValueChange(options[target].value)
    buttons.current[target]?.focus({ preventScroll: true })
  }

  return (
    <div
      className={`${styles.root} ${className ?? ''}`}
      role="group"
      aria-label={label}
      data-disabled={disabled || undefined}
    >
      <LayoutGroup id={id}>
        <div className={styles.track}>
          {options.map((option, index) => {
            const selected = value === option.value
            return (
              <button
                key={option.value}
                ref={(node) => {
                  buttons.current[index] = node
                }}
                className={styles.button}
                type="button"
                data-value={option.value}
                aria-pressed={selected}
                tabIndex={index === selectedIndex ? 0 : -1}
                disabled={disabled}
                onClick={() => onValueChange(option.value)}
                onKeyDown={onKeyDown}
              >
                {selected &&
                  (reduced ? (
                    <span className={styles.selection} aria-hidden="true" />
                  ) : (
                    <motion.span
                      className={styles.selection}
                      layoutId="selection"
                      layoutDependency={value}
                      transition={MORPH_SPRING}
                      aria-hidden="true"
                    />
                  ))}
                <span className={styles.label}>{option.label}</span>
              </button>
            )
          })}
        </div>
      </LayoutGroup>
    </div>
  )
}
