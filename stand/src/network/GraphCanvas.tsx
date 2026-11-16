import * as d3 from 'd3'
import { useEffect, useRef, useState } from 'react'
import type { GraphEdge, GraphNode, Investigation } from '../../../service/src/graph/types.ts'
import { useWidth } from '../useWidth.ts'
import { GRAPH, ICON, LEVEL_LABEL, ROLE_SHORT, roleStyle, shortMoney, TYPE_LABEL } from './look.ts'

export type Focus = { nodes: Set<string>; edges: Set<string>; tone: 'path' | 'route' | 'finding' }

type SimNode = GraphNode & d3.SimulationNodeDatum & { r: number }
type SimEdge = Omit<GraphEdge, 'source' | 'target'> & { source: SimNode; target: SimNode; width: number; bend: number }
type Hover = { node: SimNode; x: number; y: number }

const TONE = { path: GRAPH.critical, route: GRAPH.warning, finding: '#ffffff' }

const radius = (n: GraphNode) => {
  const base = n.type === 'client' || n.type === 'account' ? 10 : 7.5
  return base + Math.sqrt(n.centrality) * 8
}

// Граф связей в духе Obsidian Graph View: силовая раскладка, наведение подсвечивает соседей,
// двойной щелчок раскрывает узел ещё на уровень, колесо и щипок — масштаб.
// Тип сущности — значок внутри узла; цвет — только роль: красная заливка — признаки схемы,
// цветное кольцо вокруг нейтрального узла — пострадавший или «много отправителей».
export function GraphCanvas(props: {
  data: Investigation
  selected: string | null
  focus: Focus | null
  height: number
  onSelect: (id: string | null) => void
  onExpand: (id: string) => void
}) {
  const [box, width] = useWidth<HTMLDivElement>()
  const svgRef = useRef<SVGSVGElement>(null)
  const positions = useRef(new Map<string, { x: number; y: number }>())
  const state = useRef({ hover: null as string | null, k: 1, paint: () => {}, fit: () => {}, zoomBy: (_f: number) => {} })
  const lastRoot = useRef<string | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props
  const [hover, setHover] = useState<Hover | null>(null)

  useEffect(() => {
    const svgEl = svgRef.current
    if (!svgEl || width === 0) return
    const { data, height } = props
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const newRoot = lastRoot.current !== data.root
    lastRoot.current = data.root
    if (newRoot) positions.current.clear()
    setHover(null)

    const byId = new Map<string, SimNode>()
    const nodes: SimNode[] = data.nodes.map((n) => {
      const known = positions.current.get(n.id)
      const node: SimNode = { ...n, r: radius(n), x: known?.x, y: known?.y }
      byId.set(n.id, node)
      return node
    })
    // между двумя счетами бывают переводы в обе стороны: разводим их дугами в разные стороны
    const pairs = new Set(data.edges.filter((e) => e.type === 'transfer').map((e) => e.source + '>' + e.target))
    const edges: SimEdge[] = data.edges.flatMap((e) => {
      const source = byId.get(e.source)
      const target = byId.get(e.target)
      if (!source || !target) return []
      const width = e.type === 'transfer' ? 1 + Math.log10((e.total ?? 0) / 20000 + 1) * 1.2 : 1
      const bend = e.type !== 'transfer' ? 0 : pairs.has(e.target + '>' + e.source) ? 0.22 : 0.12
      return [{ ...e, source, target, width, bend }]
    })
    for (const e of edges) {
      for (const [a, b] of [[e.source, e.target], [e.target, e.source]] as const) {
        if (a.x === undefined && b.x !== undefined) {
          a.x = b.x + (Math.random() - 0.5) * 40
          a.y = b.y! + (Math.random() - 0.5) * 40
        }
      }
    }
    const root = byId.get(data.root)
    if (root && root.x === undefined) {
      root.x = 0
      root.y = 0
    }

    const neighbors = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set([n.id])]))
    for (const e of edges) {
      neighbors.get(e.source.id)!.add(e.target.id)
      neighbors.get(e.target.id)!.add(e.source.id)
    }

    const svg = d3.select(svgEl)
    svg.selectAll('*').remove()
    svg.attr('viewBox', `0 0 ${width} ${height}`)

    const defs = svg.append('defs')
    for (const [id, color] of [['arrow', GRAPH.edgeStrong], ['arrow-path', TONE.path], ['arrow-route', TONE.route], ['arrow-finding', TONE.finding], ['arrow-held', GRAPH.critical]]) {
      defs
        .append('marker')
        .attr('id', 'g-' + id)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 9)
        .attr('markerWidth', 7)
        .attr('markerHeight', 7)
        .attr('markerUnits', 'userSpaceOnUse')
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,-4.5L10,0L0,4.5Z')
        .attr('fill', color!)
    }

    const viewport = svg.append('g')
    const edgeLayer = viewport.append('g')
    const nodeLayer = viewport.append('g')
    const labelLayer = viewport.append('g').attr('pointer-events', 'none')

    const edgeSel = edgeLayer
      .selectAll<SVGPathElement, SimEdge>('path')
      .data(edges, (d) => d.id)
      .join('path')
      .attr('fill', 'none')
      .attr('stroke-linecap', 'round')

    const nodeSel = nodeLayer
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes, (d) => d.id)
      .join('g')
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', (d) => `${TYPE_LABEL[d.external ? 'external' : d.type]}: ${d.label}${d.assessment ? '. ' + ROLE_SHORT[d.assessment.role] : ''}`)
      .style('cursor', 'pointer')
      .style('outline', 'none')

    // невидимый круг побольше: в маленький узел легко попасть пальцем
    nodeSel.append('circle').attr('r', (d) => Math.max(d.r + 6, 16)).attr('fill', 'transparent')
    nodeSel
      .filter((d) => d.id === data.root)
      .append('circle')
      .attr('r', (d) => d.r + 9)
      .attr('fill', 'none')
      .attr('stroke', '#ffffff')
      .attr('stroke-opacity', 0.7)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '1 3.2')
      .attr('stroke-linecap', 'round')
    nodeSel
      .append('circle')
      .attr('class', 'select-ring')
      .attr('r', (d) => d.r + 5)
      .attr('fill', 'none')
      .attr('stroke', '#ffffff')
      .attr('stroke-width', 2)
      .attr('opacity', 0)
    nodeSel.each(function (d) {
      const style = roleStyle(d)
      const g = d3.select(this)
      if (style.outer) {
        g.append('circle')
          .attr('r', d.r + 4.5)
          .attr('fill', 'none')
          .attr('stroke', style.outer.color)
          .attr('stroke-width', 1.6)
          .attr('stroke-dasharray', style.outer.dashed ? '3 2.5' : null)
      }
      g.append('circle')
        .attr('class', 'dot')
        .attr('r', d.r)
        .attr('fill', style.fill)
        .attr('stroke', style.ring ?? style.stroke)
        .attr('stroke-width', style.ring ? 2.5 : 1.2)
        .attr('stroke-dasharray', style.dashed ? '2.5 2' : null)
      const scale = (d.r * 1.15) / 12
      g.append('path')
        .attr('d', ICON[d.external ? 'external' : d.type])
        .attr('transform', `scale(${scale}) translate(-6 -6)`)
        .attr('fill', 'none')
        .attr('stroke', style.icon)
        .attr('stroke-width', 1.25 / Math.max(scale, 0.8))
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round')
    })

    // подписи — «таблетки» под узлом, чтобы читались поверх линий
    const labelSel = labelLayer
      .selectAll<SVGGElement, SimNode>('g')
      .data(nodes, (d) => d.id)
      .join('g')
    labelSel
      .append('rect')
      .attr('rx', 6)
      .attr('fill', GRAPH.pill)
      .attr('stroke', GRAPH.pillLine)
    labelSel
      .append('text')
      .text((d) => d.label)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('fill', GRAPH.text)
      .attr('font-weight', 500)

    const edgeLabel = labelLayer
      .selectAll<SVGTextElement, SimEdge>('text.amount')
      .data(edges.filter((e) => e.type === 'transfer'), (d) => d.id)
      .join('text')
      .attr('class', 'amount tabular')
      .text((d) => (d.transfers?.some((t) => t.status === 'held') && !d.total ? 'придержан' : shortMoney(d.total ?? 0)))
      .attr('text-anchor', 'middle')
      .attr('fill', GRAPH.amount)
      .attr('font-weight', 600)
      .attr('paint-order', 'stroke')
      .attr('stroke', GRAPH.bg)
      .attr('stroke-width', 3.5)

    const sim = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink<SimNode, SimEdge>(edges)
          .distance((e) => (e.type === 'owns' || e.type === 'card' ? 26 : e.type === 'transfer' ? 95 : 55))
          .strength((e) => (e.type === 'owns' || e.type === 'card' ? 1 : 0.45)),
      )
      .force('charge', d3.forceManyBody<SimNode>().strength((d) => -110 - 220 * d.centrality).distanceMax(520))
      .force('collide', d3.forceCollide<SimNode>((d) => d.r + 7))
      .force('x', d3.forceX(0).strength(0.03))
      .force('y', d3.forceY(0).strength(0.04))
      .stop()

    sim.alpha(newRoot ? 1 : 0.5)
    sim.tick(newRoot ? 300 : 100)

    // дуга: контрольная точка смещена вбок от середины отрезка
    const arc = (e: SimEdge) => {
      const sx = e.source.x!
      const sy = e.source.y!
      const tx = e.target.x!
      const ty = e.target.y!
      const dx = tx - sx
      const dy = ty - sy
      const mx = (sx + tx) / 2 - dy * e.bend
      const my = (sy + ty) / 2 + dx * e.bend
      // концы обрезаем по краю узлов, направление берём на контрольную точку
      const cut = (px: number, py: number, qx: number, qy: number, r: number) => {
        const l = Math.hypot(qx - px, qy - py) || 1
        return [px + ((qx - px) / l) * r, py + ((qy - py) / l) * r] as const
      }
      const [ax, ay] = cut(sx, sy, mx, my, e.source.r + 2)
      const [bx, by] = cut(tx, ty, mx, my, e.target.r + (e.type === 'transfer' ? 5 : 2))
      return { d: `M${ax},${ay}Q${mx},${my} ${bx},${by}`, mx: (ax + 2 * mx + bx) / 4, my: (ay + 2 * my + by) / 4 }
    }

    const draw = () => {
      edgeSel.attr('d', (e) => arc(e).d)
      nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`)
      labelSel.attr('transform', (d) => `translate(${d.x},${d.y! + d.r + 14})`)
      edgeLabel.each(function (e) {
        const { mx, my } = arc(e)
        d3.select(this).attr('x', mx).attr('y', my - 4)
      })
      for (const n of nodes) positions.current.set(n.id, { x: n.x!, y: n.y! })
    }

    const paint = () => {
      const { hover, k } = state.current
      const { selected, focus } = callbacks.current
      const near = hover ? neighbors.get(hover) : null
      const nodeOn = (id: string) => (near ? near.has(id) : focus ? focus.nodes.has(id) : true)
      const edgeOn = (e: SimEdge) => (near ? e.source.id === hover || e.target.id === hover : focus ? focus.edges.has(e.id) : true)
      const tone = (e: SimEdge) => (!near && focus?.edges.has(e.id) ? focus.tone : null)
      const held = (e: SimEdge) => !!e.transfers?.some((x) => x.status === 'held' || x.status === 'warned')
      const s = 1 / Math.sqrt(k)

      nodeSel.attr('opacity', (d) => (nodeOn(d.id) ? 1 : 0.12))
      nodeSel.select('circle.select-ring').attr('opacity', (d) => (d.id === selected ? 1 : 0))

      edgeSel
        .attr('stroke', (e) => {
          const t = tone(e)
          if (t) return TONE[t]
          if (held(e)) return GRAPH.critical
          if (near && edgeOn(e)) return GRAPH.edgeHover
          return e.type === 'transfer' ? GRAPH.edge : GRAPH.tech
        })
        .attr('stroke-width', (e) => (tone(e) ? e.width + 1.4 : e.width) * s)
        .attr('stroke-dasharray', (e) => {
          if (tone(e) === 'route' && !reduced) return '8 6'
          if (held(e)) return '5 4'
          return e.type === 'transfer' ? null : '1.5 4'
        })
        .attr('class', (e) => (tone(e) === 'route' && !reduced ? 'flow' : null))
        .attr('opacity', (e) => (edgeOn(e) ? 1 : 0.05))
        .attr('marker-end', (e) => {
          if (e.type !== 'transfer') return null
          const t = tone(e)
          return t ? `url(#g-arrow-${t})` : held(e) ? 'url(#g-arrow-held)' : 'url(#g-arrow)'
        })

      // подписи: важные узлы всегда, остальные — при приближении или наведении
      const visible = (d: SimNode) => {
        if (!nodeOn(d.id)) return false
        if (near || d.id === selected) return true
        if (d.id === data.root || focus?.nodes.has(d.id)) return d.type === 'client' || d.type === 'account' || !!d.external
        if (k >= 1.6) return true
        if (d.type !== 'client' && !d.external) return false
        // граф сильно отдалён (телефон, большая сеть): подписи налезают — оставляем только главные
        if (k < 0.75) return d.centrality >= 0.5 || d.assessment?.role === 'possible_collector' || d.assessment?.role === 'confirmed_fraud'
        return d.centrality >= 0.3 || (!!d.assessment && d.assessment.role !== 'regular')
      }
      labelSel.attr('opacity', (d) => (visible(d) ? 1 : 0))
      labelSel.select('text').attr('font-size', 11.5 * s)
      labelSel.each(function () {
        const g = d3.select(this)
        const w = g.select<SVGTextElement>('text').node()!.getComputedTextLength()
        g.select('rect')
          .attr('x', -w / 2 - 7 * s)
          .attr('y', -10 * s)
          .attr('width', w + 14 * s)
          .attr('height', 20 * s)
          .attr('rx', 10 * s)
          .attr('stroke-width', s)
      })
      edgeLabel.attr('font-size', 10.5 * s).attr('opacity', (e) => (k >= 1.8 || (near && edgeOn(e)) || tone(e) ? 1 : 0))
    }

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        viewport.attr('transform', event.transform.toString())
        if (event.sourceEvent) setHover(null)
        if (Math.abs(event.transform.k - state.current.k) > 0.05) {
          state.current.k = event.transform.k
          paint()
        }
      })
    svg.call(zoom).on('dblclick.zoom', null)

    const fit = (animate: boolean) => {
      const xs = nodes.map((n) => n.x!)
      const ys = nodes.map((n) => n.y!)
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
      const k = Math.min(1.8, 0.86 / Math.max((x1 - x0 + 80) / width, (y1 - y0 + 90) / height))
      const t = d3.zoomIdentity.translate(width / 2 - (k * (x0 + x1)) / 2, height / 2 - (k * (y0 + y1)) / 2).scale(k)
      if (animate && !reduced) svg.transition().duration(450).call(zoom.transform, t)
      else svg.call(zoom.transform, t)
    }
    state.current.fit = () => fit(true)
    state.current.zoomBy = (f) => svg.transition().duration(200).call(zoom.scaleBy, f)
    state.current.paint = paint

    const showTip = (d: SimNode) => {
      const [x, y] = d3.zoomTransform(svgEl).apply([d.x!, d.y!])
      setHover({ node: d, x, y })
    }
    const enter = (d: SimNode) => {
      state.current.hover = d.id
      paint()
      showTip(d)
    }
    const leave = () => {
      state.current.hover = null
      paint()
      setHover(null)
    }
    nodeSel
      .on('mouseenter', (_e, d) => enter(d))
      .on('mouseleave', leave)
      .on('focus', (_e, d) => enter(d))
      .on('blur', leave)
      .on('click', (event: MouseEvent, d) => {
        event.stopPropagation()
        callbacks.current.onSelect(d.id)
      })
      .on('dblclick', (event: MouseEvent, d) => {
        event.stopPropagation()
        callbacks.current.onExpand(d.id)
      })
      .on('keydown', (event: KeyboardEvent, d) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          callbacks.current.onSelect(d.id)
        }
      })
    svg.on('click', () => callbacks.current.onSelect(null))

    nodeSel.call(
      d3
        .drag<SVGGElement, SimNode>()
        .on('start', (event, d) => {
          if (!event.active) sim.alphaTarget(0.25).restart()
          d.fx = d.x
          d.fy = d.y
          setHover(null)
        })
        .on('drag', (event, d) => {
          d.fx = event.x
          d.fy = event.y
        })
        .on('end', (event, d) => {
          if (!event.active) sim.alphaTarget(0)
          d.fx = null
          d.fy = null
        }),
    )

    draw()
    paint()
    if (newRoot) fit(false)
    // раскрытие узла: остаёмся там, где сотрудник смотрел
    else svg.call(zoom.transform, d3.zoomTransform(svgEl))
    sim.on('tick', draw)
    // раскладка ещё немного сжимается после показа: когда она успокоится, вписываем граф заново,
    // если сотрудник за это время не двигал и не масштабировал его
    let touched = false
    svg.on('wheel.touched mousedown.touched touchstart.touched', () => {
      touched = true
    })
    sim.on('end', () => {
      if (newRoot && !touched) fit(true)
    })
    if (!reduced) sim.alpha(0.08).restart()

    return () => {
      sim.stop()
    }
    // перерисовываем при новых данных и размере; выделение и подсветку меняет paint ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.data, props.height, width])

  useEffect(() => state.current.paint(), [props.selected, props.focus])

  const button = 'grid size-9 cursor-pointer place-items-center text-white/80 hover:bg-white/10 hover:text-white'
  return (
    <div
      ref={box}
      className="graph-canvas relative overflow-hidden rounded-[20px]"
      style={{ height: props.height }}
      onKeyDown={(e) => e.key === 'Escape' && props.onSelect(null)}
    >
      <svg ref={svgRef} width="100%" height={props.height} className="block touch-none select-none" role="img" aria-label="Граф связей. Узлы можно выбирать клавишей Tab и Enter." />

      <div className="graph-panel absolute top-3 right-3 flex flex-col overflow-hidden" role="group" aria-label="Масштаб">
        <button type="button" className={button} onClick={() => state.current.zoomBy(1.4)} aria-label="Приблизить">
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M7 2v10M2 7h10" /></svg>
        </button>
        <button type="button" className={button} onClick={() => state.current.zoomBy(1 / 1.4)} aria-label="Отдалить">
          <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M2 7h10" /></svg>
        </button>
        <span className="mx-2 h-px bg-white/10" />
        <button type="button" className={button} onClick={() => state.current.fit()} aria-label="Показать весь граф">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M1.5 5.5v-4h4M10.5 1.5h4v4M14.5 10.5v4h-4M5.5 14.5h-4v-4" />
          </svg>
        </button>
      </div>

      <GraphLegend />

      {hover && <Tooltip hover={hover} width={width} />}
    </div>
  )
}

