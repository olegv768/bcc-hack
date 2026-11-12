// Помеченные счета для аналитика. Храним в памяти и в одном JSON-файле, чтобы пережить перезапуск.
// В банке вместо файла подключается его хранилище или очередь — интерфейс тот же.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FeatureKey, RecipientFeatures } from './features.ts'
import type { Action } from './model.ts'

export type FlaggedAccount = {
  account_id: string
  max_risk: number
  last_action: Exclude<Action, 'allow'>
  flagged_transfers: number
  flagged_amount: number
  first_flagged_at: string
  last_flagged_at: string
  reason_codes: string[]
  reasons: string[]
  features: RecipientFeatures
  model_version: string
}

export type Flag = Omit<FlaggedAccount, 'flagged_transfers' | 'flagged_amount' | 'first_flagged_at' | 'last_flagged_at' | 'max_risk'> & {
  risk: number
  amount: number
}

export function createStore(file: string) {
  const accounts = new Map<string, FlaggedAccount>()
  if (existsSync(file)) {
    for (const item of JSON.parse(readFileSync(file, 'utf8')) as FlaggedAccount[]) accounts.set(item.account_id, item)
  }

  const save = () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify([...accounts.values()], null, 2))
  }

  return {
    add(flag: Flag) {
      const now = new Date().toISOString()
      const previous = accounts.get(flag.account_id)
      const { risk, amount, ...latest } = flag
      accounts.set(flag.account_id, {
        ...latest,
        max_risk: Math.max(risk, previous?.max_risk ?? 0),
        flagged_transfers: (previous?.flagged_transfers ?? 0) + 1,
        flagged_amount: (previous?.flagged_amount ?? 0) + amount,
        first_flagged_at: previous?.first_flagged_at ?? now,
        last_flagged_at: now,
      })
      save()
    },

    list(filter: { since?: string; min_risk?: number; action?: string }) {
      return [...accounts.values()]
        .filter((a) => !filter.since || a.last_flagged_at >= filter.since)
        .filter((a) => filter.min_risk === undefined || a.max_risk >= filter.min_risk)
        .filter((a) => !filter.action || a.last_action === filter.action)
        .sort((a, b) => b.max_risk - a.max_risk)
    },

    clear() {
      accounts.clear()
      save()
    },
  }
}

const FEATURE_COLUMNS: FeatureKey[] = ['account_age_days', 'unrelated_senders_7d', 'fast_outflow_share_7d', 'shared_device_accounts']

export function toCsv(items: FlaggedAccount[], separator: string): string {
  const header = [
    'account_id', 'max_risk', 'last_action', 'flagged_transfers', 'flagged_amount',
    'first_flagged_at', 'last_flagged_at', 'reason_codes', 'reasons', ...FEATURE_COLUMNS, 'model_version',
  ]
  const rows = items.map((a) => [
    a.account_id, a.max_risk, a.last_action, a.flagged_transfers, a.flagged_amount,
    a.first_flagged_at, a.last_flagged_at, a.reason_codes.join(' '), a.reasons.join(' | '),
    ...FEATURE_COLUMNS.map((key) => a.features[key] ?? ''), a.model_version,
  ])
  const cell = (value: string | number) => {
    let text = String(value)
    // значение, начинающееся с =, +, -, @, Excel выполнил бы как формулу
    if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = "'" + text
    return /[",;\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
  }
  // BOM в начале — чтобы Excel правильно показал кириллицу
  return '﻿' + [header, ...rows].map((row) => row.map(cell).join(separator)).join('\r\n') + '\r\n'
}
