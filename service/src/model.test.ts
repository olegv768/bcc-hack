// Свойства рабочей модели, которые не должны ломаться при переобучении.

import { describe, expect, it } from 'vitest'
import { generateAccounts } from '../../ml/generate.ts'
import { createRng } from '../../ml/random.ts'
import { FEATURE_KEYS, type FeatureKey, type RecipientFeatures } from './features.ts'
import { decide, loadModel, scoreRecipient } from './model.ts'
import { expectedLogit } from './trees.ts'

const model = loadModel(new URL('../model/model.json', import.meta.url))
const accounts = generateAccounts(600, createRng(7))

// «хуже» для каждого признака: моложе счёт, больше незнакомых отправителей, быстрее вывод, больше устройств
const WORSE: Record<FeatureKey, (v: number) => number> = {
  account_age_days: (v) => Math.max(0, Math.round(v * 0.6)),
  unrelated_senders_7d: (v) => v + 4,
  fast_outflow_share_7d: (v) => Math.min(1, v + 0.2),
  shared_device_accounts: (v) => v + 2,
}

describe('рабочая модель', () => {
  it('это деревья LightGBM с монотонными ограничениями', () => {
    expect(model.kind).toBe('trees')
  })

  it('риск не падает, когда признак становится хуже', () => {
    for (const a of accounts) {
      const base = scoreRecipient(model, a.features, false).logit
      for (const key of FEATURE_KEYS) {
        const worse = { ...a.features, [key]: WORSE[key](a.features[key]!) }
        expect(scoreRecipient(model, worse, false).logit).toBeGreaterThanOrEqual(base - 1e-9)
      }
    }
  })

  it('счёт-сборщик с десятками незнакомых отправителей придерживается', () => {
    // в обучающих данных столько отправителей бывает только у честных продавцов; без ограничения
    // монотонности модель считала такой счёт безопасным
    const collector: RecipientFeatures = { account_age_days: 400, unrelated_senders_7d: 30, fast_outflow_share_7d: 0.85, shared_device_accounts: 2 }
    expect(scoreRecipient(model, collector).risk).toBeGreaterThanOrEqual(model.thresholds.hold)
  })

  it('вклады признаков в сумме дают «оценка минус средняя оценка»', () => {
    if (model.kind !== 'trees') return
    for (const a of accounts.slice(0, 100)) {
      const { logit, contributions } = scoreRecipient(model, a.features)
      const sum = FEATURE_KEYS.reduce((s, key) => s + contributions[key], 0)
      expect(sum + expectedLogit(model)).toBeCloseTo(logit, 9)
    }
  })

  it('непереданный признак ничего не добавляет в причины, а оценка остаётся разумной', () => {
    const features: RecipientFeatures = { account_age_days: 4, unrelated_senders_7d: null, fast_outflow_share_7d: 0.92, shared_device_accounts: 3 }
    const scored = scoreRecipient(model, features)
    expect(scored.contributions.unrelated_senders_7d).toBe(0)
    expect(scored.missing).toEqual(['unrelated_senders_7d'])
    // оценка без признака лежит между оценками с самым «безопасным» и самым «опасным» его значением
    const low = scoreRecipient(model, { ...features, unrelated_senders_7d: 0 }, false).logit
    const high = scoreRecipient(model, { ...features, unrelated_senders_7d: 60 }, false).logit
    expect(scored.logit).toBeGreaterThanOrEqual(low - 1e-9)
    expect(scored.logit).toBeLessThanOrEqual(high + 1e-9)
  })

  it('без признаков счёта оценка — средняя, а решение принимают обстоятельства перевода', () => {
    const empty = Object.fromEntries(FEATURE_KEYS.map((key) => [key, null])) as RecipientFeatures
    const scored = scoreRecipient(model, empty)
    if (model.kind === 'trees') expect(scored.logit).toBeCloseTo(expectedLogit(model), 9)
    const result = decide(model, empty, { amount: 50000, sender_on_call: true, remote_access_active: true, first_transfer_to_recipient: true, amount_to_typical_ratio: 1 })
    expect(result.action).toBe('warn')
  })
})
