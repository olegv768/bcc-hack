// Модель из деревьев (LightGBM с монотонными ограничениями, обучение — ml/challenger/export_lgbm.py)
// и вклад каждого признака в оценку по Шепли — те же числа, что даёт TreeSHAP (Lundberg и др., 2018,
// вариант «path-dependent»), стандарт объяснения бустинга над деревьями. Вклады в сумме дают ровно
// «оценка этого счёта минус средняя оценка», и каждый вклад — честная доля признака.
//
// TreeSHAP — быстрый способ посчитать значения Шепли для игры «оценка, когда известны только эти
// признаки, а остальные усреднены по обучающим счетам». Признаков у нас четыре, поэтому эти значения
// проще и быстрее получить прямо: перебрать все 16 наборов известных признаков.
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

export function scoreTrees(model: TreeModel, features: RecipientFeatures) {
  const x = model.features.map((key) => features[key] ?? null)
  const known = model.features.map((_, j) => j).filter((j) => x[j] !== null)
  const bitOf = new Int8Array(model.features.length).fill(-1)
  known.forEach((j, bit) => (bitOf[j] = bit))
  const sets = 1 << known.length

  if (!scratchOf.has(model)) {
    const depth = Math.max(...model.trees.map((tree) => treeDepth(tree))) + 1
    const size = 1 << model.features.length
    scratchOf.set(model, { left: Array.from({ length: depth }, () => new Float64Array(size)), right: Array.from({ length: depth }, () => new Float64Array(size)) })
  }
  const scratch = scratchOf.get(model)!
  // value[набор] — оценка, когда известны только признаки набора (номер — битовая маска по known)
  const value = new Float64Array(sets)
  const start = new Float64Array(sets).fill(1)
  for (const tree of model.trees) accumulate(tree, x, bitOf, sets, 0, start, 0, scratch, value)
  for (let m = 0; m < sets; m++) value[m]! += model.offset

  // вклад признака по Шепли: средний прирост оценки, когда признак добавляют к остальным в любом порядке
  const n = known.length
  const factorial = (k: number): number => (k <= 1 ? 1 : k * factorial(k - 1))
  const phi = model.features.map(() => 0)
  known.forEach((j, bit) => {
    for (let mask = 0; mask < sets; mask++) {
      if (mask & (1 << bit)) continue
      let size = 0
      for (let m = mask; m; m &= m - 1) size++
      phi[j]! += ((factorial(size) * factorial(n - size - 1)) / factorial(n)) * (value[mask | (1 << bit)]! - value[mask]!)
    }
  })
  const contributions = Object.fromEntries(model.features.map((key, j) => [key, phi[j]!])) as Record<FeatureKey, number>
  return { logit: value[sets - 1]!, contributions }
}
