// Оценка получателя и решение по переводу. Всё считается в этом процессе, наружу ничего не уходит.

import { readFileSync } from 'node:fs'
import { FEATURE_KEYS, type FeatureKey, type RecipientFeatures, type TransferContext } from './features.ts'

// Объяснимый бустинг (обучение — ml/ebm.ts). Оценка — сумма вкладов:
//   features — «кривая» по каждому признаку: значения признака разбиты на интервалы, у каждого свой вклад;
//   pairs — таблица по каждой паре признаков: поправка за их сочетание.
// Вклад признака в причины = его кривая + половина каждой парной поправки с его участием.
export type Model = {
  version: string
  bias: number
  features: Record<FeatureKey, { edges: number[]; scores: number[] }>
  pairs: { a: FeatureKey; b: FeatureKey; edgesA: number[]; edgesB: number[]; scores: number[][] }[]
  // пороги оценки, подобранные на проверочной выборке по доле ложных срабатываний
  thresholds: { soft: number; warn: number; hold: number }
}

export type Action = 'allow' | 'warn' | 'hold'

export type ReasonCode =
  | 'NEW_ACCOUNT'
  | 'MANY_UNRELATED_SENDERS'
  | 'FAST_OUTFLOW'
  | 'SHARED_DEVICE'
  | 'CONFIRMED_FRAUD'
  | 'REPEAT_TARGET'
  | 'ON_CALL'
  | 'REMOTE_ACCESS'
  | 'FIRST_TRANSFER'
  | 'UNUSUAL_AMOUNT'

export type Reason = { code: ReasonCode; value: number | null; contribution: number | null }

// Что сервис уже знает о счёте получателя из прошлых переводов и разборов аналитика.
export type AccountHistory = {
  confirmedFraud: boolean // аналитик закрыл алерт по этому счёту как мошенничество
  confirmedLegit: boolean // аналитик закрыл алерт как ложное срабатывание
  otherClients24h: number // сколько других клиентов за сутки получили предупреждение или приостановку на этот счёт
}

export const NO_HISTORY: AccountHistory = { confirmedFraud: false, confirmedLegit: false, otherClients24h: 0 }

const FEATURE_REASON: Record<FeatureKey, ReasonCode> = {
  account_age_days: 'NEW_ACCOUNT',
  unrelated_senders_7d: 'MANY_UNRELATED_SENDERS',
  fast_outflow_share_7d: 'FAST_OUTFLOW',
  shared_device_accounts: 'SHARED_DEVICE',
}

// Признак попадает в причины, если заметно поднял оценку (в единицах логита).
const MIN_CONTRIBUTION = 0.4
const UNUSUAL_AMOUNT_RATIO = 3
// С какого числа других клиентов за сутки счёт считается «мишенью»: совпадение трёх независимых людей маловероятно.
export const REPEAT_TARGET_CLIENTS = 3

export function loadModel(path: string | URL): Model {
  return JSON.parse(readFileSync(path, 'utf8')) as Model
}

// Номер интервала: сколько границ не больше значения.
export function binOf(edges: number[], value: number): number {
  let low = 0
  let high = edges.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (value >= edges[middle]!) low = middle + 1
    else high = middle
  }
  return low
}

export function scoreRecipient(model: Model, features: RecipientFeatures) {
  let logit = model.bias
  const contributions = Object.fromEntries(FEATURE_KEYS.map((key) => [key, 0])) as Record<FeatureKey, number>
  const known = (key: FeatureKey) => features[key] !== null && features[key] !== undefined
  // непереданный признак ничего не добавляет: это равносильно «как у среднего счёта»
  const missing = FEATURE_KEYS.filter((key) => !known(key))

  for (const key of FEATURE_KEYS) {
    if (!known(key)) continue
    const curve = model.features[key]
    const score = curve.scores[binOf(curve.edges, features[key]!)]!
    contributions[key] += score
    logit += score
  }

  for (const pair of model.pairs) {
    if (!known(pair.a) || !known(pair.b)) continue
    const score = pair.scores[binOf(pair.edgesA, features[pair.a]!)]![binOf(pair.edgesB, features[pair.b]!)]!
    contributions[pair.a] += score / 2
    contributions[pair.b] += score / 2
    logit += score
  }

  return { risk: 1 / (1 + Math.exp(-logit)), contributions, missing }
}

export function decide(model: Model, features: RecipientFeatures, context: TransferContext, history: AccountHistory = NO_HISTORY) {
  const { risk, contributions, missing } = scoreRecipient(model, features)
  const { soft, warn, hold } = model.thresholds

  // Типичная картина обмана: клиента ведут по телефону или управляют его телефоном удалённо,
  // и деньги уходят на счёт, куда он раньше не переводил.
  const remoteAccess = context.remote_access_active === true
  const underPressure = (context.sender_on_call === true || remoteAccess) && context.first_transfer_to_recipient
  const unusualAmount = (context.amount_to_typical_ratio ?? 0) >= UNUSUAL_AMOUNT_RATIO
  const repeatTarget = !history.confirmedLegit && history.otherClients24h >= REPEAT_TARGET_CLIENTS

  // Счёт, который аналитик проверил и признал честным, по признакам счёта больше не тревожит;
  // обстоятельства перевода (звонок, удалённый доступ) продолжают действовать.
  const accountRisk = history.confirmedLegit ? 0 : risk

  let action: Action = 'allow'
  if (accountRisk >= hold) action = 'hold'
  else if (accountRisk >= warn) action = underPressure ? 'hold' : 'warn'
  else if (underPressure && (accountRisk >= soft || unusualAmount || remoteAccess)) action = 'warn'

  // На счёт за сутки уже шли подозрительные переводы от нескольких клиентов — поднимаем решение на ступень.
  if (repeatTarget) action = action === 'allow' ? 'warn' : 'hold'
  // Подтверждённый мошеннический счёт: придерживаем всегда.
  if (history.confirmedFraud) action = 'hold'

  const reasons: Reason[] = []
  if (history.confirmedFraud) reasons.push({ code: 'CONFIRMED_FRAUD', value: null, contribution: null })
  if (repeatTarget) reasons.push({ code: 'REPEAT_TARGET', value: history.otherClients24h, contribution: null })

  if (!history.confirmedLegit) {
    reasons.push(
      ...FEATURE_KEYS.filter((key) => contributions[key] >= MIN_CONTRIBUTION)
        .sort((a, b) => contributions[b] - contributions[a])
        .map((key) => ({ code: FEATURE_REASON[key], value: features[key], contribution: round(contributions[key], 2) })),
    )
  }

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
