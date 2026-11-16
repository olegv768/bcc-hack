// Демонстрационный источник для расследования сети: вымышленный банк с двумя сетями дропов,
// пострадавшими, семьёй с общим планшетом, продавцом с сотнями покупателей и общественным Wi-Fi.
// В банке вместо него подключается адаптер к хранилищу банка с тем же интерфейсом BankGraphSource.
// Сверху накладывается живая очередь алертов сервиса: перевод со стенда сразу виден в графе.

import { createRng, uniform } from '../../../ml/random.ts'
import { money } from './investigate.ts'
import type { Alert } from '../alerts.ts'
import type { AntifraudMark, BankGraphSource, Entity, ExternalKind, IncomingCase, TechLink, TechLinkType, Transfer } from './types.ts'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

type Person = { id: string; name: string; account: string; opened: number; dormant?: number }

export function createDemoGraphSource(options: { now?: number; alerts?: () => Alert[] } = {}): BankGraphSource {
  const now = options.now ?? Date.now()
  const at = (daysAgo: number, minutes = 0) => new Date(now - daysAgo * DAY + minutes * MINUTE).toISOString()
  const rng = createRng(20261116)

  const entities = new Map<string, Entity>()
  const links: TechLink[] = []
  const transfers: Transfer[] = []
  const staticMarks = new Map<string, AntifraudMark[]>()
  const engineCases: IncomingCase[] = []
  let seq = 0

  const add = (entity: Entity) => entities.set(entity.id, entity)
  const link = (type: TechLinkType, from: string, to: string, firstDaysAgo: number, lastDaysAgo = 0) =>
    links.push({ type, from, to, first_seen: at(firstDaysAgo), last_seen: at(lastDaysAgo) })
  const send = (from: string, to: string, amount: number, daysAgo: number, minutes = 0, channel: Transfer['channel'] = 'p2p', purpose: Transfer['purpose'] = null) => {
    const transfer: Transfer = { id: 'tr_' + String(++seq).padStart(5, '0'), from, to, amount: Math.round(amount), at: at(daysAgo, minutes), channel, status: 'done', purpose }
    transfers.push(transfer)
    return transfer
  }
  const mark = (id: string, m: AntifraudMark) => staticMarks.set(id, [...(staticMarks.get(id) ?? []), m])

  // Клиент со счётом и картой. Устройство, телефон и IP подключаются отдельно: их и сравнивает модуль.
  const person = (p: Person) => {
    add({ id: p.id, type: 'client', label: p.name, attrs: { name: p.name } })
    add({
      id: p.account,
      type: 'account',
      label: 'Счёт ' + p.account,
      attrs: { owner: p.id, opened_at: at(p.opened), ...(p.dormant ? { dormant_days: p.dormant } : {}) },
    })
    const card = 'card_' + p.account.slice(-4)
    add({ id: card, type: 'card', label: 'Карта ···' + p.account.slice(-4), attrs: { owner: p.id, account: p.account } })
    link('owns', p.id, p.account, p.opened)
    link('card', p.account, card, Math.min(p.opened, 700))
    return p
  }
  const device = (id: string, label: string) => add({ id, type: 'device', label, attrs: {} })
  const ip = (id: string, label: string, note?: string) => add({ id, type: 'ip', label, attrs: note ? { note } : {} })
  const phone = (id: string, label: string) => add({ id, type: 'phone', label, attrs: {} })
  const external = (id: string, label: string, kind: ExternalKind) => add({ id, type: 'account', label, attrs: { external: kind } })

  // Своё устройство, телефон и домашний IP обычного клиента.
  const ownTech = (p: Person, ipId?: string) => {
    const tail = p.id.slice(-4)
    device('dev_' + tail, 'Телефон ·' + tail)
    phone('ph_' + tail, `+7 7${tail.slice(0, 2)} ··· ·· ${tail.slice(2)}`)
    link('device', p.id, 'dev_' + tail, Math.min(p.opened, 600), 0)
    link('phone', p.id, 'ph_' + tail, Math.min(p.opened, 900), 0)
    const home = ipId ?? 'ip_' + tail
    if (!ipId) ip(home, `IP 95.56.${Number(tail) % 250}.x`, 'домашний интернет')
    link('ip', p.id, home, 200, 0)
  }

  // --- внешние получатели: банк видит только сам перевод ---
  external('ext_bank_4471', 'Счёт в другом банке ···4471', 'other_bank')
  external('ext_exch', 'Криптобиржа, вывод', 'exchange')
  external('ext_cash', 'Снятие наличных, банкомат', 'cash')
  external('ext_supplier', 'Поставщик мебели, другой банк', 'other_bank')

  // --- клиент со стенда и его семья ---
  const aigerim = person({ id: 'cl_48213', name: 'Айгерим С.', account: 'tok_5a8213', opened: 2900 })
  ownTech(aigerim)
  const sister = person({ id: 'cl_51007', name: 'Сауле С.', account: 'tok_7f3a91', opened: 2100 })
  const mother = person({ id: 'cl_51008', name: 'Гульнар С.', account: 'tok_91be08', opened: 4100 })
  ownTech(sister)
  ownTech(mother)
  // общий семейный планшет: два клиента на одном устройстве — само по себе не признак мошенничества
  device('dev_tab_fam', 'Планшет ·fam')
  link('device', sister.id, 'dev_tab_fam', 400)
  link('device', mother.id, 'dev_tab_fam', 380)
  for (let m = 0; m < 3; m++) send(aigerim.account, sister.account, 30000, 3 + m * 30, 600)
  send(sister.account, mother.account, 25000, 10, 300)
  send(mother.account, aigerim.account, 15000, 21, 200)

  const landlord = person({ id: 'cl_33410', name: 'Бахыт Ж.', account: 'tok_c40e22', opened: 1200 })
  ownTech(landlord)
  send(aigerim.account, landlord.account, 180000, 14, 540)

  // --- продавец: много разных покупателей, но деньги остаются на счёте и уходят поставщику раз в неделю ---
  const seller = person({ id: 'cl_20071', name: 'ИП Ермеков (мебель)', account: 'tok_19bd05', opened: 700 })
  ownTech(seller)
  send(aigerim.account, seller.account, 94000, 18, 700)

  // --- обычные клиенты; часть ходит через общественный Wi-Fi торгового центра ---
  ip('ip_pub', 'IP 37.150.0.x', 'Wi-Fi торгового центра, общий для сотен посетителей')
  const NAMES = ['Азамат', 'Динара', 'Ерболат', 'Камила', 'Олжас', 'Сабина', 'Жандос', 'Меруерт', 'Нуржан', 'Алия', 'Берик', 'Томирис',
    'Канат', 'Айжан', 'Серик', 'Лаура', 'Максат', 'Индира', 'Талгат', 'Зарина', 'Ринат', 'Эльмира', 'Асан', 'Гаухар']
  const regulars: Person[] = NAMES.map((name, i) =>
    person({ id: 'cl_6' + String(1000 + i * 37), name: name + ' ' + 'АБДЕЖКМНОРСТ'[i % 12] + '.', account: 'tok_r' + (4000 + i * 53).toString(16), opened: Math.round(uniform(rng, 500, 4000)) }),
  )
  regulars.forEach((p, i) => {
    ownTech(p)
    if (i % 2 === 0) link('ip', p.id, 'ip_pub', 30, Math.round(uniform(rng, 0, 20)))
  })
  regulars.forEach((p, i) => {
    // покупки у продавца
    if (i < 20) send(p.account, seller.account, Math.round(uniform(rng, 25, 260)) * 1000, uniform(rng, 0.5, 28), Math.round(uniform(rng, 0, 600)))
    // переводы друзьям
    const friend = regulars[(i * 7 + 3) % regulars.length]!
    if (friend !== p) send(p.account, friend.account, Math.round(uniform(rng, 3, 40)) * 1000, uniform(rng, 1, 25))
    if (i < 2) send(p.account, landlord.account, 160000, 12 + i, 300)
  })
  for (let week = 0; week < 4; week++) send(seller.account, 'ext_supplier', 450000 + week * 40000, 2 + week * 7, 480, 'interbank')

  // --- сеть А: «безопасный счёт». Четыре транзитных счёта, общее устройство и точка доступа, один сборщик ---
  ip('ip_A', 'IP 2.134.77.x', 'мобильная точка доступа')
  const drop1 = person({ id: 'cl_70114', name: 'Нурлан Е.', account: 'tok_02d9fc', opened: 4 })
  const drop2 = person({ id: 'cl_70215', name: 'Арман Т.', account: 'tok_e8a670', opened: 900, dormant: 310 })
  const drop3 = person({ id: 'cl_70316', name: 'Дана К.', account: 'tok_a3c117', opened: 12 })
  const drop4 = person({ id: 'cl_70417', name: 'Ильяс М.', account: 'tok_b7e402', opened: 20 })
  const collector = person({ id: 'cl_70990', name: 'Самат Р.', account: 'tok_c011ec', opened: 60 })
  device('dev_A1', 'Телефон Android ·A1f3')
  device('dev_A2', 'Телефон Android ·77c0')
  for (const d of [drop1, drop2, drop3, drop4]) {
    const tail = d.id.slice(-4)
    phone('ph_' + tail, `+7 747 ··· ·· ${tail.slice(2)}`)
    link('phone', d.id, 'ph_' + tail, 30)
    link('ip', d.id, 'ip_A', 9, 0)
  }
  link('device', drop1.id, 'dev_A1', 4)
  link('device', drop2.id, 'dev_A1', 8)
  link('device', drop3.id, 'dev_A1', 11)
  link('device', drop3.id, 'dev_A2', 10)
  link('device', drop4.id, 'dev_A2', 19)
  device('dev_c0ll', 'iPhone ·c0ll')
  phone('ph_0990', '+7 778 ··· ·· 90')
  link('device', collector.id, 'dev_c0ll', 60)
  link('phone', collector.id, 'ph_0990', 60)
  link('ip', collector.id, 'ip_A', 6, 6) // один вход в мобильный банк с той же точки доступа

  // счёт по делу, закрытому как мошенничество: тот же телефон Android уже был у его владельца
  const past = person({ id: 'cl_55102', name: 'Ержан Б.', account: 'tok_x9f201', opened: 140 })
  link('device', past.id, 'dev_A2', 75, 52)
  phone('ph_5102', '+7 705 ··· ·· 02')
  link('phone', past.id, 'ph_5102', 140)
  send(past.account, collector.account, 1_450_000, 58, 120)
  send(collector.account, 'ext_exch', 1_380_000, 58, 230, 'interbank')
  for (const id of [past.id, past.account]) {
    mark(id, { kind: 'confirmed_fraud', ref: 'FR-2026-0412', at: at(50), note: 'Дело закрыто: счёт использовался для вывода похищенных денег, заблокирован' })
  }

  // пострадавшие: старые счета, по одному-два крупных перевода незнакомцу
  const victimsA: [Person, typeof drop1, number[], number, boolean][] = [
    [{ id: 'cl_80101', name: 'Галина П.', account: 'tok_v80101', opened: 3500 }, drop1, [1_200_000], 2, true],
    [{ id: 'cl_80102', name: 'Марат С.', account: 'tok_v80102', opened: 2600 }, drop2, [650_000], 3, true],
    [{ id: 'cl_80103', name: 'Людмила К.', account: 'tok_v80103', opened: 5200 }, drop3, [300_000, 280_000], 5, false],
    [{ id: 'cl_80104', name: 'Айдос Н.', account: 'tok_v80104', opened: 1900 }, drop4, [420_000], 6, true],
    [{ id: 'cl_80105', name: 'Роза Т.', account: 'tok_v80105', opened: 4400 }, drop1, [890_000], 1, true],
    [{ id: 'cl_80106', name: 'Виктор Л.', account: 'tok_v80106', opened: 3100 }, drop3, [510_000], 8, false],
  ]
  const collected: [number, number][] = [] // сколько и когда (в минутах от сейчас) пришло сборщику
  for (const [v, drop, amounts, daysAgo, onCall] of victimsA) {
    person(v)
    ownTech(v, v.id === 'cl_80104' ? 'ip_pub' : undefined)
    // обычная жизнь пострадавшего до мошенничества
    send(v.account, seller.account, Math.round(uniform(rng, 40, 120)) * 1000, daysAgo + uniform(rng, 5, 15))
    amounts.forEach((amount, k) => {
      const start = k * 50
      const tr = send(v.account, drop.account, amount, daysAgo, start)
      // дроп уводит 90–95% за 10–80 минут: часть сборщику, часть в другой банк
      const delay = start + 10 + Math.round(uniform(rng, 0, 70))
      const share = uniform(rng, 0.9, 0.95)
      send(drop.account, collector.account, amount * share * 0.7, daysAgo, delay)
      send(drop.account, 'ext_bank_4471', amount * share * 0.3, daysAgo, delay + 4, 'interbank')
      collected.push([amount * share * 0.7, daysAgo * 24 * 60 - delay])
      if (k === 0 && onCall) {
        mark(v.id, { kind: 'alert', ref: 'AF-' + (77000 + Number(v.id.slice(-3))), at: tr.at, note: 'Основной антифрод: перевод новому получателю во время звонка, клиент подтвердил', sender_on_call: true })
      }
    })
    mark(drop.account, { kind: 'alert', ref: 'AF-' + (77100 + Number(v.id.slice(-3))), at: at(daysAgo, 1), note: `Основной антифрод: крупный входящий перевод от ${v.name}, счёт получателя под наблюдением` })
  }
  // сборщик через 1–3 часа выводит на биржу и снимает наличные
  for (const [amount, minutesAgo] of collected) {
    const days = minutesAgo / (24 * 60)
    const delay = 60 + Math.round(uniform(rng, 0, 120))
    send(collector.account, 'ext_exch', amount * 0.6, days, delay, 'interbank')
    send(collector.account, 'ext_cash', Math.round((amount * 0.37) / 5000) * 5000, days, delay + 25, 'cash')
  }

  // --- сеть Б: «предоплата за товар по объявлению», мелкие суммы; оба держателя на одном номере телефона ---
  const dropB1 = person({ id: 'cl_71501', name: 'Асхат Ж.', account: 'tok_e1d550', opened: 9 })
  const dropB2 = person({ id: 'cl_71502', name: 'Тимур Б.', account: 'tok_e2a881', opened: 15 })
  phone('ph_B', '+7 776 ··· ·· 15')
  device('dev_B1', 'Телефон Android ·b1e5')
  device('dev_B2', 'Телефон Android ·b2a8')
  link('phone', dropB1.id, 'ph_B', 9)
  link('phone', dropB2.id, 'ph_B', 15)
  link('device', dropB1.id, 'dev_B1', 9)
  link('device', dropB2.id, 'dev_B2', 15)
  ip('ip_B', 'IP 178.89.4.x', 'домашний интернет')
  link('ip', dropB1.id, 'ip_B', 9, 0)
  link('ip', dropB2.id, 'ip_A', 3, 3) // скрытая связь с сетью А: один вход с той же точки доступа
  const victimsB: [Person, Person, number, number][] = [
    [{ id: 'cl_81201', name: 'Ольга В.', account: 'tok_w81201', opened: 2200 }, dropB1, 85_000, 4],
    [{ id: 'cl_81202', name: 'Бауыржан К.', account: 'tok_w81202', opened: 1700 }, dropB1, 120_000, 4],
    [{ id: 'cl_81203', name: 'Светлана Д.', account: 'tok_w81203', opened: 2900 }, dropB2, 60_000, 7],
    [{ id: 'cl_81204', name: 'Ербол А.', account: 'tok_w81204', opened: 800 }, dropB2, 95_000, 9],
  ]
  for (const [v, drop, amount, daysAgo] of victimsB) {
    person(v)
    ownTech(v)
    send(v.account, drop.account, amount, daysAgo, 120)
    send(drop.account, collector.account, amount * 0.93, daysAgo, 120 + 30 + Math.round(uniform(rng, 0, 40)))
  }

  // --- «треугольник»: честный продавец криптовалюты, чьими реквизитами расплатился мошенник ---
  // Продавец давно торгует USDT на P2P-площадке: покупатели платят ему с назначением «криптовалюта»,
  // через несколько часов он докупает USDT на бирже на свой счёт. Мошенник выставил на OLX «дешёвый
  // iPhone» и дал покупателям реквизиты продавца, а сам в это время купил у него USDT.
  const trader = person({ id: 'cl_90501', name: 'Ринат К. (продаёт USDT)', account: 'tok_p2p771', opened: 1600 })
  ownTech(trader)
  external('ext_exch_own', 'Криптобиржа, счёт владельца', 'exchange')
  regulars.slice(4, 12).forEach((p, i) => {
    const day = 2 + i * 2.5
    const amount = Math.round(uniform(rng, 60, 320)) * 1000
    send(p.account, trader.account, amount, day, 300, 'p2p', 'crypto_p2p')
    send(trader.account, 'ext_exch_own', amount * 0.99, day, 300 + 180 + Math.round(uniform(rng, 0, 240)), 'interbank')
  })
  const triangleVictims: [Person, number, number, string][] = [
    [{ id: 'cl_82301', name: 'Алмас Т.', account: 'tok_t82301', opened: 2400 }, 185_000, 3, 'iPhone 15 по объявлению на OLX'],
    [{ id: 'cl_82302', name: 'Жанар Е.', account: 'tok_t82302', opened: 3300 }, 240_000, 9, 'ноутбук по объявлению в Telegram'],
  ]
  for (const [v, amount, daysAgo, item] of triangleVictims) {
    person(v)
    ownTech(v)
    send(v.account, seller.account, Math.round(uniform(rng, 30, 90)) * 1000, daysAgo + 12)
    const tr = send(v.account, trader.account, amount, daysAgo, 420, 'p2p', 'goods')
    send(trader.account, 'ext_exch_own', amount * 0.99, daysAgo, 420 + 200, 'interbank')
    mark(v.id, { kind: 'complaint', ref: 'ЖБ-' + v.id.slice(-4), at: at(daysAgo - 1), note: `Жалоба клиента: оплатил ${item}, продавец пропал, товар не получен` })
    mark(trader.account, { kind: 'center', ref: 'АЦ-' + tr.id.slice(-5), at: at(daysAgo - 1), note: `Антифрод-центр Нацбанка: перевод ${money(amount)} от ${v.name} отмечен как мошеннический по жалобе отправителя` })
  }

  // сигналы основного антифрода, с которых сотрудник начинает расследование
  engineCases.push(
    { ref: 'AF-77105', source: 'antifraud_engine', entity_id: drop1.account, transfer_id: transfers.find((t) => t.from === 'tok_v80105' && t.to === drop1.account)?.id ?? null, amount: 890_000, at: at(1), priority: 'high',
      summary: 'Крупный перевод на счёт, открытый 4 дня назад; отправитель был на звонке' },
    { ref: 'AF-77093', source: 'antifraud_engine', entity_id: drop3.account, transfer_id: null, amount: null, at: at(5, 200), priority: 'medium',
      summary: 'Счёт за неделю получил деньги от трёх незнакомых отправителей' },
    { ref: 'AF-77051', source: 'antifraud_engine', entity_id: dropB1.account, transfer_id: null, amount: null, at: at(4, 300), priority: 'medium',
      summary: 'Входящие «предоплаты» от незнакомых людей уходят дальше за полчаса' },
    { ref: 'АЦ-2026-1187', source: 'antifraud_center', entity_id: trader.account, transfer_id: transfers.find((t) => t.from === 'tok_t82301' && t.to === trader.account)?.id ?? null, amount: 185_000, at: at(2), priority: 'high',
      summary: 'Антифрод-центр: банк отправителя сообщил о мошенничестве. Получатель — клиент нашего банка, продаёт USDT на P2P' },
    { ref: 'AF-76980', source: 'antifraud_engine', entity_id: seller.account, transfer_id: null, amount: null, at: at(6), priority: 'medium',
      summary: 'Много входящих от разных людей за неделю' },
  )

  // --- живая очередь алертов сервиса оценки поверх демонстрационных данных ---
  const live = () => options.alerts?.() ?? []
  const mainAccount = (clientId: string) => links.find((l) => l.type === 'owns' && l.from === clientId)?.to

  const liveTransfers = (): Transfer[] =>
    live().flatMap((a) => {
      const from = a.client_ref ? mainAccount(a.client_ref) : undefined
      if (!from || !entities.has(a.account_id)) return []
      return [{ id: a.transfer_id ?? a.alert_id, from, to: a.account_id, amount: a.amount, at: a.created_at, channel: 'p2p' as const, status: a.action === 'hold' ? ('held' as const) : ('warned' as const), purpose: a.signals?.purpose ?? null }]
    })

  const liveMarks = (id: string): AntifraudMark[] =>
    live().flatMap((a): AntifraudMark[] => {
      const out: AntifraudMark[] = []
      if (a.account_id === id || (entities.get(a.account_id)?.attrs.owner === id && entities.has(id))) {
        const kind = a.resolution === 'fraud' ? 'confirmed_fraud' : a.resolution === 'legit' ? 'cleared' : 'alert'
        const note =
          kind === 'confirmed_fraud' ? 'Аналитик подтвердил мошенничество по алерту' :
          kind === 'cleared' ? 'Аналитик закрыл алерт как ложное срабатывание' :
          `Сервис оценки: перевод ${a.action === 'hold' ? 'придержан' : 'с предупреждением'}, риск ${a.risk.toFixed(2)}`
        out.push({ kind, ref: a.alert_id, at: a.updated_at, note })
      }
      if (a.client_ref === id) {
        out.push({ kind: 'alert', ref: a.alert_id, at: a.created_at, note: 'Клиент получил предупреждение при переводе', sender_on_call: a.signals?.on_call ?? null, remote_access: a.signals?.remote_access ?? null })
      }
      return out
    })

  const allTransfers = () => [...transfers, ...liveTransfers()]

  return {
    entity: (id) => entities.get(id),
    links: (id) => links.filter((l) => l.from === id || l.to === id),
    transfers: (accountId) => allTransfers().filter((t) => t.from === accountId || t.to === accountId),
    transfer: (id) => allTransfers().find((t) => t.id === id),
    search(query, limit) {
      const q = query.trim().toLowerCase()
      if (!q) return []
      return [...entities.values()].filter((e) => e.id.toLowerCase().includes(q) || e.label.toLowerCase().includes(q)).slice(0, limit)
    },
    marks: (id) => [...(staticMarks.get(id) ?? []), ...liveMarks(id)],
    confirmedFraud() {
      const ids = new Set([...staticMarks].filter(([, ms]) => ms.some((m) => m.kind === 'confirmed_fraud')).map(([id]) => id))
      for (const a of live()) if (a.resolution === 'fraud' && entities.has(a.account_id)) ids.add(a.account_id)
      return [...ids]
    },
    incoming() {
      const fromQueue: IncomingCase[] = live()
        .filter((a) => a.status !== 'closed' && entities.has(a.account_id))
        .map((a) => ({
          ref: a.alert_id,
          source: 'alert_queue',
          entity_id: a.account_id,
          transfer_id: a.transfer_id ?? a.alert_id,
          amount: a.amount,
          at: a.created_at,
          priority: a.priority,
          summary: `Сервис оценки: ${a.action === 'hold' ? 'перевод придержан' : 'клиент предупреждён'}. ${a.triggers[0]?.text ?? ''}`.trim(),
        }))
      return [...fromQueue, ...engineCases]
    },
  }
}
