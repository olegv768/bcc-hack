import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { loadModel } from './model.ts'

const model = loadModel(new URL('../model/model.json', import.meta.url))
const dataFile = join(mkdtempSync(join(tmpdir(), 'dropper-guard-')), 'flagged.json')

const dropper = { account_id: 'tok_drop', account_age_days: 3, unrelated_senders_7d: 9, fast_outflow_share_7d: 0.9, shared_device_accounts: 4 }
const friend = { account_id: 'tok_friend', account_age_days: 1500, unrelated_senders_7d: 0, fast_outflow_share_7d: 0.1, shared_device_accounts: 0 }
const calm = { amount: 20000, sender_on_call: false, first_transfer_to_recipient: false, amount_to_typical_ratio: 1 }
const pressured = { amount: 400000, sender_on_call: true, first_transfer_to_recipient: true, amount_to_typical_ratio: 8 }

let url = ''
let close = () => {}

beforeAll(async () => {
  const server = createApp({ model, dataFile, openapi: 'openapi: 3.0.3', demo: true }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  close = () => server.close()
})
afterAll(() => close())

const score = (body: unknown) =>
  fetch(url + '/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('POST /score', () => {
  test('обычный перевод знакомому проходит без причин и предупреждений', async () => {
    const body = await (await score({ recipient: friend, context: calm })).json()
    expect(body.action).toBe('allow')
    expect(body.risk).toBeLessThan(0.1)
    expect(body.reasons).toEqual([])
    expect(body.client_message).toBeNull()
  })

  test('перевод на счёт с признаками дроппера придерживается, причины названы словами', async () => {
    const body = await (await score({ recipient: dropper, context: pressured })).json()
    expect(body.action).toBe('hold')
    expect(body.risk_level).toBe('high')
    const codes = body.reasons.map((r: { code: string }) => r.code)
    expect(codes).toEqual(expect.arrayContaining(['NEW_ACCOUNT', 'FAST_OUTFLOW', 'SHARED_DEVICE', 'ON_CALL']))
    expect(body.reasons[0].text).toMatch(/[а-я]/i)
    expect(body.client_message.title).toBeTruthy()
  })

  test('звонок и новый получатель поднимают предупреждение до приостановки', async () => {
    const borderline = { account_id: 'tok_mid', account_age_days: 400, unrelated_senders_7d: 6, fast_outflow_share_7d: 0.7, shared_device_accounts: 1 }
    const quiet = await (await score({ recipient: borderline, context: calm })).json()
    const onCall = await (await score({ recipient: borderline, context: pressured })).json()
    expect(quiet.risk).toBe(onCall.risk)
    expect(quiet.action).toBe('warn')
    expect(onCall.action).toBe('hold')
  })

  test('звонок, новый получатель и необычная сумма дают предупреждение даже при чистом счёте', async () => {
    const body = await (await score({ recipient: friend, context: pressured, lang: 'kk' })).json()
    expect(body.action).toBe('warn')
    expect(body.client_message.title).toContain('телефонмен')
  })

  test('удалённый доступ и новый получатель дают предупреждение даже при обычной сумме', async () => {
    const context = { amount: 20000, sender_on_call: false, remote_access_active: true, first_transfer_to_recipient: true, amount_to_typical_ratio: 1 }
    const body = await (await score({ recipient: { ...friend, account_id: 'tok_remote' }, context })).json()
    expect(body.action).toBe('warn')
    expect(body.reasons.map((r: { code: string }) => r.code)).toContain('REMOTE_ACCESS')
    expect(body.client_message.title).toContain('удалённо')

    const known = await (await score({ recipient: friend, context: { ...context, first_transfer_to_recipient: false } })).json()
    expect(known.action).toBe('allow')
  })

  test('отсутствующие признаки не ломают оценку и перечислены в ответе', async () => {
    const body = await (await score({ recipient: { account_id: 'tok_x', account_age_days: 2 }, context: calm })).json()
    expect(body.missing_features).toEqual(['unrelated_senders_7d', 'fast_outflow_share_7d', 'shared_device_accounts'])
    expect(body.contributions.shared_device_accounts).toBe(0)
  })

  test('неверный запрос получает 400 с объяснением', async () => {
    const response = await score({ recipient: { account_id: 'a', fast_outflow_share_7d: 7 }, context: { amount: -5 } })
    expect(response.status).toBe(400)
    expect((await response.json()).error).toBe('invalid_request')
    expect((await fetch(url + '/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })).status).toBe(400)
  })
})

describe('выгрузка для аналитика', () => {
  test('помеченные счета отдаются в JSON и CSV, честный счёт туда не попадает', async () => {
    const json = await (await fetch(url + '/flagged?min_risk=0.9')).json()
    const ids = json.items.map((a: { account_id: string }) => a.account_id)
    expect(ids).toContain('tok_drop')
    expect(ids).not.toContain('tok_friend')
    expect(json.items[0].reasons.length).toBeGreaterThan(0)

    const csv = await (await fetch(url + '/flagged.csv?separator=semicolon')).text()
    expect(csv.split('\r\n')[0]).toContain('account_id;max_risk;last_action')
    expect(csv).toContain('tok_drop')
  })

  test('повторный перевод на тот же счёт увеличивает счётчик, а не создаёт вторую строку', async () => {
    await score({ recipient: dropper, context: pressured })
    const json = await (await fetch(url + '/flagged')).json()
    const rows = json.items.filter((a: { account_id: string }) => a.account_id === 'tok_drop')
    expect(rows).toHaveLength(1)
    expect(rows[0].flagged_transfers).toBe(2)
    expect(rows[0].flagged_amount).toBe(800000)
  })
})

test('с заданным ключом запросы без X-API-Key отклоняются', async () => {
  const server = createApp({ model, dataFile, openapi: 'openapi: 3.0.3', apiKey: 'secret' }).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  expect((await fetch(base + '/flagged')).status).toBe(401)
  expect((await fetch(base + '/flagged', { headers: { 'x-api-key': 'secret' } })).status).toBe(200)
  expect((await fetch(base + '/health')).status).toBe(200)
  server.close()
})
