// Признаки счёта получателя. Банк считает их сам по своим данным и передаёт в POST /score.

export const FEATURE_KEYS = [
  'account_age_days', // сколько дней назад открыт счёт
  'unrelated_senders_7d', // сколько разных людей без прошлой истории переводов прислали деньги за 7 дней
  'fast_outflow_share_7d', // доля поступлений за 7 дней, ушедшая со счёта в течение часа (0..1)
  'shared_device_accounts', // в сколько других счетов входили с тех же устройств
] as const

export type FeatureKey = (typeof FEATURE_KEYS)[number]

// Признак может отсутствовать (null): тогда он не влияет на оценку.
export type RecipientFeatures = Record<FeatureKey, number | null>

// Счётчики и возраст сжимаем логарифмом: разница между 1 и 10 днями важнее, чем между 1000 и 1010.
const LOG_SCALED: FeatureKey[] = ['account_age_days', 'unrelated_senders_7d', 'shared_device_accounts']

export function transform(key: FeatureKey, value: number): number {
  return LOG_SCALED.includes(key) ? Math.log1p(Math.max(0, value)) : Math.min(1, Math.max(0, value))
}

export type TransferContext = {
  amount: number
  sender_on_call: boolean | null // сигнал клиентского модуля; null — модуль не подключён
  remote_access_active: boolean | null // телефоном могут управлять удалённо (AnyDesk и подобные); null — не проверялось
  first_transfer_to_recipient: boolean
  amount_to_typical_ratio: number | null // сумма перевода / обычный перевод этого клиента
}
