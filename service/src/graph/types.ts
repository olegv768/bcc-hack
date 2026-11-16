// Расследование сети: из каких сущностей и связей строится граф и что модуль отдаёт сотруднику.
// Модуль не хранит банковские данные у себя. Он читает их через BankGraphSource:
// в банке это адаптер к его хранилищу, на стенде — демонстрационный набор (demo-source.ts).

import type { Purpose } from '../features.ts'

export type EntityType = 'client' | 'account' | 'card' | 'device' | 'ip' | 'phone'

// external — счёт в другом банке, биржа или снятие наличных: банк видит только сам перевод туда
export type ExternalKind = 'other_bank' | 'exchange' | 'cash'

export type Entity = {
  id: string
  type: EntityType
  label: string
  // client: имя (на стенде вымышленное), owner для счёта и карты, opened_at, dormant_days, external
  attrs: {
    name?: string
    owner?: string // клиент, которому принадлежит счёт или карта
    account?: string // счёт, к которому выпущена карта
    opened_at?: string
    dormant_days?: number // сколько дней счёт не использовался перед последней активностью
    external?: ExternalKind
    note?: string
  }
}

// Технические связи и владение. Переводы — отдельно (Transfer): у них есть время и сумма.
export type TechLinkType = 'owns' | 'card' | 'device' | 'ip' | 'phone'

export type TechLink = {
  type: TechLinkType
  from: string // клиент или счёт
  to: string // счёт, карта, устройство, IP-адрес, телефон
  first_seen: string
  last_seen: string
}

export type Transfer = {
  id: string
  from: string // счёт
  to: string // счёт
  amount: number
  at: string
  channel: 'p2p' | 'interbank' | 'card' | 'cash'
  // live — перевод из очереди алертов: банк его предупредил или придержал, он мог и не пройти
  status?: 'done' | 'warned' | 'held'
  purpose?: Purpose | null // назначение, которое указал отправитель
}

// Что уже известно банку о сущности из основного антифрода и разборов дел.
export type AntifraudMark = {
  // complaint — обращение клиента («оплатил товар, товар не пришёл»); center — отметка Антифрод-центра Нацбанка
  kind: 'confirmed_fraud' | 'cleared' | 'alert' | 'complaint' | 'center'
  ref: string // номер дела или алерта
  at: string
  note: string
  // признаки с телефона клиента в момент перевода (только для отправителя в алерте)
  sender_on_call?: boolean | null
  remote_access?: boolean | null
}

export interface BankGraphSource {
  entity(id: string): Entity | undefined
  // все технические связи, где сущность с одной из сторон
  links(id: string): TechLink[]
  // входящие и исходящие переводы счёта
  transfers(accountId: string): Transfer[]
  transfer(id: string): Transfer | undefined
  search(query: string, limit: number): Entity[]
  // решения по прошлым делам и алерты основного антифрода
  marks(id: string): AntifraudMark[]
  // все сущности с подтверждённым мошенничеством: цели поиска пути
  confirmedFraud(): string[]
  // для очереди «что прислал антифрод»
  incoming(): IncomingCase[]
}

export type IncomingCase = {
  ref: string // номер алерта или сигнала основного антифрода
  source: 'alert_queue' | 'antifraud_engine' | 'antifraud_center'
  entity_id: string
  transfer_id: string | null
  amount: number | null
  at: string
  priority: 'high' | 'medium'
  summary: string
}

export type LinkFilter = 'transfer' | 'device' | 'ip' | 'phone' | 'card'

export type InvestigateOptions = {
  root: string
  depth: number
  from?: string
  to?: string
  minAmount?: number
  links: LinkFilter[]
  expand: string[] // узлы, раскрытые сотрудником ещё на уровень
  highlightTransfer?: string
}

export type Role =
  | 'confirmed_fraud' // решение банка по делу, не вывод модуля
  | 'possible_dropper' // транзитный счёт
  | 'possible_collector' // собирает деньги с транзитных счетов
  | 'possible_victim'
  | 'p2p_intermediary' // продаёт криптовалюту на P2P; его реквизитами могли расплатиться в «треугольнике»
  | 'busy_legit' // много отправителей, но деньги не уходят транзитом
  | 'regular'

export type Confidence = { value: number; level: 'low' | 'medium' | 'high' }

export type Evidence = { text: string; source: string }

export type Assessment = {
  role: Role
  label: string
  confidence: Confidence
  evidence: Evidence[]
  caveat: string | null
}

export type AccountStats = {
  inflow: number
  outflow: number
  incoming: number
  outgoing: number
  senders: number
  fast_share: number // доля поступившего, ушедшего дальше в течение 2 часов
  median_hold_minutes: number | null
  age_days: number | null
}

export type GraphNode = {
  id: string
  type: EntityType
  label: string
  level: number // на каком уровне от исходного узла найден
  external: ExternalKind | null
  assessment: Assessment | null
  marks: AntifraudMark[]
  centrality: number // 0..1, посредничество внутри построенного графа
  degree: number
  // узел с очень большим числом связей (общий Wi-Fi, NAT оператора): дальше не раскрывается
  capped: boolean
}

export type GraphEdge = {
  id: string
  type: TechLinkType | 'transfer'
  source: string
  target: string
  // для переводов: все переводы между двумя счетами за период
  transfers?: { id: string; amount: number; at: string; status: Transfer['status'] }[]
  total?: number
  first_seen: string
  last_seen: string
}

export type FindingKind = 'triangle' | 'transit' | 'collector' | 'shared_identifier' | 'repeated_pattern' | 'confirmed_link' | 'central_node' | 'victims' | 'not_suspicious'

export type Finding = {
  id: string
  kind: FindingKind
  title: string
  explanation: string
  confidence: Confidence
  sources: string[]
  node_ids: string[]
  edge_ids: string[]
}

export type GraphPath = {
  target: string
  hops: { from: string; to: string; edge_id: string; text: string }[]
  via_innocent: string[] // через кого из людей без признаков схемы проходит путь
  confidence: Confidence
}

export type MoneyRoute = {
  transfers: string[] // id переводов по порядку
  nodes: string[]
  amount: number // сколько дошло до конца маршрута
  minutes: number // от первого перевода до последнего
  text: string
}

export type Investigation = {
  root: string
  generated_at: string
  period: { from: string | null; to: string | null }
  nodes: GraphNode[]
  edges: GraphEdge[]
  findings: Finding[]
  fraud_paths: GraphPath[]
  routes: MoneyRoute[]
  truncated: boolean
  disclaimer: string
}
