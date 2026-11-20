import * as d3 from 'd3'
import { useEffect, useRef, useState } from 'react'
import type { Investigation } from '../../../service/src/graph/types.ts'
import { useWidth } from '../useWidth.ts'
import { shortMoney } from './look.ts'

const HEIGHT = 104
const M = { top: 10, right: 4, bottom: 24, left: 4 }
const SUSPICIOUS = new Set(['possible_dropper', 'possible_collector', 'confirmed_fraud'])
const BAD = '#d93b41'
const OK = '#c3cad9'

type Bin = { day: Date; bad: number; ok: number; count: number }

// Переводы по дням: красным — через счета с признаками схемы. Выделите отрезок мышью или пальцем,
// чтобы граф показал только этот период.
export function Timeline(props: { graph: Investigation; period: { from?: string; to?: string }; onPeriod: (from?: string, to?: string) => void }) {
  const [box, width] = useWidth<HTMLDivElement>()
  const svgRef = useRef<SVGSVGElement>(null)
  const onPeriod = useRef(props.onPeriod)
  onPeriod.current = props.onPeriod
  const [tip, setTip] = useState<{ bin: Bin; x: number } | null>(null)

  useEffect(() => {
    if (!svgRef.current || width === 0) return
    const roles = new Map(props.graph.nodes.map((n) => [n.id, n.assessment?.role]))
    const items = props.graph.edges.flatMap((e) =>
      (e.transfers ?? [])
        .filter((t) => t.status !== 'held')
        .map((t) => ({ at: new Date(t.at), amount: t.amount, bad: SUSPICIOUS.has(roles.get(e.source) ?? '') || SUSPICIOUS.has(roles.get(e.target) ?? '') })),
    )
    const svg = d3.select(svgRef.current)
    svg.selectAll('*').remove()
    setTip(null)
    if (!items.length) return

    const end = d3.timeDay.ceil(new Date(props.graph.generated_at))
    const start = d3.timeDay.offset(d3.timeDay.floor(d3.min(items, (d) => d.at)!), -1)
    const x = d3.scaleTime().domain([start, end]).range([M.left, width - M.right])
    const days = d3.timeDay.range(start, end)
    const bins: Bin[] = days.map((day) => {
      const list = items.filter((d) => d3.timeDay.floor(d.at).getTime() === day.getTime())
      return { day, bad: d3.sum(list.filter((d) => d.bad), (d) => d.amount), ok: d3.sum(list.filter((d) => !d.bad), (d) => d.amount), count: list.length }
    })
    // корень: один крупный день не прижимает к нулю все остальные
    const y = d3.scaleSqrt().domain([0, d3.max(bins, (b) => b.bad + b.ok) || 1]).range([HEIGHT - M.bottom, M.top])
    const step = (width - M.left - M.right) / days.length
    const bw = Math.max(1.5, Math.min(14, step - 2))

    // базовая линия и тонкие отметки по неделям
    svg.append('line').attr('x1', M.left).attr('x2', width - M.right).attr('y1', y(0) + 0.5).attr('y2', y(0) + 0.5).attr('stroke', '#d5dae6')

    const bars = svg.append('g')
    for (const b of bins) {
      if (!b.count) continue
      const x0 = x(b.day) + (step - bw) / 2
      const top = y(b.ok + b.bad)
      const mid = y(b.ok)
      // столбик: снизу обычные переводы, сверху — через подозрительные счета, между ними зазор 2px
      if (b.ok) bars.append('rect').attr('x', x0).attr('width', bw).attr('y', mid).attr('height', Math.max(1, y(0) - mid)).attr('rx', Math.min(3, bw / 2)).attr('fill', OK)
      if (b.bad) bars.append('rect').attr('x', x0).attr('width', bw).attr('y', top).attr('height', Math.max(1.5, mid - top - (b.ok ? 2 : 0))).attr('rx', Math.min(3, bw / 2)).attr('fill', BAD)
    }
    svg
      .append('g')
      .attr('transform', `translate(0,${HEIGHT - M.bottom + 4})`)
      .call(d3.axisBottom(x).ticks(Math.min(8, width / 95)).tickFormat((d) => (d as Date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })).tickSize(0).tickPadding(6))
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('text').attr('fill', '#69728a').attr('font-size', 11))

    const brush = d3
      .brushX()
      .extent([[M.left, M.top - 6], [width - M.right, HEIGHT - M.bottom]])
      .on('brush', () => setTip(null))
      .on('end', (event: d3.D3BrushEvent<unknown>) => {
        if (!event.sourceEvent) return
        if (!event.selection) {
          onPeriod.current(undefined, undefined)
          return
        }
        const [a, b] = (event.selection as [number, number]).map((v) => x.invert(v))
        onPeriod.current(d3.timeDay.floor(a!).toISOString(), d3.timeDay.ceil(b!).toISOString())
      })
    const g = svg.append('g').call(brush)
    g.select('.selection').attr('fill', '#4f8fc0').attr('fill-opacity', 0.1).attr('stroke', '#4f8fc0').attr('stroke-width', 1.5).attr('rx', 6)
    g.selectAll('.handle').attr('fill', '#4f8fc0').attr('rx', 2)
    // подсказка по дню: оверлей кисти перехватывает мышь, поэтому слушаем его
    g.select('.overlay')
      .on('mousemove.tip', (event: MouseEvent) => {
        const [px] = d3.pointer(event)
        const bin = bins[Math.min(bins.length - 1, Math.max(0, Math.floor((px - M.left) / step)))]
        setTip(bin && bin.count ? { bin, x: x(bin.day) + step / 2 } : null)
      })
      .on('mouseleave.tip', () => setTip(null))
    if (props.period.from || props.period.to) {
      const a = props.period.from ? x(new Date(props.period.from)) : M.left
      const b = props.period.to ? x(new Date(props.period.to)) : width - M.right
      g.call(brush.move, [Math.max(M.left, a), Math.min(width - M.right, b)])
    }
  }, [props.graph, props.period, width])

  return (
    <div ref={box} className="relative">
      <svg ref={svgRef} width="100%" height={HEIGHT} role="img" aria-label="Переводы в графе по дням. Выделите отрезок, чтобы выбрать период." />
      {tip && (
        <div
          className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-[12px] bg-navy px-3 py-2 text-[12.5px] whitespace-nowrap text-white shadow-lg"
          style={tip.x > width / 2 ? { right: width - tip.x - 8 } : { left: tip.x - 8 }}
        >
          <div className="font-semibold">{tip.bin.day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</div>
          <div className="tabular text-white/80">
            {tip.bin.count} перев. · {shortMoney(tip.bin.ok + tip.bin.bad)}
          </div>
          {tip.bin.bad > 0 && <div className="tabular text-[#ff9a9e]">через подозрительные: {shortMoney(tip.bin.bad)}</div>}
        </div>
      )}
    </div>
  )
}
