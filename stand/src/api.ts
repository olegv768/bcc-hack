// Запросы стенда к сервису оценки (через прокси Vite: /api/* → http://127.0.0.1:8787/*).

import type { Action, Lang } from '../../sdk/web/dropper-guard.ts'
import type { FeatureKey, RecipientFeatures, TransferContext } from '../../service/src/features.ts'
import type { FlaggedAccount } from '../../service/src/store.ts'

export type ScoreRequest = {
  transfer_id: string
  lang: Lang
  recipient: { account_id: string } & RecipientFeatures
  context: TransferContext
}

export type ScoreResponse = {
  request_id: string
  risk: number
  risk_level: 'low' | 'medium' | 'high'
  action: Action
  reasons: { code: string; text: string; contribution: number | null }[]
  client_message: { title: string; body: string } | null
  contributions: Record<FeatureKey, number>
  missing_features: FeatureKey[]
  model_version: string
}

const UNAVAILABLE = 'Сервис оценки не отвечает. Проверьте, что он запущен: npm run dev'

export async function score(request: ScoreRequest): Promise<ScoreResponse> {
  const response = await fetch('/api/score', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }).catch(() => null)
  if (!response || response.status >= 500) throw new Error(UNAVAILABLE)
  const body = await response.json()
  if (!response.ok) throw new Error(body.message ?? 'Сервис отклонил запрос')
  return body
}

export async function loadFlagged(): Promise<FlaggedAccount[]> {
  const response = await fetch('/api/flagged').catch(() => null)
  if (!response?.ok) throw new Error(UNAVAILABLE)
  return (await response.json()).items
}

export async function clearFlagged(): Promise<void> {
  await fetch('/api/flagged', { method: 'DELETE' })
}
