import { useEffect, useState } from 'react'
import type { Assessment, GraphNode, Investigation } from '../../../service/src/graph/types.ts'
import { loadDetails, type EntityDetails, type Filters } from './graphApi.ts'
import { dateTime, LEVEL_LABEL, LINK_LABEL, money, ROLE_COLOR, ROLE_SHORT, TYPE_LABEL } from './look.ts'
import { TypeIcon } from './TypeIcon.tsx'

const CHANNEL = { p2p: 'перевод', interbank: 'в другой банк', card: 'по карте', cash: 'наличные' } as Record<string, string>

// Боковая панель выбранного узла: роль с объяснением и источниками, активность, связи, история денег.
export function NodePanel(props: {
  id: string
  graph: Investigation
  filters: Filters
  onSelect: (id: string) => void
  onExpand: (id: string) => void
  onRecenter: (id: string) => void
  onShowPath: (target: string) => void
}) {
  const [details, setDetails] = useState<EntityDetails | null>(null)
  const [error, setError] = useState('')
  const node = props.graph.nodes.find((n) => n.id === props.id)

  useEffect(() => {
    const controller = new AbortController()
    setDetails(null)
    setError('')
    loadDetails(props.id, props.filters, controller.signal)
      .then(setDetails)
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
    return () => controller.abort()
  }, [props.id, props.filters])

  const inGraph = new Set(props.graph.nodes.map((n) => n.id))
  const path = props.graph.fraud_paths.find((p) => p.hops.some((h) => h.to === props.id || h.from === props.id))
  const assessment = details?.assessment ?? node?.assessment ?? null
  const type = node?.external ? 'external' : (node?.type ?? details?.entity.type ?? 'client')

  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <TypeIcon type={type} size={44} tone={assessment && ROLE_COLOR[assessment.role] && ['confirmed_fraud', 'possible_collector', 'possible_dropper'].includes(assessment.role) ? ROLE_COLOR[assessment.role] : undefined} />
        <div className="min-w-0">
          <div className="text-[13px] text-muted">
            {TYPE_LABEL[type]}
            {node && ` · уровень ${node.level}`}
          </div>
          <h3 className="text-[21px] leading-tight font-bold break-words">{node?.label ?? details?.entity.label ?? props.id}</h3>
          <div className="mt-0.5 font-mono text-[12.5px] text-muted">{props.id}</div>
        </div>
        {node?.capped && (
          <p className="mt-2 rounded-[12px] bg-field px-3 py-2 text-[14px] text-ink-2">
            У этого узла очень много связей (общий Wi-Fi, сеть оператора или крупный продавец). Граф показывает его, но дальше не раскрывает: такая связь мало что говорит о людях.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => props.onExpand(props.id)} className="min-h-10 cursor-pointer rounded-full bg-ink px-4 text-[14px] font-semibold text-white">
          Раскрыть связи
        </button>
        {props.id !== props.graph.root && (
          <button type="button" onClick={() => props.onRecenter(props.id)} className="min-h-10 cursor-pointer rounded-full bg-field px-4 text-[14px] font-semibold">
            Сделать центром
          </button>
        )}
        {path && (
          <button type="button" onClick={() => props.onShowPath(path.target)} className="min-h-10 cursor-pointer rounded-full bg-hold-bg px-4 text-[14px] font-semibold text-hold-ink">
            Путь к подтверждённому делу
          </button>
        )}
      </div>

      {assessment && <AssessmentBox assessment={assessment} />}

      {error && <p className="rounded-[14px] bg-hold-bg px-4 py-3 text-hold-ink">{error}</p>}
      {!details && !error && <p className="text-muted">Загружаем данные банка…</p>}

      {details && details.marks.length > 0 && (
        <section>
          <h4 className="mb-2 text-[14px] text-muted">Что уже знает антифрод банка</h4>
          <ul className="space-y-2">
            {details.marks.map((m) => (
              <li key={m.ref + m.at} className={'rounded-[12px] px-3 py-2 text-[14px] ' + (m.kind === 'confirmed_fraud' ? 'bg-hold-bg text-hold-ink' : m.kind === 'cleared' ? 'bg-allow-bg text-allow-ink' : 'bg-field')}>
                <span className="font-semibold">{m.ref}</span> · {dateTime(m.at)}
                <span className="block">{m.note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {details?.stats && <Activity stats={details.stats} />}

      {details && details.shared_clients !== null && (
        <p className="text-[15px]">
          С этим {type === 'phone' ? 'номером' : type === 'ip' ? 'адресом' : 'устройством'} связано клиентов банка: <b className="tabular">{details.shared_clients}</b>
        </p>
      )}

      {details && details.links.length > 0 && (
        <section>
          <h4 className="mb-2 text-[14px] text-muted">Связи</h4>
          <ul className="divide-y divide-line rounded-[14px] border border-line">
            {details.links.slice(0, 30).map((l) => (
              <li key={l.type + l.id}>
                <button
                  type="button"
                  disabled={!inGraph.has(l.id)}
                  onClick={() => props.onSelect(l.id)}
                  className="flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-[14px] hover:bg-field disabled:cursor-default disabled:hover:bg-transparent"
                >
                  {l.entity_type && <TypeIcon type={l.entity_type} size={26} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{l.label}</span>
                    <span className="block text-[12px] text-muted">
                      {LINK_LABEL[l.type]} · с {new Date(l.first_seen).toLocaleDateString('ru-RU')}
                    </span>
                  </span>
                  {!inGraph.has(l.id) && <span className="shrink-0 text-[12px] text-muted">не в графе</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {details && details.history.length > 0 && (
        <section>
          <h4 className="mb-2 text-[14px] text-muted">
            История движения средств{details.history_total > details.history.length ? ` (последние ${details.history.length} из ${details.history_total})` : ''}
          </h4>
          <ol className="space-y-1">
            {details.history.slice(0, 40).map((h) => (
              <li key={h.id + h.direction} className="grid grid-cols-[auto_1fr_auto] items-baseline gap-x-3 rounded-[10px] px-2 py-1.5 text-[14px] hover:bg-field">
                <span className="tabular text-[12px] text-muted">{dateTime(h.at)}</span>
                <button
                  type="button"
                  onClick={() => inGraph.has(h.counterparty) && props.onSelect(h.counterparty)}
                  className={'min-w-0 truncate text-left ' + (inGraph.has(h.counterparty) ? 'cursor-pointer underline decoration-line underline-offset-2' : 'cursor-default')}
                >
                  {h.direction === 'in' ? 'от ' : '→ '}
                  {h.counterparty_label}
                  <span className="text-muted"> · {CHANNEL[h.channel] ?? h.channel}{h.status === 'held' ? ', придержан' : h.status === 'warned' ? ', с предупреждением' : ''}</span>
                </button>
                <span className={'tabular font-semibold ' + (h.direction === 'in' ? 'text-allow' : '')}>
                  {h.direction === 'in' ? '+' : '−'}
                  {money(h.amount)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

export function AssessmentBox(props: { assessment: Assessment }) {
  const a = props.assessment
  const color = ROLE_COLOR[a.role] ?? '#9aa3b8'
  return (
    <section className="rounded-[16px] bg-field p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-[5px] size-3 shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
        <div className="text-[16px] leading-snug font-bold">{a.label}</div>
      </div>
      <Confidence value={a.confidence.value} level={a.confidence.level} official={a.role === 'confirmed_fraud'} />
      {a.evidence.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {a.evidence.map((e) => (
            <li key={e.text} className="rounded-[12px] bg-white px-3 py-2.5 text-[14px] leading-snug">
              {e.text}
              <span className="mt-1 block text-[12px] text-muted">{e.source}</span>
            </li>
          ))}
        </ul>
      )}
      {a.caveat && <p className="mt-3 text-[13px] leading-snug text-ink-2">{a.caveat}</p>}
    </section>
  )
}

export function Confidence(props: { value: number; level: 'low' | 'medium' | 'high'; official?: boolean }) {
  return (
    <div className="mt-2 flex items-center gap-2.5 text-[13px]">
      <span className="flex gap-[3px]" aria-hidden="true">
        {[0.25, 0.45, 0.7].map((step, i) => (
          <span key={i} className={'h-1.5 w-5 rounded-full ' + (props.value >= step ? 'bg-ink' : 'bg-[#d5dae6]')} />
        ))}
      </span>
      <span className="text-ink-2">
        {props.official ? 'решение банка' : `уверенность ${LEVEL_LABEL[props.level]}`} · {props.value.toLocaleString('ru-RU')}
      </span>
    </div>
  )
}

function Activity(props: { stats: NonNullable<EntityDetails['stats']> }) {
  return (
    <section>
      <h4 className="mb-2 text-[14px] text-muted">Финансовая активность за период</h4>
      {Object.entries(props.stats).map(([account, s]) => (
        <dl key={account} className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-[14px] bg-field p-3 text-[14px]">
          {Object.keys(props.stats).length > 1 && <div className="col-span-2 font-mono text-[12px] text-muted">{account}</div>}
          <Stat label="Пришло" value={`${money(s.inflow)} · ${s.incoming}`} />
          <Stat label="Ушло" value={`${money(s.outflow)} · ${s.outgoing}`} />
          <Stat label="Отправителей" value={String(s.senders)} />
          <Stat label="Ушло за 2 часа" value={Math.round(s.fast_share * 100) + '%'} />
          <Stat label="Деньги на счёте" value={s.median_hold_minutes === null ? '—' : s.median_hold_minutes < 60 ? `≈ ${Math.round(s.median_hold_minutes)} мин` : s.median_hold_minutes < 2880 ? `≈ ${Math.round(s.median_hold_minutes / 60)} ч` : `≈ ${Math.round(s.median_hold_minutes / 1440)} дн.`} />
          <Stat label="Возраст счёта" value={s.age_days === null ? '—' : s.age_days < 365 ? `${s.age_days} дн.` : `${Math.round(s.age_days / 365)} г.`} />
        </dl>
      ))}
    </section>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{props.label}</dt>
      <dd className="tabular font-semibold">{props.value}</dd>
    </div>
  )
}

export const roleShort = (n: GraphNode) => (n.assessment ? ROLE_SHORT[n.assessment.role] : null)
