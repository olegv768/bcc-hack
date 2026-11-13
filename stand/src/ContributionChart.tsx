import { scaleLinear } from 'd3'
import type { FeatureKey, RecipientFeatures } from '../../service/src/features.ts'
import { FEATURE_KEYS } from '../../service/src/features.ts'
import { FEATURE_LABELS } from './scenarios.ts'
import { useWidth } from './useWidth.ts'

const ROW = 46
const BAR = 14
const PAD = 44 // место под подпись значения у конца столбика

// Вклад каждого признака в оценку: вправо — поднимает риск, влево — снижает.
export function ContributionChart(props: { contributions: Record<FeatureKey, number>; features: RecipientFeatures }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const values = FEATURE_KEYS.map((key) => props.contributions[key])
  // ось от самого сильного «снижает» до самого сильного «поднимает»; ноль всегда на ней
  const x = scaleLinear()
    .domain([Math.min(-0.5, ...values), Math.max(0.5, ...values)])
    .range([PAD, Math.max(PAD + 1, width - PAD)])
  const height = FEATURE_KEYS.length * ROW

  return (
    <figure className="m-0">
      <figcaption className="mb-3 text-[14px] text-ink-2">Длина столбика — насколько признак сдвинул оценку.</figcaption>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-lower" /> снижает риск
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-raise" /> поднимает риск
        </span>
      </div>
      <div ref={ref}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label="Вклад признаков получателя в оценку риска">
            <line x1={x(0)} x2={x(0)} y1={0} y2={height} stroke="#c5cbd8" />
            {FEATURE_KEYS.map((key, i) => {
              const value = props.contributions[key]
              const raw = props.features[key]
              const y = i * ROW
              const left = Math.min(x(0), x(value))
              const barWidth = Math.abs(x(value) - x(0))
              const label = raw === null ? 'нет данных' : (value > 0 ? '+' : '') + value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
              return (
                <g key={key}>
                  <title>{`${raw === null ? key : FEATURE_LABELS[key](raw)} — вклад ${label}`}</title>
                  <text x={0} y={y + 14} fontSize={13} fill="#0e1b3d">
                    {raw === null ? `${key}: не передан` : FEATURE_LABELS[key](raw)}
                  </text>
                  <rect x={0} y={y} width={width} height={ROW} fill="transparent" />
                  <rect x={left} y={y + 22} width={barWidth} height={BAR} rx={3} fill={value >= 0 ? '#d03b3b' : '#2a78d6'} />
                  <text
                    x={value >= 0 ? x(value) + 6 : x(value) - 6}
                    y={y + 33}
                    fontSize={12}
                    textAnchor={value >= 0 ? 'start' : 'end'}
                    fill="#46506a"
                    className="tabular"
                  >
                    {label}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
      </div>
    </figure>
  )
}
