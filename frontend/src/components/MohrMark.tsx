import { useId } from 'react'

interface MohrMarkProps {
  size?: number
}

export function MohrMark({ size = 20 }: MohrMarkProps) {
  const petalId = `mohr-petal-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg
      className="mohr-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <path
          id={petalId}
          d="M16 3.5 C14.1 5.4 14.1 6.5 16 7.5 C17.9 6.5 17.9 5.4 16 3.5 Z"
        />
      </defs>
      <circle
        cx="16"
        cy="16"
        r="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <g fill="currentColor">
        <use href={`#${petalId}`} />
        <use href={`#${petalId}`} transform="rotate(45 16 16)" />
        <use href={`#${petalId}`} transform="rotate(90 16 16)" />
        <use href={`#${petalId}`} transform="rotate(135 16 16)" />
        <use href={`#${petalId}`} transform="rotate(180 16 16)" />
        <use href={`#${petalId}`} transform="rotate(225 16 16)" />
        <use href={`#${petalId}`} transform="rotate(270 16 16)" />
        <use href={`#${petalId}`} transform="rotate(315 16 16)" />
      </g>
      <circle cx="16" cy="16" r="1.2" fill="currentColor" />
      <path d="M9.5 21 V10.5 L16 17 L22.5 10.5 V21 Z" fill="currentColor" />
    </svg>
  )
}
