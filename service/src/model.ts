// Оценка получателя и решение по переводу. Всё считается в этом процессе, наружу ничего не уходит.

import { readFileSync } from 'node:fs'
import { FEATURE_KEYS, type FeatureKey, type RecipientFeatures, type TransferContext } from './features.ts'
import { logitTrees, scoreTrees, type TreeModel } from './trees.ts'

// Сервис принимает два вида модели (поле kind в model.json):
// - trees — рабочая: LightGBM с монотонными ограничениями, вклады признаков по TreeSHAP (trees.ts);
// - таблицы (kind нет) — объяснимый бустинг ml/ebm.ts: им обучается модель на CSV банка без Python.

// Объяснимый бустинг (обучение — ml/ebm.ts). Оценка — сумма таблиц:
// по одной на каждый признак (значения разбиты на интервалы, у каждого интервала свой вклад)
// и по одной на каждое сочетание признаков — поправка за то, что они встретились вместе.
// Вклад признака в причины = его таблица + равная доля каждой поправки с его участием.
export type Term = {
  features: FeatureKey[] // один признак или сочетание
  edges: number[][] // границы интервалов по каждому признаку таблицы
  scores: number[] // вклады клеток, развёрнутые в один список
}

export type TableModel = {
  kind?: undefined
  version: string
  bias: number
  terms: Term[]
  // пороги оценки, подобранные на проверочной выборке по доле ложных срабатываний
  thresholds: { soft: number; warn: number; hold: number }
}

// Вторая ступень — оценка перевода целиком (обучение — ml/train.ts). Это логистическая регрессия:
// логарифм шансов «перевод мошеннический» = свободный член + вес · логит счёта получателя + вклады
// обстоятельств перевода. Неизвестное обстоятельство (null) ничего не добавляет: на обучении часть
// сведений намеренно скрыта, поэтому модель знает, сколько весит «да», «нет» и «неизвестно».
export const TRANSFER_INPUTS = ['call_yes', 'call_no', 'first_yes', 'first_no', 'amount_known', 'amount_log'] as const
export type TransferInput = (typeof TRANSFER_INPUTS)[number]

export type TransferModel = {
  bias: number
  weights: Record<'account' | TransferInput, number>
  // пороги оценки перевода: при них честных переводов беспокоим столько же, сколько прежние правила
  thresholds: { warn: number; hold: number }
  clean_logit: number // логит обычного честного счёта: столько весит счёт, который аналитик признал честным
}

// Без transfer решение принимают правила (так работает модель, обученная на счетах банка без переводов).
export type Model = (TableModel | TreeModel) & { transfer?: TransferModel }

// Обстоятельства перевода в числах для второй ступени.
export function transferInputs(context: TransferContext): Record<TransferInput, number> {
  // Телефоном управляют удалённо — то же давление, что и звонок; «уже переводил» тогда не в счёт:
  // перевод делает не сам клиент.
  const remote = context.remote_access_active === true
  const ratio = context.amount_to_typical_ratio
  const known = ratio !== null && ratio !== undefined
  return {
    call_yes: context.sender_on_call === true || remote ? 1 : 0,
    call_no: context.sender_on_call === false && !remote ? 1 : 0,
    first_yes: context.first_transfer_to_recipient === true ? 1 : 0,
    first_no: context.first_transfer_to_recipient === false && !remote ? 1 : 0,
    amount_known: known ? 1 : 0,
    // Сумма меньше обычной риск не снижает: иначе мошенник просил бы переводить частями.
    // Сумма в AMOUNT_RATIO_CAP раз больше обычной и выше весит одинаково: крупные разовые платежи
    // (залог за квартиру, покупка машины) бывают и у честных клиентов, а одна сумма не должна
    // приостанавливать перевод на чистый счёт.
    amount_log: known ? Math.log(Math.min(AMOUNT_RATIO_CAP, Math.max(1, ratio))) : 0,
  }
}

export const AMOUNT_RATIO_CAP = 5

// Страховка по счёту: перевод на счёт, который модель сама считает дроппером (риск выше порога
// «приостановить»), молча не уходит. Жертву могут уговорить платить одному и тому же дропперу много
// раз — тогда «уже переводил» и обычная сумма не значат, что всё в порядке.
export function accountFloor(risk: number, thresholds: { hold: number }, history: AccountHistory = NO_HISTORY) {
  return !history.confirmedLegit && risk >= thresholds.hold
}

