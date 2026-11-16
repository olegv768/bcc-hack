import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from '../app.ts'
import { loadModel } from '../model.ts'
import { createDemoGraphSource } from './demo-source.ts'
import { createInvestigator } from './investigate.ts'
import type { Investigation, LinkFilter } from './types.ts'

const ALL: LinkFilter[] = ['transfer', 'device', 'ip', 'phone', 'card']
const source = createDemoGraphSource()
const investigator = createInvestigator(source, { links: ALL })
const role = (id: string) => investigator.assess(id)?.role

describe('роли в сети', () => {
  test('транзитные счета, сборщик, пострадавшие и подтверждённое дело различаются', () => {
    for (const drop of ['tok_02d9fc', 'tok_e8a670', 'tok_a3c117', 'tok_b7e402', 'tok_e1d550', 'tok_e2a881']) expect(role(drop)).toBe('possible_dropper')
    expect(role('tok_c011ec')).toBe('possible_collector')
    for (const victim of ['cl_80101', 'cl_80102', 'cl_80103', 'cl_81201']) expect(role(victim)).toBe('possible_victim')
    expect(role('tok_x9f201')).toBe('confirmed_fraud')
  })

  test('продавец с десятками покупателей и семья с общим планшетом не попадают в схему', () => {
    expect(role('tok_19bd05')).toBe('busy_legit')
    expect(role('cl_51007')).toBe('regular')
    expect(role('cl_51008')).toBe('regular')
    expect(role('cl_48213')).toBe('regular')
  })

  test('ни один обычный клиент не получает роль дропа или сборщика', () => {
    const graph = investigator.investigate('ip_pub', 3, [])
    const regulars = graph.nodes.filter((n) => n.id.startsWith('cl_6'))
    expect(regulars.length).toBeGreaterThan(5)
    for (const n of regulars) expect(['regular', 'busy_legit']).toContain(n.assessment?.role)
  })

  test('вывод модуля не бывает увереннее 0,9 и всегда с источником; 0,95 — только решение банка', () => {
    const graph = investigator.investigate('tok_c011ec', 3, [])
    for (const n of graph.nodes) {
      if (!n.assessment) continue
      expect(n.assessment.confidence.value).toBeLessThanOrEqual(n.assessment.role === 'confirmed_fraud' ? 0.95 : 0.9)
      for (const e of n.assessment.evidence) expect(e.source).toBeTruthy()
    }
    for (const f of graph.findings) {
      expect(f.sources.length).toBeGreaterThan(0)
      expect(f.explanation.length).toBeGreaterThan(10)
      // слово «мошенник» модуль не произносит: только решения банка называют мошенничество
      if (f.kind !== 'confirmed_link') expect(f.title + f.explanation).not.toMatch(/мошенник/i)
    }
  })
})

describe('граф и находки', () => {
  const graph: Investigation = investigator.investigate('tok_02d9fc', 2, [])
  const kinds = graph.findings.map((f) => f.kind)

  test('от подозрительного счёта граф доходит до сборщика, общих устройств и подтверждённого дела', () => {
    const ids = graph.nodes.map((n) => n.id)
    expect(ids).toEqual(expect.arrayContaining(['tok_c011ec', 'dev_A1', 'cl_80101', 'tok_x9f201']))
    expect(kinds).toEqual(expect.arrayContaining(['confirmed_link', 'transit', 'shared_identifier', 'victims']))
    expect(graph.fraud_paths[0]!.target).toMatch(/x9f201|55102/)
    expect(graph.routes[0]!.nodes[0]).toMatch(/tok_v8010/)
    for (const e of graph.edges) {
      expect(ids).toContain(e.source)
      expect(ids).toContain(e.target)
    }
  })

  test('повторяющаяся схема находится у сборщика', () => {
    const collector = investigator.investigate('tok_c011ec', 2, [])
    const pattern = collector.findings.find((f) => f.kind === 'repeated_pattern' && f.node_ids[0] === 'tok_c011ec')
    expect(pattern).toBeDefined()
    expect(pattern!.node_ids.length).toBeGreaterThan(6)
  })

  test('глубина и раскрытие узла добавляют связи', () => {
    const one = investigator.investigate('tok_02d9fc', 1, [])
    const three = investigator.investigate('tok_02d9fc', 3, [])
    expect(three.nodes.length).toBeGreaterThan(one.nodes.length)
    const expanded = investigator.investigate('tok_02d9fc', 1, ['tok_c011ec'])
    expect(expanded.nodes.length).toBeGreaterThan(one.nodes.length)
  })

  test('общий Wi-Fi показан, но не раскрывается и не даёт пути к делу', () => {
    const victim = investigator.investigate('cl_80104', 2, [])
    const wifi = victim.nodes.find((n) => n.id === 'ip_pub')
    expect(wifi?.capped).toBe(true)
    const finding = victim.findings.find((f) => f.id === 'shared:ip_pub')
    expect(finding?.confidence.level).toBe('low')
    for (const p of victim.fraud_paths) expect(p.hops.some((h) => h.from === 'ip_pub' || h.to === 'ip_pub')).toBe(false)
  })

  test('семейный планшет — слабая находка', () => {
    const family = investigator.investigate('dev_tab_fam', 1, [])
    expect(family.findings.find((f) => f.id === 'shared:dev_tab_fam')?.confidence.level).toBe('low')
  })

  test('фильтры по типу связей и сумме', () => {
    const money = createInvestigator(source, { links: ['transfer'] }).investigate('tok_02d9fc', 2, [])
    expect(money.nodes.some((n) => n.type === 'device' || n.type === 'ip')).toBe(false)
    const big = createInvestigator(source, { links: ALL, minAmount: 1_000_000 }).investigate('tok_02d9fc', 1, [])
    for (const e of big.edges.filter((x) => x.type === 'transfer')) for (const t of e.transfers!) expect(t.amount).toBeGreaterThanOrEqual(1_000_000)
  })
})

