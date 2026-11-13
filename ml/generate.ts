// Синтетические данные: счета получателей и переводы на них.
// Открытых наборов с такими признаками (устройства, связи отправителей) нет, поэтому данные моделируем.
// Доли и распределения ниже — наши допущения, а не статистика банка.

import type { RecipientFeatures, TransferContext } from '../service/src/features.ts'
import { beta, lognormal, pick, poisson, uniform, type Rng } from './random.ts'

export type AccountKind =
  // честные
  | 'regular' // обычный клиент со старым счётом
  | 'newcomer' // недавно открыл счёт
  | 'seller' // продавец, фрилансер, сбор: много входящих от незнакомых людей
  | 'transit' // получает деньги и сразу уводит в другой банк
  | 'household' // семья или небольшое дело: несколько счетов на одном устройстве
  // дропперы
  | 'drop_fresh' // свежий счёт под обнал
  | 'drop_bought' // купленный «старый» счёт
  | 'drop_first_use' // счёт используют впервые, истории почти нет
  | 'drop_careful' // маскируется под обычного клиента

export type Account = {
  account_id: string
  kind: AccountKind
  is_dropper: boolean
  features: RecipientFeatures
}

export const DROPPER_SHARE = 0.02

const HONEST_MIX: [AccountKind, number][] = [
  ['regular', 72],
  ['newcomer', 10],
  ['seller', 8],
  ['transit', 7],
  ['household', 3],
]

const DROPPER_MIX: [AccountKind, number][] = [
  ['drop_fresh', 50],
  ['drop_bought', 25],
  ['drop_first_use', 15],
  ['drop_careful', 10],
]

function featuresFor(kind: AccountKind, rng: Rng): RecipientFeatures {
  const oldAccount = () => Math.min(6000, Math.max(45, lognormal(rng, 900, 0.9)))
  switch (kind) {
    case 'regular':
      return make(oldAccount(), poisson(rng, 0.4), beta(rng, 1.2, 8), poisson(rng, 0.25))
    case 'newcomer':
      return make(uniform(rng, 1, 60), poisson(rng, 0.8), beta(rng, 1.5, 5), poisson(rng, 0.2))
    case 'seller':
      // часть продавцов только начали: счёт молодой, а незнакомых отправителей уже много
      return make(
        rng() < 0.25 ? uniform(rng, 5, 90) : oldAccount(),
        poisson(rng, lognormal(rng, 12, 0.7)),
        beta(rng, 2, 6),
        poisson(rng, 0.3),
      )
    case 'transit':
      return make(oldAccount(), poisson(rng, 0.5), beta(rng, 6, 2), poisson(rng, 0.2))
    case 'household':
      return make(oldAccount(), poisson(rng, 0.5), beta(rng, 1.5, 6), 1 + poisson(rng, 2))
    case 'drop_fresh':
      return make(uniform(rng, 1, 30), 1 + poisson(rng, 6), beta(rng, 8, 1.5), poisson(rng, 2.5))
    case 'drop_bought':
      return make(oldAccount(), 1 + poisson(rng, 5), beta(rng, 7, 2), poisson(rng, 1.5))
    case 'drop_first_use':
      return make(uniform(rng, 1, 20), poisson(rng, 1), beta(rng, 2, 3), poisson(rng, 1.5))
    case 'drop_careful':
      return make(lognormal(rng, 300, 0.8), poisson(rng, 2), beta(rng, 3, 3), poisson(rng, 0.5))
  }
}

function make(age: number, senders: number, outflow: number, devices: number): RecipientFeatures {
  return {
    account_age_days: Math.round(age),
    unrelated_senders_7d: senders,
    fast_outflow_share_7d: Math.round(outflow * 100) / 100,
    shared_device_accounts: devices,
  }
}

export function generateAccounts(count: number, rng: Rng): Account[] {
  const accounts: Account[] = []
  for (let i = 0; i < count; i++) {
    const is_dropper = rng() < DROPPER_SHARE
    const kind = pick(rng, is_dropper ? DROPPER_MIX : HONEST_MIX)
    accounts.push({
      account_id: 'acc_' + i.toString(36).padStart(5, '0'),
      kind,
      is_dropper,
      features: featuresFor(kind, rng),
    })
  }
  return accounts
}

// Допущения о переводах. Мошеннический — жертва переводит дропперу, честный — любой другой.
export const TRANSFER_ASSUMPTIONS = {
  fraud: { on_call: 0.7, first_transfer: 0.95, ratio_median: 5 },
  honest: { on_call: 0.02, first_transfer: 0.25, ratio_median: 1 },
}

export function generateContext(isFraud: boolean, rng: Rng): TransferContext {
  const a = isFraud ? TRANSFER_ASSUMPTIONS.fraud : TRANSFER_ASSUMPTIONS.honest
  const ratio = lognormal(rng, a.ratio_median, 0.8)
  return {
    amount: Math.round((ratio * lognormal(rng, 25000, 0.6)) / 100) * 100,
    sender_on_call: rng() < a.on_call,
    remote_access_active: null, // в расчёт метрик не входит: данных о доле таких переводов нет
    first_transfer_to_recipient: rng() < a.first_transfer,
    amount_to_typical_ratio: Math.round(ratio * 10) / 10,
  }
}
