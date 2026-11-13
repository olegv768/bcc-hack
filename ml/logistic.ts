// Логистическая регрессия — прежняя модель. Осталась как точка сравнения: новая модель должна
// быть лучше неё на тех же данных, иначе усложнение не оправдано.

import { FEATURE_KEYS, transform, type RecipientFeatures } from '../service/src/features.ts'

export type Logistic = { bias: number; weights: number[]; mean: number[]; std: number[] }

export function fitLogistic(items: { features: RecipientFeatures }[], labels: number[], sampleWeights: number[]): Logistic {
  const mean: number[] = []
  const std: number[] = []
  FEATURE_KEYS.forEach((key, j) => {
    const values = items.map((a) => a.features[key]).filter((v) => v !== null).map((v) => transform(key, v))
    mean[j] = values.reduce((s, v) => s + v, 0) / values.length
    std[j] = Math.sqrt(values.reduce((s, v) => s + (v - mean[j]!) ** 2, 0) / values.length) || 1
  })
  // непереданный признак заменяем средним: после нормировки это ноль
  const rows = items.map((a) => FEATURE_KEYS.map((key, j) => (a.features[key] === null ? 0 : (transform(key, a.features[key]) - mean[j]!) / std[j]!)))

  const weights = FEATURE_KEYS.map(() => 0)
  let bias = 0
  for (let step = 0; step < 800; step++) {
    const gradient = weights.map(() => 0)
    let gradientBias = 0
    for (let i = 0; i < rows.length; i++) {
      const x = rows[i]!
      const logit = x.reduce((s, v, j) => s + v * weights[j]!, bias)
      const error = (1 / (1 + Math.exp(-logit)) - labels[i]!) * sampleWeights[i]!
      for (let j = 0; j < x.length; j++) gradient[j]! += error * x[j]!
      gradientBias += error
    }
    for (let j = 0; j < weights.length; j++) weights[j]! -= 0.5 * (gradient[j]! / rows.length + 0.001 * weights[j]!)
    bias -= (0.5 * gradientBias) / rows.length
  }
  return { bias, weights, mean, std }
}

export function scoreLogistic(model: Logistic, features: RecipientFeatures): number {
  let logit = model.bias
  FEATURE_KEYS.forEach((key, j) => {
    const value = features[key]
    if (value !== null) logit += (model.weights[j]! * (transform(key, value) - model.mean[j]!)) / model.std[j]!
  })
  return 1 / (1 + Math.exp(-logit))
}
