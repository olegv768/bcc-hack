import { line, scaleLinear } from 'd3'
import { useState } from 'react'
import { percent } from './scenarios.ts'
import { useWidth } from './useWidth.ts'

type Point = { threshold: number; droppers_found: number; honest_flagged: number }
type Mark = { label: string; droppers_found: number; honest_flagged: number }

const HEIGHT = 300
const MARGIN = { top: 16, right: 20, bottom: 44, left: 48 }
const MAX_X = 0.1 // показываем до 10% ложных срабатываний: дальше банку неинтересно

// Цена порога: сколько честных клиентов побеспокоим, чтобы найти такую долю дропперов.
export function TradeoffChart(props: { points: Point[]; marks: Mark[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<Point | null>(null)

  const points = props.points.filter((p) => p.honest_flagged <= MAX_X).sort((a, b) => a.honest_flagged - b.honest_flagged)
  const x = scaleLinear().domain([0, MAX_X]).range([MARGIN.left, Math.max(MARGIN.left + 1, width - MARGIN.right)])
  const y = scaleLinear().domain([0, 1]).range([HEIGHT - MARGIN.bottom, MARGIN.top])
  const path = line<Point>().x((p) => x(p.honest_flagged)).y((p) => y(p.droppers_found))(points)

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const value = x.invert(event.clientX - event.currentTarget.getBoundingClientRect().left)
    let nearest = points[0]!
    for (const p of points) if (Math.abs(p.honest_flagged - value) < Math.abs(nearest.honest_flagged - value)) nearest = p
    setHover(nearest)
  }

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label="Доля найденных дропперов в зависимости от доли ложных срабатываний среди честных счетов"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="touch-pan-y"
        >
          {y.ticks(5).map((tick) => (
            <g key={tick}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? '#c5cbd8' : '#e6e9f0'} />
              <text x={MARGIN.left - 8} y={y(tick) + 4} fontSize={12} textAnchor="end" fill="#69728a" className="tabular">
                {percent(tick, 0)}
              </text>
            </g>
          ))}
          {x.ticks(width < 480 ? 5 : 10).map((tick) => (
            <text key={tick} x={x(tick)} y={HEIGHT - MARGIN.bottom + 18} fontSize={12} textAnchor="middle" fill="#69728a" className="tabular">
              {percent(tick, 0)}
            </text>
          ))}
          <text x={(MARGIN.left + width - MARGIN.right) / 2} y={HEIGHT - 6} fontSize={12} textAnchor="middle" fill="#46506a">
            Честные счета, помеченные по ошибке
          </text>

          <path d={path ?? ''} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

          {props.marks.map((mark) => (
            <g key={mark.label}>
              <circle cx={x(mark.honest_flagged)} cy={y(mark.droppers_found)} r={5} fill="#2a78d6" stroke="#ffffff" strokeWidth={2} />
              <text x={x(mark.honest_flagged) + 10} y={y(mark.droppers_found) + 18} fontSize={12} fill="#0e1b3d">
                {mark.label}: {percent(mark.droppers_found, 0)} при {percent(mark.honest_flagged)}
              </text>
            </g>
          ))}

          {hover && (
            <g pointerEvents="none">
              <line x1={x(hover.honest_flagged)} x2={x(hover.honest_flagged)} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} stroke="#8a93a8" />
              <circle cx={x(hover.honest_flagged)} cy={y(hover.droppers_found)} r={4} fill="#2a78d6" stroke="#ffffff" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      {hover && (
        <div
          className="pointer-events-none absolute top-2 rounded-[12px] bg-navy px-3 py-2 text-[13px] text-white shadow-lg"
          style={x(hover.honest_flagged) > width / 2 ? { right: width - x(hover.honest_flagged) + 10 } : { left: x(hover.honest_flagged) + 10 }}
        >
          <div>
            Найдено дропперов: <b className="tabular">{percent(hover.droppers_found)}</b>
          </div>
          <div>
            Ложных среди честных: <b className="tabular">{percent(hover.honest_flagged)}</b>
          </div>
          <div className="text-white/65">порог оценки {hover.threshold.toLocaleString('ru-RU')}</div>
        </div>
      )}
    </div>
  )
}
