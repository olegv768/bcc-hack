import type { EntityType } from '../../../service/src/graph/types.ts'
import { ICON } from './look.ts'

// Значок типа сущности для светлых панелей: тот же, что внутри узла графа.
export function TypeIcon(props: { type: EntityType | 'external'; size?: number; tone?: string }) {
  const size = props.size ?? 24
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-field text-ink-2"
      style={{ width: size, height: size, ...(props.tone ? { background: props.tone, color: '#fff' } : {}) }}
      aria-hidden="true"
    >
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        <path d={ICON[props.type]} />
      </svg>
    </span>
  )
}
