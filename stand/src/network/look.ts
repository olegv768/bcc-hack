// Как выглядит граф. Тип сущности — значок внутри узла, цвет — только роль.
// Роли различаются не одним цветом (красный и жёлтый путаются при дейтеранопии):
// признаки схемы — красная заливка, пострадавший и «много отправителей» — кольцо вокруг нейтрального узла.

import type { EntityType, GraphNode, Role } from '../../../service/src/graph/types.ts'

// цвета статусов проверены на тёмном фоне графа (#0d1530) скриптом проверки палитры
export const GRAPH = {
  bg: '#0d1530',
  node: '#1d2849',
  nodeLine: '#3b4a75',
  icon: '#c9d2ea',
  text: '#e6eaf5',
  pill: 'rgb(13 21 48 / 0.88)',
  pillLine: 'rgb(255 255 255 / 0.1)',
  edge: 'rgb(150 166 210 / 0.42)',
  edgeStrong: 'rgb(170 184 224 / 0.75)',
  edgeHover: 'rgb(214 222 245 / 0.85)',
  tech: 'rgb(150 166 210 / 0.3)',
  amount: '#f2c46b',
  critical: '#ec4f55',
  warning: '#e0a43a',
  good: '#24a86c',
  info: '#5b8def', // посредник P2P: не участник схемы, но его реквизиты использовали
}

// Значки 12×12, рисуются линией
export const ICON: Record<EntityType | 'external', string> = {
  client: 'M6 5.6a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6ZM1.8 11c.3-2.3 2-3.6 4.2-3.6s3.9 1.3 4.2 3.6',
  account: 'M1.3 4.4 6 1.6l4.7 2.8M2.6 5.6v3.8M5 5.6v3.8M7 5.6v3.8M9.4 5.6v3.8M1.3 10.6h9.4',
  card: 'M2.2 2.8h7.6a1.2 1.2 0 0 1 1.2 1.2v4a1.2 1.2 0 0 1-1.2 1.2H2.2A1.2 1.2 0 0 1 1 8V4a1.2 1.2 0 0 1 1.2-1.2ZM1 5h10M2.8 7.4h2.2',
  device: 'M4.4 1h3.2c.7 0 1.2.5 1.2 1.2v7.6c0 .7-.5 1.2-1.2 1.2H4.4c-.7 0-1.2-.5-1.2-1.2V2.2C3.2 1.5 3.7 1 4.4 1ZM5.4 9.2h1.2',
  ip: 'M6 11A5 5 0 1 0 6 1a5 5 0 0 0 0 10ZM1 6h10M6 1c1.3 1.4 2 3.1 2 5s-.7 3.6-2 5c-1.3-1.4-2-3.1-2-5s.7-3.6 2-5Z',
  phone: 'M3 1.4h1.7l.9 2.3-1.1.8a6 6 0 0 0 3 3l.8-1.1 2.3.9v1.7c0 .6-.5 1.1-1.1 1.1A8.5 8.5 0 0 1 1.9 2.5c0-.6.5-1.1 1.1-1.1Z',
  external: 'M7.2 1.5h3.3v3.3M10.5 1.5 5.6 6.4M9 7.2v2.6c0 .4-.3.7-.7.7H2.2a.7.7 0 0 1-.7-.7V3.7c0-.4.3-.7.7-.7h2.6',
}

type Style = {
  fill: string
  stroke: string
  icon: string
  ring?: string // цветное кольцо по краю узла
  outer?: { color: string; dashed: boolean } // второе кольцо снаружи
  dashed?: boolean
  swatch: string
}

export function roleStyle(n: { assessment?: { role: Role } | null; external?: string | null; capped?: boolean }): Style {
  const role = n.assessment?.role
  const base: Style = {
    fill: n.external ? GRAPH.bg : GRAPH.node,
    stroke: GRAPH.nodeLine,
    icon: GRAPH.icon,
    dashed: !!n.external || !!n.capped,
    swatch: GRAPH.nodeLine,
  }
  if (role === 'confirmed_fraud') return { ...base, fill: GRAPH.critical, stroke: GRAPH.critical, icon: '#fff', outer: { color: GRAPH.critical, dashed: false }, swatch: GRAPH.critical }
  if (role === 'possible_collector') return { ...base, fill: GRAPH.critical, stroke: GRAPH.critical, icon: '#fff', outer: { color: GRAPH.critical, dashed: true }, swatch: GRAPH.critical }
  if (role === 'possible_dropper') return { ...base, fill: GRAPH.critical, stroke: GRAPH.critical, icon: '#fff', swatch: GRAPH.critical }
  if (role === 'possible_victim') return { ...base, ring: GRAPH.warning, swatch: GRAPH.warning }
  if (role === 'busy_legit') return { ...base, ring: GRAPH.good, swatch: GRAPH.good }
  if (role === 'p2p_intermediary') return { ...base, ring: GRAPH.info, outer: { color: GRAPH.info, dashed: true }, swatch: GRAPH.info }
  return base
}

// для светлых панелей рядом с графом
export const ROLE_COLOR: Partial<Record<Role, string>> = {
  confirmed_fraud: '#d93b41',
  possible_collector: '#d93b41',
  possible_dropper: '#d93b41',
  possible_victim: '#d99a1e',
  busy_legit: '#1f9e63',
  p2p_intermediary: '#2f5bff',
}

export const TYPE_LABEL: Record<EntityType | 'external', string> = {
  client: 'Клиент',
  account: 'Счёт',
  card: 'Карта',
  device: 'Устройство',
  ip: 'IP-адрес',
  phone: 'Телефон',
  external: 'За пределами банка',
}

export const ROLE_SHORT: Record<Role, string> = {
  confirmed_fraud: 'Подтверждённое дело',
  possible_collector: 'Признаки сборщика',
  possible_dropper: 'Признаки дропа',
  possible_victim: 'Вероятно, пострадавший',
  p2p_intermediary: 'P2P-продавец: возможный «треугольник»',
  busy_legit: 'Много отправителей, не транзит',
  regular: 'Признаков схемы нет',
}

export const LEVEL_LABEL = { low: 'низкая', medium: 'средняя', high: 'высокая' } as const

export const LINK_LABEL = {
  transfer: 'Переводы',
  device: 'Общие устройства',
  ip: 'IP-адреса',
  phone: 'Телефоны',
  card: 'Карты',
  owns: 'Владелец',
} as const

export const typeKey = (n: Pick<GraphNode, 'type' | 'external'>) => (n.external ? 'external' : n.type)

export const money = (value: number) => Math.round(value).toLocaleString('ru-RU') + ' ₸'

export const shortMoney = (value: number) =>
  value >= 1_000_000
    ? (value / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' млн ₸'
    : value >= 1000
      ? Math.round(value / 1000).toLocaleString('ru-RU') + ' тыс. ₸'
      : money(value)

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10
  const mod100 = n % 100
  const word = mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many
  return `${n} ${word}`
}
