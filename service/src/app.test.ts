import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from './app.ts'
import { decide, loadModel, modelFeatures } from './model.ts'

const model = loadModel(new URL('../model/model.json', import.meta.url))
const dataFile = join(mkdtempSync(join(tmpdir(), 'dropper-guard-')), 'flagged.json')

const dropper = { account_id: 'tok_drop', account_age_days: 3, unrelated_senders_7d: 9, fast_outflow_share_7d: 0.9, shared_device_accounts: 4 }
const friend = { account_id: 'tok_friend', account_age_days: 1500, unrelated_senders_7d: 0, fast_outflow_share_7d: 0.1, shared_device_accounts: 0 }
const calm = { amount: 20000, sender_on_call: false, first_transfer_to_recipient: false, amount_to_typical_ratio: 1 }
// новый получатель без звонка: признаки счёта действуют в полную силу
const stranger = { ...calm, first_transfer_to_recipient: true }
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

  test('перевод на счёт с признаками дроппера приостанавливается, причины названы словами', async () => {
    const body = await (await score({ recipient: dropper, context: pressured })).json()
    expect(body.action).toBe('hold')
    expect(body.risk_level).toBe('high')
    const codes = body.reasons.map((r: { code: string }) => r.code)
    expect(codes).toEqual(expect.arrayContaining(['NEW_ACCOUNT', 'FAST_OUTFLOW', 'SHARED_DEVICE', 'ON_CALL']))
    expect(body.reasons[0].text).toMatch(/[а-я]/i)
    expect(body.client_message.title).toBeTruthy()
  })

  test('звонок, новый получатель и крупная сумма поднимают решение по тому же счёту до приостановки', async () => {
    // счёт, перевод на который без звонка не приостанавливается, а под давлением — приостанавливается,
    // ищем перебором: модель могли переобучить
    const candidates = [3, 5, 7, 9, 12].flatMap((senders) =>
      [0.5, 0.6, 0.7, 0.8].flatMap((outflow) =>
        [0, 1, 2].map((devices) => ({
          account_age_days: 400,
          unrelated_senders_7d: senders,
          fast_outflow_share_7d: outflow,
          shared_device_accounts: devices,
          idle_days_before_inflow: null,
          new_device_7d: null,
          flagged_linked_senders_7d: null,
        })),
      ),
    )
    const middle = candidates.find(
      (f) => decide(model, f, { ...stranger, remote_access_active: null }).action !== 'hold' && decide(model, f, { ...pressured, remote_access_active: null }).action === 'hold',
    )
    expect(middle).toBeDefined()
    const borderline = { account_id: 'tok_mid', ...middle! }
    const quiet = await (await score({ recipient: borderline, context: stranger })).json()
    const onCall = await (await score({ recipient: borderline, context: pressured })).json()
    expect(quiet.risk).toBe(onCall.risk)
    expect(quiet.action).not.toBe('hold')
    expect(onCall.action).toBe('hold')
    if (model.transfer) {
      expect(onCall.transfer.parts.call).toBeGreaterThan(0)
      expect(onCall.transfer.parts.amount).toBeGreaterThan(quiet.transfer.parts.amount)
      expect(onCall.transfer.score).toBeGreaterThan(quiet.transfer.score)
    }
  })

  test('100 ₸ во время звонка — маме или новому человеку на чистый счёт — проходят', async () => {
    const small = { amount: 100, sender_on_call: true, first_transfer_to_recipient: false, amount_to_typical_ratio: 0.01 }
    const mom = await (await score({ recipient: { ...friend, account_id: 'tok_mom' }, context: small })).json()
    const someone = await (await score({ recipient: { ...friend, account_id: 'tok_someone' }, context: { ...small, first_transfer_to_recipient: true } })).json()
    expect(mom.action).toBe('allow')
    expect(someone.action).toBe('allow')
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

  test('если клиент уже переводил этому получателю, оценка перевода ниже, а удалённый доступ это отменяет', async () => {
    const account = { ...dropper, account_id: 'tok_known_recipient' }
    const first = await (await score({ recipient: account, context: stranger })).json()
    const repeat = await (await score({ recipient: account, context: calm })).json()
    const unknown = await (await score({ recipient: account, context: { ...calm, first_transfer_to_recipient: null } })).json()
    const remote = await (await score({ recipient: account, context: { ...calm, remote_access_active: true } })).json()
    expect(first.action).toBe('hold')
    expect(remote.action).toBe('hold')
    if (model.transfer) {
      // «уже переводил» снижает оценку, «неизвестно» — посередине: ни смягчения, ни надбавки
      expect(repeat.transfer.score).toBeLessThan(unknown.transfer.score)
      expect(unknown.transfer.score).toBeLessThan(first.transfer.score)
      expect(unknown.transfer.parts.first).toBe(0)
      // при удалённом доступе «уже переводил» не в счёт: переводит не сам клиент
      expect(remote.transfer.parts.first).toBe(0)
      expect(remote.transfer.score).toBeGreaterThan(repeat.transfer.score)
    } else {
      expect(repeat.action).toBe('warn')
      expect(unknown.action).toBe('hold')
    }
  })

  test('отсутствующие признаки не ломают оценку и перечислены в ответе', async () => {
    const body = await (await score({ recipient: { account_id: 'tok_x', account_age_days: 2 }, context: calm })).json()
    expect(body.missing_features).toEqual(modelFeatures(model).filter((key) => key !== 'account_age_days'))
    expect(body.missing_features).toEqual(expect.arrayContaining(['unrelated_senders_7d', 'fast_outflow_share_7d', 'shared_device_accounts']))
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

describe('память о счёте', () => {
  const patch = (id: string, body: unknown) =>
    fetch(`${url}/alerts/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const transit = { account_age_days: 400, unrelated_senders_7d: 6, fast_outflow_share_7d: 0.85, shared_device_accounts: 2 }

  test('после подтверждения мошенничества любой перевод на этот счёт приостанавливается', async () => {
    const first = await (await score({ recipient: { ...dropper, account_id: 'tok_known' }, context: pressured })).json()
    await patch(first.alert_id, { status: 'closed', resolution: 'fraud' })

    // даже спокойный перевод с нейтральными признаками счёта
    const next = await (await score({ recipient: { ...friend, account_id: 'tok_known' }, context: calm })).json()
    expect(next.action).toBe('hold')
    expect(next.reasons[0].code).toBe('CONFIRMED_FRAUD')
  })

  test('после отметки «ложное срабатывание» счёт перестаёт тревожить, но звонок всё ещё учитывается', async () => {
    const first = await (await score({ recipient: { ...transit, account_id: 'tok_ok' }, context: stranger })).json()
    expect(first.action).not.toBe('allow')
    await patch(first.alert_id, { status: 'closed', resolution: 'legit' })

    const quiet = await (await score({ recipient: { ...transit, account_id: 'tok_ok' }, context: stranger })).json()
    expect(quiet.action).toBe('allow')
    const onCall = await (await score({ recipient: { ...transit, account_id: 'tok_ok' }, context: pressured })).json()
    expect(onCall.action).toBe('warn')
  })

  test('переводы от нескольких клиентов на один счёт поднимают решение на ступень', async () => {
    const quietSeller = { account_id: 'tok_target', account_age_days: 700, unrelated_senders_7d: 3, fast_outflow_share_7d: 0.2, shared_device_accounts: 0 }
    const alone = await (await score({ client_ref: 'cl_0', recipient: { ...quietSeller, account_id: 'tok_alone' }, context: calm })).json()
    expect(alone.action).toBe('allow')

    // трое разных клиентов под давлением уже получили предупреждение на этот счёт
    for (const client of ['cl_1', 'cl_2', 'cl_3']) {
      const warned = await (await score({ client_ref: client, recipient: quietSeller, context: pressured })).json()
      expect(warned.action).not.toBe('allow')
    }
    // клиент из этой тройки сам себя не считает: для него «других» только двое
    const again = await (await score({ client_ref: 'cl_1', recipient: quietSeller, context: calm })).json()
    expect(again.action).toBe('allow')

    const fourth = await (await score({ client_ref: 'cl_4', recipient: quietSeller, context: calm })).json()
    expect(fourth.action).toBe('warn')
    expect(fourth.reasons[0]).toMatchObject({ code: 'REPEAT_TARGET' })
    expect(fourth.reasons[0].text).toContain('3 клиента')
  })

  test('повтор того же перевода не создаёт второй алерт', async () => {
    const body = { transfer_id: 'tr_same', client_ref: 'cl_9', recipient: { ...dropper, account_id: 'tok_twice' }, context: pressured }
    const first = await (await score(body)).json()
    const second = await (await score(body)).json()
    expect(second.alert_id).toBe(first.alert_id)
    const queue = await (await fetch(url + '/alerts')).json()
    expect(queue.items.filter((a: { transfer_id: string }) => a.transfer_id === 'tr_same')).toHaveLength(1)
    const flagged = await (await fetch(url + '/flagged')).json()
    expect(flagged.items.find((a: { account_id: string }) => a.account_id === 'tok_twice').flagged_transfers).toBe(1)
  })
})

describe('очередь алертов для аналитика', () => {
  test('приостановленный перевод создаёт алерт высокого приоритета с триггерами, суммой и псевдонимом клиента', async () => {
    const scored = await (await score({ transfer_id: 'tr_1', client_ref: 'cl_777', recipient: { ...dropper, account_id: 'tok_case' }, context: pressured })).json()
    expect(scored.alert_id).toMatch(/^al_/)

    const queue = await (await fetch(url + '/alerts?priority=high&status=new')).json()
    const alert = queue.items.find((a: { alert_id: string }) => a.alert_id === scored.alert_id)
    expect(alert).toMatchObject({ priority: 'high', status: 'new', action: 'hold', amount: 400000, client_ref: 'cl_777', transfer_id: 'tr_1', account_id: 'tok_case' })
    expect(alert.triggers.map((t: { code: string }) => t.code)).toEqual(expect.arrayContaining(['NEW_ACCOUNT', 'ON_CALL']))
    expect(alert.signals).toEqual({ on_call: true, remote_access: null, first_transfer: true, purpose: null })
    expect(alert.triggers[0].text).toMatch(/[а-я]/i)
  })

  test('обычный перевод алерта не создаёт', async () => {
    const scored = await (await score({ recipient: friend, context: calm })).json()
    expect(scored.alert_id).toBeNull()
  })

  test('аналитик берёт алерт в работу и закрывает с итогом', async () => {
    const { alert_id } = await (await score({ recipient: { ...dropper, account_id: 'tok_case2' }, context: pressured })).json()
    const patch = (body: unknown) =>
      fetch(`${url}/alerts/${alert_id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    expect((await (await patch({ status: 'in_progress' })).json()).status).toBe('in_progress')
    const closed = await (await patch({ status: 'closed', resolution: 'fraud' })).json()
    expect(closed).toMatchObject({ status: 'closed', resolution: 'fraud' })
    expect((await patch({ status: 'done' })).status).toBe(400)
    expect((await fetch(url + '/alerts/al_missing', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"status":"closed"}' })).status).toBe(404)
  })

  test('стенд восстанавливает алерт, который сервис потерял при перезапуске', async () => {
    const { alert_id } = await (await score({ recipient: { ...dropper, account_id: 'tok_lost' }, context: pressured })).json()
    const queue = await (await fetch(url + '/alerts')).json()
    const snapshot = queue.items.find((a: { alert_id: string }) => a.alert_id === alert_id)

    // «перезапуск»: очередь пуста, стенд всё ещё показывает старую карточку
    await fetch(url + '/flagged', { method: 'DELETE' })
    const send = (base: string, body: unknown) =>
      fetch(`${base}/alerts/${alert_id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    expect((await send(url, { status: 'in_progress' })).status).toBe(404)
    const restored = await send(url, { status: 'closed', resolution: 'fraud', snapshot })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toMatchObject({ alert_id, status: 'closed', resolution: 'fraud', account_id: 'tok_lost' })

    // память о счёте после восстановления работает
    const next = await (await score({ recipient: { ...friend, account_id: 'tok_lost' }, context: calm })).json()
    expect(next.reasons[0].code).toBe('CONFIRMED_FRAUD')

    // вне стенда копия не принимается
    const file = join(mkdtempSync(join(tmpdir(), 'dropper-guard-')), 'flagged.json')
    const server = createApp({ model, dataFile: file, openapi: '', demo: false }).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await send(base, { status: 'closed', snapshot })).status).toBe(404)
    server.close()
  })

  test('в теневом режиме сервис ничего не блокирует, но записывает рекомендацию и не шлёт вебхук', async () => {
    let calls = 0
    const bank = createServer((_req, res) => {
      calls++
      res.end()
    }).listen(0, '127.0.0.1')
    await new Promise((resolve) => bank.once('listening', resolve))
    const webhook = `http://127.0.0.1:${(bank.address() as AddressInfo).port}/cases`

    const file = join(mkdtempSync(join(tmpdir(), 'dropper-guard-')), 'flagged.json')
    const server = createApp({ model, dataFile: file, openapi: '', alertWebhook: webhook, shadow: true }).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const body = await (
      await fetch(base + '/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ transfer_id: 'tr_shadow', recipient: dropper, context: pressured }),
      })
    ).json()

    expect(body).toMatchObject({ mode: 'shadow', action: 'allow', recommended_action: 'hold', client_message: null })
    const queue = await (await fetch(base + '/alerts')).json()
    expect(queue.items[0]).toMatchObject({ transfer_id: 'tr_shadow', action: 'hold' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(calls).toBe(0)
    server.close()
    bank.close()
  })

  test('новый алерт сразу уходит в систему банка, если задан её адрес', async () => {
    const received: { priority: string; alert_id: string }[] = []
    const bank = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        received.push(JSON.parse(body))
        res.end()
      })
    }).listen(0, '127.0.0.1')
    await new Promise((resolve) => bank.once('listening', resolve))
    const webhook = `http://127.0.0.1:${(bank.address() as AddressInfo).port}/cases`

    const file = join(mkdtempSync(join(tmpdir(), 'dropper-guard-')), 'flagged.json')
    const server = createApp({ model, dataFile: file, openapi: '', alertWebhook: webhook }).listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const response = await fetch(base + '/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: dropper, context: pressured }),
    })
    const scored = await response.json()

    await expect.poll(() => received.length).toBe(1)
    expect(received[0]).toMatchObject({ alert_id: scored.alert_id, priority: 'high' })
    server.close()
    bank.close()
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
