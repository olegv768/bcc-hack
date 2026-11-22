// Модель из деревьев (LightGBM с монотонными ограничениями, обучение — ml/challenger/export_lgbm.py)
// и вклад каждого признака в оценку по Шепли — те же числа, что даёт TreeSHAP (Lundberg и др., 2018,
// вариант «path-dependent»), стандарт объяснения бустинга над деревьями. Вклады в сумме дают ровно
// «оценка этого счёта минус средняя оценка», и каждый вклад — честная доля признака.
//
// TreeSHAP — быстрый способ посчитать значения Шепли для игры «оценка, когда известны только эти
// признаки, а остальные усреднены по обучающим счетам». Признаков у нас немного, поэтому эти значения
// проще получить прямо: в каждом дереве перебрать все наборы признаков, которые оно использует.
// Числа сверены с самим LightGBM: ml/train.ts при импорте модели пересчитывает контрольные счета
// и останавливается, если хоть один вклад разошёлся.
//
// Непереданный признак (null) усредняется по обучающим счетам на каждой развилке, где он нужен:
// оценка — «как у похожих счетов, о которых этот признак неизвестен», а вклад признака равен нулю.

import type { FeatureKey, RecipientFeatures } from './features.ts'

export type Tree = {
  feature: number[] // номер признака в развилке; −1 — лист
  threshold: number[] // значение ≤ порога — налево, иначе направо
  left: number[]
  right: number[]
  value: number[] // у листа — его вклад в оценку
  cover: number[] // сколько обучающих счетов прошло через узел
}

export type TreeModel = {
  kind: 'trees'
  version: string
  features: FeatureKey[]
  offset: number // постоянный сдвиг шкалы оценки (см. export_lgbm.py)
  trees: Tree[]
  thresholds: { soft: number; warn: number; hold: number }
}

// Оценка дерева: спуск по развилкам; где признак неизвестен — среднее ветвей с весом по счетам.
function treeValue(tree: Tree, x: (number | null)[], node = 0): number {
  const split = tree.feature[node]!
  if (split < 0) return tree.value[node]!
  const value = x[split]
  if (value === null || value === undefined) {
    const left = tree.left[node]!
    const right = tree.right[node]!
    return (tree.cover[left]! * treeValue(tree, x, left) + tree.cover[right]! * treeValue(tree, x, right)) / tree.cover[node]!
  }
  return treeValue(tree, x, value <= tree.threshold[node]! ? tree.left[node]! : tree.right[node]!)
}

// средняя оценка по обучающим счетам — от неё отсчитываются вклады признаков
const expectedCache = new WeakMap<TreeModel, number>()
export function expectedLogit(model: TreeModel): number {
  if (!expectedCache.has(model)) {
    const unknown = model.features.map(() => null)
    expectedCache.set(model, model.offset + model.trees.reduce((sum, tree) => sum + treeValue(tree, unknown), 0))
  }
  return expectedCache.get(model)!
}

export function logitTrees(model: TreeModel, features: RecipientFeatures): number {
  const x = model.features.map((key) => features[key] ?? null)
  return model.trees.reduce((sum, tree) => sum + treeValue(tree, x), model.offset)
}

// Один обход дерева сразу для всех наборов известных признаков: у каждого набора свой вес на узле.
// Если признак развилки в наборе — весь вес уходит в ветвь, куда ведёт значение счёта; если нет —
// делится между ветвями по доле обучающих счетов. В листе вес набора умножается на значение листа.
type Scratch = { left: Float64Array[]; right: Float64Array[] }
const scratchOf = new WeakMap<TreeModel, Scratch>()

function accumulate(tree: Tree, x: (number | null)[], bitOf: Int8Array, sets: number, node: number, weight: Float64Array, depth: number, scratch: Scratch, out: Float64Array) {
  const split = tree.feature[node]!
  if (split < 0) {
    const leaf = tree.value[node]!
    for (let m = 0; m < sets; m++) out[m]! += weight[m]! * leaf
    return
  }
  const left = tree.left[node]!
  const right = tree.right[node]!
  const toLeft = scratch.left[depth]!
  const toRight = scratch.right[depth]!
  const shareLeft = tree.cover[left]! / tree.cover[node]!
  const bit = bitOf[split]!
  const goesLeft = bit >= 0 && x[split]! <= tree.threshold[node]!
  let anyLeft = false
  let anyRight = false
  for (let m = 0; m < sets; m++) {
    const w = weight[m]!
    if (bit >= 0 && m & (1 << bit)) {
      toLeft[m] = goesLeft ? w : 0
      toRight[m] = goesLeft ? 0 : w
    } else {
      toLeft[m] = w * shareLeft
      toRight[m] = w - toLeft[m]!
    }
    if (toLeft[m]) anyLeft = true
    if (toRight[m]) anyRight = true
  }
  if (anyLeft) accumulate(tree, x, bitOf, sets, left, toLeft, depth + 1, scratch, out)
  if (anyRight) accumulate(tree, x, bitOf, sets, right, toRight, depth + 1, scratch, out)
}

