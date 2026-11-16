import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Finding, MoneyRoute } from '../../../service/src/graph/types.ts'
import { Findings } from './Findings.tsx'
import { GraphCanvas, type Focus } from './GraphCanvas.tsx'
import { investigate, loadCases, search, type Filters, type IncomingCase, type Investigation, type LinkFilter, type SearchResult, type Target } from './graphApi.ts'
import { dateTime, LINK_LABEL, money, plural, TYPE_LABEL } from './look.ts'
import { NodePanel } from './NodePanel.tsx'
import { Timeline } from './Timeline.tsx'
import { TypeIcon } from './TypeIcon.tsx'

const ALL_LINKS: LinkFilter[] = ['transfer', 'device', 'phone', 'ip', 'card']
const AMOUNTS = [0, 50_000, 200_000, 1_000_000]

export function targetFromRef(ref: string): Target {
  if (ref.startsWith('al_') || ref.startsWith('AF-')) return { alert_id: ref }
  if (ref.startsWith('tr_')) return { transfer_id: ref }
  return { entity_id: ref }
}

const targetKey = (t: Target | null) => (t ? (t.alert_id ?? t.transfer_id ?? t.entity_id ?? '') : '')

// Вкладка «Network Investigation»: сотрудник выбирает подозрительный счёт и видит всю сеть связей вокруг него.
export function NetworkPage(props: { initial: string | null }) {
  const [cases, setCases] = useState<IncomingCase[] | null>(null)
  const [casesError, setCasesError] = useState('')
  const [target, setTarget] = useState<Target | null>(props.initial ? targetFromRef(props.initial) : null)
  const [targetLabel, setTargetLabel] = useState(props.initial ?? '')
  const [analyzed, setAnalyzed] = useState<Target | null>(props.initial ? targetFromRef(props.initial) : null)

  const [depth, setDepth] = useState(2)
  const [links, setLinks] = useState<LinkFilter[]>(ALL_LINKS)
  const [minAmount, setMinAmount] = useState(0)
  const [period, setPeriod] = useState<{ from?: string; to?: string }>({})
  const [expand, setExpand] = useState<string[]>([])

  const [result, setResult] = useState<Investigation | null>(null)
  const [baseline, setBaseline] = useState<Investigation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [selected, setSelected] = useState<string | null>(null)
  const [focus, setFocus] = useState<(Focus & { key: string }) | null>(null)
  const [tab, setTab] = useState<'findings' | 'node'>('findings')
  const height = useGraphHeight()

  const refreshCases = useCallback(() => {
    loadCases()
      .then((items) => {
        setCases(items)
        setCasesError('')
      })
      .catch((e: Error) => setCasesError(e.message))
  }, [])
  useEffect(refreshCases, [refreshCases])

  const filters: Filters = useMemo(() => ({ links, min_amount: minAmount || undefined, ...period }), [links, minAmount, period])

  useEffect(() => {
    if (!analyzed) return
    const controller = new AbortController()
    setLoading(true)
    setError('')
    investigate(analyzed, depth, filters, expand, controller.signal)
      .then((data) => {
        setResult(data)
        if (!period.from && !period.to) setBaseline(data)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (e.name === 'AbortError') return
        setError(e.message)
        setLoading(false)
      })
    return () => controller.abort()
  }, [analyzed, depth, filters, expand, period])

  const analyze = (t: Target | null = target) => {
    if (!t) return
    setSelected(null)
    setFocus(null)
    setExpand([])
    setPeriod({})
    setTab('findings')
    // тот же запрос второй раз: новый объект, чтобы граф перестроился
    setAnalyzed({ ...t })
    history.replaceState(null, '', '#network/' + encodeURIComponent(targetKey(t)))
    refreshCases()
  }

  const choose = (t: Target, label: string) => {
    setTarget(t)
    setTargetLabel(label)
  }

  const select = (id: string | null) => {
    setSelected(id)
    if (id) setTab('node')
    // выбранный узел вне подсветки был бы почти не виден — снимаем подсветку
    if (id && focus && !focus.nodes.has(id)) setFocus(null)
  }

  const onFinding = (f: Finding) => {
    if (focus?.key === f.id) return setFocus(null)
    setFocus({ key: f.id, nodes: new Set(f.node_ids), edges: new Set(f.edge_ids), tone: f.kind === 'confirmed_link' ? 'path' : 'finding' })
  }
  const onRoute = (r: MoneyRoute, key: string) => {
    if (focus?.key === key) return setFocus(null)
    const edges = new Set(r.nodes.slice(1).map((to, i) => `transfer:${r.nodes[i]}:${to}`))
    setFocus({ key, nodes: new Set(r.nodes), edges, tone: 'route' })
  }
  const showPath = (targetId: string) => {
    const path = result?.fraud_paths.find((p) => p.target === targetId)
    if (!path) return
    setFocus({ key: 'path:' + targetId, nodes: new Set(path.hops.flatMap((h) => [h.from, h.to])), edges: new Set(path.hops.map((h) => h.edge_id)), tone: 'path' })
  }

  const rootNode = result?.nodes.find((n) => n.id === result.root)
  const counts = useMemo(() => {
    const people = result?.nodes.filter((n) => n.type === 'client') ?? []
    const role = (r: string) => people.filter((n) => n.assessment?.role === r).length
    return { scheme: role('possible_dropper') + role('possible_collector'), victims: role('possible_victim'), confirmed: role('confirmed_fraud') }
  }, [result])

  return (
    <div className="mx-auto grid max-w-[1640px] gap-5 px-4 py-6 sm:px-6 xl:grid-cols-[300px_minmax(0,1fr)_390px]">
      {/* --- что прислал антифрод, поиск, фильтры --- */}
      <aside className="space-y-5 xl:max-h-[calc(100vh-120px)] xl:overflow-auto xl:pr-1">
        <Card>
          <h2 className="text-[17px] font-bold">Сигналы антифрода</h2>
          <p className="mt-1 mb-3 text-[13px] text-ink-2">Счета и переводы, которые основной антифрод и сервис оценки передали на расследование.</p>
          {cases === null ? (
            <p className="text-[14px] text-muted">{casesError || 'Загружаем…'}</p>
          ) : (
            <ul className="-mx-1 max-h-[300px] space-y-1 overflow-auto">
              {cases.map((c) => {
                const t: Target = { alert_id: c.ref }
                const active = targetKey(target) === c.ref
                return (
                  <li key={c.ref}>
                    <button
                      type="button"
                      onClick={() => choose(t, c.ref)}
                      aria-pressed={active}
                      className={'flex w-full cursor-pointer gap-2.5 rounded-[12px] px-2.5 py-2 text-left ' + (active ? 'bg-[#eef2ff]' : 'hover:bg-field')}
                    >
                      <span className={'mt-1.5 size-2 shrink-0 rounded-full ' + (c.priority === 'high' ? 'bg-hold' : 'bg-warn')} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-baseline gap-x-2 text-[14px] font-semibold">
                          {c.ref}
                          {c.amount && <span className="tabular font-normal text-ink-2">{money(c.amount)}</span>}
                        </span>
                        <span className="block text-[13px] leading-snug text-ink-2">{c.summary}</span>
                        <span className="block text-[12px] text-muted">
                          {c.source === 'alert_queue' ? 'сервис оценки' : 'основной антифрод'} · {dateTime(c.at)}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card>
          <SearchBox onPick={choose} />
          <div className="mt-4 rounded-[12px] bg-field px-3 py-2.5 text-[14px]">
            <span className="block text-[12px] text-muted">Расследуем</span>
            <span className="font-semibold break-all">{targetLabel || 'выберите сигнал или найдите счёт'}</span>
          </div>
          <button
            type="button"
            disabled={!target || loading}
            onClick={() => analyze()}
            className="mt-3 min-h-12 w-full cursor-pointer rounded-full bg-accent px-5 text-[16px] font-semibold text-white disabled:cursor-default disabled:opacity-50"
          >
            {loading ? 'Строим сеть…' : 'Analyze Network'}
          </button>
        </Card>

        <Card>
          <h2 className="mb-3 text-[15px] font-bold">Фильтры</h2>
          <fieldset>
            <legend className="mb-1.5 text-[13px] text-muted">Глубина связей</legend>
            <div className="grid grid-cols-4 gap-1 rounded-full bg-field p-1">
              {[1, 2, 3, 4].map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={depth === d}
                  onClick={() => setDepth(d)}
                  className={'min-h-9 cursor-pointer rounded-full text-[14px] font-semibold ' + (depth === d ? 'bg-white shadow-[0_1px_3px_rgb(11_22_56/0.2)]' : 'text-ink-2')}
                >
                  {d}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-4">
            <legend className="mb-1.5 text-[13px] text-muted">Типы связей</legend>
            <div className="flex flex-wrap gap-1.5">
              {ALL_LINKS.map((l) => {
                const on = links.includes(l)
                return (
                  <label key={l} className={'cursor-pointer rounded-full border px-3 py-1.5 text-[13px] font-medium ' + (on ? 'border-ink bg-ink text-white' : 'border-line bg-white text-ink-2')}>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      onChange={() => setLinks(on ? links.filter((x) => x !== l) : [...links, l])}
                    />
                    {LINK_LABEL[l]}
                  </label>
                )
              })}
            </div>
          </fieldset>

          <label className="mt-4 block">
            <span className="mb-1.5 block text-[13px] text-muted">Переводы от суммы</span>
            <select value={minAmount} onChange={(e) => setMinAmount(Number(e.target.value))} className="min-h-10 w-full rounded-[12px] border border-line bg-white px-3 text-[14px]">
              {AMOUNTS.map((a) => (
                <option key={a} value={a}>
                  {a ? 'от ' + money(a) : 'любые суммы'}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-4 text-[13px]">
            <span className="text-muted">Период: </span>
            {period.from || period.to ? (
              <>
                {period.from ? new Date(period.from).toLocaleDateString('ru-RU') : '…'} — {period.to ? new Date(period.to).toLocaleDateString('ru-RU') : '…'}{' '}
                <button type="button" className="cursor-pointer text-accent underline underline-offset-2" onClick={() => setPeriod({})}>
                  сбросить
                </button>
              </>
            ) : (
              'весь, выделите отрезок на шкале под графом'
            )}
          </div>
        </Card>
      </aside>

      {/* --- граф --- */}
      <section className="min-w-0">
        {!result ? (
          <div className="grid place-items-center rounded-[18px] bg-navy px-6 text-center text-white" style={{ height }}>
            <div className="max-w-[46ch]">
              <p className="text-[21px] font-semibold">{loading ? 'Строим сеть…' : error || 'Выберите сигнал антифрода и нажмите Analyze Network'}</p>
              {!loading && !error && (
                <p className="mt-2 text-white/70">
                  Модуль соберёт клиентов, счета, карты, устройства, IP-адреса и телефоны вокруг подозрительного счёта и покажет, как они связаны.
                </p>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2 className="text-[19px] font-bold">
                Сеть вокруг: {rootNode?.label ?? result.root}
                {loading && <span className="ml-2 text-[14px] font-normal text-muted">обновляем…</span>}
              </h2>
              <p className="tabular text-[14px] text-ink-2">
                {plural(result.nodes.length, 'узел', 'узла', 'узлов')} · {plural(result.edges.length, 'связь', 'связи', 'связей')} · с признаками схемы: <b className="text-hold">{counts.scheme}</b> · вероятно пострадавших:{' '}
                <b className="text-warn-ink">{counts.victims}</b> · подтверждённых дел: <b>{counts.confirmed}</b>
              </p>
            </div>
            {error && <p className="mb-3 rounded-[14px] bg-hold-bg px-4 py-3 text-hold-ink">{error}</p>}
            <GraphCanvas
              data={result}
              selected={selected}
              focus={focus}
              height={height}
              onSelect={select}
              onExpand={(id) => {
                setExpand((list) => (list.includes(id) ? list : [...list, id]))
                select(id)
              }}
            />
            {result.truncated && <p className="mt-2 text-[13px] text-warn-ink">Граф обрезан до 400 узлов. Уменьшите глубину или включите фильтр по сумме.</p>}
            {baseline && (
              <div className="mt-4 rounded-[16px] border border-line bg-white px-4 pt-3 pb-1">
                <div className="flex flex-wrap justify-between gap-x-4 text-[13px]">
                  <span className="font-semibold">История движения средств по дням</span>
                  <span className="text-muted">
                    <span className="mr-1 inline-block size-2 rounded-full bg-[#e0484d]" aria-hidden="true" />
                    через счета с признаками схемы
                  </span>
                </div>
                <Timeline graph={baseline} period={period} onPeriod={(from, to) => setPeriod({ from, to })} />
              </div>
            )}
            <p className="mt-3 text-[13px] text-muted">{result.disclaimer} Данные демонстрационные, люди вымышлены.</p>
          </>
        )}
      </section>

      {/* --- находки и карточка узла --- */}
      <aside className="min-w-0 xl:max-h-[calc(100vh-120px)] xl:overflow-auto">
        <div className="mb-4 grid grid-cols-2 gap-1 rounded-full bg-white p-1 shadow-[0_1px_3px_rgb(11_22_56/0.12)]" role="tablist">
          {(['findings', 'node'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              disabled={t === 'node' && !selected}
              onClick={() => setTab(t)}
              className={'min-h-10 cursor-pointer rounded-full text-[14px] font-semibold disabled:cursor-default disabled:opacity-40 ' + (tab === t ? 'bg-ink text-white' : 'text-ink-2')}
            >
              {t === 'findings' ? `Находки${result ? ' · ' + result.findings.length : ''}` : 'Узел'}
            </button>
          ))}
        </div>
        <div className="rounded-[18px] border border-line bg-white p-4 sm:p-5">
          {!result ? (
            <p className="text-ink-2">Здесь появятся находки: транзитные счета, общие устройства, повторяющиеся схемы и связь с подтверждёнными делами — у каждой с объяснением, источником и уверенностью.</p>
          ) : tab === 'node' && selected ? (
            <NodePanel
              id={selected}
              graph={result}
              filters={filters}
              onSelect={select}
              onExpand={(id) => setExpand((list) => (list.includes(id) ? list : [...list, id]))}
              onRecenter={(id) => {
                const label = result.nodes.find((n) => n.id === id)?.label ?? id
                choose({ entity_id: id }, label)
                analyze({ entity_id: id })
              }}
              onShowPath={showPath}
            />
          ) : (
            <Findings graph={result} active={focus?.key ?? null} onFinding={onFinding} onRoute={onRoute} />
          )}
        </div>
      </aside>
    </div>
  )
}

function Card(props: { children: React.ReactNode }) {
  return <div className="rounded-[18px] border border-line bg-white p-4">{props.children}</div>
}

function SearchBox(props: { onPick: (t: Target, label: string) => void }) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<SearchResult | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (q.trim().length < 2) {
      setFound(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      search(q, controller.signal)
        .then((r) => {
          setFound(r)
          setError('')
        })
        .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
    }, 220)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [q])

  const pick = (t: Target, label: string) => {
    props.onPick(t, label)
    setQ('')
    setFound(null)
  }

  return (
    <div>
      <label className="block">
        <span className="mb-1.5 block text-[15px] font-bold">Найти</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Имя, счёт, устройство, номер перевода"
          className="min-h-11 w-full rounded-[12px] border border-line bg-white px-3 text-[15px]"
        />
      </label>
      {error && <p className="mt-2 text-[13px] text-hold-ink">{error}</p>}
      {found && (
        <ul className="mt-2 max-h-[220px] overflow-auto rounded-[12px] border border-line">
          {found.transfer && (
            <li>
              <button type="button" onClick={() => pick({ transfer_id: found.transfer!.id }, found.transfer!.id)} className="w-full cursor-pointer px-3 py-2 text-left text-[14px] hover:bg-field">
                Перевод {found.transfer.id} · {money(found.transfer.amount)}
              </button>
            </li>
          )}
          {found.items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => pick({ entity_id: item.id }, item.label)} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[14px] hover:bg-field">
                <TypeIcon type={item.type} size={24} />
                <span className="min-w-0 truncate">{item.label}</span>
                <span className="ml-auto shrink-0 text-[12px] text-muted">{TYPE_LABEL[item.type]}</span>
              </button>
            </li>
          ))}
          {!found.transfer && !found.items.length && <li className="px-3 py-2 text-[14px] text-muted">Ничего не нашлось</li>}
        </ul>
      )}
    </div>
  )
}

function useGraphHeight() {
  const get = () => (window.innerWidth >= 1280 ? Math.max(520, window.innerHeight - 330) : window.innerWidth >= 640 ? 560 : 440)
  const [h, setH] = useState(get)
  useEffect(() => {
    const on = () => setH(get())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return h
}
