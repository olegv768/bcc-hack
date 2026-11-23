// «Треугольник» в P2P: защита у отправителя (POST /score), у получателя (POST /incoming)
// и разбор в расследовании сети.

import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { createDemoGraphSource } from './graph/demo-source.ts'
import { createInvestigator } from './graph/investigate.ts'
import { loadModel } from './model.ts'

const model = loadModel(new URL('../model/model.json', import.meta.url))
// старый чистый счёт продавца USDT: по признакам счёта он не подозрителен
const trader = { account_id: 'tok_trader', account_age_days: 1600, unrelated_senders_7d: 6, fast_outflow_share_7d: 0.4, shared_device_accounts: 0, p2p_trader_profile: true }
const context = { amount: 185000, sender_on_call: false, first_transfer_to_recipient: true, amount_to_typical_ratio: 1.5 }

let url = ''
let close = () => {}
beforeAll(async () => {
  const dataFile = join(mkdtempSync(join(tmpdir(), 'triangle-')), 'flagged.json')
  const server = createApp({ model, dataFile, openapi: '', demo: true }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})
afterAll(() => close())

const post = (path: string, body: unknown) =>
  fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

describe('отправитель: POST /score', () => {
  test('оплата товара продавцу криптовалюты — предупреждение о «треугольнике»', async () => {
    const body = await post('/score', { recipient: trader, context: { ...context, payment_purpose: 'goods' } })
    expect(body.action).toBe('warn')
    expect(body.reasons.map((r: { code: string }) => r.code)).toContain('TRIANGLE')
    expect(body.client_message.title).toMatch(/треугольник/)
  })

  test('покупка криптовалюты у того же продавца — обычная сделка, без предупреждения', async () => {
    const body = await post('/score', { recipient: trader, context: { ...context, payment_purpose: 'crypto_p2p' } })
    expect(body.action).toBe('allow')
  })

  test('без назначения платежа правило молчит: банк не спросил — сервис не гадает', async () => {
    const body = await post('/score', { recipient: trader, context })
    expect(body.reasons.map((r: { code: string }) => r.code)).not.toContain('TRIANGLE')
  })

  test('алерт хранит назначение платежа', async () => {
    const body = await post('/score', { transfer_id: 'tr_tri', recipient: trader, context: { ...context, payment_purpose: 'goods' } })
    const alerts = await (await fetch(url + '/alerts')).json()
    expect(alerts.items.find((a: { alert_id: string }) => a.alert_id === body.alert_id).signals.purpose).toBe('goods')
  })

  test('честный счёт продавца не попадает в выгрузку помеченных счетов', async () => {
    const flagged = await (await fetch(url + '/flagged')).json()
    expect(flagged.items.map((a: { account_id: string }) => a.account_id)).not.toContain('tok_trader')
  })

  test('алерт проверки поступления не показывает выдуманный риск', async () => {
    const body = await post('/incoming', { amount: 1000, recipient: { account_id: 'tok_r', p2p_trader_profile: true }, sender: { bank: 'same', payment_purpose: 'goods' } })
    const alert = (await (await fetch(url + '/alerts')).json()).items.find((a: { alert_id: string }) => a.alert_id === body.alert_id)
    expect(alert.risk).toBe(0)
    expect(alert.model_version).toMatch(/^incoming/)
  })
})

describe('получатель: POST /incoming', () => {
  const base = { amount: 185000, recipient: { account_id: 'tok_trader', p2p_trader_profile: true } }

  test('«оплата товара» продавцу криптовалюты — предупредить получателя, деньги зачислить', async () => {
    const body = await post('/incoming', { ...base, sender: { bank: 'same', display_name: 'Алмас Т.', first_transfer_to_recipient: true, payment_purpose: 'goods' } })
    expect(body.action).toBe('notify')
    expect(body.recipient_message.body).toContain('Алмас Т.')
    expect(body.alert_id).toBeTruthy()
  })

  test('отметка Антифрод-центра — зачисление приостановить', async () => {
    const body = await post('/incoming', { ...base, lang: 'kk', sender: { bank: 'other' }, antifraud_center: { flagged: true, ref: 'АЦ-1' } })
    expect(body.action).toBe('hold_credit')
    expect(body.reasons[0].code).toBe('ANTIFRAUD_CENTER')
    expect(body.recipient_message.title).toBeTruthy()
  })

  test('обычная покупка криптовалюты — ничего не делать', async () => {
    const body = await post('/incoming', { ...base, sender: { bank: 'other', first_transfer_to_recipient: true, payment_purpose: 'crypto_p2p' } })
    expect(body).toMatchObject({ action: 'none', recipient_message: null, alert_id: null })
  })

  test('неверный запрос — 400', async () => {
    const response = await fetch(url + '/incoming', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: -1 }) })
    expect(response.status).toBe(400)
  })
})

describe('расследование сети', () => {
  const investigator = createInvestigator(createDemoGraphSource(), { links: ['transfer', 'device', 'ip', 'phone', 'card'] })

  test('продавец криптовалюты — посредник, а не дроп; заплатившие «за товар» — пострадавшие', () => {
    expect(investigator.assess('tok_p2p771')?.role).toBe('p2p_intermediary')
    expect(investigator.assess('cl_82301')?.role).toBe('possible_victim')
    expect(investigator.assess('cl_82302')?.role).toBe('possible_victim')
  })

  test('обычные покупатели криптовалюты не попадают в пострадавшие', () => {
    const graph = investigator.investigate('tok_p2p771', 1, [])
    const buyers = graph.nodes.filter((n) => n.id.startsWith('cl_6'))
    expect(buyers.length).toBeGreaterThan(3)
    for (const b of buyers) expect(b.assessment?.role).toBe('regular')
  })

  test('находка «треугольник» советует не блокировать продавца и запросить ордера', () => {
    const graph = investigator.investigate('tok_p2p771', 2, [])
    const finding = graph.findings.find((f) => f.kind === 'triangle')
    expect(finding).toBeDefined()
    expect(finding!.explanation).toMatch(/не блокировать/)
    expect(finding!.explanation).toMatch(/ордера/)
    expect(finding!.node_ids).toEqual(expect.arrayContaining(['tok_t82301', 'tok_t82302']))
  })

  test('сигнал Антифрод-центра открывает расследование вокруг продавца', async () => {
    const cases = await (await fetch(url + '/graph/cases')).json()
    const center = cases.items.find((c: { source: string }) => c.source === 'antifraud_center')
    expect(center.entity_id).toBe('tok_p2p771')
    const body = await post('/graph/investigate', { alert_id: center.ref })
    expect(body.root).toBe('tok_p2p771')
  })
})