function treeDepth(tree: Tree, node = 0): number {
  return tree.feature[node]! < 0 ? 0 : 1 + Math.max(treeDepth(tree, tree.left[node]!), treeDepth(tree, tree.right[node]!))
}

// Какие признаки встречаются в развилках дерева.
const usedOf = new WeakMap<TreeModel, number[][]>()
function treeFeatures(model: TreeModel): number[][] {
  if (!usedOf.has(model)) usedOf.set(model, model.trees.map((tree) => [...new Set(tree.feature.filter((f) => f >= 0))].sort((a, b) => a - b)))
  return usedOf.get(model)!
}

// Вес набора в формуле Шепли: |S|! · (n − |S| − 1)! / n!. Считаем таблицей один раз — внутри
// перебора наборов это самая частая операция.
const MAX_PLAYERS = 16
const FACTORIAL = [1]
for (let k = 1; k <= MAX_PLAYERS; k++) FACTORIAL.push(FACTORIAL[k - 1]! * k)
const SHAPLEY_WEIGHT = Array.from({ length: MAX_PLAYERS + 1 }, (_, n) =>
  Float64Array.from({ length: Math.max(n, 1) }, (_, size) => (n ? (FACTORIAL[size]! * FACTORIAL[n - size - 1]!) / FACTORIAL[n]! : 0)),
)
// сколько признаков в наборе (число единичных битов маски)
const MEMBERS = Uint8Array.from({ length: 1 << 12 }, (_, mask) => {
  let count = 0
  for (let m = mask; m; m &= m - 1) count++
  return count
})

// Значения Шепли считаем по каждому дереву отдельно и складываем: оценка модели — сумма деревьев,
// а значение Шепли суммы — сумма значений Шепли. Признак, которого нет в развилках дерева, на это
// дерево не влияет, и его вклад в дереве — ноль; поэтому наборы перебираем только среди признаков,
// которые дерево использует (обычно 2–5 из 7). Результат тот же, что при переборе всех наборов.
export function scoreTrees(model: TreeModel, features: RecipientFeatures) {
  const x = model.features.map((key) => features[key] ?? null)
  if (!scratchOf.has(model)) {
    const depth = Math.max(...model.trees.map((tree) => treeDepth(tree))) + 1
    const size = 1 << model.features.length
    scratchOf.set(model, { left: Array.from({ length: depth }, () => new Float64Array(size)), right: Array.from({ length: depth }, () => new Float64Array(size)) })
  }
  const scratch = scratchOf.get(model)!
  const used = treeFeatures(model)
  const size = 1 << model.features.length
  const bitOf = new Int8Array(model.features.length)
  const known: number[] = []
  const value = new Float64Array(size)
  const start = new Float64Array(size).fill(1)
  const phi = model.features.map(() => 0)
  let logit = model.offset

  for (let t = 0; t < model.trees.length; t++) {
    // известные признаки этого дерева — игроки; номер набора — битовая маска по ним
    known.length = 0
    bitOf.fill(-1)
    for (const j of used[t]!) if (x[j] !== null) bitOf[j] = known.push(j) - 1
    const sets = 1 << known.length
    // value[набор] — оценка дерева, когда известны только признаки набора
    value.fill(0, 0, sets)
    accumulate(model.trees[t]!, x, bitOf, sets, 0, start, 0, scratch, value)
    logit += value[sets - 1]!
    // вклад признака по Шепли: средний прирост оценки, когда признак добавляют к остальным в любом порядке
    const n = known.length
    const weight = SHAPLEY_WEIGHT[n]!
    for (let bit = 0; bit < n; bit++) {
      const flag = 1 << bit
      let sum = 0
      for (let mask = 0; mask < sets; mask++) {
        if (mask & flag) continue
        sum += weight[MEMBERS[mask]!]! * (value[mask | flag]! - value[mask]!)
      }
      phi[known[bit]!]! += sum
    }
  }
  const contributions = Object.fromEntries(model.features.map((key, j) => [key, phi[j]!])) as Record<FeatureKey, number>
  return { logit, contributions }
}
