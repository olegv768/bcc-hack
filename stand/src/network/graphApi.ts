// Запросы вкладки «Network Investigation» к модулю расследования сети (/api/graph/*).

import type {
  AccountStats, AntifraudMark, Assessment, Entity, IncomingCase, Investigation, LinkFilter, TechLinkType,
} from '../../../service/src/graph/types.ts'

export type { Investigation, IncomingCase, LinkFilter }

export type Filters = { from?: string; to?: string; min_amount?: number; links: LinkFilter[] }

export type Target = { entity_id?: string; alert_id?: string; transfer_id?: string }

export type HistoryItem = {
  id: string
  at: string
  amount: number
  channel: string
  status: 'done' | 'warned' | 'held'
  direction: 'in' | 'out'
  account: string
  counterparty: string
  counterparty_label: string
}

export type EntityDetails = {
  entity: Entity
  assessment: Assessment | null
  marks: AntifraudMark[]
  stats: Record<string, AccountStats> | null
  shared_clients: number | null
  links: { type: TechLinkType; id: string; label: string; entity_type: Entity['type'] | null; first_seen: string; last_seen: string }[]
  history: HistoryItem[]
  history_total: number
}

const UNAVAILABLE = 'Модуль расследования не отвечает. Проверьте, что сервис запущен: npm run dev'

async function readJson<T>(response: Response | null): Promise<T> {
  if (!response || response.status >= 500) throw new Error(UNAVAILABLE)
  const body = await response.json().catch(() => null)
  if (body === null) throw new Error(UNAVAILABLE)
  if (!response.ok) throw new Error(body.message ?? 'Модуль отклонил запрос')
  return body as T
}

export async function loadCases(): Promise<IncomingCase[]> {
  return (await readJson<{ items: IncomingCase[] }>(await fetch('/api/graph/cases').catch(() => null))).items
}

export async function investigate(target: Target, depth: number, filters: Filters, expand: string[], signal?: AbortSignal): Promise<Investigation> {
  const response = await fetch('/api/graph/investigate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...target, depth, expand, ...filters }),
    signal,
  }).catch((e: Error) => {
    if (e.name === 'AbortError') throw e
    return null
  })
  return readJson(response)
}

export async function loadDetails(id: string, filters: Filters, signal?: AbortSignal): Promise<EntityDetails> {
  const params = new URLSearchParams({ links: filters.links.join(',') })
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.min_amount) params.set('min_amount', String(filters.min_amount))
  const response = await fetch(`/api/graph/entities/${encodeURIComponent(id)}?${params}`, { signal }).catch((e: Error) => {
    if (e.name === 'AbortError') throw e
    return null
  })
  return readJson(response)
}

export type SearchResult = {
  items: { id: string; type: Entity['type']; label: string }[]
  transfer: { id: string; from: string; to: string; amount: number; at: string } | null
}

export async function search(q: string, signal?: AbortSignal): Promise<SearchResult> {
  const response = await fetch('/api/graph/search?q=' + encodeURIComponent(q), { signal }).catch((e: Error) => {
    if (e.name === 'AbortError') throw e
    return null
  })
  return readJson(response)
}
