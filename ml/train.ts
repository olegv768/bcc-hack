// Обучение и проверка модели: npm run train
// 1) генерирует синтетические счета, 2) обучает логистическую регрессию, 3) подбирает пороги
// на проверочной выборке, 4) считает метрики на отложенной выборке, которую модель не видела.

import { writeFileSync, mkdirSync } from 'node:fs'
import { FEATURE_KEYS, transform, type FeatureKey } from '../service/src/features.ts'
import { decide, scoreRecipient, type Model } from '../service/src/model.ts'
import { DROPPER_SHARE, TRANSFER_ASSUMPTIONS, generateAccounts, generateContext, type Account } from './generate.ts'
import { createRng } from './random.ts'

const SEED = 20261112
const ACCOUNTS = 200000
// Допустимая доля честных счетов выше каждого порога (на проверочной выборке).
const TARGET_FPR = { soft: 0.1, warn: 0.02, hold: 0.003 }

const rng = createRng(SEED)
const accounts = generateAccounts(ACCOUNTS, rng)
const train = accounts.slice(0, ACCOUNTS * 0.6)
const validation = accounts.slice(ACCOUNTS * 0.6, ACCOUNTS * 0.8)
const test = accounts.slice(ACCOUNTS * 0.8)

// --- обучение ---

const stats = {} as Record<FeatureKey, { mean: number; std: number }>
for (const key of FEATURE_KEYS) {
  const values = train.map((a) => transform(key, a.features[key]!))
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const std = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
  stats[key] = { mean, std }
}

const rows = train.map((a) => FEATURE_KEYS.map((key) => (transform(key, a.features[key]!) - stats[key].mean) / stats[key].std))
const labels = train.map((a) => (a.is_dropper ? 1 : 0))
const positives = labels.reduce((s: number, y) => s + y, 0)
// Дропперов мало, поэтому их примеры весят больше: оба класса влияют на обучение одинаково.
const weightPositive = train.length / (2 * positives)
const weightNegative = train.length / (2 * (train.length - positives))

const weights = FEATURE_KEYS.map(() => 0)
let bias = 0
const LEARNING_RATE = 0.5
const L2 = 0.001
for (let step = 0; step < 800; step++) {
  const gradient = weights.map(() => 0)
  let gradientBias = 0
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i]!
    const logit = x.reduce((s, v, j) => s + v * weights[j]!, bias)
    const error = (1 / (1 + Math.exp(-logit)) - labels[i]!) * (labels[i] ? weightPositive : weightNegative)
    for (let j = 0; j < x.length; j++) gradient[j]! += error * x[j]!
    gradientBias += error
  }
  for (let j = 0; j < weights.length; j++) {
    weights[j]! -= LEARNING_RATE * (gradient[j]! / rows.length + L2 * weights[j]!)
  }
  bias -= (LEARNING_RATE * gradientBias) / rows.length
}

const model: Model = {
  version: 'lr-synthetic-' + SEED,
  bias,
  features: Object.fromEntries(
    FEATURE_KEYS.map((key, j) => [key, { ...stats[key], weight: weights[j]! }]),
  ) as Model['features'],
  thresholds: { soft: 0, warn: 0, hold: 0 },
}

// --- пороги: по проверочной выборке ---

const riskOf = (a: Account) => scoreRecipient(model, a.features).risk
const honestValidation = validation.filter((a) => !a.is_dropper).map(riskOf).sort((a, b) => b - a)
for (const name of ['soft', 'warn', 'hold'] as const) {
  model.thresholds[name] = round(honestValidation[Math.floor(honestValidation.length * TARGET_FPR[name])]!, 4)
}

// --- метрики: по отложенной выборке ---

const scored = test.map((a) => ({ ...a, risk: riskOf(a) }))
const droppers = scored.filter((a) => a.is_dropper)
const honest = scored.filter((a) => !a.is_dropper)
const share = (items: { risk: number }[], threshold: number) =>
  items.length ? items.filter((a) => a.risk >= threshold).length / items.length : 0

const accountLevel = (['warn', 'hold'] as const).map((name) => {
  const threshold = model.thresholds[name]
  const found = share(droppers, threshold)
  const falseAlarms = share(honest, threshold)
  // точность при доле дропперов из генератора: сколько помеченных счетов действительно дропперы
  const flaggedDroppers = found * DROPPER_SHARE
  const precision = flaggedDroppers / (flaggedDroppers + falseAlarms * (1 - DROPPER_SHARE))
  return { threshold: name, value: threshold, droppers_found: found, honest_flagged: falseAlarms, precision }
})

const kinds = [...new Set(scored.map((a) => a.kind))]
const byKind = kinds.map((kind) => {
  const items = scored.filter((a) => a.kind === kind)
  return {
    kind,
    is_dropper: items[0]!.is_dropper,
    count: items.length,
    above_warn: share(items, model.thresholds.warn),
    above_hold: share(items, model.thresholds.hold),
  }
})

