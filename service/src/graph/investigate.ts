// Расследование сети вокруг подозрительного счёта, клиента или перевода.
// Строит граф связей на несколько уровней, оценивает роль каждого счёта по прозрачным правилам
// и собирает находки. Ни одна находка не называет клиента мошенником: у каждой есть объяснение,
// источник данных и уровень уверенности, решение остаётся за сотрудником банка.

import type {
  AccountStats, Assessment, BankGraphSource, Confidence, Entity, Evidence, Finding, GraphEdge, GraphNode, GraphPath,
  InvestigateOptions, Investigation, LinkFilter, MoneyRoute, Role, TechLink, TechLinkType, Transfer,
} from './types.ts'

export const SOURCES = {
  payments: 'Платёжные данные банка',
  accounts: 'Справочник счетов банка',
  devices: 'Журнал входов в мобильный банк: устройства',
  ips: 'Журнал входов в мобильный банк: IP-адреса',
  phones: 'Справочник клиентов: номера телефонов',
  cases: 'Решения по делам (система ведения инцидентов банка)',
  engine: 'Основной антифрод банка: алерты',
  purpose: 'Назначение платежа, указанное отправителем',
  complaints: 'Обращения клиентов',
  center: 'Антифрод-центр Национального банка',
  module: 'Расчёт модуля по данным выше',
} as const

export const DISCLAIMER =
  'Граф — инструмент расследования, а не решение. Он не объявляет клиента мошенником: у каждого вывода указаны источник данных и уверенность. Решение принимает сотрудник банка.'

const MAX_NODES = 400
// узел с таким числом связей (общий Wi-Fi, NAT оператора, крупный продавец) показываем, но дальше не раскрываем
const CAP_TECH = 10
const CAP_ACCOUNT = 40
const INNOCENT_DETOUR = 2
const FAST_MINUTES = 120
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

// Вес шага при поиске пути: владение и карта — это одна и та же сторона, IP — самая слабая связь.
const STEP_COST: Record<TechLinkType | 'transfer', number> = { owns: 0, card: 0, transfer: 1, device: 1, phone: 1, ip: 2 }
const STEP_STRENGTH: Record<TechLinkType | 'transfer', number> = { owns: 1, card: 1, transfer: 0.9, device: 0.85, phone: 0.85, ip: 0.6 }

const ROLE_LABEL: Record<Role, string> = {
  confirmed_fraud: 'Подтверждённое мошенничество (решение банка)',
  possible_collector: 'Признаки сборщика: собирает деньги с транзитных счетов',
  possible_dropper: 'Признаки транзитного счёта (дропа)',
  possible_victim: 'Вероятно, пострадавший',
  p2p_intermediary: 'Продаёт криптовалюту на P2P: его реквизиты, похоже, использовали в «треугольнике»',
  busy_legit: 'Много отправителей, признаков транзита нет',
  regular: 'Признаков схемы не найдено',
}
const ROLE_RANK: Record<Role, number> = { confirmed_fraud: 6, possible_collector: 5, possible_dropper: 4, p2p_intermediary: 3, possible_victim: 2, busy_legit: 1, regular: 0 }

export const money = (value: number) => Math.round(value).toLocaleString('ru-RU') + ' ₸'
const pct = (share: number) => Math.round(share * 100) + '%'

export function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10
  const mod100 = n % 100
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many
  return `${n} ${word}`
}

// список имён в конце предложения: «Арман Т.» уже заканчивается точкой
const names = (list: string[]) => {
  const text = list.join(', ')
  return text.endsWith('.') ? text : text + '.'
}

export function duration(minutes: number): string {
  if (minutes < 60) return Math.max(1, Math.round(minutes)) + ' мин'
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60)
    const m = Math.round(minutes % 60)
    return m ? `${h} ч ${m} мин` : `${h} ч`
  }
  return Math.round(minutes / (24 * 60)) + ' дн.'
}

// Выводы модуля не поднимаются выше 0,9: 0,95 остаётся только для решений банка по делам.
export function confidence(value: number, max = 0.9): Confidence {
  const v = Math.round(Math.min(max, Math.max(0.05, value)) * 100) / 100
  return { value: v, level: v >= 0.7 ? 'high' : v >= 0.45 ? 'medium' : 'low' }
}

type Step = { to: string; type: TechLinkType | 'transfer'; edgeKey: string }

