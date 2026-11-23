// Обучение и проверка модели.
//   npm run train                                — рабочая модель: деревья LightGBM (ml/challenger/export_lgbm.py)
//                                                  на синтетических счетах из ml/generate.ts
//   npm run train:tables                         — наш объяснимый бустинг на TypeScript, без Python
//   npm run train:tables -- --data счета.csv     — он же на размеченных счетах банка (формат — ml/data.ts)
//   npm run train:tables -- --export образец.csv — сохранить синтетические счета как образец формата
//
// Шаги: модель счёта учится на 60% счетов, пороги подбираются на 20%, метрики считаются на
// оставшихся 20%, которых модель не видела. Для синтетики рядом считаем потолок — результат
// идеальной модели — и учим вторую ступень, оценку перевода целиком, на переводах к счетам из тех же 20%,
// на которых подбирались пороги.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { FEATURE_KEYS, type RecipientFeatures, type TransferContext } from '../service/src/features.ts'
import { NO_HISTORY, TRANSFER_INPUTS, accountFloor, decide, pressureFloor, scoreRecipient, transferInputs, transferScore, type Model, type TransferModel } from '../service/src/model.ts'
import { expectedLogit } from '../service/src/trees.ts'
import { idealScore } from './ceiling.ts'
import { readCsv, writeCsv } from './data.ts'
import { fitEbm } from './ebm.ts'
import { CAREFUL_DROPPER_MIX, DROPPER_SHARE, TRANSFER_ASSUMPTIONS, generateAccounts, generateContext, type Account } from './generate.ts'
import { fitLogistic } from './logistic.ts'
import { createRng } from './random.ts'

const SEED = 20261112
// 10 млн счетов: 6 млн на обучение, по 2 млн на подбор порогов и итоговую проверку.
// Нужно около 8 ГБ памяти и 20–30 минут (npm run train сам разрешает Node столько памяти).
// Меньше для быстрого прогона: --accounts 200000
const accountsIndex = process.argv.indexOf('--accounts')
const ACCOUNTS = accountsIndex >= 0 ? Number(process.argv[accountsIndex + 1]) : 10_000_000
const STRESS_ACCOUNTS = Math.round(ACCOUNTS / 10)
// Допустимая доля честных счетов выше каждого порога (на проверочной выборке).
const TARGET_FPR = { soft: 0.1, warn: 0.02, hold: 0.003 }
const BOOTSTRAP_RUNS = 300

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const dataFile = argument('--data')
const exportFile = argument('--export')
const importFile = argument('--import')

// --- данные ---

const rng = createRng(SEED)
let accounts: Account[]
if (dataFile) {
  accounts = readCsv(dataFile)
  // перемешиваем: в файле банка счета могут идти по дате или по типу
  for (let i = accounts.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[accounts[i], accounts[j]] = [accounts[j]!, accounts[i]!]
  }
} else {
  accounts = generateAccounts(ACCOUNTS, rng)
}
if (exportFile) {
  writeCsv(exportFile, accounts)
  console.log(`Сохранено счетов: ${accounts.length} → ${exportFile}`)
  process.exit(0)
}

const dropperShare = accounts.filter((a) => a.is_dropper).length / accounts.length
const train = accounts.slice(0, Math.floor(accounts.length * 0.6))
const validation = accounts.slice(train.length, Math.floor(accounts.length * 0.8))
const test = accounts.slice(train.length + validation.length)

// --- обучение ---

const labels = train.map((a) => (a.is_dropper ? 1 : 0))
const positives = labels.reduce((s: number, y) => s + y, 0)
// Дропперов мало, поэтому их примеры весят больше: оба класса влияют на обучение одинаково.
const weights = labels.map((y) => (y ? train.length / (2 * positives) : train.length / (2 * (train.length - positives))))