// Страховка по обстоятельствам: новому получателю при удалённом доступе или при звонке и сумме
// втрое больше обычной — классическая картина «безопасного счёта», так бывает и со свежим счётом
// дропа, который ещё выглядит чистым. Удалённый доступ в обучающих переводах не встречается
// (о его доле нет данных), поэтому для него это единственное правило.
export function pressureFloor(context: TransferContext) {
  if (context.first_transfer_to_recipient !== true) return false
  if (context.remote_access_active === true) return true
  return context.sender_on_call === true && (context.amount_to_typical_ratio ?? 0) >= UNUSUAL_AMOUNT_RATIO
}

export function transferScore(transfer: TransferModel, accountLogit: number, context: TransferContext) {
  const inputs = transferInputs(context)
  const account = transfer.weights.account * accountLogit
  const call = transfer.weights.call_yes * inputs.call_yes + transfer.weights.call_no * inputs.call_no
  const first = transfer.weights.first_yes * inputs.first_yes + transfer.weights.first_no * inputs.first_no
  const amount = transfer.weights.amount_known * inputs.amount_known + transfer.weights.amount_log * inputs.amount_log
  return { score: transfer.bias + account + call + first + amount, parts: { account, call, first, amount } }
}

export type Action = 'allow' | 'warn' | 'hold'

export type ReasonCode =
  | 'NEW_ACCOUNT'
  | 'MANY_UNRELATED_SENDERS'
  | 'FAST_OUTFLOW'
  | 'SHARED_DEVICE'
  | 'IDLE_THEN_ACTIVE'
  | 'NEW_DEVICE'
  | 'LINKED_SENDERS'
  | 'CONFIRMED_FRAUD'
  | 'REPEAT_TARGET'
  | 'ON_CALL'
  | 'REMOTE_ACCESS'
  | 'FIRST_TRANSFER'
  | 'UNUSUAL_AMOUNT'
  | 'TRIANGLE'

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
  idle_days_before_inflow: 'IDLE_THEN_ACTIVE',
  new_device_7d: 'NEW_DEVICE',
  flagged_linked_senders_7d: 'LINKED_SENDERS',
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

// Какие признаки модель вообще использует: модель могли обучить без дополнительных сигналов.
const usedCache = new WeakMap<Model, FeatureKey[]>()
export function modelFeatures(model: Model): FeatureKey[] {
  if (!usedCache.has(model)) {
    const used = new Set<FeatureKey>(model.kind === 'trees' ? model.features : model.terms.flatMap((term) => term.features))
    usedCache.set(model, FEATURE_KEYS.filter((key) => used.has(key)))
  }
  return usedCache.get(model)!
}

// explain = false — только оценка, без вкладов признаков: так быстрее при обучении и проверке
export function scoreRecipient(model: Model, features: RecipientFeatures, explain = true) {
  const known = (key: FeatureKey) => features[key] !== null && features[key] !== undefined
  // непереданный признак ничего не добавляет: это равносильно «как у среднего счёта»
  const missing = modelFeatures(model).filter((key) => !known(key))
  const zeros = () => Object.fromEntries(FEATURE_KEYS.map((key) => [key, 0])) as Record<FeatureKey, number>

  if (model.kind === 'trees') {
    const { logit, contributions } = explain ? scoreTrees(model, features) : { logit: logitTrees(model, features), contributions: zeros() }
    // у признаков, которых нет в модели, вклад ноль
    return { risk: 1 / (1 + Math.exp(-logit)), logit, contributions: { ...zeros(), ...contributions }, missing }
  }

  let logit = model.bias
  const contributions = zeros()
  for (const term of model.terms) {
    if (!term.features.every(known)) continue
    let cell = 0
    term.features.forEach((key, f) => {
      cell = cell * (term.edges[f]!.length + 1) + binOf(term.edges[f]!, features[key]!)
    })
    const score = term.scores[cell]!
    for (const key of term.features) contributions[key] += score / term.features.length
    logit += score
  }

  return { risk: 1 / (1 + Math.exp(-logit)), logit, contributions, missing }
}

