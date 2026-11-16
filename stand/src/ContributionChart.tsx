import type { FeatureKey, RecipientFeatures } from '../../service/src/features.ts'
import { FEATURE_KEYS } from '../../service/src/features.ts'
import { FEATURE_LABELS } from './scenarios.ts'

// Вклад каждого признака в оценку: вправо от нуля — поднимает риск, влево — снижает.
// Строка = подпись, дорожка с нулём посередине, число. Самый сильный признак — сверху.
export function ContributionChart(props: { contributions: Record<FeatureKey, number>; features: RecipientFeatures }) {
  const rows = FEATURE_KEYS.map((key) => ({ key, value: props.contributions[key], raw: props.features[key] })).sort(
    (a, b) => Math.abs(b.value) - Math.abs(a.value),
  )
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)))

  return (
    <figure className="m-0">
      <figcaption className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-ink-2">
        <span>Длина полосы — насколько признак сдвинул оценку.</span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full bg-lower" aria-hidden="true" /> снижает риск
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full bg-raise" aria-hidden="true" /> поднимает риск
        </span>
      </figcaption>
      <ul className="space-y-3.5" aria-label="Вклад признаков получателя в оценку риска">
        {rows.map(({ key, value, raw }) => {
          const share = (Math.abs(value) / max) * 50
          const label = raw === null ? 'нет данных' : (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 })
          return (
            <li key={key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,15rem)_1fr_3.5rem]">
              <span className="text-[14px] leading-snug sm:text-[14.5px]">{raw === null ? `${key}: не передан` : FEATURE_LABELS[key](raw)}</span>
              <span className={'tabular text-right text-[14px] font-semibold sm:order-last ' + (raw === null ? 'text-muted' : 'text-ink')}>{label}</span>
              {/* дорожка: ноль посередине */}
              <span className="relative col-span-2 h-2.5 rounded-full bg-field sm:col-span-1" aria-hidden="true">
                <span className="absolute top-[-3px] bottom-[-3px] left-1/2 w-px bg-[#c5cbd8]" />
                {raw !== null && value !== 0 && (
                  <span
                    className={'absolute top-0 h-full ' + (value > 0 ? 'rounded-r-full bg-raise' : 'rounded-l-full bg-lower')}
                    style={value > 0 ? { left: '50%', width: `${share}%` } : { right: '50%', width: `${share}%` }}
                  />
                )}
              </span>
            </li>
          )
        })}
      </ul>
    </figure>
  )
}