// Готовая модель из Python (LightGBM — ml/challenger/export_lgbm.py, InterpretML — export_ebm.py):
// сначала убеждаемся, что наш код считает по ней ровно то же, что сама библиотека, — и оценку,
// и вклад каждого признака. Иначе в сервисе окажется не та модель, которую проверяли.
type Check = { features: RecipientFeatures; logit: number; contributions?: Record<string, number>; expected?: number }
function importModel(file: string): Model {
  const source = JSON.parse(readFileSync(file, 'utf8')) as Model & { check?: Check[] }
  const { check, ...rest } = source
  const imported = { ...rest, thresholds: { soft: 0, warn: 0, hold: 0 } } as Model
  delete (imported as { source?: unknown }).source
  delete (imported as { robustness?: unknown }).robustness
  if (!check?.length) throw new Error(`В ${file} нет контрольных счетов (check) — модель не проверить`)
  let worstLogit = 0
  let worstContribution = 0
  for (const c of check) {
    const scored = scoreRecipient(imported, c.features)
    worstLogit = Math.max(worstLogit, Math.abs(scored.logit - c.logit))
    // сумма вкладов TreeSHAP + средняя оценка = оценка счёта, и каждый вклад — как у библиотеки
    if (c.contributions) for (const key of FEATURE_KEYS) worstContribution = Math.max(worstContribution, Math.abs(scored.contributions[key] - c.contributions[key]!))
  }
  if (imported.kind === 'trees' && check[0]!.expected !== undefined) {
    worstContribution = Math.max(worstContribution, Math.abs(expectedLogit(imported) - check[0]!.expected))
  }
  // таблицы InterpretML округлены до 6 знаков, отсюда допуск
  if (worstLogit > 1e-4 || worstContribution > 1e-4) {
    throw new Error(`Сервис расходится с библиотекой: оценка до ${worstLogit}, вклады признаков до ${worstContribution}`)
  }
  console.log(
    `Импорт ${file}: ${check.length} контрольных счетов совпали с библиотекой — оценка до ${worstLogit.toExponential(1)}` +
      (imported.kind === 'trees' ? `, вклады признаков (SHAP) до ${worstContribution.toExponential(1)}` : ''),
  )
  return imported
}

let model: Model
if (importFile) model = importModel(importFile)
else {
  const fit = fitEbm(train.map((a) => FEATURE_KEYS.map((key) => a.features[key])), labels, weights)
  model = {
    version: `ebm-${dataFile ? 'bank' : 'synthetic'}-${SEED}`,
    bias: fit.bias,
    terms: fit.terms.map((term) => ({ ...term, features: term.features.map((j) => FEATURE_KEYS[j]!) })),
    thresholds: { soft: 0, warn: 0, hold: 0 },
  }
}

// --- пороги и метрики ---

type Scorer = (features: RecipientFeatures) => number
type Thresholds = Model['thresholds']
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits

function thresholdsFor(score: Scorer, fpr: Thresholds = TARGET_FPR): Thresholds {
  const honest = validation.filter((a) => !a.is_dropper).map((a) => score(a.features)).sort((a, b) => b - a)
  const at = (share: number) => round(honest[Math.floor(honest.length * share)]!, 4)
  return { soft: at(fpr.soft), warn: at(fpr.warn), hold: at(fpr.hold) }
}

// Три варианта строгости. Банк выбирает свой после пилота; здесь — чтобы было видно, чем он платит за выбор.
const PRESETS: { id: string; name: string; fpr: Thresholds }[] = [
  { id: 'soft', name: 'Мягче', fpr: { soft: 0.05, warn: 0.01, hold: 0.001 } },
  { id: 'base', name: 'Как сейчас', fpr: TARGET_FPR },
  { id: 'strict', name: 'Строже', fpr: { soft: 0.2, warn: 0.05, hold: 0.01 } },
]

const share = (risks: number[], threshold: number) => (risks.length ? risks.filter((r) => r >= threshold).length / risks.length : 0)

// площадь под ROC: вероятность, что случайный дроппер получит оценку выше случайного честного счёта
function auc(droppers: number[], honest: number[]): number {
  const ranked = [...droppers.map((risk) => ({ risk, positive: true })), ...honest.map((risk) => ({ risk, positive: false }))].sort((a, b) => a.risk - b.risk)
  let rankSum = 0
  ranked.forEach((item, i) => {
    if (item.positive) rankSum += i + 1
  })
  return (rankSum - (droppers.length * (droppers.length + 1)) / 2) / (droppers.length * honest.length)
}

