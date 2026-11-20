// Выгрузка данных для сравнения моделей-претендентов (ml/challenger/benchmark.py).
//   npm run export-bench                       — оценки модели сервиса (service/model/model.json)
//   npm run export-bench -- --model файл.json  — оценки другой модели в формате сервиса
// Те же счета и то же деление на обучение / проверку / отложенную выборку, что в ml/train.ts.
// Кроме них:
//   stress     — дропперы сменили тактику (как в ml/train.ts);
//   collectors — дропперы из test стали «сборщиками»: деньги несут 15–40 незнакомых людей;
//   perturb_*  — первые 4000 счетов test с одним «ухудшенным» признаком (столбец base — номер
//                исходного счёта в test): по ним видно, падает ли риск, когда признак хуже.
// Для каждого счёта — оценка выбранной модели (current) и идеальной модели (ideal).

import { mkdirSync, writeFileSync } from 'node:fs'
import { FEATURE_KEYS, type FeatureKey, type RecipientFeatures } from '../service/src/features.ts'
import { loadModel, scoreRecipient } from '../service/src/model.ts'
import { idealScore } from './ceiling.ts'
import { CAREFUL_DROPPER_MIX, generateAccounts, type Account } from './generate.ts'
import { createRng } from './random.ts'

const SEED = 20261112
const ACCOUNTS = 200000
export const PERTURB: Record<FeatureKey, (v: number) => number> = {
  account_age_days: (v) => Math.round(v * 0.5), // счёт вдвое моложе
  unrelated_senders_7d: (v) => v + 3,
  fast_outflow_share_7d: (v) => Math.min(1, Math.round((v + 0.15) * 100) / 100),
  shared_device_accounts: (v) => v + 2,
}

const modelIndex = process.argv.indexOf('--model')
const modelFile = modelIndex >= 0 ? process.argv[modelIndex + 1]! : new URL('../service/model/model.json', import.meta.url)
const model = loadModel(modelFile)
const accounts = generateAccounts(ACCOUNTS, createRng(SEED))
const trainEnd = Math.floor(ACCOUNTS * 0.6)
const validationEnd = Math.floor(ACCOUNTS * 0.8)
const test = accounts.slice(validationEnd)
const stress = generateAccounts(40000, createRng(SEED + 2), CAREFUL_DROPPER_MIX)
const collectorRng = createRng(SEED + 3)
const collectors = test.filter((a) => a.is_dropper).map((a) => ({ ...a, features: { ...a.features, unrelated_senders_7d: 15 + Math.floor(collectorRng() * 26) } }))

const split = (i: number) => (i < trainEnd ? 'train' : i < validationEnd ? 'validation' : 'test')
const line = (part: string, features: RecipientFeatures, label: boolean, kind: string, base = -1) =>
  [part, ...FEATURE_KEYS.map((key) => features[key]), label ? 1 : 0, kind, base, scoreRecipient(model, features, false).risk.toFixed(6), idealScore(features).toFixed(6)].join(',')
const row = (a: Account, part: string) => line(part, a.features, a.is_dropper, a.kind)

const rows = [
  ['split', ...FEATURE_KEYS, 'is_dropper', 'kind', 'base', 'current', 'ideal'].join(','),
  ...accounts.map((a, i) => row(a, split(i))),
  ...stress.map((a) => row(a, 'stress')),
  ...collectors.map((a) => row(a, 'collectors')),
  ...FEATURE_KEYS.flatMap((key) =>
    test.slice(0, 4000).map((a, i) => line(`perturb_${key}`, { ...a.features, [key]: PERTURB[key](a.features[key]!) }, a.is_dropper, a.kind, i)),
  ),
]

const dir = new URL('./challenger/data/', import.meta.url)
mkdirSync(dir, { recursive: true })
writeFileSync(new URL('bench.csv', dir), rows.join('\n') + '\n')
console.log(`Сохранено строк: ${rows.length - 1} → ml/challenger/data/bench.csv (модель ${model.version})`)