// площадь под ROC: вероятность, что случайный дроппер получит оценку выше случайного честного счёта
const ranked = [...scored].sort((a, b) => a.risk - b.risk)
let rankSum = 0
ranked.forEach((a, i) => {
  if (a.is_dropper) rankSum += i + 1
})
const auc = (rankSum - (droppers.length * (droppers.length + 1)) / 2) / (droppers.length * honest.length)

const roc = Array.from({ length: 101 }, (_, i) => {
  const threshold = i / 100
  return { threshold, droppers_found: share(droppers, threshold), honest_flagged: share(honest, threshold) }
})

const BINS = 20
const histogram = Array.from({ length: BINS }, (_, i) => {
  const inBin = (a: { risk: number }) => Math.min(BINS - 1, Math.floor(a.risk * BINS)) === i
  return {
    from: i / BINS,
    to: (i + 1) / BINS,
    honest_share: honest.filter(inBin).length / honest.length,
    dropper_share: droppers.filter(inBin).length / droppers.length,
  }
})

// --- переводы: что делает сервис целиком (модель + обстоятельства перевода) ---

function transferLevel(withCallSignal: boolean) {
  const transferRng = createRng(SEED + 1)
  const counts = { fraud: { allow: 0, warn: 0, hold: 0, total: 0 }, honest: { allow: 0, warn: 0, hold: 0, total: 0 } }
  for (const account of test) {
    const group = account.is_dropper ? counts.fraud : counts.honest
    // на дроппера приходит несколько жертв, чтобы оценка по мошенническим переводам была устойчивее
    for (let i = 0; i < (account.is_dropper ? 20 : 1); i++) {
      const context = generateContext(account.is_dropper, transferRng)
      if (!withCallSignal) context.sender_on_call = null
      group[decide(model, account.features, context).action]++
      group.total++
    }
  }
  const rates = (g: typeof counts.fraud) => ({ warn: g.warn / g.total, hold: g.hold / g.total, total: g.total })
  return { fraud: rates(counts.fraud), honest: rates(counts.honest) }
}

const metrics = {
  model_version: model.version,
  data: {
    source: 'synthetic',
    seed: SEED,
    accounts: ACCOUNTS,
    dropper_share: DROPPER_SHARE,
    test_accounts: test.length,
    test_droppers: droppers.length,
    test_honest: honest.length,
  },
  auc,
  thresholds: model.thresholds,
  account_level: accountLevel,
  by_kind: byKind,
  transfer_level: {
    assumptions: TRANSFER_ASSUMPTIONS,
    with_call_signal: transferLevel(true),
    without_call_signal: transferLevel(false),
  },
  roc,
  histogram,
}

mkdirSync(new URL('../service/model/', import.meta.url), { recursive: true })
writeFileSync(new URL('../service/model/model.json', import.meta.url), JSON.stringify(model, null, 2) + '\n')
writeFileSync(new URL('./metrics.json', import.meta.url), JSON.stringify(metrics, null, 2) + '\n')

// --- отчёт в консоль ---

const pct = (v: number) => (v * 100).toFixed(1) + '%'
console.log(`Модель ${model.version}, AUC ${auc.toFixed(3)}`)
console.log('Веса:', Object.fromEntries(FEATURE_KEYS.map((k) => [k, round(model.features[k].weight, 2)])), 'bias', round(bias, 2))
console.log('Пороги:', model.thresholds)
console.log(`\nСчета (отложенная выборка: ${droppers.length} дропперов, ${honest.length} честных)`)
for (const m of accountLevel) {
  console.log(`  ${m.threshold.padEnd(4)} найдено дропперов ${pct(m.droppers_found)}, ложных среди честных ${pct(m.honest_flagged)}, точность ${pct(m.precision)}`)
}
console.log('\nПо типам счетов (доля выше порога warn / hold)')
for (const k of byKind) console.log(`  ${k.kind.padEnd(15)} ${String(k.count).padStart(6)}  ${pct(k.above_warn).padStart(6)} / ${pct(k.above_hold).padStart(6)}`)
for (const [title, t] of [['с сигналом звонка', metrics.transfer_level.with_call_signal], ['без сигнала звонка', metrics.transfer_level.without_call_signal]] as const) {
  console.log(`\nПереводы, ${title}`)
  console.log(`  мошеннические: придержано ${pct(t.fraud.hold)}, предупреждение ${pct(t.fraud.warn)}, пропущено ${pct(1 - t.fraud.hold - t.fraud.warn)}`)
  console.log(`  честные:       придержано ${pct(t.honest.hold)}, предупреждение ${pct(t.honest.warn)}`)
}

function round(value: number, digits: number): number {
  const k = 10 ** digits
  return Math.round(value * k) / k
}