// Разброс метрики: много раз набираем выборку заново из тех же счетов и смотрим, как гуляет результат.
function interval(risks: number[], threshold: number, bootstrapRng: () => number): [number, number] {
  const results: number[] = []
  for (let run = 0; run < BOOTSTRAP_RUNS; run++) {
    let above = 0
    for (let i = 0; i < risks.length; i++) if (risks[Math.floor(bootstrapRng() * risks.length)]! >= threshold) above++
    results.push(above / risks.length)
  }
  results.sort((a, b) => a - b)
  return [results[Math.floor(BOOTSTRAP_RUNS * 0.025)]!, results[Math.floor(BOOTSTRAP_RUNS * 0.975)]!]
}

function evaluate(score: Scorer, thresholds: Thresholds, items: Account[], withIntervals = false) {
  const droppers = items.filter((a) => a.is_dropper).map((a) => score(a.features))
  const honest = items.filter((a) => !a.is_dropper).map((a) => score(a.features))
  const bootstrapRng = createRng(SEED + 7)
  return {
    auc: auc(droppers, honest),
    account_level: (['warn', 'hold'] as const).map((name) => {
      const found = share(droppers, thresholds[name])
      const falseAlarms = share(honest, thresholds[name])
      // сколько помеченных счетов действительно дропперы — при доле дропперов как в данных
      const precision = (found * dropperShare) / (found * dropperShare + falseAlarms * (1 - dropperShare) || 1)
      return {
        threshold: name,
        value: thresholds[name],
        droppers_found: found,
        honest_flagged: falseAlarms,
        precision,
        ...(withIntervals && {
          droppers_found_interval: interval(droppers, thresholds[name], bootstrapRng),
          honest_flagged_interval: interval(honest, thresholds[name], bootstrapRng),
        }),
      }
    }),
  }
}

// Оценку счёта считаем один раз: те же счета проходят через пороги, переводы и варианты строгости.
const logitCache = new WeakMap<RecipientFeatures, number>()
const accountLogit = (features: RecipientFeatures) => {
  let value = logitCache.get(features)
  if (value === undefined) {
    value = scoreRecipient(model, features, false).logit
    logitCache.set(features, value)
  }
  return value
}
const ebmScore: Scorer = (features) => 1 / (1 + Math.exp(-accountLogit(features)))
model.thresholds = thresholdsFor(ebmScore)

const result = evaluate(ebmScore, model.thresholds, test, true)
// потолок: модель, которая знает формулы генератора (есть только для синтетики)
const idealThresholds = dataFile ? null : thresholdsFor(idealScore)
const ceiling = idealThresholds && evaluate(idealScore, idealThresholds, test)

const scored = test.map((a) => ({ ...a, risk: ebmScore(a.features) }))
const droppers = scored.filter((a) => a.is_dropper)
const honest = scored.filter((a) => !a.is_dropper)

const byKind = [...new Set(scored.map((a) => a.kind))].map((kind) => {
  const items = scored.filter((a) => a.kind === kind)
  const risks = items.map((a) => a.risk)
  return { kind, is_dropper: items[0]!.is_dropper, count: items.length, above_warn: share(risks, model.thresholds.warn), above_hold: share(risks, model.thresholds.hold) }
})

const roc = Array.from({ length: 201 }, (_, i) => {
  const threshold = i / 200
  return { threshold, droppers_found: share(droppers.map((a) => a.risk), threshold), honest_flagged: share(honest.map((a) => a.risk), threshold) }
})

// --- проверка на прочность: дропперы стали осторожнее, чем в обучении (только для синтетики) ---
// Пороги не меняем: так видно, что будет, если мошенники сменят поведение, а модель ещё не переобучили.

const shifted = dataFile ? null : generateAccounts(STRESS_ACCOUNTS, createRng(SEED + 2), CAREFUL_DROPPER_MIX)
const stress = shifted && {
  dropper_mix: Object.fromEntries(CAREFUL_DROPPER_MIX),
  droppers: shifted.filter((a) => a.is_dropper).length,
  model: evaluate(ebmScore, model.thresholds, shifted),
  // идеальная модель тоже «не знает» о смене тактики: формулы и пороги у неё от прежних данных
  ceiling: evaluate(idealScore, idealThresholds!, shifted),
}