export function decide(model: Model, features: RecipientFeatures, context: TransferContext, history: AccountHistory = NO_HISTORY, explain = true) {
  const { risk, logit, contributions, missing } = scoreRecipient(model, features, explain)
  const { soft, warn, hold } = model.thresholds

  // Типичная картина обмана: клиента ведут по телефону или управляют его телефоном удалённо,
  // и деньги уходят на счёт, куда он раньше не переводил.
  const remoteAccess = context.remote_access_active === true
  const newRecipient = context.first_transfer_to_recipient === true
  const underPressure = (context.sender_on_call === true || remoteAccess) && newRecipient
  const unusualAmount = (context.amount_to_typical_ratio ?? 0) >= UNUSUAL_AMOUNT_RATIO
  const repeatTarget = !history.confirmedLegit && history.otherClients24h >= REPEAT_TARGET_CLIENTS

  let action: Action = 'allow'
  let transfer: ReturnType<typeof transferScore> | null = null
  if (model.transfer) {
    // Вторая ступень: счёт, звонок, новый ли получатель и сумма складываются в одну оценку перевода.
    // Счёт, который аналитик признал честным, весит как обычный честный счёт.
    const t = model.transfer
    transfer = transferScore(t, history.confirmedLegit ? Math.min(logit, t.clean_logit) : logit, context)
    if (transfer.score >= t.thresholds.hold) action = 'hold'
    else if (transfer.score >= t.thresholds.warn) action = 'warn'
    // Страховки — как минимум предупреждение, что бы ни сказала оценка перевода:
    if (action === 'allow' && (accountFloor(risk, model.thresholds, history) || pressureFloor(context))) action = 'warn'
  } else {
    // Счёт, который аналитик проверил и признал честным, по признакам счёта больше не тревожит;
    // обстоятельства перевода (звонок, удалённый доступ) продолжают действовать.
    const accountRisk = history.confirmedLegit ? 0 : risk
    if (accountRisk >= hold) action = 'hold'
    else if (accountRisk >= warn) action = underPressure ? 'hold' : 'warn'
    else if (underPressure && (accountRisk >= soft || unusualAmount || remoteAccess)) action = 'warn'

    // Клиент уже переводил этому получателю, значит, счёт ему не продиктовали по телефону только что.
    // Решение по признакам счёта смягчаем на ступень: так реже беспокоим людей, которые платят знакомым.
    const knownRecipient = context.first_transfer_to_recipient === false && !remoteAccess
    if (knownRecipient) action = action === 'hold' ? 'warn' : 'allow'
  }

  // На счёт за сутки уже шли подозрительные переводы от нескольких клиентов — поднимаем решение на ступень.
  if (repeatTarget) action = action === 'allow' ? 'warn' : 'hold'
  // Подтверждённый мошеннический счёт: приостанавливаем всегда.
  if (history.confirmedFraud) action = 'hold'

  // «Треугольник»: клиент платит за товар или услугу, а получатель — продавец криптовалюты на P2P.
  // Так мошенник расплачивается деньгами покупателя за чужую криптовалюту. Счёт получателя при этом
  // обычно честный и оценку не поднимает, поэтому правило отдельное: предупредить, а не приостановить.
  const triangle = isTriangle(context)
  if (triangle && action === 'allow') action = 'warn'

  const reasons: Reason[] = []
  if (history.confirmedFraud) reasons.push({ code: 'CONFIRMED_FRAUD', value: null, contribution: null })
  if (triangle) reasons.push({ code: 'TRIANGLE', value: null, contribution: null })
  if (repeatTarget) reasons.push({ code: 'REPEAT_TARGET', value: history.otherClients24h, contribution: null })

  // Признаки счёта называем причинами, только когда сам счёт заметно рискованный (выше нижнего
  // порога): у обычного счёта признак может быть чуть выше среднего, но причиной тревоги он не служит.
  if (!history.confirmedLegit && risk >= soft) {
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
    if (newRecipient) reasons.push({ code: 'FIRST_TRANSFER', value: null, contribution: null })
    if (unusualAmount) reasons.push({ code: 'UNUSUAL_AMOUNT', value: context.amount_to_typical_ratio, contribution: null })
  }

  return {
    risk: round(risk, 4),
    action,
    reasons,
    contributions,
    missing,
    triangle,
    // оценка перевода и из чего она сложилась (есть, когда в модели есть вторая ступень)
    transfer: transfer && { score: round(transfer.score, 2), parts: mapValues(transfer.parts, (v) => round(v, 2)) },
  }
}

// Оплата товара или услуги новому получателю, который продаёт криптовалюту на P2P.
export function isTriangle(context: Pick<TransferContext, 'payment_purpose' | 'recipient_p2p_trader' | 'first_transfer_to_recipient'>) {
  return (
    context.recipient_p2p_trader === true &&
    (context.payment_purpose === 'goods' || context.payment_purpose === 'services') &&
    context.first_transfer_to_recipient !== false
  )
}

export function riskLevel(model: Model, risk: number): 'low' | 'medium' | 'high' {
  if (risk >= model.thresholds.hold) return 'high'
  return risk >= model.thresholds.warn ? 'medium' : 'low'
}

function round(value: number, digits: number): number {
  const k = 10 ** digits
  return Math.round(value * k) / k
}

function mapValues<K extends string>(object: Record<K, number>, f: (v: number) => number): Record<K, number> {
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, f(v as number)])) as Record<K, number>
}