function Tooltip(props: { hover: Hover; width: number }) {
  const { node, x, y } = props.hover
  const style = roleStyle(node)
  const toLeft = x > props.width - 270
  return (
    <div
      className="graph-panel pointer-events-none absolute z-10 w-[240px] px-3.5 py-3 text-[13px] text-white"
      style={{ top: Math.max(8, y - 24), ...(toLeft ? { right: props.width - x + node.r + 14 } : { left: x + node.r + 14 }) }}
    >
      <div className="text-[11.5px] text-white/55">{TYPE_LABEL[node.external ? 'external' : node.type]}</div>
      <div className="text-[14.5px] leading-snug font-semibold">{node.label}</div>
      {node.assessment && (
        <div className="mt-2 flex items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: style.swatch }} aria-hidden="true" />
          <span>{ROLE_SHORT[node.assessment.role]}</span>
          <span className="ml-auto shrink-0 text-white/55">
            {node.assessment.role === 'confirmed_fraud' ? 'решение банка' : LEVEL_LABEL[node.assessment.confidence.level]}
          </span>
        </div>
      )}
      <div className="mt-2 flex gap-3 text-[12px] text-white/55">
        <span>уровень {node.level}</span>
        <span>связей {node.degree}</span>
        {node.capped && <span>не раскрывается</span>}
      </div>
    </div>
  )
}

