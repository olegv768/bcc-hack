// Итоги пилота в теневом режиме: npm run shadow-report -- --responses ответы.csv --confirmed подтверждённые.csv --days 30
//
// responses.csv — ответы сервиса, которые банк сохранял во время пилота, по одному на перевод.
//   Колонки: transfer_id, risk, recommended_action; необязательная amount (сумма перевода).
// confirmed.csv — переводы за тот же период, которые банк признал мошенническими. Колонка transfer_id.
//
// Отчёт показывает, сколько мошеннических переводов сервис бы заметил, сколько честных побеспокоил
// и сколько срабатываний в день пришлось бы разбирать. Таблица порогов помогает выбрать свои.
//
// Попробовать без данных банка: npm run shadow-report -- --example

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decide, loadModel } from '../service/src/model.ts'
import { generateAccounts, generateContext } from './generate.ts'
import { createRng } from './random.ts'

type Response = { transfer_id: string; risk: number; action: string; amount: number | null }

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function table(file: string): Record<string, string>[] {
  const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim())
  const separator = lines[0]!.includes(';') ? ';' : ','
  const header = lines[0]!.split(separator).map((name) => name.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split(separator)
    return Object.fromEntries(header.map((name, i) => [name, (cells[i] ?? '').trim()]))
  })
}

// Пример входных файлов на синтетических данных: так выглядел бы месяц пилота.
function writeExample(): { responses: string; confirmed: string; days: number } {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-pilot-'))
  const model = loadModel(new URL('../service/model/model.json', import.meta.url))
  const rng = createRng(7)
  const responses = ['transfer_id,risk,recommended_action,amount']
  const confirmed = ['transfer_id']
  generateAccounts(30000, rng).forEach((account, i) => {
    // на счёт дроппера приходят несколько жертв
    for (let k = 0; k < (account.is_dropper ? 5 : 1); k++) {
      const context = generateContext(account.is_dropper, rng)
      const result = decide(model, account.features, context)
      const id = `tr_${i}_${k}`
      responses.push(`${id},${result.risk},${result.action},${context.amount}`)
      if (account.is_dropper) confirmed.push(id)
    }
  })
  writeFileSync(join(dir, 'responses.csv'), responses.join('\n'))
  writeFileSync(join(dir, 'confirmed.csv'), confirmed.join('\n'))
  console.log(`Пример входных файлов: ${dir}\n`)
  return { responses: join(dir, 'responses.csv'), confirmed: join(dir, 'confirmed.csv'), days: 30 }
}

const files = process.argv.includes('--example')
  ? writeExample()
  : { responses: argument('--responses'), confirmed: argument('--confirmed'), days: Number(argument('--days') ?? 30) }

if (!files.responses || !files.confirmed) {
  console.error('Нужны --responses и --confirmed (или --example). Формат — в начале ml/shadow-report.ts.')
  process.exit(1)
}

const responses: Response[] = table(files.responses).map((row, i) => {
  const risk = Number(row.risk?.replace(',', '.'))
  if (!row.transfer_id || !Number.isFinite(risk)) throw new Error(`responses, строка ${i + 2}: нужны transfer_id и risk`)
  const amount = row.amount ? Number(row.amount.replace(',', '.')) : null
  return { transfer_id: row.transfer_id, risk, action: row.recommended_action || 'allow', amount: Number.isFinite(amount) ? amount : null }
})
const fraudIds = new Set(table(files.confirmed).map((row) => row.transfer_id).filter(Boolean))

const fraud = responses.filter((r) => fraudIds.has(r.transfer_id))
const honest = responses.filter((r) => !fraudIds.has(r.transfer_id))
const missingFraud = fraudIds.size - fraud.length
const flagged = (r: Response) => r.action === 'warn' || r.action === 'hold'
const sum = (items: Response[]) => items.reduce((total, r) => total + (r.amount ?? 0), 0)
const pct = (value: number) => (value * 100).toFixed(1) + '%'
const money = (value: number) => Math.round(value).toLocaleString('ru-RU') + ' ₸'
const per10k = (part: number, whole: number) => Math.round((part / Math.max(whole, 1)) * 10000)

console.log(`Переводов в пилоте: ${responses.length.toLocaleString('ru-RU')} за ${files.days} дн.`)
console.log(`Подтверждённых мошеннических: ${fraud.length.toLocaleString('ru-RU')}` +
  (missingFraud ? ` (ещё ${missingFraud} нет среди ответов сервиса — их сервис не видел, в расчёт не входят)` : ''))

const held = fraud.filter((r) => r.action === 'hold')
const warned = fraud.filter((r) => r.action === 'warn')
console.log('\nПри порогах, с которыми шёл пилот')
console.log(`  мошеннических замечено: ${pct((held.length + warned.length) / Math.max(fraud.length, 1))}` +
  ` (приостановлено ${pct(held.length / Math.max(fraud.length, 1))}, предупреждение ${pct(warned.length / Math.max(fraud.length, 1))})`)
if (fraud.some((r) => r.amount !== null)) {
  console.log(`  сумма мошеннических переводов: ${money(sum(fraud))}; из неё приостановлено ${money(sum(held))}, под предупреждением ${money(sum(warned))}`)
}
const honestFlagged = honest.filter(flagged)
console.log(`  честных побеспокоено зря: ${per10k(honestFlagged.length, honest.length)} на 10 000` +
  ` (приостановлено ${per10k(honest.filter((r) => r.action === 'hold').length, honest.length)} на 10 000)`)
console.log(`  срабатываний в день на разбор: ${Math.round(responses.filter(flagged).length / files.days)}`)

// Таблица порогов — только по оценке счёта (risk). Правила по звонку и удалённому доступу добавят сверху ещё срабатываний.
console.log('\nЕсли поставить порог «предупредить» по оценке счёта')
console.log('  порог     замечено мошеннических    зря на 10 000 честных    срабатываний в день')
for (const threshold of [0.5, 0.7, 0.8, 0.9, 0.95, 0.99]) {
  const fraudAbove = fraud.filter((r) => r.risk >= threshold).length
  const honestAbove = honest.filter((r) => r.risk >= threshold).length
  console.log(
    `  ${threshold.toFixed(2).padEnd(9)} ${pct(fraudAbove / Math.max(fraud.length, 1)).padStart(22)}    ${String(per10k(honestAbove, honest.length)).padStart(21)}    ` +
      `${String(Math.round((fraudAbove + honestAbove) / files.days)).padStart(19)}`,
  )
}
console.log('\nВыбранные пороги вписываются в service/model/model.json, поле thresholds.')
