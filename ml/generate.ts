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

// Для проверки на прочность: мошенники ушли от свежих счетов к купленным и «тихим».
export const CAREFUL_DROPPER_MIX: [AccountKind, number][] = [
  ['drop_fresh', 20],
  ['drop_bought', 40],
  ['drop_first_use', 20],
  ['drop_careful', 20],
]

// Дополнительные сигналы о счёте. Честные клиенты тоже их дают: новички входят с нового телефона,
// редкими счетами пользуются и честные люди, а продавцам платят в том числе жертвы мошенников.
// Числа — наши допущения; ml/ceiling.ts повторяет их для расчёта потолка.
type Signals = {
  // сколько дней счёт молчал перед поступлениями: доли «молчал с открытия», короткая пауза (Пуассон)
  // и долгая пауза (логнормальная: медиана, разброс)
  idle: { sinceOpening: number; long: number; shortMean: number; longMedian: number; longSigma: number }
  newDevice: number // вероятность входа с нового устройства за 7 дней
  linked: number // вероятность, что незнакомый отправитель платил и на заблокированные банком счета
}

export const SIGNALS: Record<AccountKind, Signals> = {
  regular: { idle: { sinceOpening: 0, long: 0.15, shortMean: 1.5, longMedian: 45, longSigma: 1 }, newDevice: 0.03, linked: 0.02 },
  newcomer: { idle: { sinceOpening: 0.3, long: 0, shortMean: 2, longMedian: 1, longSigma: 1 }, newDevice: 0.1, linked: 0.02 },
  seller: { idle: { sinceOpening: 0, long: 0, shortMean: 1, longMedian: 1, longSigma: 1 }, newDevice: 0.05, linked: 0.02 },
  transit: { idle: { sinceOpening: 0, long: 0, shortMean: 1, longMedian: 1, longSigma: 1 }, newDevice: 0.05, linked: 0.02 },
  household: { idle: { sinceOpening: 0, long: 0, shortMean: 2, longMedian: 1, longSigma: 1 }, newDevice: 0.15, linked: 0.02 },
  drop_fresh: { idle: { sinceOpening: 0.5, long: 0, shortMean: 2, longMedian: 1, longSigma: 1 }, newDevice: 0.45, linked: 0.3 },
  drop_bought: { idle: { sinceOpening: 0, long: 1, shortMean: 1, longMedian: 120, longSigma: 0.8 }, newDevice: 0.75, linked: 0.3 },
  drop_first_use: { idle: { sinceOpening: 0.9, long: 0, shortMean: 2, longMedian: 1, longSigma: 1 }, newDevice: 0.45, linked: 0.25 },
  drop_careful: { idle: { sinceOpening: 0, long: 0.25, shortMean: 2, longMedian: 30, longSigma: 1 }, newDevice: 0.2, linked: 0.3 },
}

function withSignals(kind: AccountKind, base: RecipientFeatures, rng: Rng): RecipientFeatures {
  const s = SIGNALS[kind]
  const age = base.account_age_days!
  const draw = rng()
  const idle =
    draw < s.idle.sinceOpening ? age : draw < s.idle.sinceOpening + s.idle.long ? Math.round(lognormal(rng, s.idle.longMedian, s.idle.longSigma)) : poisson(rng, s.idle.shortMean)
  let linked = 0
  for (let i = 0; i < base.unrelated_senders_7d!; i++) if (rng() < s.linked) linked++
  return {
    ...base,
    idle_days_before_inflow: Math.min(age, idle),
    new_device_7d: rng() < s.newDevice ? 1 : 0,
    flagged_linked_senders_7d: linked,
  }
}

function featuresFor(kind: AccountKind, rng: Rng): RecipientFeatures {
  return withSignals(kind, baseFeaturesFor(kind, rng), rng)
}

function baseFeaturesFor(kind: AccountKind, rng: Rng): RecipientFeatures {
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
    idle_days_before_inflow: null,
    new_device_7d: null,
    flagged_linked_senders_7d: null,
  }
}

export function generateAccounts(count: number, rng: Rng, dropperMix = DROPPER_MIX): Account[] {
  const accounts: Account[] = []
  for (let i = 0; i < count; i++) {
    const is_dropper = rng() < DROPPER_SHARE
    const kind = pick(rng, is_dropper ? dropperMix : HONEST_MIX)
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