function GraphLegend() {
  const [open, setOpen] = useState(false)
  const roles = [
    ['Признаки дропа', roleStyle({ assessment: { role: 'possible_dropper' } })],
    ['Признаки сборщика', roleStyle({ assessment: { role: 'possible_collector' } })],
    ['Подтверждённое дело', roleStyle({ assessment: { role: 'confirmed_fraud' } })],
    ['Вероятно, пострадавший', roleStyle({ assessment: { role: 'possible_victim' } })],
    ['P2P-продавец, возможный «треугольник»', roleStyle({ assessment: { role: 'p2p_intermediary' } })],
    ['Много отправителей, не транзит', roleStyle({ assessment: { role: 'busy_legit' } })],
  ] as const
  const types = ['client', 'account', 'card', 'device', 'ip', 'phone', 'external'] as const
  return (
    <div className="graph-panel absolute bottom-3 left-3 max-w-[calc(100%-24px)] text-[12px] text-white/80">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 font-semibold text-white">
        Обозначения
        <svg width="10" height="10" viewBox="0 0 10 10" className={'ml-auto transition-transform ' + (open ? 'rotate-180' : '')} aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="grid gap-x-6 gap-y-1.5 px-3 pb-3 sm:grid-cols-[auto_auto]">
          <ul className="space-y-1.5">
            {roles.map(([label, s]) => (
              <li key={label} className="flex items-center gap-2">
                <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
                  {s.outer && <circle r="7.8" fill="none" stroke={s.outer.color} strokeWidth="1.2" strokeDasharray={s.outer.dashed ? '2.5 2' : undefined} />}
                  <circle r={s.outer ? 5 : 6.5} fill={s.fill} stroke={s.ring ?? s.stroke} strokeWidth={s.ring ? 2 : 1} />
                </svg>
                {label}
              </li>
            ))}
          </ul>
          <ul className="space-y-1.5">
            {types.map((t) => (
              <li key={t} className="flex items-center gap-2">
                <svg width="18" height="18" viewBox="-9 -9 18 18" aria-hidden="true">
                  <circle r="8.2" fill={GRAPH.node} stroke={GRAPH.nodeLine} strokeDasharray={t === 'external' ? '2 2' : undefined} />
                  <path d={ICON[t]} transform="scale(0.9) translate(-6 -6)" fill="none" stroke={GRAPH.icon} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {TYPE_LABEL[t]}
              </li>
            ))}
            <li className="flex items-center gap-2 pt-1">
              <svg width="18" height="10" aria-hidden="true"><path d="M1 5h16" stroke={GRAPH.edgeStrong} strokeWidth="2" /></svg>
              Перевод
            </li>
            <li className="flex items-center gap-2">
              <svg width="18" height="10" aria-hidden="true"><path d="M1 5h16" stroke={GRAPH.edgeStrong} strokeWidth="1.4" strokeDasharray="1.5 3" strokeLinecap="round" /></svg>
              Общий идентификатор
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
