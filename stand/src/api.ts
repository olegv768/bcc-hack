// Запросы стенда к сервису оценки (через прокси Vite: /api/* → http://127.0.0.1:8787/*).

import type { Action, Lang } from '../../sdk/web/dropper-guard.ts'
import type { FeatureKey, RecipientFeatures, TransferContext } from '../../service/src/features.ts'
import type { Alert } from '../../service/src/alerts.ts'
import type { FlaggedAccount } from '../../service/src/store.ts'

export type ScoreRequest = {
  transfer_id: string
  lang: Lang
  client_ref?: string
  recipient: { account_id: string } & RecipientFeatures
  context: TransferContext
}

export type ScoreResponse = {
  request_id: string
  risk: number
  risk_level: 'low' | 'medium' | 'high'
  action: Action
  alert_id: string | null
  reasons: { code: string; text: string; contribution: number | null }[]
  client_message: { title: string; body: string } | null
  contributions: Record<FeatureKey, number>
  missing_features: FeatureKey[]
  model_version: string
}

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname)
const UNAVAILABLE = LOCAL
  ? 'Сервис оценки не отвечает. Проверьте, что он запущен: npm run dev'
  : 'Сервис оценки не отвечает. Попробуйте ещё раз через минуту.'

// Ответ сервиса — всегда JSON. Если пришло что-то другое (страница ошибки хостинга, прокси),
// значит до сервиса запрос не дошёл.
async function readJson(response: Response | null) {
  if (!response || response.status >= 500) throw new Error(UNAVAILABLE)
  const body = await response.json().catch(() => null)
  if (body === null) throw new Error(UNAVAILABLE)
  if (!response.ok) throw new Error(body.message ?? 'Сервис отклонил запрос')
  return body
}

export async function score(request: ScoreRequest): Promise<ScoreResponse> {
  const response = await fetch('/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }).catch(() => null)
  return readJson(response)
}

export async function loadFlagged(): Promise<FlaggedAccount[]> {
  return (await readJson(await fetch('/api/flagged').catch(() => null))).items
}

export async function loadAlerts(): Promise<Alert[]> {
  return (await readJson(await fetch('/api/alerts').catch(() => null))).items
}

// Вместе с изменением шлём копию алерта: если сервис перезапустился и забыл очередь, он восстановит алерт по ней.
export async function updateAlert(alert: Alert, status: Alert['status'], resolution?: 'fraud' | 'legit'): Promise<Alert> {
  const response = await fetch('/api/alerts/' + encodeURIComponent(alert.alert_id), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, resolution, snapshot: alert }),
  }).catch(() => null)
  return readJson(response)
}

export async function clearFlagged(): Promise<void> {
  const response = await fetch('/api/flagged', { method: 'DELETE' }).catch(() => null)
  if (!response?.ok) throw new Error(UNAVAILABLE)
}
