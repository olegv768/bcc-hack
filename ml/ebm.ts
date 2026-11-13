// Объяснимый бустинг: оценка = сумма «кривых» по каждому признаку и таблиц по каждой паре признаков.
// В отличие от логистической регрессии, вклад признака может быть любой формы (например, резко
// расти на счетах младше месяца), а пары ловят сочетания («много отправителей» + «деньги сразу уходят»).
// При этом оценка остаётся суммой отдельных вкладов, поэтому причины по-прежнему видны напрямую.

import { binOf } from '../service/src/model.ts'

export type Curve = { edges: number[]; scores: number[] }
export type PairTable = { a: number; b: number; edgesA: number[]; edgesB: number[]; scores: number[][] }
export type EbmFit = { bias: number; curves: Curve[]; pairs: PairTable[] }

type Options = {
  bins: number // на сколько интервалов делим значения признака
  pairBins: number // то же для парных таблиц (грубее: в клетках меньше примеров)
  rounds: number
  pairRounds: number
  learningRate: number
  smoothing: number // чем больше, тем осторожнее обновляются клетки с малым числом примеров
}

export const DEFAULTS: Options = { bins: 24, pairBins: 8, rounds: 200, pairRounds: 80, learningRate: 0.1, smoothing: 20 }

// Границы по квантилям: в каждом интервале примерно поровну примеров.
function quantileEdges(values: number[], bins: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const edges: number[] = []
  for (let k = 1; k < bins; k++) {
    const edge = sorted[Math.floor((sorted.length * k) / bins)]!
    if (edge > sorted[0]! && edge !== edges[edges.length - 1]) edges.push(edge)
  }
  return edges
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

export function fitEbm(rows: (number | null)[][], labels: number[], weights: number[], options: Options = DEFAULTS): EbmFit {
  const n = rows.length
  const featureCount = rows[0]!.length
  const column = (j: number) => rows.map((row) => row[j]!).filter((v) => v !== null)

  // --- раскладка по интервалам (−1 — значение не передано: такой пример признак не учит) ---
  const curves: Curve[] = []
  const bins: Int16Array[] = []
  const pairEdges: number[][] = []
  const pairBinsOf: Int16Array[] = []
  for (let j = 0; j < featureCount; j++) {
    const edges = quantileEdges(column(j), options.bins)
    curves.push({ edges, scores: new Array(edges.length + 1).fill(0) })
    bins.push(Int16Array.from(rows, (row) => (row[j] === null ? -1 : binOf(edges, row[j]!))))
    const coarse = quantileEdges(column(j), options.pairBins)
    pairEdges.push(coarse)
    pairBinsOf.push(Int16Array.from(rows, (row) => (row[j] === null ? -1 : binOf(coarse, row[j]!))))
  }

  // начальная оценка — общая доля положительных примеров (с учётом весов)
  let positive = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    positive += weights[i]! * labels[i]!
    total += weights[i]!
  }
  let bias = Math.log(positive / (total - positive))
  const score = new Float64Array(n).fill(bias)

  // Один шаг: для каждой клетки считаем, куда и насколько сдвинуть оценку, чтобы ошибка уменьшилась.
  const step = (cellOf: (i: number) => number, cells: number, apply: (cell: number, delta: number) => void) => {
    const gradient = new Float64Array(cells)
    const hessian = new Float64Array(cells)
    for (let i = 0; i < n; i++) {
      const cell = cellOf(i)
      if (cell < 0) continue
      const p = sigmoid(score[i]!)
      gradient[cell]! += weights[i]! * (labels[i]! - p)
      hessian[cell]! += weights[i]! * p * (1 - p)
    }
    const delta = new Float64Array(cells)
    for (let c = 0; c < cells; c++) {
      delta[c] = (options.learningRate * gradient[c]!) / (hessian[c]! + options.smoothing)
      apply(c, delta[c]!)
    }
    for (let i = 0; i < n; i++) {
      const cell = cellOf(i)
      if (cell >= 0) score[i]! += delta[cell]!
    }
  }

  // --- кривые по одному признаку ---
  for (let round = 0; round < options.rounds; round++) {
    for (let j = 0; j < featureCount; j++) {
      const curve = curves[j]!
      step((i) => bins[j]![i]!, curve.scores.length, (cell, delta) => (curve.scores[cell]! += delta))
    }
  }

  // --- таблицы по парам: учат только то, что кривые по одному признаку объяснить не смогли ---
  const pairs: PairTable[] = []
  for (let a = 0; a < featureCount; a++) {
    for (let b = a + 1; b < featureCount; b++) {
      const sizeA = pairEdges[a]!.length + 1
      const sizeB = pairEdges[b]!.length + 1
      pairs.push({ a, b, edgesA: pairEdges[a]!, edgesB: pairEdges[b]!, scores: Array.from({ length: sizeA }, () => new Array(sizeB).fill(0)) })
    }
  }
  for (let round = 0; round < options.pairRounds; round++) {
    for (const pair of pairs) {
      const sizeB = pair.edgesB.length + 1
      const binsA = pairBinsOf[pair.a]!
      const binsB = pairBinsOf[pair.b]!
      step(
        (i) => (binsA[i]! < 0 || binsB[i]! < 0 ? -1 : binsA[i]! * sizeB + binsB[i]!),
        pair.scores.length * sizeB,
        (cell, delta) => (pair.scores[Math.floor(cell / sizeB)]![cell % sizeB]! += delta),
      )
    }
  }

  // --- центрирование: средний вклад каждой части равен нулю, остаток уходит в общий сдвиг ---
  // Тогда «признак не передан» означает «вклад как у среднего счёта», то есть ноль.
  const center = (valueOf: (i: number) => number | null, shift: (mean: number) => void) => {
    let sum = 0
    let weight = 0
    for (let i = 0; i < n; i++) {
      const value = valueOf(i)
      if (value === null) continue
      sum += weights[i]! * value
      weight += weights[i]!
    }
    const mean = weight ? sum / weight : 0
    shift(mean)
    bias += mean
  }
  curves.forEach((curve, j) =>
    center(
      (i) => (bins[j]![i]! < 0 ? null : curve.scores[bins[j]![i]!]!),
      (mean) => (curve.scores = curve.scores.map((s) => s - mean)),
    ),
  )
  for (const pair of pairs) {
    const binsA = pairBinsOf[pair.a]!
    const binsB = pairBinsOf[pair.b]!
    center(
      (i) => (binsA[i]! < 0 || binsB[i]! < 0 ? null : pair.scores[binsA[i]!]![binsB[i]!]!),
      (mean) => (pair.scores = pair.scores.map((row) => row.map((s) => s - mean))),
    )
  }

  const round4 = (value: number) => Math.round(value * 10000) / 10000
  return {
    bias: round4(bias),
    curves: curves.map((c) => ({ edges: c.edges, scores: c.scores.map(round4) })),
    pairs: pairs.map((p) => ({ ...p, scores: p.scores.map((row) => row.map(round4)) })),
  }
}
