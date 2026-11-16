// Готовые получатели для стенда. В банке эти признаки считает его собственная система.

import type { FeatureKey, Purpose, RecipientFeatures } from '../../service/src/features.ts'

export type Scenario = {
  id: string
  name: string
  note: string
  account_id: string
  first_transfer: boolean
  features: RecipientFeatures
  purpose: Purpose // что клиент обычно выбирает для такого получателя
  p2p_trader?: boolean // банк видит, что получатель продаёт криптовалюту на P2P
}

export const PURPOSE_LABELS: Record<Purpose, string> = {
  family: 'Перевод близким',
  goods: 'Оплата товара',
  services: 'Оплата услуги, аренды',
  crypto_p2p: 'Покупка криптовалюты',
  other: 'Другое',
}

// Получатель «треугольника» — клиент BCC, продаёт USDT. Демонстрационный псевдоним и имя отправителя для него.
export const P2P_TRADER_REF = 'cl_90501'
export const SENDER_DISPLAY_NAME = 'Айгерим С.'

// Обычный перевод клиента на демонстрационном экране — от него считается «необычная сумма».
export const TYPICAL_TRANSFER = 25000

// Псевдоним клиента на демонстрационном экране: банк передаёт его в сервис вместо имени и телефона.
export const CLIENT_REF = 'cl_48213'

const NAMES = ['Айгерим С.', 'Данияр К.', 'Мадина Т.', 'Ерлан Б.', 'Асель Н.', 'Тимур А.', 'Жанна О.', 'Руслан М.']

// Вместо справочника клиентов банка: по псевдониму возвращает вымышленные контакты.
// В банке это делает его система ведения инцидентов; сервис оценки контактов не видит.
export function clientContacts(ref: string): { name: string; phone: string } {
  let hash = 0
  for (const char of ref) hash = (hash * 31 + char.charCodeAt(0)) % 100000
  const digits = String(hash).padStart(4, '0').slice(-4)
  return { name: NAMES[hash % NAMES.length]!, phone: `+7 700 000 ${digits.slice(0, 2)} ${digits.slice(2)}` }
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'sister',
    name: 'Сестра',
    note: 'перевожу каждый месяц',
    account_id: 'tok_7f3a91',
    first_transfer: false,
    purpose: 'family',
    features: { account_age_days: 2100, unrelated_senders_7d: 0, fast_outflow_share_7d: 0.08, shared_device_accounts: 0 },
  },
  {
    id: 'landlord',
    name: 'Арендодатель',
    note: 'первый платёж за квартиру',
    account_id: 'tok_c40e22',
    first_transfer: true,
    purpose: 'services',
    features: { account_age_days: 1200, unrelated_senders_7d: 1, fast_outflow_share_7d: 0.3, shared_device_accounts: 0 },
  },
  {
    id: 'seller',
    name: 'Продавец из объявления',
    note: 'много покупателей, счёт старый',
    account_id: 'tok_19bd05',
    first_transfer: true,
    purpose: 'goods',
    features: { account_age_days: 700, unrelated_senders_7d: 22, fast_outflow_share_7d: 0.2, shared_device_accounts: 0 },
  },
  {
    id: 'bought',
    name: '«Сотрудник банка» продиктовал счёт',
    note: 'купленный старый счёт',
    account_id: 'tok_e8a670',
    first_transfer: true,
    purpose: 'other',
    features: { account_age_days: 900, unrelated_senders_7d: 6, fast_outflow_share_7d: 0.85, shared_device_accounts: 2 },
  },
  {
    id: 'fresh',
    name: '«Безопасный счёт»',
    note: 'счёт открыт 4 дня назад',
    account_id: 'tok_02d9fc',
    first_transfer: true,
    purpose: 'other',
    features: { account_age_days: 4, unrelated_senders_7d: 8, fast_outflow_share_7d: 0.92, shared_device_accounts: 3 },
  },
]

// «Треугольник»: в объявлении дёшево продают iPhone и дают реквизиты честного продавца криптовалюты.
// Счёт старый и чистый — оценка счёта его не поймает, ловит правило «товар → продавец криптовалюты».
SCENARIOS.push({
  id: 'olx',
  name: 'Продавец iPhone с OLX',
  note: 'оплата товара по объявлению',
  account_id: 'tok_p2p771',
  first_transfer: true,
  purpose: 'goods',
  p2p_trader: true,
  features: { account_age_days: 1600, unrelated_senders_7d: 6, fast_outflow_share_7d: 0.4, shared_device_accounts: 0 },
})

export const FEATURE_LABELS: Record<FeatureKey, (value: number) => string> = {
  account_age_days: (v) => `Возраст счёта: ${v} дн.`,
  unrelated_senders_7d: (v) => `Незнакомых отправителей за 7 дней: ${v}`,
  fast_outflow_share_7d: (v) => `Уходит со счёта за час: ${Math.round(v * 100)}%`,
  shared_device_accounts: (v) => `Других счетов на тех же устройствах: ${v}`,
}

export const ACTION_LABELS = { allow: 'Пропустить', warn: 'Предупредить', hold: 'Придержать' } as const

export const KIND_LABELS: Record<string, string> = {
  regular: 'Обычный клиент со старым счётом',
  newcomer: 'Недавно открыл счёт',
  seller: 'Продавец, фрилансер, сбор денег',
  transit: 'Сразу уводит деньги в другой банк',
  household: 'Несколько счетов на одном устройстве',
  drop_fresh: 'Свежий счёт под вывод денег',
  drop_bought: 'Купленный старый счёт',
  drop_first_use: 'Счёт используют впервые',
  drop_careful: 'Маскируется под обычного клиента',
}

export const percent = (value: number, digits = 1) =>
  (value * 100).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + '%'

export const money = (value: number) => value.toLocaleString('ru-RU') + ' ₸'

// Оценка 0,996 при округлении дала бы «1,00» — будто сервис уверен на все сто. Показываем «> 0,99».
export const riskText = (value: number) =>
  value >= 0.995 ? '> 0,99' : value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