// --- вторая ступень: оценка перевода целиком (только для синтетики: нужны размеченные переводы) ---
// Учится на переводах к счетам validation — первая ступень их не видела; test не трогаем.
// Вместо ручных правил («звонок и новый получатель», «сумма втрое больше обычной») логистическая
// регрессия сама взвешивает риск счёта и обстоятельства перевода. Пороги подбираем так, чтобы честных
// переводов она беспокоила столько же, сколько правила: тогда видно, сколько мошеннических переводов
// она ловит сверх них при той же нагрузке на клиентов.

// на дроппера приходит несколько жертв, чтобы оценка по мошенническим переводам была устойчивее
const PER_DROPPER = 20
// доля переводов, где каждое сведение скрыто на обучении: так модель знает, сколько весит «неизвестно»
const HIDE_SHARE = 0.2

// Правила и вторая ступень принимают решение по уже посчитанному логиту счёта: модель-«константа»
// с таблицами без клеток даёт ровно этот логит, а сотни деревьев не пересчитываются на каждый перевод.
const constantModel = (logit: number, thresholds: Thresholds, transfer?: TransferModel): Model => ({ version: model.version, bias: logit, terms: [], thresholds, ...(transfer && { transfer }) })

function fitTransferModel(): TransferModel {
  const transferRng = createRng(SEED + 11)
  const rows: number[] = []
  const labels: number[] = []
  for (const account of validation) {
    const logit = accountLogit(account.features)
    for (let i = 0; i < (account.is_dropper ? PER_DROPPER : 1); i++) {
      const context = generateContext(account.is_dropper, transferRng)
      if (transferRng() < HIDE_SHARE) context.sender_on_call = null
      if (transferRng() < HIDE_SHARE) context.first_transfer_to_recipient = null
      if (transferRng() < HIDE_SHARE) context.amount_to_typical_ratio = null
      const inputs = transferInputs(context)
      rows.push(logit, ...TRANSFER_INPUTS.map((key) => inputs[key]))
      labels.push(account.is_dropper ? 1 : 0)
    }
  }
  const w = fitLogistic(Float64Array.from(rows), Uint8Array.from(labels), TRANSFER_INPUTS.length + 1)
  const weights = Object.fromEntries([['account', w[1]!], ...TRANSFER_INPUTS.map((key, j) => [key, w[j + 2]!])]) as TransferModel['weights']
  // здравый смысл: рискованный счёт, звонок, новый получатель и крупная сумма не могут снижать оценку,
  // а «неизвестно» лежит между «да» и «нет»
  const sane = weights.account > 0 && weights.call_yes > 0 && weights.call_no < 0 && weights.first_yes > 0 && weights.first_no < 0 && weights.amount_log >= 0
  if (!sane) {
    throw new Error(`Вторая ступень выучила странные веса: ${JSON.stringify(weights)}`)
  }
  const honestLogits = validation.filter((a) => !a.is_dropper).map((a) => accountLogit(a.features)).sort((a, b) => a - b)
  return { bias: w[0]!, weights, thresholds: { warn: 0, hold: 0 }, clean_logit: honestLogits[Math.floor(honestLogits.length / 2)]! }
}

// Честные переводы validation — всегда одни и те же (одно зерно), на них сравниваем нагрузку.
// adjust — каких сведений банк не сообщает.
function honestValidationTransfers(visit: (logit: number, account: Account, context: TransferContext) => void, adjust?: (context: TransferContext) => void) {
  const transferRng = createRng(SEED + 12)
  for (const account of validation) {
    const logit = accountLogit(account.features)
    for (let i = 0; i < (account.is_dropper ? PER_DROPPER : 1); i++) {
      const context = generateContext(account.is_dropper, transferRng)
      if (account.is_dropper) continue
      adjust?.(context)
      visit(logit, account, context)
    }
  }
}

type Load = { hold: number; seen: number }

// Сколько честных переводов validation беспокоят правила при данных порогах счёта.
function rulesLoad(thresholds: Thresholds): Load {
  let held = 0
  let seen = 0
  let total = 0
  honestValidationTransfers((logit, account, context) => {
    const action = decide(constantModel(logit, thresholds), account.features, context, NO_HISTORY, false).action
    if (action === 'hold') held++
    if (action !== 'allow') seen++
    total++
  })
  return { hold: held / total, seen: seen / total }
}

