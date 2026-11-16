import { area, curveMonotoneX, line, scaleLinear } from 'd3'
import { useState } from 'react'
import { useWidth } from './useWidth.ts'

type Point = {
  threshold: number
  droppers_found: number
  honest_flagged: number
}
type Mark = { label: string; droppers_found: number; honest_flagged: number }

const HEIGHT = 340
const MARGIN = { top: 20, right: 24, bottom: 52, left: 52 }
const MAX_X = 0.1 // показываем до 100 из 1000 зря побеспокоенных: дальше банку неинтересно
const LINE = '#2f5bff'

// Цена порога: сколько честных клиентов побеспокоим, чтобы заметить столько-то мошенников.
// Шкалы — «из 1000» и «из 100», как в остальных блоках страницы.
export function TradeoffChart(props: { points: Point[]; marks: Mark[] }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<Point | null>(null)

  // Точку «порог такой строгий, что сервис ни на ком не срабатывает» (0 и 0) не рисуем: она ничего
  // не сообщает, а линия из неё вертикально прыгает вверх и выглядит сломанной. Из точек с одной
  // и той же долей зря побеспокоенных оставляем лучшую.
  const best = new Map<number, Point>()
  for (const p of props.points) {
    if (p.honest_flagged > MAX_X || p.droppers_found === 0) continue
    const key = Math.round(p.honest_flagged * 100000)
    if (!best.has(key) || best.get(key)!.droppers_found < p.droppers_found) best.set(key, p)
  }
  const points = [...best.values()].sort((a, b) => a.honest_flagged - b.honest_flagged)

  // Вертикальная шкала начинается не с нуля, а чуть ниже самой нижней точки: так видна форма линии.
  const lowest = Math.min(...points.map((p) => p.droppers_found), ...props.marks.map((m) => m.droppers_found))
  const yMin = Math.max(0, Math.floor(lowest * 10) / 10 - 0.1)
  const right = Math.max(MARGIN.left + 1, width - MARGIN.right)
  const x = scaleLinear().domain([0, MAX_X]).range([MARGIN.left, right])
  const y = scaleLinear()
    .domain([yMin, 1])
    .range([HEIGHT - MARGIN.bottom, MARGIN.top])
  const path = line<Point>()
    .x((p) => x(p.honest_flagged))
    .y((p) => y(p.droppers_found))
    .curve(curveMonotoneX)(points)
  // лёгкая заливка под линией: глаз сразу видит, сколько «набрано»
  const fill = area<Point>()
    .x((p) => x(p.honest_flagged))
    .y0(HEIGHT - MARGIN.bottom)
    .y1((p) => y(p.droppers_found))
    .curve(curveMonotoneX)(points)
  const narrow = width < 480

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const value = x.invert(event.clientX - event.currentTarget.getBoundingClientRect().left)
    let nearest = points[0]!
    for (const p of points) if (Math.abs(p.honest_flagged - value) < Math.abs(nearest.honest_flagged - value)) nearest = p
    setHover(nearest)
  }

  return (
    <div ref={ref}>
      {/* подсказка привязана к самому графику, а не к списку под ним */}
      <div className="relative">
        {width > 0 && points.length > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label="Сколько мошенников из 100 сервис замечает в зависимости от того, сколько честных клиентов из 1000 он беспокоит зря"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            className="touch-pan-y"
          >
            {/* сетка и подписи по вертикали: мошенников из 100 */}
            {y.ticks(narrow ? 3 : 5).map((tick) => (
              <g key={tick}>
                <line x1={MARGIN.left} x2={right} y1={y(tick)} y2={y(tick)} stroke="#e9ecf3" strokeDasharray="2 4" />
                <text x={MARGIN.left - 10} y={y(tick) + 4} fontSize={12} textAnchor="end" fill="#69728a" className="tabular">
                  {Math.round(tick * 100)}
                </text>
              </g>
            ))}
            <line x1={MARGIN.left} x2={right} y1={HEIGHT - MARGIN.bottom} y2={HEIGHT - MARGIN.bottom} stroke="#d5dae6" />

            {/* подписи по горизонтали: честных из 1000 */}
            {x.ticks(narrow ? 5 : 10).map((tick) => (
              <text
                key={tick}
                x={x(tick)}
                y={HEIGHT - MARGIN.bottom + 20}
                fontSize={12}
                textAnchor="middle"
                fill="#69728a"
                className="tabular"
              >
                {Math.round(tick * 1000)}
              </text>
            ))}
            <text x={(MARGIN.left + right) / 2} y={HEIGHT - 8} fontSize={13} textAnchor="middle" fill="#46506a">
              {narrow ? 'Честных из 1000, побеспокоено зря' : 'Честных клиентов из 1000, которых побеспокоили зря'}
            </text>
            <text
              transform={`translate(14 ${(MARGIN.top + HEIGHT - MARGIN.bottom) / 2}) rotate(-90)`}
              fontSize={13}
              textAnchor="middle"
              fill="#46506a"
            >
              Мошенников из 100 замечено
            </text>

            <path d={fill ?? ''} fill={LINE} fillOpacity={0.07} />
            <path d={path ?? ''} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {props.marks.map((mark) => {
              const cx = x(mark.honest_flagged)
              const cy = y(mark.droppers_found)
              // подпись — под точкой; у правого края уходит влево, чтобы не обрезалась
              const toLeft = cx > right - 170
              const text = `${mark.label} · ${Math.round(mark.droppers_found * 100)} из 100`
              const w = text.length * 6.6 + 20
              const px = toLeft ? cx - 12 - w : cx + 12
              return (
                <g key={mark.label}>
                  <line x1={cx} x2={cx} y1={cy} y2={HEIGHT - MARGIN.bottom} stroke={LINE} strokeOpacity={0.35} strokeDasharray="2 3" />
                  <circle cx={cx} cy={cy} r={6} fill={LINE} stroke="#ffffff" strokeWidth={2.5} />
                  {/* подпись — «таблетка» под точкой */}
                  <rect x={px} y={cy + 10} width={w} height={24} rx={12} fill="#0b1638" />
                  <text x={px + w / 2} y={cy + 26} fontSize={12.5} fontWeight={600} textAnchor="middle" fill="#ffffff">
                    {text}
                  </text>
                </g>
              )
            })}

            {hover && (
              <g pointerEvents="none">
                <line
                  x1={x(hover.honest_flagged)}
                  x2={x(hover.honest_flagged)}
                  y1={MARGIN.top}
                  y2={HEIGHT - MARGIN.bottom}
                  stroke="#8a93a8"
                />
                <circle cx={x(hover.honest_flagged)} cy={y(hover.droppers_found)} r={5} fill={LINE} stroke="#ffffff" strokeWidth={2} />
              </g>
            )}
          </svg>
        )}
        {hover && (
          <div
            className="pointer-events-none absolute bottom-[64px] rounded-[12px] bg-navy px-3 py-2 text-[13px] text-white shadow-lg"
            style={
              x(hover.honest_flagged) > width / 2 ? { right: width - x(hover.honest_flagged) + 12 } : { left: x(hover.honest_flagged) + 12 }
            }
          >
            <div>
              Замечено <b className="tabular">{Math.round(hover.droppers_found * 100)}</b> из 100 мошенников
            </div>
            <div>
              Зря побеспокоено <b className="tabular">{Math.round(hover.honest_flagged * 1000)}</b> из 1000 честных
            </div>
          </div>
        )}
      </div>
      <ul className="mt-4 space-y-1 text-[15px]">
        {props.marks.map((mark) => (
          <li key={mark.label}>
            <b>{mark.label}:</b> {Math.round(mark.droppers_found * 100)} из 100 мошенников замечено,{' '}
            {Math.round(mark.honest_flagged * 1000)} из 1000 честных побеспокоено зря
          </li>
        ))}
      </ul>
    </div>
  )
}