export function createInvestigator(source: BankGraphSource, options: Omit<InvestigateOptions, 'root' | 'depth' | 'expand'> & { now?: number }) {
  const now = options.now ?? Date.now()
  const enabled = new Set<LinkFilter>(options.links)
  const from = options.from ? Date.parse(options.from) : -Infinity
  const to = options.to ? Date.parse(options.to) : Infinity
  const minAmount = options.minAmount ?? 0

  const inPeriod = (t: Transfer) => {
    const time = Date.parse(t.at)
    return time >= from && time <= to && t.amount >= minAmount
  }
  const name = (id: string) => {
    const e = source.entity(id)
    if (!e) return id
    if (e.type === 'account' && e.attrs.owner) return source.entity(e.attrs.owner)?.label ?? e.label
    return e.label
  }

  const cache = new Map<string, unknown>()
  const memo = <T>(key: string, make: () => T): T => {
    if (!cache.has(key)) cache.set(key, make())
    return cache.get(key) as T
  }

  const periodTransfers = (accountId: string) => memo('tr:' + accountId, () => source.transfers(accountId).filter(inPeriod))

  const linkAllowed = (l: TechLink) => l.type === 'owns' || (l.type === 'card' ? enabled.has('card') : enabled.has(l.type))

  // клиенты, связанные с техническим идентификатором (устройство, IP, телефон)
  const techClients = (id: string) => memo('tc:' + id, () => [...new Set(source.links(id).filter((l) => l.to === id).map((l) => l.from))])

  const isCapped = (e: Entity) => {
    if (e.type === 'device' || e.type === 'ip' || e.type === 'phone') return techClients(e.id).length > CAP_TECH
    if (e.type === 'account') return new Set(periodTransfers(e.id).map((t) => (t.from === e.id ? t.to : t.from))).size > CAP_ACCOUNT
    return false
  }

  function steps(id: string): Step[] {
    return memo('st:' + id, () => {
      const out: Step[] = []
      for (const l of source.links(id)) {
        if (!linkAllowed(l)) continue
        const other = l.from === id ? l.to : l.from
        out.push({ to: other, type: l.type, edgeKey: `${l.type}:${l.from}:${l.to}` })
      }
      const entity = source.entity(id)
      if (entity?.type === 'account' && enabled.has('transfer')) {
        const seen = new Set<string>()
        for (const t of periodTransfers(id)) {
          const other = t.from === id ? t.to : t.from
          const key = `transfer:${t.from}:${t.to}`
          if (seen.has(key)) continue
          seen.add(key)
          out.push({ to: other, type: 'transfer', edgeKey: key })
        }
      }
      return out
    })
  }

  // ---------- финансовая активность счёта ----------

  function stats(accountId: string): AccountStats {
    return memo('stats:' + accountId, () => {
      const list = periodTransfers(accountId).filter((t) => t.status !== 'held')
      const incoming = list.filter((t) => t.to === accountId).sort((a, b) => a.at.localeCompare(b.at))
      const outgoing = list.filter((t) => t.from === accountId).sort((a, b) => a.at.localeCompare(b.at))
      const inflow = incoming.reduce((s, t) => s + t.amount, 0)
      const outflow = outgoing.reduce((s, t) => s + t.amount, 0)

      // сколько от каждого поступления ушло дальше в течение двух часов
      let fast = 0
      for (const t of incoming) {
        const start = Date.parse(t.at)
        const after = outgoing.filter((o) => Date.parse(o.at) >= start && Date.parse(o.at) - start <= FAST_MINUTES * MINUTE).reduce((s, o) => s + o.amount, 0)
        fast += Math.min(t.amount, after)
      }
      const holds = outgoing
        .map((o) => {
          const before = incoming.filter((t) => t.at <= o.at).at(-1)
          return before ? (Date.parse(o.at) - Date.parse(before.at)) / MINUTE : null
        })
        .filter((m): m is number => m !== null)
        .sort((a, b) => a - b)
      const opened = source.entity(accountId)?.attrs.opened_at
      return {
        inflow,
        outflow,
        incoming: incoming.length,
        outgoing: outgoing.length,
        senders: new Set(incoming.map((t) => t.from)).size,
        fast_share: inflow ? Math.min(1, fast / inflow) : 0,
        median_hold_minutes: holds.length ? holds[Math.floor(holds.length / 2)]! : null,
        age_days: opened ? Math.floor((now - Date.parse(opened)) / DAY) : null,
      }
    })
  }

  const isTransit = (accountId: string) => {
    const s = stats(accountId)
    return s.inflow >= 50_000 && s.outflow >= 0.8 * s.inflow && s.fast_share >= 0.6
  }

  const ownerOf = (accountId: string) => source.entity(accountId)?.attrs.owner

  // Продавец криптовалюты на P2P, которому платили «за товар»: признак «треугольника».
  // Нужны назначения платежей; без них банк такого продавца от сборщика не отличит.
  function p2pProfile(accountId: string) {
    return memo('p2p:' + accountId, () => {
      const list = periodTransfers(accountId)
      const incoming = list.filter((t) => t.to === accountId)
      const cryptoBuyers = new Set(incoming.filter((t) => t.purpose === 'crypto_p2p').map((t) => t.from)).size
      const outflow = list.filter((t) => t.from === accountId && t.status !== 'held')
      const toExchange = outflow.filter((t) => source.entity(t.to)?.attrs.external === 'exchange').reduce((a, t) => a + t.amount, 0)
      const out = outflow.reduce((a, t) => a + t.amount, 0)
      const goodsSenders = [...new Set(incoming.filter((t) => t.purpose === 'goods' || t.purpose === 'services').map((t) => t.from))]
      const age = stats(accountId).age_days ?? 0
      if (age < 180 || goodsSenders.length === 0 || (cryptoBuyers < 3 && (!out || toExchange / out < 0.5))) return null
      const complaints = goodsSenders.filter((a) => [...source.marks(a), ...source.marks(ownerOf(a) ?? '')].some((m) => m.kind === 'complaint'))
      return { cryptoBuyers, goodsSenders, complaints }
    })
  }
  const accountsOf = (clientId: string) => source.links(clientId).filter((l) => l.type === 'owns' && l.from === clientId).map((l) => l.to)
  const isConfirmed = (id: string) => source.marks(id).some((m) => m.kind === 'confirmed_fraud')

  // другие клиенты на тех же устройствах и номерах телефона, что и владелец счёта
  function sharedWith(clientId: string, type: 'device' | 'phone') {
    return source
      .links(clientId)
      .filter((l) => l.type === type && l.from === clientId)
      .map((l) => ({ id: l.to, others: techClients(l.to).filter((c) => c !== clientId) }))
      .filter((x) => x.others.length > 0 && x.others.length <= CAP_TECH)
  }

  // ---------- роль счёта ----------

  function assessAccount(accountId: string): Assessment | null {
    return memo('as:' + accountId, () => {
      const entity = source.entity(accountId)
      if (!entity || entity.attrs.external) return null
      const owner = entity.attrs.owner
      const marks = [...source.marks(accountId), ...(owner ? source.marks(owner) : [])]

      const confirmed = marks.filter((m) => m.kind === 'confirmed_fraud')
      if (confirmed.length) {
        return {
          role: 'confirmed_fraud',
          label: ROLE_LABEL.confirmed_fraud,
          confidence: confidence(0.95, 0.95),
          evidence: dedupe(confirmed.map((m) => ({ text: `${m.ref}: ${m.note}`, source: m.ref.startsWith('al_') ? SOURCES.engine : SOURCES.cases }))),
          caveat: 'Это решение банка по делу, а не вывод модуля.',
        }
      }

      const s = stats(accountId)
      const p2p = p2pProfile(accountId)
      if (p2p) {
        const evidence: Evidence[] = [
          { text: `${plural(p2p.cryptoBuyers, 'человек платил', 'человека платили', 'человек платили')} с назначением «покупка криптовалюты», деньги уходят на биржу на свой счёт — так работает продавец USDT на P2P-площадке.`, source: SOURCES.purpose },
          { text: `${names(p2p.goodsSenders.map(name))} указали назначение «оплата товара или услуги» — за товар, которого этот человек не продаёт.`, source: SOURCES.purpose },
        ]
        if (p2p.complaints.length) evidence.push({ text: `Из них жалуются, что товар не получили: ${names(p2p.complaints.map(name))}`, source: SOURCES.complaints })
        const center = marks.filter((m) => m.kind === 'center')
        if (center.length) evidence.push({ text: `Антифрод-центр передал ${plural(center.length, 'отметку', 'отметки', 'отметок')} о мошенничестве по входящим переводам (${center.map((m) => m.ref).join(', ')}).`, source: SOURCES.center })
        evidence.push({ text: `Счёт открыт ${Math.round((s.age_days ?? 0) / 365)} г. назад.`, source: SOURCES.accounts })
        return {
          role: 'p2p_intermediary',
          label: ROLE_LABEL.p2p_intermediary,
          confidence: confidence(0.5 + p2p.complaints.length * 0.12 + (center.length ? 0.1 : 0)),
          evidence,
          caveat: 'Скорее всего, владелец счёта сам пострадал: он отдал криптовалюту мошеннику за чужие деньги. Не блокируйте счёт — запросите у него ордера P2P-площадки за даты этих платежей: в них ник и реквизиты настоящего покупателя.',
        }
      }
      const evidence: Evidence[] = []
      let score = 0
      const transit = isTransit(accountId)

      if (transit) {
        score += 0.35
        evidence.push({
          text: `За период пришло ${money(s.inflow)}, ушло дальше ${money(s.outflow)} (${pct(s.outflow / s.inflow)}). ${pct(s.fast_share)} поступлений ушло в течение двух часов${s.median_hold_minutes !== null ? `, обычно через ${duration(s.median_hold_minutes)}` : ''}.`,
          source: SOURCES.payments,
        })
        if (s.senders >= 3) {
          score += 0.15
          evidence.push({ text: `Деньги пришли от ${plural(s.senders, 'отправителя', 'разных отправителей', 'разных отправителей')}.`, source: SOURCES.payments })
        }
      }
      if (s.age_days !== null && s.age_days < 30 && s.inflow > 0) {
        score += 0.1
        evidence.push({ text: `Счёт открыт ${s.age_days} дн. назад.`, source: SOURCES.accounts })
      }
      if ((entity.attrs.dormant_days ?? 0) >= 180) {
        score += 0.1
        evidence.push({ text: `До этих переводов счёт ${entity.attrs.dormant_days} дн. не использовался — так выглядят купленные или переданные счета.`, source: SOURCES.accounts })
      }

      if (owner) {
        for (const d of sharedWith(owner, 'device')) {
          const suspicious = d.others.some((c) => accountsOf(c).some((a) => isTransit(a) || isConfirmed(a)))
          score += suspicious ? 0.15 : 0.03
          evidence.push({
            text: `${source.entity(d.id)?.label ?? d.id}: с него входили ещё ${plural(d.others.length, 'клиент', 'клиента', 'клиентов')}: ${names(d.others.map(name))}${suspicious ? '' : ' Может быть семейным устройством.'}`,
            source: SOURCES.devices,
          })
        }
        for (const p of sharedWith(owner, 'phone')) {
          score += 0.2
          evidence.push({ text: `Тот же номер телефона указан у клиента: ${names(p.others.map(name))}`, source: SOURCES.phones })
        }
        // связь с подтверждённым делом через общее устройство или номер
        const viaTech = [...sharedWith(owner, 'device'), ...sharedWith(owner, 'phone')].flatMap((x) => x.others).filter(isConfirmed)
        if (viaTech.length) {
          score += 0.15
          evidence.push({ text: `Общее устройство или номер с клиентом из подтверждённого дела: ${names([...new Set(viaTech)].map(name))}`, source: SOURCES.cases })
        }
      }

      const partners = [...new Set(periodTransfers(accountId).map((t) => (t.from === accountId ? t.to : t.from)))]
      const confirmedPartners = partners.filter((p) => isConfirmed(p) || isConfirmed(ownerOf(p) ?? ''))
      if (confirmedPartners.length) {
        score += 0.15
        evidence.push({ text: `Переводы со счётом из подтверждённого дела: ${names(confirmedPartners.map(name))}`, source: SOURCES.cases })
      }

      const alerts = marks.filter((m) => m.kind === 'alert' && m.sender_on_call === undefined)
      if (alerts.length) {
        score += 0.1
        evidence.push({ text: `Антифрод уже выдавал по счёту ${plural(alerts.length, 'алерт', 'алерта', 'алертов')} (${alerts.map((m) => m.ref).slice(0, 3).join(', ')}).`, source: SOURCES.engine })
      }
      const cleared = marks.filter((m) => m.kind === 'cleared')
      if (cleared.length) {
        score -= 0.3
        evidence.push({ text: `Сотрудник закрыл алерт ${cleared[0]!.ref} как ложное срабатывание.`, source: SOURCES.engine })
      }

      // сборщик: принимает деньги с нескольких транзитных счетов
      const transitSenders = [...new Set(periodTransfers(accountId).filter((t) => t.to === accountId).map((t) => t.from))].filter(
        (a) => a !== accountId && isTransit(a),
      )
      if (transitSenders.length >= 2 && s.outflow >= 0.6 * s.inflow) {
        const out = periodTransfers(accountId).filter((t) => t.from === accountId)
        const cashOut = out.filter((t) => ['exchange', 'cash'].includes(source.entity(t.to)?.attrs.external ?? '')).reduce((sum, t) => sum + t.amount, 0)
        evidence.unshift({ text: `Получал деньги от ${plural(transitSenders.length, 'счёта', 'счетов', 'счетов')} с признаками транзита: ${names(transitSenders.map(name))}`, source: SOURCES.module })
        if (cashOut) evidence.push({ text: `${money(cashOut)} выведено на биржу или снято наличными.`, source: SOURCES.payments })
        return {
          role: 'possible_collector',
          label: ROLE_LABEL.possible_collector,
          confidence: confidence(score + 0.25 + Math.min(0.3, transitSenders.length * 0.05) + (cashOut ? 0.1 : 0)),
          evidence,
          caveat: 'Требует проверки сотрудником: модуль видит только переводы внутри банка и выход из него.',
        }
      }

      if (transit && score >= 0.45) {
        return {
          role: 'possible_dropper',
          label: ROLE_LABEL.possible_dropper,
          confidence: confidence(score),
          evidence,
          caveat: 'Владелец счёта может сам не знать, как используется его счёт. Требует проверки сотрудником.',
        }
      }

      // пострадавший: старый счёт, перевод (или попытка) на счёт с признаками транзита
      const sent = source.transfers(accountId).filter((t) => t.from === accountId && inPeriod(t))
      const triangleTarget = (t: Transfer) => (t.purpose === 'goods' || t.purpose === 'services') && !!p2pProfile(t.to)
      const suspiciousTargets = sent.filter((t) => t.to !== accountId && (isTransit(t.to) || isConfirmed(t.to) || triangleTarget(t)))
      if (suspiciousTargets.length && !transit && (s.age_days ?? 0) >= 180) {
        const victim: Evidence[] = []
        let v = 0.45
        for (const t of suspiciousTargets.slice(0, 3)) {
          const before = sent.filter((x) => x.to === t.to && x.at < t.at).length
          const status = t.status === 'held' ? ' (перевод придержан)' : t.status === 'warned' ? ' (с предупреждением)' : ''
          victim.push({
            text: triangleTarget(t)
              ? names([`Оплатил «товар» ${money(t.amount)} на счёт продавца криптовалюты: ${name(t.to)}${status}`])
              : names([`${before ? 'Перевёл' : 'Впервые перевёл'} ${money(t.amount)} на счёт с признаками транзита: ${name(t.to)}${status}`]),
            source: triangleTarget(t) ? SOURCES.purpose : SOURCES.payments,
          })
        }
        victim.push({ text: `Счёт открыт ${Math.round((s.age_days ?? 0) / 365)} г. назад, деньги на нём не задерживаются транзитом.`, source: SOURCES.accounts })
        v += 0.1
        const complaint = marks.find((m) => m.kind === 'complaint')
        if (complaint) {
          v += 0.15
          victim.push({ text: `${complaint.ref}: ${complaint.note}.`, source: SOURCES.complaints })
        }
        const pressure = marks.filter((m) => m.sender_on_call || m.remote_access)
        if (pressure.length) {
          v += 0.2
          victim.push({
            text: `Во время перевода ${pressure.some((m) => m.remote_access) ? 'телефоном могли управлять удалённо' : 'клиент разговаривал по телефону'} (${pressure[0]!.ref}).`,
            source: SOURCES.engine,
          })
        }
        if (score <= 0.1) v += 0.1
        return {
          role: 'possible_victim',
          label: ROLE_LABEL.possible_victim,
          confidence: confidence(v),
          evidence: victim,
          caveat: 'Отправитель может быть и соучастником. Уточните у клиента обстоятельства перевода.',
        }
      }

      if (s.senders >= 5 && !transit && (s.age_days ?? 0) >= 180) {
        return {
          role: 'busy_legit',
          label: ROLE_LABEL.busy_legit,
          confidence: confidence(0.6),
          evidence: [
            { text: `${s.senders} разных отправителей за период, но в течение двух часов дальше ушло только ${pct(s.fast_share)} поступлений.`, source: SOURCES.payments },
            { text: `Счёт открыт ${Math.round((s.age_days ?? 0) / 365 * 10) / 10} г. назад.`, source: SOURCES.accounts },
            ...evidence,
          ],
          caveat: 'Так выглядит продавец или сбор денег. Если покупатели жалуются, что не получили товар, — это другой сценарий, его граф не покажет.',
        }
      }

      return {
        role: 'regular',
        label: ROLE_LABEL.regular,
        confidence: confidence(Math.max(0.3, 0.75 - score)),
        evidence,
        caveat: null,
      }
    })
  }

  function assess(id: string): Assessment | null {
    const entity = source.entity(id)
    if (!entity) return null
    if (entity.type === 'account') return assessAccount(id)
    if (entity.type !== 'client') return null
    const own = accountsOf(id).map(assessAccount).filter((a): a is Assessment => a !== null)
    if (!own.length) return null
    return own.sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || b.confidence.value - a.confidence.value)[0]!
  }

  // ---------- граф ----------

  function investigate(root: string, depth: number, expand: string[], highlightTransfer?: string): Investigation {
    const level = new Map<string, number>()
    const capped = new Set<string>()
    let truncated = false

    // обход в ширину; владение и карта не тратят уровень: счёт, его владелец и карта — одна сторона
    const walk = (start: string, startLevel: number, budget: number) => {
      const deque: [string, number][] = [[start, 0]]
      const dist = new Map([[start, 0]])
      if (!level.has(start)) level.set(start, startLevel)
      while (deque.length) {
        const [id, d] = deque.shift()!
        if (d > (dist.get(id) ?? Infinity)) continue
        const entity = source.entity(id)
        if (!entity) continue
        if (isCapped(entity)) {
          capped.add(id)
          if (id !== start) continue
        }
        for (const step of steps(id)) {
          const nd = d + (STEP_COST[step.type] === 0 ? 0 : 1)
          if (nd > budget || nd >= (dist.get(step.to) ?? Infinity)) continue
          if (!level.has(step.to) && level.size >= MAX_NODES) {
            truncated = true
            continue
          }
          dist.set(step.to, nd)
          level.set(step.to, Math.min(level.get(step.to) ?? Infinity, startLevel + nd))
          if (STEP_COST[step.type] === 0) deque.unshift([step.to, nd])
          else deque.push([step.to, nd])
        }
      }
    }

    walk(root, 0, depth)
    for (const id of expand) if (level.has(id)) walk(id, level.get(id)!, 1)

    const fraudPaths = findFraudPaths(root)
    for (const path of fraudPaths) {
      for (const hop of path.hops) for (const id of [hop.from, hop.to]) if (!level.has(id)) level.set(id, depth + 1)
    }

    const ids = [...level.keys()]
    const edges = buildEdges(ids)
    const centrality = betweenness(ids, edges)

    const nodes: GraphNode[] = ids.map((id) => {
      const e = source.entity(id)!
      return {
        id,
        type: e.type,
        label: e.label,
        level: level.get(id)!,
        external: e.attrs.external ?? null,
        assessment: assess(id),
        marks: source.marks(id),
        centrality: Math.round((centrality.get(id) ?? 0) * 1000) / 1000,
        degree: edges.filter((x) => x.source === id || x.target === id).length,
        capped: capped.has(id) || isCapped(e),
      }
    })

    const routes = moneyRoutes(root, new Set(ids), highlightTransfer)
    return {
      root,
      generated_at: new Date(now).toISOString(),
      period: { from: options.from ?? null, to: options.to ?? null },
      nodes,
      edges,
      findings: findings(root, nodes, edges, fraudPaths),
      fraud_paths: fraudPaths,
      routes,
      truncated,
      disclaimer: DISCLAIMER,
    }
  }

  function buildEdges(ids: string[]): GraphEdge[] {
    const inGraph = new Set(ids)
    const edges = new Map<string, GraphEdge>()
    for (const id of ids) {
      for (const l of source.links(id)) {
        if (!linkAllowed(l) || !inGraph.has(l.from) || !inGraph.has(l.to)) continue
        const key = `${l.type}:${l.from}:${l.to}`
        if (!edges.has(key)) edges.set(key, { id: key, type: l.type, source: l.from, target: l.to, first_seen: l.first_seen, last_seen: l.last_seen })
      }
      if (source.entity(id)?.type !== 'account' || !enabled.has('transfer')) continue
      for (const t of periodTransfers(id)) {
        if (t.from !== id || !inGraph.has(t.to)) continue
        const key = `transfer:${t.from}:${t.to}`
        const edge = edges.get(key) ?? { id: key, type: 'transfer', source: t.from, target: t.to, transfers: [], total: 0, first_seen: t.at, last_seen: t.at }
        edge.transfers!.push({ id: t.id, amount: t.amount, at: t.at, status: t.status })
        edge.total! += t.status === 'held' ? 0 : t.amount
        if (t.at < edge.first_seen) edge.first_seen = t.at
        if (t.at > edge.last_seen) edge.last_seen = t.at
        edges.set(key, edge)
      }
    }
    for (const e of edges.values()) e.transfers?.sort((a, b) => a.at.localeCompare(b.at))
    return [...edges.values()]
  }

  // ---------- путь до подтверждённых дел ----------

  function findFraudPaths(root: string): GraphPath[] {
    const targets = new Set(source.confirmedFraud())
    // ищем от каждой стороны корня: счёт → владелец, клиент → его счета
    const dist = new Map<string, number>([[root, 0]])
    const prev = new Map<string, { from: string; step: Step }>()
    const queue: [string, number][] = [[root, 0]]
    const found: string[] = []
    const MAX_COST = 6
    while (queue.length && found.length < 3) {
      queue.sort((a, b) => a[1] - b[1])
      const [id, d] = queue.shift()!
      if (d > (dist.get(id) ?? Infinity)) continue
      if (id !== root && targets.has(id) && !isSameParty(root, id)) {
        found.push(id)
        continue
      }
      const entity = source.entity(id)
      if (!entity || (id !== root && isCapped(entity))) continue // через общий Wi-Fi путь не ведём: это не связь людей
      const detour = id !== root && !isSameParty(root, id) && isInnocent(id)
      for (const step of steps(id)) {
        // путь через людей без признаков схемы (покупатель у продавца, семья) — слабая связь, обходим её, если можно
        const nd = d + STEP_COST[step.type] + (detour && STEP_COST[step.type] > 0 ? INNOCENT_DETOUR : 0)
        if (nd > MAX_COST || nd >= (dist.get(step.to) ?? Infinity)) continue
        dist.set(step.to, nd)
        prev.set(step.to, { from: id, step })
        queue.push([step.to, nd])
      }
    }

    // одно дело — один путь: счёт и клиент из одного дела не повторяем
    const seenCases = new Set<string>()
    return found.flatMap((target) => {
      const caseRef = source.marks(target).find((m) => m.kind === 'confirmed_fraud')?.ref ?? target
      if (seenCases.has(caseRef)) return []
      seenCases.add(caseRef)
      const hops: GraphPath['hops'] = []
      let cursor = target
      let strength = 1
      while (cursor !== root) {
        const p = prev.get(cursor)!
        hops.unshift({ from: p.from, to: cursor, edge_id: p.step.edgeKey, text: hopText(p.from, cursor, p.step) })
        strength *= STEP_STRENGTH[p.step.type]
        if (p.from !== root && !isSameParty(root, p.from) && STEP_COST[p.step.type] > 0 && isInnocent(p.from)) strength *= 0.5
        cursor = p.from
      }
      const via = [...new Set(hops.map((h) => h.from).filter((x) => x !== root && !isSameParty(root, x) && isInnocent(x)).map(name))]
      return [{ target, hops, via_innocent: via, confidence: confidence(strength) }]
    })
  }

  const isSameParty = (a: string, b: string) => ownerOf(a) === b || ownerOf(b) === a
  const isInnocent = (id: string) => ['regular', 'busy_legit', 'possible_victim', 'p2p_intermediary'].includes(assess(id)?.role ?? '')

  function hopText(fromId: string, toId: string, step: Step): string {
    if (step.type === 'owns') {
      const [, client, account] = step.edgeKey.split(':') as [string, string, string]
      return `Счёт ${account} принадлежит клиенту ${name(client)}`
    }
    if (step.type === 'card') return `Карта выпущена к счёту`
    if (step.type === 'transfer') {
      const [, a, b] = step.edgeKey.split(':') as [string, string, string]
      const list = periodTransfers(a).filter((t) => t.from === a && t.to === b)
      const total = list.reduce((s, t) => s + t.amount, 0)
      return `${name(a)} → ${name(b)}: ${plural(list.length, 'перевод', 'перевода', 'переводов')} на ${money(total)}`
    }
    const label = (id: string) => source.entity(id)?.label ?? id
    if (step.type === 'device') return source.entity(fromId)?.type === 'client' ? `${name(fromId)} входил(а) с устройства «${label(toId)}»` : `С устройства «${label(fromId)}» входил(а) ${name(toId)}`
    if (step.type === 'phone') return source.entity(fromId)?.type === 'client' ? `У ${name(fromId)} номер ${label(toId)}` : `Номер ${label(fromId)} указан у ${name(toId)}`
    return source.entity(fromId)?.type === 'client' ? `${name(fromId)} входил(а) с ${label(toId)}` : `С ${label(fromId)} входил(а) ${name(toId)}`
  }

  // ---------- центральные узлы: посредничество (Брандес) ----------

  function betweenness(ids: string[], edges: GraphEdge[]): Map<string, number> {
    const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
    for (const e of edges) {
      adj.get(e.source)?.push(e.target)
      adj.get(e.target)?.push(e.source)
    }
    const cb = new Map<string, number>(ids.map((id) => [id, 0]))
    for (const s of ids) {
      const stack: string[] = []
      const pred = new Map<string, string[]>()
      const sigma = new Map<string, number>([[s, 1]])
      const d = new Map<string, number>([[s, 0]])
      const queue = [s]
      for (let i = 0; i < queue.length; i++) {
        const v = queue[i]!
        stack.push(v)
        for (const w of adj.get(v)!) {
          if (!d.has(w)) {
            d.set(w, d.get(v)! + 1)
            queue.push(w)
          }
          if (d.get(w) === d.get(v)! + 1) {
            sigma.set(w, (sigma.get(w) ?? 0) + sigma.get(v)!)
            pred.set(w, [...(pred.get(w) ?? []), v])
          }
        }
      }
      const delta = new Map<string, number>()
      while (stack.length) {
        const w = stack.pop()!
        for (const v of pred.get(w) ?? []) delta.set(v, (delta.get(v) ?? 0) + (sigma.get(v)! / sigma.get(w)!) * (1 + (delta.get(w) ?? 0)))
        if (w !== s) cb.set(w, cb.get(w)! + (delta.get(w) ?? 0))
      }
    }
    const max = Math.max(...cb.values(), 1e-9)
    return new Map([...cb].map(([id, v]) => [id, v / max]))
  }

  // ---------- денежные маршруты ----------

  function moneyRoutes(root: string, inGraph: Set<string>, highlightTransfer?: string): MoneyRoute[] {
    const entity = source.entity(root)
    let accounts: string[] = []
    if (entity?.type === 'account') accounts = [root]
    else if (entity?.type === 'client') accounts = accountsOf(root)
    else if (entity?.type === 'card') accounts = entity.attrs.account ? [entity.attrs.account] : []
    else accounts = techClients(root).flatMap(accountsOf)

    const next = (t: Transfer) =>
      periodTransfers(t.to)
        .filter((o) => o.from === t.to && o.at > t.at && Date.parse(o.at) - Date.parse(t.at) <= DAY && o.status !== 'held')
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 3)
    const previous = (t: Transfer) =>
      periodTransfers(t.from)
        .filter((i) => i.to === t.from && i.at < t.at && Date.parse(t.at) - Date.parse(i.at) <= 3 * 60 * MINUTE)
        .sort((a, b) => b.at.localeCompare(a.at))[0]

    const chains: Transfer[][] = []
    const extend = (chain: Transfer[]) => {
      const options = chain.length < 5 ? next(chain.at(-1)!) : []
      if (!options.length) {
        if (chain.length >= 2) chains.push(chain)
        return
      }
      for (const o of options) extend([...chain, o])
    }
    const starts = accounts.flatMap((a) => periodTransfers(a).filter((t) => t.status !== 'held'))
    for (const t of starts) {
      let chain = [t]
      for (let i = 0; i < 2; i++) {
        const p = previous(chain[0]!)
        if (!p) break
        chain = [p, ...chain]
      }
      extend(chain)
    }

    const unique = new Map<string, Transfer[]>()
    for (const c of chains) {
      // маршрут, целиком содержащийся в другом, не показываем
      const key = c.map((t) => t.id).join('>')
      if (![...unique.keys()].some((k) => k.includes(key))) unique.set(key, c)
    }
    return [...unique.values()]
      // деньги, вернувшиеся к тому же счёту, — это расчёты между знакомыми, а не маршрут
      .filter((c) => new Set([c[0]!.from, ...c.map((t) => t.to)]).size === c.length + 1)
      .filter((c) => c.every((t) => inGraph.has(t.from) && inGraph.has(t.to)) || c.some((t) => t.id === highlightTransfer))
      .map((c) => {
        const nodes = [c[0]!.from, ...c.map((t) => t.to)]
        const minutes = (Date.parse(c.at(-1)!.at) - Date.parse(c[0]!.at)) / MINUTE
        return {
          transfers: c.map((t) => t.id),
          nodes,
          amount: c.at(-1)!.amount,
          minutes,
          text: `${nodes.map(name).join(' → ')}: ${money(c[0]!.amount)} вошло, ${money(c.at(-1)!.amount)} дошло до конца за ${duration(minutes)}`,
        }
      })
      .sort((a, b) => Number(b.transfers.includes(highlightTransfer ?? '')) - Number(a.transfers.includes(highlightTransfer ?? '')) || b.amount - a.amount)
      .slice(0, 8)
  }

  // ---------- находки ----------

  function findings(root: string, nodes: GraphNode[], edges: GraphEdge[], paths: GraphPath[]): Finding[] {
    const out: Finding[] = []
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const roleOf = (id: string) => byId.get(id)?.assessment?.role

    for (const path of paths) {
      const ref = source.marks(path.target).find((m) => m.kind === 'confirmed_fraud')?.ref ?? ''
      out.push({
        id: 'path:' + path.target,
        kind: 'confirmed_link',
        title: `Связь с подтверждённым делом ${ref}: ${plural(path.hops.filter((h) => !h.edge_id.startsWith('owns') && !h.edge_id.startsWith('card')).length, 'шаг', 'шага', 'шагов')}`,
        explanation:
          path.hops.filter((h) => !h.edge_id.startsWith('card')).map((h) => h.text).join('; ') + '.' +
          (path.via_innocent.length ? ` Путь проходит через клиентов без признаков схемы (${path.via_innocent.join(', ')}) — связь слабая, скорее совпадение.` : ''),
        confidence: path.confidence,
        sources: [...new Set([SOURCES.cases, ...path.hops.map((h) => stepSource(h.edge_id))])],
        node_ids: [...new Set(path.hops.flatMap((h) => [h.from, h.to]))],
        edge_ids: path.hops.map((h) => h.edge_id),
      })
    }

    for (const n of nodes.filter((x) => x.type === 'account' && x.assessment?.role === 'p2p_intermediary')) {
      const p2p = p2pProfile(n.id)!
      const payers = p2p.goodsSenders
      out.push({
        id: 'triangle:' + n.id,
        kind: 'triangle',
        title: `Похоже на «треугольник»: реквизитами ${name(n.id)} расплатились за чужой товар`,
        explanation:
          `${names(payers.map(name))} оплатили «товар» на счёт человека, который продаёт криптовалюту на P2P${p2p.complaints.length ? `; ${plural(p2p.complaints.length, 'пожаловался', 'пожаловались', 'пожаловались')}, что товар не пришёл` : ''}. ` +
          'Мошенника в переводах нет: он купил криптовалюту у продавца, а заплатить за неё заставил покупателей своего объявления. ' +
          'Что делать: не блокировать счёт продавца; запросить у него ордера P2P-площадки за даты этих платежей — ник и реквизиты покупателя ведут к мошеннику; вернуть деньги пострадавшим через Антифрод-центр Национального банка.',
        confidence: n.assessment!.confidence,
        sources: [SOURCES.purpose, SOURCES.complaints, SOURCES.center, SOURCES.payments],
        node_ids: [n.id, ...(ownerOf(n.id) ? [ownerOf(n.id)!] : []), ...payers, ...payers.map((p) => ownerOf(p) ?? p)],
        edge_ids: payers.map((p) => `transfer:${p}:${n.id}`),
      })
    }

    for (const n of nodes.filter((x) => x.type === 'account' && (x.assessment?.role === 'possible_collector' || x.assessment?.role === 'possible_dropper'))) {
      const a = n.assessment!
      out.push({
        id: 'role:' + n.id,
        kind: a.role === 'possible_collector' ? 'collector' : 'transit',
        title: `${a.role === 'possible_collector' ? 'Сборщик' : 'Транзитный счёт'}: ${name(n.id)}`,
        explanation: a.evidence.map((e) => e.text).join(' '),
        confidence: a.confidence,
        sources: [...new Set(a.evidence.map((e) => e.source))],
        node_ids: [n.id, ...(ownerOf(n.id) && byId.has(ownerOf(n.id)!) ? [ownerOf(n.id)!] : [])],
        edge_ids: edges.filter((e) => e.type === 'transfer' && (e.source === n.id || e.target === n.id)).map((e) => e.id),
      })
    }

    // общие идентификаторы: устройство, номер или IP у двух и более клиентов
    for (const n of nodes.filter((x) => x.type === 'device' || x.type === 'phone' || x.type === 'ip')) {
      const clients = techClients(n.id).filter((c) => byId.has(c))
      if (clients.length < 2) continue
      const suspicious = clients.filter((c) => ['possible_dropper', 'possible_collector', 'confirmed_fraud'].includes(roleOf(c) ?? '')).length
      const base = n.type === 'phone' ? 0.8 : n.type === 'device' ? 0.7 : 0.45
      const value = n.capped ? 0.1 : suspicious >= 2 ? base : suspicious === 1 ? base * 0.7 : base * 0.45
      const what = n.type === 'phone' ? 'Один номер телефона' : n.type === 'device' ? 'Одно устройство' : 'Один IP-адрес'
      const note = n.capped
        ? ' Это общая сеть, через неё входят сотни людей — само по себе связь не доказывает.'
        : suspicious === 0
          ? n.type === 'ip' ? ' Может быть общей домашней или рабочей сетью.' : ' Может быть семейным устройством: у этих клиентов нет признаков схемы.'
          : ` Из них с признаками схемы: ${suspicious}.`
      out.push({
        id: 'shared:' + n.id,
        kind: 'shared_identifier',
        title: `${what} у ${n.capped ? 'многих клиентов' : plural(clients.length, 'клиента', 'клиентов', 'клиентов')}: ${n.label}`,
        explanation: (n.capped ? `${what} у ${plural(techClients(n.id).length, 'клиента', 'клиентов', 'клиентов')} банка.` : names(clients.map(name))) + note,
        confidence: confidence(value),
        sources: [n.type === 'phone' ? SOURCES.phones : n.type === 'device' ? SOURCES.devices : SOURCES.ips],
        node_ids: [n.id, ...clients],
        edge_ids: edges.filter((e) => e.source === n.id || e.target === n.id).map((e) => e.id),
      })
    }

    // повторяющаяся схема: разные люди → транзитный счёт → один и тот же получатель, каждый раз за пару часов
    const chains = new Map<string, { senders: Set<string>; drops: Set<string>; edges: Set<string>; minutes: number[] }>()
    for (const n of nodes.filter((x) => x.type === 'account' && isTransit(x.id))) {
      const list = periodTransfers(n.id)
      for (const out of list.filter((t) => t.from === n.id)) {
        const input = list.filter((t) => t.to === n.id && t.at <= out.at && Date.parse(out.at) - Date.parse(t.at) <= 3 * 60 * MINUTE).at(-1)
        if (!input || !byId.has(out.to) || !byId.has(input.from)) continue
        const c = chains.get(out.to) ?? { senders: new Set(), drops: new Set(), edges: new Set(), minutes: [] }
        c.senders.add(input.from)
        c.drops.add(n.id)
        c.edges.add(`transfer:${input.from}:${n.id}`).add(`transfer:${n.id}:${out.to}`)
        c.minutes.push((Date.parse(out.at) - Date.parse(input.at)) / MINUTE)
        chains.set(out.to, c)
      }
    }
    for (const [target, c] of chains) {
      if (c.senders.size < 2 || c.drops.size < 2) continue
      const min = Math.min(...c.minutes)
      const max = Math.max(...c.minutes)
      out.push({
        id: 'pattern:' + target,
        kind: 'repeated_pattern',
        title: `Повторяющаяся схема: ${plural(c.senders.size, 'отправитель', 'отправителя', 'отправителей')} → ${plural(c.drops.size, 'транзитный счёт', 'транзитных счёта', 'транзитных счетов')} → ${name(target)}`,
        explanation: `${plural(c.minutes.length, 'раз', 'раза', 'раз')} деньги разных людей проходили через транзитный счёт и уходили к одному получателю через ${duration(min)}–${duration(max)}. Одинаковый маршрут у не связанных между собой отправителей редко бывает случайным.`,
        confidence: confidence(0.5 + Math.min(0.35, c.senders.size * 0.05)),
        sources: [SOURCES.payments, SOURCES.module],
        node_ids: [target, ...c.drops, ...c.senders],
        edge_ids: [...c.edges],
      })
    }

    const victims = nodes.filter((n) => n.type === 'client' && n.assessment?.role === 'possible_victim')
    if (victims.length) {
      out.push({
        id: 'victims',
        kind: 'victims',
        title: `Вероятно, пострадавшие: ${victims.length}`,
        explanation: `${names(victims.map((v) => v.label))} Старые счета, обычная история операций, крупный перевод на счёт с признаками транзита или «за товар» продавцу криптовалюты. Их не стоит смешивать с участниками схемы — им нужен звонок банка.`,
        confidence: confidence(victims.reduce((s, v) => s + v.assessment!.confidence.value, 0) / victims.length),
        sources: [SOURCES.payments, SOURCES.accounts, SOURCES.engine],
        node_ids: victims.map((v) => v.id),
        edge_ids: [],
      })
    }

    const central = nodes
      .filter((n) => (n.type === 'account' || n.type === 'client') && !n.external && n.centrality >= 0.25 && n.id !== root)
      // люди без признаков схемы оказываются «мостами» из-за обычных покупок и семьи — центром сети их не называем
      .filter((n) => !['possible_victim', 'busy_legit', 'regular', 'p2p_intermediary'].includes(n.assessment?.role ?? 'regular'))
      .sort((a, b) => b.centrality - a.centrality)
      // счёт и его владелец — одна сторона: называем один раз
      .filter((n, i, list) => list.findIndex((x) => name(x.id) === name(n.id)) === i)
      .slice(0, 3)
    for (const n of central) {
      out.push({
        id: 'central:' + n.id,
        kind: 'central_node',
        title: `Центральный узел: ${name(n.id)}`,
        explanation: `Через этот узел проходит больше всего кратчайших связей построенной сети (посредничество ${Math.round(n.centrality * 100)} из 100, ${plural(n.degree, 'связь', 'связи', 'связей')}). ${n.assessment ? 'Оценка: ' + n.assessment.label.toLowerCase() + '.' : ''} Центральность говорит о положении в сети, а не о вине.`,
        confidence: confidence(0.4 + n.centrality * 0.3),
        sources: [SOURCES.module],
        node_ids: [n.id],
        edge_ids: [],
      })
    }

    for (const n of nodes.filter((x) => x.type === 'account' && x.assessment?.role === 'busy_legit')) {
      out.push({
        id: 'legit:' + n.id,
        kind: 'not_suspicious',
        title: `Не похоже на транзит: ${name(n.id)}`,
        explanation: n.assessment!.evidence.map((e) => e.text).join(' ') + ' ' + (n.assessment!.caveat ?? ''),
        confidence: n.assessment!.confidence,
        sources: [SOURCES.payments, SOURCES.accounts],
        node_ids: [n.id],
        edge_ids: [],
      })
    }

    const order = ['confirmed_link', 'triangle', 'collector', 'repeated_pattern', 'transit', 'shared_identifier', 'victims', 'central_node', 'not_suspicious']
    // слабая связь с делом (через людей без признаков схемы) — в конец, к прочим заметкам
    const rank = (f: Finding) => (f.kind === 'confirmed_link' && f.confidence.level === 'low' ? order.length : order.indexOf(f.kind))
    return out.sort((a, b) => rank(a) - rank(b) || b.confidence.value - a.confidence.value)
  }

  const stepSource = (edgeId: string) => {
    const type = edgeId.split(':')[0]
    return type === 'transfer' ? SOURCES.payments : type === 'device' ? SOURCES.devices : type === 'phone' ? SOURCES.phones : type === 'ip' ? SOURCES.ips : SOURCES.accounts
  }

  // ---------- карточка узла ----------

  function details(id: string) {
    const entity = source.entity(id)
    if (!entity) return null
    const accounts = entity.type === 'client' ? accountsOf(id) : entity.type === 'account' ? [id] : entity.type === 'card' && entity.attrs.account ? [entity.attrs.account] : []
    const history = accounts
      .flatMap((a) =>
        periodTransfers(a).map((t) => ({
          id: t.id,
          at: t.at,
          amount: t.amount,
          channel: t.channel,
          status: t.status ?? 'done',
          direction: t.to === a ? ('in' as const) : ('out' as const),
          account: a,
          counterparty: t.to === a ? t.from : t.to,
          counterparty_label: name(t.to === a ? t.from : t.to),
        })),
      )
      .sort((a, b) => b.at.localeCompare(a.at))
    const links = source.links(id).map((l) => {
      const other = l.from === id ? l.to : l.from
      return { type: l.type, id: other, label: name(other), entity_type: source.entity(other)?.type ?? null, first_seen: l.first_seen, last_seen: l.last_seen }
    })
    return {
      entity,
      assessment: assess(id),
      marks: source.marks(id),
      stats: accounts.length ? Object.fromEntries(accounts.map((a) => [a, stats(a)])) : null,
      shared_clients: entity.type === 'device' || entity.type === 'ip' || entity.type === 'phone' ? techClients(id).length : null,
      links,
      history: history.slice(0, 200),
      history_total: history.length,
    }
  }

  return { investigate, details, assess, stats }
}

function dedupe(list: Evidence[]): Evidence[] {
  return list.filter((e, i) => list.findIndex((x) => x.text === e.text) === i)
}
