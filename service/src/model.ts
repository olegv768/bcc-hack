// Оценка получателя и решение по переводу. Всё считается в этом процессе, наружу ничего не уходит.

import { readFileSync } from 'node:fs'
import { FEATURE_KEYS, transform, type FeatureKey, type RecipientFeatures, type TransferContext } from './features.ts'

// Логистическая регрессия: у каждого признака один вес, поэтому вклад каждого признака в оценку виден напрямую.
export type Model = {
  version: string
  bias: number
  features: Record<FeatureKey, { mean: number; std: number; weight: number }>
  // пороги оценки, подобранные на проверочной выборке по доле ложных срабатываний
  thresholds: { soft: number; warn: number; hold: number }
}

export type Action = 'allow' | 'warn' | 'hold'

export type ReasonCode =
  | 'NEW_ACCOUNT'
  | 'MANY_UNRELATED_SENDERS'
  | 'FAST_OUTFLOW'
  | 'SHARED_DEVICE'
  | 'ON_CALL'
  | 'REMOTE_ACCESS'
  | 'FIRST_TRANSFER'
  | 'UNUSUAL_AMOUNT'

export type Reason = { code: ReasonCode; value: number | null; contribution: number | null }

const FEATURE_REASON: Record<FeatureKey, ReasonCode> = {
  account_age_days: 'NEW_ACCOUNT',
  unrelated_senders_7d: 'MANY_UNRELATED_SENDERS',
  fast_outflow_share_7d: 'FAST_OUTFLOW',
  shared_device_accounts: 'SHARED_DEVICE',
}

// Признак попадает в причины, если заметно поднял оценку (в единицах логита).
const MIN_CONTRIBUTION = 0.4
const UNUSUAL_AMOUNT_RATIO = 3

export function loadModel(path: string | URL): Model {
  return JSON.parse(readFileSync(path, 'utf8')) as Model
}

export function scoreRecipient(model: Model, features: RecipientFeatures) {
  let logit = model.bias
  const contributions = {} as Record<FeatureKey, number>
  const missing: FeatureKey[] = []

  for (const key of FEATURE_KEYS) {
    const value = features[key]
    if (value === null || value === undefined) {
      missing.push(key)
      contributions[key] = 0
      continue
    }
    const { mean, std, weight } = model.features[key]
    contributions[key] = (weight * (transform(key, value) - mean)) / std
    logit += contributions[key]
  }

  return { risk: 1 / (1 + Math.exp(-logit)), contributions, missing }
}

export function decide(model: Model, features: RecipientFeatures, context: TransferContext) {
  const { risk, contributions, missing } = scoreRecipient(model, features)
  const { soft, warn, hold } = model.thresholds

  // Типичная картина обмана: клиента ведут по телефону или управляют его телефоном удалённо,
  // и деньги уходят на счёт, куда он раньше не переводил.
  const remoteAccess = context.remote_access_active === true
  const underPressure = (context.sender_on_call === true || remoteAccess) && context.first_transfer_to_recipient
  const unusualAmount = (context.amount_to_typical_ratio ?? 0) >= UNUSUAL_AMOUNT_RATIO

  let action: Action = 'allow'
  if (risk >= hold) action = 'hold'
  else if (risk >= warn) action = underPressure ? 'hold' : 'warn'
  else if (underPressure && (risk >= soft || unusualAmount || remoteAccess)) action = 'warn'

  const reasons: Reason[] = FEATURE_KEYS.filter((key) => contributions[key] >= MIN_CONTRIBUTION)
    .sort((a, b) => contributions[b] - contributions[a])
    .map((key) => ({ code: FEATURE_REASON[key], value: features[key], contribution: round(contributions[key], 2) }))

  // Обстоятельства перевода показываем, только когда есть о чём предупреждать.
  if (action !== 'allow') {
    if (remoteAccess) reasons.push({ code: 'REMOTE_ACCESS', value: null, contribution: null })
    if (context.sender_on_call) reasons.push({ code: 'ON_CALL', value: null, contribution: null })
    if (context.first_transfer_to_recipient) reasons.push({ code: 'FIRST_TRANSFER', value: null, contribution: null })
    if (unusualAmount) reasons.push({ code: 'UNUSUAL_AMOUNT', value: context.amount_to_typical_ratio, contribution: null })
  }

  return { risk: round(risk, 4), action, reasons, contributions, missing }
}

export function riskLevel(model: Model, risk: number): 'low' | 'medium' | 'high' {
  if (risk >= model.thresholds.hold) return 'high'
  return risk >= model.thresholds.warn ? 'medium' : 'low'
}

function round(value: number, digits: number): number {
  const k = 10 ** digits
  return Math.round(value * k) / k
}
