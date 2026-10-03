import styles from './MetricCard.module.css'

export interface MetricCardProps {
  label: string
  value: string
  className?: string
  valueClassName?: string
}

export function MetricCard({
  label,
  value,
  className,
  valueClassName,
}: MetricCardProps) {
  const rootClassName =
    className === undefined ? styles.card : `${styles.card} ${className}`
  return (
    <div className={rootClassName}>
      <dt>{label}</dt>
      <dd className={valueClassName}>{value}</dd>
    </div>
  )
}
