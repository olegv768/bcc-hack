// Обучение и проверка модели.
//   npm run train                          — на синтетических счетах из ml/generate.ts
//   npm run train -- --data счета.csv       — на размеченных счетах банка (формат — ml/data.ts)
//   npm run train -- --export образец.csv   — сохранить синтетические счета как образец формата
//   npm run train -- --import модель.json   — взять готовые таблицы (InterpretML, ml/challenger/export_ebm.py)
//                                             и только подобрать пороги и посчитать метрики
//
// Шаги: обучаем на 60% счетов, подбираем пороги на 20%, считаем метрики на оставшихся 20%,
// которых модель не видела. Для синтетики рядом считаем потолок — результат идеальной модели.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { FEATURE_KEYS, type RecipientFeatures } from '../service/src/features.ts'
import { NO_HISTORY, decide, scoreRecipient, type Model } from '../service/src/model.ts'
import { expectedLogit } from '../service/src/trees.ts'
import { idealScore } from './ceiling.ts'
import { readCsv, writeCsv } from './data.ts'
import { fitEbm } from './ebm.ts'
import { CAREFUL_DROPPER_MIX, DROPPER_SHARE, TRANSFER_ASSUMPTIONS, generateAccounts, generateContext, type Account } from './generate.ts'
import { createRng } from './random.ts'

const SEED = 20261112
// 2 млн счетов: 1,2 млн на обучение, по 400 тыс. на подбор порогов и итоговую проверку.
// Меньше для быстрого прогона: --accounts 200000
const accountsIndex = process.argv.indexOf('--accounts')
const ACCOUNTS = accountsIndex >= 0 ? Number(process.argv[accountsIndex + 1]) : 2_000_000
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

const ebmScore: Scorer = (features) => scoreRecipient(model, features, false).risk
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

// --- переводы: что делает сервис целиком (модель + обстоятельства перевода; только для синтетики) ---

function transferLevel(withCallSignal: boolean, withKnownRecipient = true, thresholds: Thresholds = model.thresholds) {
  const transferRng = createRng(SEED + 1)
  const scoring = { ...model, thresholds }
  const empty = () => ({ allow: 0, warn: 0, hold: 0, total: 0, amount: { allow: 0, warn: 0, hold: 0, total: 0 } })
  const counts = { fraud: empty(), honest: empty() }
  for (const account of test) {
    const group = account.is_dropper ? counts.fraud : counts.honest
    // на дроппера приходит несколько жертв, чтобы оценка по мошенническим переводам была устойчивее
    for (let i = 0; i < (account.is_dropper ? 20 : 1); i++) {
      const context = generateContext(account.is_dropper, transferRng)
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
        with_call_signal: transferLevel(true),
        without_call_signal: transferLevel(false),
        // то же, что with_call_signal, но без правила «клиент уже переводил этому получателю»
        without_known_recipient_rule: transferLevel(true, false),
        // одни и те же переводы при разной строгости порогов: на этом строится расчёт выгоды для банка
        presets: PRESETS.map((preset) => {
          const thresholds = thresholdsFor(ebmScore, preset.fpr)
          return { id: preset.id, name: preset.name, target_fpr: preset.fpr, thresholds, ...transferLevel(true, true, thresholds) }
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
  for (const [title, t] of [
    ['все сигналы', metrics.transfer_level.with_call_signal],
    ['без сигнала звонка', metrics.transfer_level.without_call_signal],
    ['без правила «уже переводил получателю»', metrics.transfer_level.without_known_recipient_rule],
  ] as const) {
    console.log(`\nПереводы, ${title}`)
    console.log(`  мошеннические: придержано ${pct(t.fraud.hold)}, предупреждение ${pct(t.fraud.warn)}, пропущено ${pct(1 - t.fraud.hold - t.fraud.warn)}`)
    console.log(`  честные:       придержано ${pct(t.honest.hold)}, предупреждение ${pct(t.honest.warn)}`)
  }
}

if (metrics.transfer_level) {
  console.log('\nСтрогость порогов (все сигналы)          мошеннические: замечено / по сумме придержано    честные: зря на 10 000')
  for (const p of metrics.transfer_level.presets) {
    const seen = p.fraud.hold + p.fraud.warn
    console.log(`  ${p.name.padEnd(12)} ${pct(seen).padStart(26)} / ${pct(p.fraud.hold_amount).padStart(22)}    ${Math.round((p.honest.hold + p.honest.warn) * 10000)}`)
  }
}
