// Чтение и запись размеченных счетов в CSV — чтобы обучить и проверить модель на данных банка.
// Колонки: четыре базовых признака счёта и is_dropper (1 — дроппер, 0 — нет). Пустая ячейка — признак неизвестен.
// Колонки дополнительных сигналов (idle_days_before_inflow, new_device_7d, flagged_linked_senders_7d)
// необязательны: если их нет, сигналы считаются неизвестными.
// Необязательные колонки account_id и kind (тип счёта для разбивки метрик).

import { readFileSync, writeFileSync } from 'node:fs'
import { BASE_FEATURE_KEYS, FEATURE_KEYS, type RecipientFeatures } from '../service/src/features.ts'
import type { Account } from './generate.ts'

const COLUMNS = ['account_id', ...FEATURE_KEYS, 'is_dropper', 'kind']

export function writeCsv(file: string, accounts: Account[]) {
  const rows = accounts.map((a) => [a.account_id, ...FEATURE_KEYS.map((key) => a.features[key] ?? ''), a.is_dropper ? 1 : 0, a.kind].join(','))
  writeFileSync(file, [COLUMNS.join(','), ...rows].join('\n') + '\n')
}

export function readCsv(file: string): Account[] {
  const lines = readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim())
  // разделитель — запятая или точка с запятой (так сохраняет Excel с русскими настройками)
  const separator = lines[0]!.includes(';') ? ';' : ','
  const header = lines[0]!.split(separator).map((name) => name.trim())
  for (const required of [...BASE_FEATURE_KEYS, 'is_dropper']) {
    if (!header.includes(required)) throw new Error(`В файле ${file} нет колонки ${required}`)
  }
  const at = (cells: string[], name: string) => (header.includes(name) ? (cells[header.indexOf(name)]?.trim() ?? '') : '')

  return lines.slice(1).map((line, i) => {
    const cells = line.split(separator)
    const features = {} as RecipientFeatures
    for (const key of FEATURE_KEYS) {
      const cell = at(cells, key).replace(',', '.')
      const value = cell === '' ? null : Number(cell)
      if (value !== null && !Number.isFinite(value)) throw new Error(`Строка ${i + 2}: в колонке ${key} не число — «${cell}»`)
      features[key] = value
    }
    const label = at(cells, 'is_dropper')
    if (label !== '0' && label !== '1') throw new Error(`Строка ${i + 2}: is_dropper должен быть 0 или 1, а не «${label}»`)
    return {
      account_id: at(cells, 'account_id') || 'row_' + (i + 2),
      kind: (at(cells, 'kind') || (label === '1' ? 'dropper' : 'honest')) as Account['kind'],
      is_dropper: label === '1',
      features,
    }
  })
}
