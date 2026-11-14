// Объяснимый бустинг: оценка = сумма таблиц. Сначала по таблице на каждый признак («кривая»:
// вклад зависит от значения признака), затем на каждую пару, тройку и четвёрку признаков —
// поправки за сочетания, которые отдельные признаки объяснить не смогли.
// Оценка остаётся суммой отдельных вкладов, поэтому причины решения видны напрямую.

import { binOf, type Term } from '../service/src/model.ts'

export type EbmFit = { bias: number; terms: (Omit<Term, 'features'> & { features: number[] })[] }

export type Options = {
  // настройки по числу признаков в таблице: [один, пара, тройка, четвёрка]
  bins: number[] // на сколько интервалов делим каждый признак (0 — таблицы такого порядка не строим)
  rounds: number[]
  learningRate: number
  smoothing: number // чем больше, тем осторожнее обновляются клетки с малым числом примеров
  bags: number // сколько раз обучаем на случайных повторных выборках и усредняем: результат устойчивее
  seed: number
}

// Подобраны на проверочной выборке (npm run tune): варианты отличались меньше чем на процентный пункт,
// поэтому взяты более грубые клетки и короткое обучение — они устойчивее и быстрее.
export const DEFAULTS: Options = { bins: [24, 10, 6, 5], rounds: [150, 80, 50, 30], learningRate: 0.1, smoothing: 20, bags: 8, seed: 1 }

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

// все сочетания из size признаков
function combinations(count: number, size: number): number[][] {
  if (size === 0) return [[]]
  const result: number[][] = []
  for (let first = 0; first <= count - size; first++) {
    for (const rest of combinations(count - first - 1, size - 1)) result.push([first, ...rest.map((i) => i + first + 1)])
  }
  return result
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

export function fitEbm(rows: (number | null)[][], labels: number[], weights: number[], options: Options = DEFAULTS): EbmFit {
  const n = rows.length
  const featureCount = rows[0]!.length

  // --- таблицы и раскладка примеров по клеткам (−1 — признак не передан: пример эту таблицу не учит) ---
  const terms: { features: number[]; edges: number[][]; cells: Int32Array; size: number; order: number }[] = []
  for (let order = 1; order <= featureCount; order++) {
    const bins = options.bins[order - 1] ?? 0
    if (!bins) continue
    const edgesOf = Array.from({ length: featureCount }, (_, j) =>
      quantileEdges(rows.map((row) => row[j]!).filter((v) => v !== null), bins),
    )
    for (const features of combinations(featureCount, order)) {
      const edges = features.map((j) => edgesOf[j]!)
      const cells = new Int32Array(n)
      for (let i = 0; i < n; i++) {
        let cell = 0
        for (let f = 0; f < features.length; f++) {
          const value = rows[i]![features[f]!]
          if (value === null) {
            cell = -1
            break
          }
          cell = cell * (edges[f]!.length + 1) + binOf(edges[f]!, value!)
        }
        cells[i] = cell
      }
      terms.push({ features, edges, cells, size: edges.reduce((product, e) => product * (e.length + 1), 1), order })
    }
  }

  let positive = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    positive += weights[i]! * labels[i]!
    total += weights[i]!
  }
  const startBias = Math.log(positive / (total - positive))

  // --- одно обучение на выборке с весами bagWeights; возвращает таблицы ---
  const fitOnce = (bagWeights: Float64Array) => {
    const scores = terms.map((term) => new Float64Array(term.size))
    const score = new Float64Array(n).fill(startBias)
    // таблицы учатся по порядку: сначала отдельные признаки, потом пары и так далее
    for (let order = 1; order <= featureCount; order++) {
      const group = terms.map((term, index) => ({ term, index })).filter((item) => item.term.order === order)
      for (let round = 0; round < (options.rounds[order - 1] ?? 0); round++) {
        for (const { term, index } of group) {
          // для каждой клетки считаем, куда и насколько сдвинуть оценку, чтобы ошибка уменьшилась
          const gradient = new Float64Array(term.size)
          const hessian = new Float64Array(term.size)
          for (let i = 0; i < n; i++) {
            const cell = term.cells[i]!
            if (cell < 0 || bagWeights[i] === 0) continue
            const p = sigmoid(score[i]!)
            gradient[cell]! += bagWeights[i]! * (labels[i]! - p)
            hessian[cell]! += bagWeights[i]! * p * (1 - p)
          }
          const table = scores[index]!
          for (let c = 0; c < term.size; c++) {
            gradient[c] = (options.learningRate * gradient[c]!) / (hessian[c]! + options.smoothing)
            table[c]! += gradient[c]!
          }
          for (let i = 0; i < n; i++) {
            const cell = term.cells[i]!
            if (cell >= 0) score[i]! += gradient[cell]!
          }
        }
      }
    }
    return scores
  }

  // --- усреднение по нескольким случайным повторным выборкам ---
  let random = options.seed >>> 0
  const next = () => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0
    return random / 4294967296
  }
  const average = terms.map((term) => new Float64Array(term.size))
  for (let bag = 0; bag < options.bags; bag++) {
    const bagWeights = new Float64Array(n)
    if (options.bags === 1) bagWeights.set(weights)
    else {
      // каждый пример попадает в выборку 0, 1, 2… раз (в среднем один)
      for (let i = 0; i < n; i++) {
        let copies = 0
        let p = next()
        const limit = Math.exp(-1)
        while (p > limit) {
          copies++
          p *= next()
        }
        bagWeights[i] = weights[i]! * copies
      }
    }
    fitOnce(bagWeights).forEach((table, t) => {
      for (let c = 0; c < table.length; c++) average[t]![c]! += table[c]! / options.bags
    })
  }

  // --- центрирование: средний вклад каждой таблицы равен нулю, остаток уходит в общий сдвиг ---
  // Тогда «признак не передан» означает «вклад как у среднего счёта», то есть ноль.
  let bias = startBias
  terms.forEach((term, t) => {
    let sum = 0
    let weight = 0
    for (let i = 0; i < n; i++) {
      if (term.cells[i]! < 0) continue
      sum += weights[i]! * average[t]![term.cells[i]!]!
      weight += weights[i]!
    }
    const mean = weight ? sum / weight : 0
    for (let c = 0; c < term.size; c++) average[t]![c]! -= mean
    bias += mean
  })

  const round4 = (value: number) => Math.round(value * 10000) / 10000
  return {
    bias: round4(bias),
    terms: terms.map((term, t) => ({ features: term.features, edges: term.edges, scores: Array.from(average[t]!, round4) })),
  }
}
