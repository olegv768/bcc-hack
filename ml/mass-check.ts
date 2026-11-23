// Массовая проверка: миллиарды переводов через ту же функцию решения, что в сервисе.
//   npm run mass-check                          — 2 млн отложенных счетов, до 3000 переводов на счёт (около 3 млрд)
//   npm run mass-check -- --per 300 --workers 4  — меньше переводов, меньше процессов
// Счета — отложенная выборка из ml/train.ts (последние 20% из 10 млн): модель их не видела.
// У каждого счёта своё число входящих переводов — от 1 до --per, как в жизни.
//
// Ускорение без потери точности: риск счёта считается один раз на счёт, а решение по каждому
// переводу принимает decide сервиса с моделью-«константой»: тот же логит, те же пороги и та же
// вторая ступень. Решение совпадает с полным расчётом бит в бит.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'
import { NO_HISTORY, decide, loadModel, scoreRecipient, type Action, type Model } from '../service/src/model.ts'
import { generateAccounts, generateContext } from './generate.ts'
import { createRng } from './random.ts'

const argument = (name: string, fallback: number) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? Number(process.argv[index + 1]) : fallback
}

const SEED = 20261112
const ACCOUNTS = 10_000_000
const TEST_FROM = Math.floor(ACCOUNTS * 0.8)
// --accounts N — только первые N отложенных счетов, для быстрой проверки
const TEST_SIZE = Math.min(ACCOUNTS - TEST_FROM, argument('--accounts', ACCOUNTS - TEST_FROM))

type Counts = Record<'fraud' | 'honest', Record<Action, number>>
const empty = (): Counts => ({ fraud: { allow: 0, warn: 0, hold: 0 }, honest: { allow: 0, warn: 0, hold: 0 } })

// Один процесс: счета отложенной выборки с номерами [from, to).
function part(from: number, to: number, perAccount: number, seed: number): Counts {
  const model = loadModel(new URL('../service/model/model.json', import.meta.url))
  // счета идут из одного генератора по порядку: пропускаем первые кусками, чтобы не держать в памяти все
  const accountRng = createRng(SEED)
  for (let skip = TEST_FROM + from; skip > 0; skip -= Math.min(skip, 100_000)) generateAccounts(Math.min(skip, 100_000), accountRng)
  const accounts = generateAccounts(to - from, accountRng)
  const rng = createRng(seed)
  const countRng = createRng(seed + 1)
  const counts = empty()
  for (const account of accounts) {
    const { logit } = scoreRecipient(model, account.features, false)
    const fixed: Model = { version: model.version, bias: logit, terms: [], thresholds: model.thresholds, ...(model.transfer && { transfer: model.transfer }) }
    const group = account.is_dropper ? counts.fraud : counts.honest
    const transfers = 1 + Math.floor(countRng() * perAccount)
    for (let k = 0; k < transfers; k++) group[decide(fixed, account.features, generateContext(account.is_dropper, rng), NO_HISTORY, false).action]++
  }
  return counts
}

const partIndex = process.argv.indexOf('--part')
if (partIndex >= 0) {
  const [from, to, perAccount, seed] = process.argv.slice(partIndex + 1, partIndex + 5).map(Number) as [number, number, number, number]
  process.stdout.write(JSON.stringify(part(from, to, perAccount, seed)))
} else {
  const perAccount = argument('--per', 3000)
  const workers = argument('--workers', cpus().length)
  const started = Date.now()
  const step = Math.ceil(TEST_SIZE / workers)
  const script = fileURLToPath(import.meta.url)
  const results = await Promise.all(
    Array.from({ length: workers }, (_, i) => {
      const from = i * step
      const to = Math.min(TEST_SIZE, from + step)
      return new Promise<Counts>((resolve, reject) => {
        const child = spawn(process.execPath, [...process.execArgv, script, '--part', String(from), String(to), String(perAccount), String(9000 + i * 10)])
        let out = ''
        child.stdout.on('data', (chunk) => (out += chunk))
        child.stderr.pipe(process.stderr)
        child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out) as Counts) : reject(new Error(`процесс ${i} завершился с кодом ${code}`))))
      })
    }),
  )
  const total = empty()
  for (const r of results) for (const group of ['fraud', 'honest'] as const) for (const action of ['allow', 'warn', 'hold'] as const) total[group][action] += r[group][action]
  const n = (g: Record<Action, number>) => g.allow + g.warn + g.hold
  const fraud = n(total.fraud)
  const honest = n(total.honest)
  const pct = (v: number) => (v * 100).toFixed(2) + '%'
  console.log(`Переводов: ${(fraud + honest).toLocaleString('ru-RU')} (мошеннических ${fraud.toLocaleString('ru-RU')}, честных ${honest.toLocaleString('ru-RU')}), ${Math.round((Date.now() - started) / 1000)} с`)
  console.log(`Мошеннические: приостановлено ${pct(total.fraud.hold / fraud)}, предупреждение ${pct(total.fraud.warn / fraud)}, пропущено ${pct(total.fraud.allow / fraud)}`)
  console.log(`Честные на 1000: приостановлено ${((total.honest.hold / honest) * 1000).toFixed(2)}, предупреждение ${((total.honest.warn / honest) * 1000).toFixed(2)}`)
}
