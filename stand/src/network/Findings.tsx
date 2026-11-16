import type { Finding, FindingKind, Investigation, MoneyRoute } from '../../../service/src/graph/types.ts'
import { Confidence } from './NodePanel.tsx'

const KIND: Record<FindingKind, string> = {
  confirmed_link: 'Связь с делом',
  triangle: '«Треугольник»',
  collector: 'Сборщик',
  repeated_pattern: 'Повторяющаяся схема',
  transit: 'Транзитный счёт',
  shared_identifier: 'Общий идентификатор',
  victims: 'Пострадавшие',
  central_node: 'Центр сети',
  not_suspicious: 'Не подозрительно',
}

const KIND_TONE: Partial<Record<FindingKind, string>> = {
  confirmed_link: 'bg-hold text-white',
  triangle: 'bg-[#e6ecff] text-[#1d3fbf]',
  collector: 'bg-hold-bg text-hold-ink',
  repeated_pattern: 'bg-hold-bg text-hold-ink',
  transit: 'bg-hold-bg text-hold-ink',
  victims: 'bg-warn-bg text-warn-ink',
  not_suspicious: 'bg-allow-bg text-allow-ink',
}

// Находки расследования и денежные маршруты. Щелчок подсвечивает их на графе.
export function Findings(props: {
  graph: Investigation
  active: string | null
  onFinding: (f: Finding) => void
  onRoute: (r: MoneyRoute, key: string) => void
}) {
  const { findings, routes } = props.graph
  return (
    <div className="space-y-7">
      <section>
        <h3 className="mb-3 text-[17px] font-bold">Что нашёл модуль</h3>
        {findings.length === 0 ? (
          <p className="text-ink-2">Ни транзитных счетов, ни общих устройств, ни связи с подтверждёнными делами в построенном графе нет.</p>
        ) : (
          <ul className="space-y-2.5">
            {findings.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => props.onFinding(f)}
                  aria-pressed={props.active === f.id}
                  className={
                    'w-full cursor-pointer rounded-[16px] border p-3.5 text-left transition-colors ' +
                    (props.active === f.id ? 'border-ink bg-white' : 'border-line bg-white hover:border-ink-2')
                  }
                >
                  <span className={'inline-block rounded-full px-2.5 py-0.5 text-[12px] font-semibold ' + (KIND_TONE[f.kind] ?? 'bg-field text-ink')}>{KIND[f.kind]}</span>
                  <span className="mt-1.5 block text-[15px] leading-snug font-semibold">{f.title}</span>
                  <span className={'mt-1 block text-[14px] leading-snug text-ink-2 ' + (props.active === f.id ? '' : 'line-clamp-3')}>{f.explanation}</span>
                  <Confidence value={f.confidence.value} level={f.confidence.level} />
                  {props.active === f.id && <span className="mt-2 block text-[12px] text-muted">Источники: {f.sources.join('; ')}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-1 text-[17px] font-bold">Денежные маршруты</h3>
        <p className="mb-3 text-[14px] text-ink-2">Куда ушли деньги после перевода: каждый следующий шаг — в течение суток после предыдущего.</p>
        {routes.length === 0 ? (
          <p className="text-ink-2">Деньги дальше не двигались или маршрут выходит за построенный граф.</p>
        ) : (
          <ol className="space-y-2">
            {routes.map((r, i) => {
              const key = 'route:' + i
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => props.onRoute(r, key)}
                    aria-pressed={props.active === key}
                    className={'w-full cursor-pointer rounded-[14px] border px-3.5 py-2.5 text-left text-[14px] leading-snug ' + (props.active === key ? 'border-[#d98a00] bg-warn-bg' : 'border-line bg-white hover:border-ink-2')}
                  >
                    {r.text}
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </section>
    </div>
  )
}