// Пороги второй ступени, при которых честных переводов validation беспокоим столько же (load).
// Перевод, который попадает под страховку (decide: accountFloor, pressureFloor), предупреждение
// получает всегда, поэтому для порога «предупредить» он считается замеченным при любой оценке.
function matchLoad(transfer: TransferModel, load: Load, adjust?: (context: TransferContext) => void, thresholds: Thresholds = model.thresholds): TransferModel['thresholds'] {
  const holdScores: number[] = []
  const seenScores: number[] = []
  honestValidationTransfers((logit, _account, context) => {
    const score = transferScore(transfer, logit, context).score
    holdScores.push(score)
    const floored = accountFloor(1 / (1 + Math.exp(-logit)), thresholds) || pressureFloor(context)
    seenScores.push(floored ? Infinity : score)
  }, adjust)
  holdScores.sort((a, b) => b - a)
  seenScores.sort((a, b) => b - a)
  const at = (scores: number[], share: number) => round(scores[Math.round(scores.length * share)]!, 4)
  return { warn: at(seenScores, load.seen), hold: at(holdScores, load.hold) }
}

const noCallSignal = (context: TransferContext) => {
  context.sender_on_call = null
}
const noKnownRecipient = (context: TransferContext) => {
  if (context.first_transfer_to_recipient === false) context.first_transfer_to_recipient = null
}

const transferModel = dataFile ? null : fitTransferModel()
const baseLoad = transferModel && rulesLoad(model.thresholds)
if (transferModel && baseLoad) {
  transferModel.thresholds = matchLoad(transferModel, baseLoad)
  model.transfer = transferModel
}
// Без одного из сведений вторую ступень настраивают заново на ту же нагрузку: так видно, сколько
// мошеннических переводов это сведение помогает поймать при том же беспокойстве честных клиентов.
const retuned = (adjust: (context: TransferContext) => void) => transferModel && { ...transferModel, thresholds: matchLoad(transferModel, baseLoad!, adjust) }

// --- переводы: что делает сервис целиком (модель + обстоятельства перевода; только для синтетики) ---

// transfer = null — решение по правилам, как без второй ступени
// Мошенники подстроились, а модель и пороги прежние: обстоятельства мошеннического перевода
// частично выглядят как у честного.
type Adapt = (context: TransferContext, rng: () => number) => void
const ADAPT: Record<'amount' | 'call', Adapt> = {
  // просят перевести обычную для клиента сумму
  amount: (context, rng) => {
    const honest = generateContext(false, rng)
    context.amount = honest.amount
    context.amount_to_typical_ratio = honest.amount_to_typical_ratio
  },
  // перестали звонить (переписка, заранее подготовленный клиент): на звонке так же редко, как честные
  call: (context, rng) => {
    context.sender_on_call = rng() < TRANSFER_ASSUMPTIONS.honest.on_call
  },
}

function transferLevel(withCallSignal: boolean, withKnownRecipient = true, thresholds: Thresholds = model.thresholds, transfer: TransferModel | null = model.transfer ?? null, adapt?: Adapt) {
  const transferRng = createRng(SEED + 1)
  const empty = () => ({ allow: 0, warn: 0, hold: 0, total: 0, amount: { allow: 0, warn: 0, hold: 0, total: 0 } })
  const counts = { fraud: empty(), honest: empty() }
  for (const account of test) {
    const group = account.is_dropper ? counts.fraud : counts.honest
    const scoring = constantModel(accountLogit(account.features), thresholds, transfer ?? undefined)
    for (let i = 0; i < (account.is_dropper ? PER_DROPPER : 1); i++) {
      const context: TransferContext = generateContext(account.is_dropper, transferRng)
      if (adapt && account.is_dropper) adapt(context, transferRng)
      if (!withCallSignal) context.sender_on_call = null
      // банк не сообщает, что клиент уже переводил получателю: правило смягчения не действует
      if (!withKnownRecipient && context.first_transfer_to_recipient === false) context.first_transfer_to_recipient = null
      const action = decide(scoring, account.features, context, NO_HISTORY, false).action
      group[action]++
      group.total++
      group.amount[action] += context.amount
      group.amount.total += context.amount
    }
  }
  const rates = (g: typeof counts.fraud) => ({
    warn: g.warn / g.total,
    hold: g.hold / g.total,
    total: g.total,
    // доли суммы: крупные мошеннические переводы ловятся чаще, поэтому по сумме доля выше, чем по штукам
    warn_amount: g.amount.warn / g.amount.total,
    hold_amount: g.amount.hold / g.amount.total,
    average_amount: Math.round(g.amount.total / g.total),
  })
  return { fraud: rates(counts.fraud), honest: rates(counts.honest) }
}

