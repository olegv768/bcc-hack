// Подбор настроек модели: npm run tune
// Сравнивает варианты настроек на проверочной выборке (не на отложенной — её бережём для
// честной итоговой оценки). Лучший вариант переносится в DEFAULTS в ml/ebm.ts вручную.

import { FEATURE_KEYS, type RecipientFeatures } from '../service/src/features.ts'
import { scoreRecipient, type Model } from '../service/src/model.ts'
import { DEFAULTS, fitEbm, type Options } from './ebm.ts'
import { generateAccounts } from './generate.ts'
import { createRng } from './random.ts'

const accounts = generateAccounts(200000, createRng(20261112))
const train = accounts.slice(0, 120000)
const validation = accounts.slice(120000, 160000)

const labels = train.map((a) => (a.is_dropper ? 1 : 0))
const positives = labels.reduce((s: number, y) => s + y, 0)
const weights = labels.map((y) => (y ? train.length / (2 * positives) : train.length / (2 * (train.length - positives))))
const rows = train.map((a) => FEATURE_KEYS.map((key) => a.features[key]))

const VARIANTS: [string, Partial<Options>][] = [
  ['как сейчас', {}],
  ['сглаживание 30', { smoothing: 30 }],
  ['сглаживание 3', { smoothing: 3 }],
  ['без четвёрок', { bins: [32, 12, 8, 0] }],
  ['только пары', { bins: [32, 12, 0, 0] }],
  ['мельче клетки', { bins: [48, 16, 10, 7] }],
  ['крупнее клетки', { bins: [24, 10, 6, 5] }],
  ['медленнее и дольше', { learningRate: 0.05, rounds: [600, 300, 200, 120] }],
  ['короче', { rounds: [150, 80, 50, 30] }],
]

console.log('вариант                 AUC     найдено при 2% ложных   при 0,3% ложных')
for (const [name, change] of VARIANTS) {
  // без усреднения по выборкам: так быстрее, а порядок вариантов тот же
  const fit = fitEbm(rows, labels, weights, { ...DEFAULTS, bags: 1, ...change })
  const model = { bias: fit.bias, terms: fit.terms.map((t) => ({ ...t, features: t.features.map((j) => FEATURE_KEYS[j]!) })) } as Model
  const score = (features: RecipientFeatures) => scoreRecipient(model, features).risk

  const droppers = validation.filter((a) => a.is_dropper).map((a) => score(a.features))
  const honest = validation.filter((a) => !a.is_dropper).map((a) => score(a.features)).sort((a, b) => b - a)
  const found = (fpr: number) => droppers.filter((r) => r >= honest[Math.floor(honest.length * fpr)]!).length / droppers.length
  const ranked = [...droppers.map((r) => [r, 1]), ...honest.map((r) => [r, 0])].sort((a, b) => a[0]! - b[0]!)
  let rankSum = 0
  ranked.forEach((item, i) => (rankSum += item[1] ? i + 1 : 0))
  const auc = (rankSum - (droppers.length * (droppers.length + 1)) / 2) / (droppers.length * honest.length)

  console.log(`${name.padEnd(22)} ${auc.toFixed(4)}        ${(found(0.02) * 100).toFixed(1)}%               ${(found(0.003) * 100).toFixed(1)}%`)
}
