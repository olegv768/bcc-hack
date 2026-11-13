// Очередь алертов для антифрод-аналитика. Каждый перевод с рекомендацией «предупредить» или
// «придержать» становится алертом: система ведения инцидентов банка (Case Management) забирает
// очередь через GET /alerts или получает алерт сразу — на адрес из ALERT_WEBHOOK_URL.
// Здесь, как и в store.ts, хранение — память и один JSON-файл.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AccountHistory } from './model.ts'

export type AlertStatus = 'new' | 'in_progress' | 'closed'

export type Alert = {
  alert_id: string
  created_at: string
  updated_at: string
  priority: 'high' | 'medium'
  status: AlertStatus
  resolution: 'fraud' | 'legit' | null // итог разбора: пригодится как разметка для переобучения модели
  transfer_id: string | null
  // псевдоним клиента-отправителя: по нему система банка сама подставляет контакты; сервис их не знает
  client_ref: string | null
  account_id: string
  amount: number
  action: 'warn' | 'hold'
  risk: number
  triggers: { code: string; text: string }[]
  model_version: string
}

const MAX_ALERTS = 2000
const DAY_MS = 24 * 60 * 60 * 1000

export function createAlertQueue(file: string) {
  let alerts: Alert[] = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Alert[]) : []

  const save = () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(alerts, null, 2))
  }

  return {
    add(input: Omit<Alert, 'alert_id' | 'created_at' | 'updated_at' | 'priority' | 'status' | 'resolution'>): Alert {
      const now = new Date().toISOString()
      // высокий приоритет: перевод придержан или телефоном клиента управляют удалённо
      const urgent = input.action === 'hold' || input.triggers.some((t) => t.code === 'REMOTE_ACCESS')
      const alert: Alert = {
        alert_id: 'al_' + randomUUID().slice(0, 13),
        created_at: now,
        updated_at: now,
        priority: urgent ? 'high' : 'medium',
        status: 'new',
        resolution: null,
        ...input,
      }
      alerts = [alert, ...alerts].slice(0, MAX_ALERTS)
      save()
      return alert
    },

    // сначала высокий приоритет, внутри приоритета — новые сверху
    list(filter: { status?: AlertStatus; priority?: string; since?: string }) {
      return alerts
        .filter((a) => !filter.status || a.status === filter.status)
        .filter((a) => !filter.priority || a.priority === filter.priority)
        .filter((a) => !filter.since || a.created_at >= filter.since)
        .sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || b.created_at.localeCompare(a.created_at))
    },

    update(id: string, patch: { status: AlertStatus; resolution?: 'fraud' | 'legit' }): Alert | null {
      const alert = alerts.find((a) => a.alert_id === id)
      if (!alert) return null
      alert.status = patch.status
      alert.resolution = patch.status === 'closed' ? (patch.resolution ?? null) : null
      alert.updated_at = new Date().toISOString()
      save()
      return alert
    },

    // Повторный запрос по тому же переводу не должен плодить алерты.
    findByTransfer(transferId: string): Alert | undefined {
      return alerts.find((a) => a.transfer_id === transferId)
    },

    // Что очередь уже знает о счёте: итог последнего разбора и сколько других клиентов
    // за сутки получили предупреждение или приостановку при переводе на него.
    history(accountId: string, clientRef: string | null): AccountHistory {
      const forAccount = alerts.filter((a) => a.account_id === accountId)
      const lastClosed = forAccount.filter((a) => a.resolution).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]
      const dayAgo = new Date(Date.now() - DAY_MS).toISOString()
      const otherClients = new Set(
        forAccount.filter((a) => a.created_at >= dayAgo && a.client_ref && a.client_ref !== clientRef).map((a) => a.client_ref),
      )
      return {
        confirmedFraud: lastClosed?.resolution === 'fraud',
        confirmedLegit: lastClosed?.resolution === 'legit',
        otherClients24h: otherClients.size,
      }
    },

    clear() {
      alerts = []
      save()
    },
  }
}