const metrics = {
  model_version: model.version,
  data: {
    source: dataFile ? 'bank' : 'synthetic',
    seed: SEED,
    accounts: accounts.length,
    dropper_share: dropperShare,
    test_accounts: test.length,
    test_droppers: droppers.length,
    test_honest: honest.length,
  },
  auc: result.auc,
  thresholds: model.thresholds,
  account_level: result.account_level,
  ceiling: ceiling && { name: 'Идеальная модель', auc: ceiling.auc, account_level: ceiling.account_level },
  by_kind: byKind,
  stress,
  transfer_level: dataFile
    ? null
    : {
        assumptions: TRANSFER_ASSUMPTIONS,
        // вторая ступень: веса, пороги и сколько честных переводов беспокоили правила на validation
        transfer_model: transferModel && { ...transferModel, matched_honest_load: baseLoad! },
        with_call_signal: transferLevel(true),
        // без сведения пороги второй ступени настроены заново на ту же нагрузку на честных клиентов
        without_call_signal: transferLevel(false, true, model.thresholds, retuned(noCallSignal)),
        // то же, что with_call_signal, но банк не сообщает, переводил ли клиент этому получателю раньше
        without_known_recipient_rule: transferLevel(true, false, model.thresholds, retuned(noKnownRecipient)),
        // мошенники подстроились, модель и пороги прежние
        adapted: {
          usual_amount: transferLevel(true, true, model.thresholds, model.transfer ?? null, ADAPT.amount),
          no_call: transferLevel(true, true, model.thresholds, model.transfer ?? null, ADAPT.call),
        },
        // для сравнения — прежние ручные правила на тех же переводах
        rules: {
          with_call_signal: transferLevel(true, true, model.thresholds, null),
          without_call_signal: transferLevel(false, true, model.thresholds, null),
          without_known_recipient_rule: transferLevel(true, false, model.thresholds, null),
          adapted: {
            usual_amount: transferLevel(true, true, model.thresholds, null, ADAPT.amount),
            no_call: transferLevel(true, true, model.thresholds, null, ADAPT.call),
          },
        },
        // одни и те же переводы при разной строгости порогов: на этом строится расчёт выгоды для банка
        presets: PRESETS.map((preset) => {
          const thresholds = thresholdsFor(ebmScore, preset.fpr)
          const transfer = { ...transferModel!, thresholds: matchLoad(transferModel!, rulesLoad(thresholds), undefined, thresholds) }
          return {
            id: preset.id,
            name: preset.name,
            target_fpr: preset.fpr,
            thresholds,
            transfer_thresholds: transfer.thresholds,
            ...transferLevel(true, true, thresholds, transfer),
            rules: transferLevel(true, true, thresholds, null),
          }
        }),
      },
  roc,
}

mkdirSync(new URL('../service/model/', import.meta.url), { recursive: true })
writeFileSync(new URL('../service/model/model.json', import.meta.url), JSON.stringify(model) + '\n')
writeFileSync(new URL('./metrics.json', import.meta.url), JSON.stringify(metrics, null, 2) + '\n')

// --- отчёт в консоль ---