describe('HTTP: /graph', () => {
  let url = ''
  let close = () => {}
  beforeAll(async () => {
    const dataFile = join(mkdtempSync(join(tmpdir(), 'graph-')), 'flagged.json')
    const app = createApp({ model: loadModel(new URL('../../model/model.json', import.meta.url)), dataFile, openapi: '', demo: true })
    const server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    close = () => server.close()
  })
  afterAll(() => close())

  const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('сигнал основного антифрода открывает расследование вокруг счёта', async () => {
    const cases = await (await fetch(url + '/graph/cases')).json()
    expect(cases.items.map((c: { ref: string }) => c.ref)).toContain('AF-77105')
    const body = await (await post('/graph/investigate', { alert_id: 'AF-77105' })).json()
    expect(body.root).toBe('tok_02d9fc')
    expect(body.disclaimer).toMatch(/не объявляет/)
  })

  test('неизвестный счёт — 404, пустой запрос — 400', async () => {
    expect((await post('/graph/investigate', { entity_id: 'tok_nope' })).status).toBe(404)
    expect((await post('/graph/investigate', { depth: 2 })).status).toBe(400)
    expect((await post('/graph/investigate', { entity_id: 'tok_02d9fc', depth: 9 })).status).toBe(400)
  })

  test('перевод со стенда сразу виден в графе, а подтверждение аналитика делает счёт подтверждённым', async () => {
    const scored = await (
      await post('/score', {
        transfer_id: 'tr_stand_1',
        client_ref: 'cl_48213',
        recipient: { account_id: 'tok_e2a881', account_age_days: 15, unrelated_senders_7d: 4, fast_outflow_share_7d: 0.93, shared_device_accounts: 1 },
        context: { amount: 300000, sender_on_call: true, first_transfer_to_recipient: true, amount_to_typical_ratio: 12 },
      })
    ).json()
    expect(scored.alert_id).toBeTruthy()

    const cases = await (await fetch(url + '/graph/cases')).json()
    expect(cases.items.find((c: { ref: string }) => c.ref === scored.alert_id)?.entity_id).toBe('tok_e2a881')

    const graph = await (await post('/graph/investigate', { entity_id: 'cl_48213', depth: 1 })).json()
    const edge = graph.edges.find((e: { id: string }) => e.id === 'transfer:tok_5a8213:tok_e2a881')
    expect(edge.transfers[0].status).toMatch(/held|warned/)
    expect(graph.nodes.find((n: { id: string }) => n.id === 'cl_48213').assessment.role).toBe('possible_victim')

    const alert = (await (await fetch(url + '/alerts')).json()).items.find((a: { alert_id: string }) => a.alert_id === scored.alert_id)
    await fetch(url + '/alerts/' + alert.alert_id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'closed', resolution: 'fraud' }) })
    const details = await (await fetch(url + '/graph/entities/tok_e2a881')).json()
    expect(details.assessment.role).toBe('confirmed_fraud')
    expect(details.history.length).toBeGreaterThan(0)

    // закрытый алерт уходит из списка сигналов, но расследование по его номеру продолжается —
    // в том числе при смене фильтров (раньше здесь был ответ 404)
    const afterClose = await (await fetch(url + '/graph/cases')).json()
    expect(afterClose.items.map((c: { ref: string }) => c.ref)).not.toContain(alert.alert_id)
    for (const links of [['transfer'], ['device', 'phone'], []]) {
      const response = await post('/graph/investigate', { alert_id: alert.alert_id, links })
      expect(response.status).toBe(200)
      expect((await response.json()).root).toBe('tok_e2a881')
    }
  })

  test('поиск по имени и номеру перевода', async () => {
    const byName = await (await fetch(url + '/graph/search?q=' + encodeURIComponent('Самат'))).json()
    expect(byName.items[0].id).toBe('cl_70990')
    const byTransfer = await (await fetch(url + '/graph/search?q=tr_00001')).json()
    expect(byTransfer.transfer.id).toBe('tr_00001')
  })
})