const pct = (v: number) => (v * 100).toFixed(1) + '%'
console.log(`Данные: ${dataFile ?? 'синтетические'}, счетов ${accounts.length}, дропперов ${pct(dropperShare)}`)
console.log(`Пороги новой модели:`, model.thresholds)
console.log(`\nОтложенная выборка: ${droppers.length} дропперов, ${honest.length} честных`)
console.log(`                         AUC    warn: найдено / ложных    hold: найдено / ложных`)
for (const [name, r] of [[`модель ${model.kind === 'trees' ? '(деревья)' : '(таблицы)'}`, result], ...(ceiling ? [['потолок (идеал)', ceiling] as const] : [])] as const) {
  const [w, h] = r.account_level
  console.log(`  ${name.padEnd(21)} ${r.auc.toFixed(3)}   ${pct(w!.droppers_found).padStart(6)} / ${pct(w!.honest_flagged).padStart(5)}        ${pct(h!.droppers_found).padStart(6)} / ${pct(h!.honest_flagged).padStart(5)}`)
}
for (const m of result.account_level) {
  const [low, high] = m.droppers_found_interval!
  console.log(`  ${m.threshold}: найдено ${pct(m.droppers_found)}, с учётом разброса от ${pct(low)} до ${pct(high)}; точность ${pct(m.precision)}`)
}
console.log('\nПо типам счетов (доля выше порога warn / hold)')
for (const k of byKind) console.log(`  ${k.kind.padEnd(15)} ${String(k.count).padStart(6)}  ${pct(k.above_warn).padStart(6)} / ${pct(k.above_hold).padStart(6)}`)
if (stress) {
  console.log(`\nДропперы стали осторожнее (${stress.droppers} дропперов, пороги прежние)`)
  for (const [name, r] of [[`модель ${model.kind === 'trees' ? '(деревья)' : '(таблицы)'}`, stress.model], ['потолок (идеал)', stress.ceiling]] as const) {
    const [w, h] = r.account_level
    console.log(`  ${name.padEnd(21)} ${r.auc.toFixed(3)}   ${pct(w!.droppers_found).padStart(6)} / ${pct(w!.honest_flagged).padStart(5)}        ${pct(h!.droppers_found).padStart(6)} / ${pct(h!.honest_flagged).padStart(5)}`)
  }
}
if (metrics.transfer_level) {
  const tm = metrics.transfer_level.transfer_model!
  console.log(`\nВторая ступень (оценка перевода): свободный ${tm.bias.toFixed(3)}, веса ${JSON.stringify(Object.fromEntries(Object.entries(tm.weights).map(([k, v]) => [k, round(v, 3)])))}`)
  console.log(`  пороги ${JSON.stringify(tm.thresholds)}, нагрузка на честных как у правил: приостановлено ${pct(tm.matched_honest_load.hold)}, замечено ${pct(tm.matched_honest_load.seen)}`)
  for (const [title, t, r] of [
    ['все сигналы', metrics.transfer_level.with_call_signal, metrics.transfer_level.rules.with_call_signal],
    ['без сигнала звонка', metrics.transfer_level.without_call_signal, metrics.transfer_level.rules.without_call_signal],
    ['без сведений «уже переводил получателю»', metrics.transfer_level.without_known_recipient_rule, metrics.transfer_level.rules.without_known_recipient_rule],
    ['мошенники просят обычную сумму (пороги прежние)', metrics.transfer_level.adapted.usual_amount, metrics.transfer_level.rules.adapted.usual_amount],
    ['мошенники перестали звонить (пороги прежние)', metrics.transfer_level.adapted.no_call, metrics.transfer_level.rules.adapted.no_call],
  ] as const) {
    console.log(`\nПереводы, ${title}`)
    for (const [name, x] of [['вторая ступень', t], ['правила', r]] as const) {
      console.log(`  ${name.padEnd(15)} мошеннические: приостановлено ${pct(x.fraud.hold)}, предупреждение ${pct(x.fraud.warn)}, пропущено ${pct(1 - x.fraud.hold - x.fraud.warn)}; честные: приостановлено ${pct(x.honest.hold)}, предупреждение ${pct(x.honest.warn)}`)
    }
  }
}

if (metrics.transfer_level) {
  console.log('\nСтрогость порогов (все сигналы)          мошеннические: замечено / по сумме приостановлено    честные: зря на 10 000')
  for (const p of metrics.transfer_level.presets) {
    for (const [name, x] of [[p.name, p], ['  правила', p.rules]] as const) {
      const seen = x.fraud.hold + x.fraud.warn
      console.log(`  ${name.padEnd(12)} ${pct(seen).padStart(26)} / ${pct(x.fraud.hold_amount).padStart(22)}    ${Math.round((x.honest.hold + x.honest.warn) * 10000)}`)
    }
  }
}
