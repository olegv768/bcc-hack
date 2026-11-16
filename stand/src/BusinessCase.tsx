import { useState } from 'react'
import metrics from '../../ml/metrics.json'
import { NumberInput } from './NumberInput.tsx'

// Расчёт выгоды для банка: банк вводит свои числа, доли берутся из проверки сервиса (ml/metrics.json).
// Формулы те же, что в docs/BUSINESS_CASE.md.

type Preset = (typeof metrics.transfer_level.presets)[number]
const PRESETS = metrics.transfer_level.presets

type Inputs = {
  transfersPerDay: number // сколько переводов в день проходит через модуль
  fraudPer100k: number // сколько из каждых 100 000 переводов — мошеннические
  averageDamage: number // средняя сумма мошеннического перевода, ₸
  cancelAfterWarning: number // доля обманутых клиентов, которые отменяют перевод после предупреждения, %
  reviewCost: number // стоимость разбора одного срабатывания аналитиком, ₸
  falseHoldCost: number // стоимость одной ложной приостановки честного перевода, ₸
}

// Условные числа для примера. Средняя сумма — из наших синтетических данных, остальное — допущения.
const EXAMPLE: Inputs = {
  transfersPerDay: 200000,
  fraudPer100k: 20,
  averageDamage: PRESETS[1]!.fraud.average_amount,
  cancelAfterWarning: 30,
  reviewCost: 1500,
  falseHoldCost: 5000,
}

export function perDay(p: Preset, inputs: Inputs) {
  const fraud = (inputs.transfersPerDay * inputs.fraudPer100k) / 100000
  const honest = inputs.transfersPerDay - fraud
  const cancel = inputs.cancelAfterWarning / 100
  // сумма, которая не ушла бы мошенникам: придержанные переводы целиком и отменённые после предупреждения
  const saved = fraud * inputs.averageDamage * (p.fraud.hold_amount + cancel * p.fraud.warn_amount)
  const alerts = fraud * (p.fraud.hold + p.fraud.warn) + honest * (p.honest.hold + p.honest.warn)
  const falseHolds = honest * p.honest.hold
  const falseWarnings = honest * p.honest.warn
  const costs = alerts * inputs.reviewCost + falseHolds * inputs.falseHoldCost
  return { fraud, saved, alerts, falseHolds, falseWarnings, costs, net: saved - costs }
}

const money = (value: number) => Math.round(value).toLocaleString('ru-RU') + ' ₸'
const count = (value: number) => (value < 10 ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) : Math.round(value).toLocaleString('ru-RU'))

export function BusinessCase() {
  const [inputs, setInputs] = useState(EXAMPLE)
  const [presetId, setPresetId] = useState('base')
  const preset = PRESETS.find((p) => p.id === presetId)!
  const day = perDay(preset, inputs)

  const field = (key: keyof Inputs, label: string, unit: string) => (
    <label className="block">
      <span className="block text-[14px] text-ink-2">{label}</span>
      <span className="mt-1 flex items-center rounded-[12px] bg-field px-3 focus-within:ring-2 focus-within:ring-accent">
        <NumberInput
          decimal
          value={inputs[key]}
          onChange={(value) => setInputs({ ...inputs, [key]: Math.max(0, value) })}
          className="tabular min-w-0 flex-1 bg-transparent py-2.5 text-[16px] font-semibold outline-none!"
        />
        <span className="shrink-0 pl-2 text-[14px] text-muted">{unit}</span>
      </span>
    </label>
  )

  const valid = Object.values(inputs).every(Number.isFinite)

  return (
    <div>
      <h3 className="text-[19px] font-semibold">Что это даёт банку в деньгах</h3>
      <p className="mt-1 mb-6 max-w-[72ch] text-[15px] text-ink-2">
        Впишите числа своего банка. Доли — из нашей проверки сервиса. Числа ниже — условный пример, а не прогноз: средняя сумма взята из
        синтетических данных, остальное — допущения.
      </p>

      <div className="grid gap-x-12 gap-y-8 lg:grid-cols-[minmax(0,340px)_1fr]">
        <div className="space-y-4">
          {field('transfersPerDay', 'Переводов в день через модуль', 'шт.')}
          {field('fraudPer100k', 'Из них мошеннических на каждые 100 000', 'шт.')}
          {field('averageDamage', 'Средняя сумма мошеннического перевода', '₸')}
          {field('cancelAfterWarning', 'Клиентов отменяют перевод после предупреждения', '%')}
          {field('reviewCost', 'Стоимость разбора одного срабатывания', '₸')}
          {field('falseHoldCost', 'Стоимость одной ложной приостановки', '₸')}
          <button type="button" onClick={() => setInputs(EXAMPLE)} className="cursor-pointer text-[14px] font-semibold text-accent">
            Вернуть пример
          </button>
        </div>

        <div className="min-w-0">
          <fieldset>
            <legend className="mb-2 text-[14px] text-ink-2">Строгость порогов</legend>
            <div className="inline-flex rounded-full bg-field p-1">
              {PRESETS.map((p) => (
                <label
                  key={p.id}
                  className={
                    'cursor-pointer rounded-full px-4 py-2 text-[15px] font-semibold has-focus-visible:outline-3 has-focus-visible:outline-accent ' +
                    (p.id === presetId ? 'bg-ink text-white' : 'text-ink')
                  }
                >
                  <input type="radio" name="preset" value={p.id} checked={p.id === presetId} onChange={() => setPresetId(p.id)} className="sr-only" />
                  {p.name}
                </label>
              ))}
            </div>
          </fieldset>

          {!valid ? (
            <p className="mt-6 text-ink-2">Заполните все поля числами.</p>
          ) : (
            <>
              <dl className="mt-6 grid gap-x-8 gap-y-6 sm:grid-cols-2" aria-live="polite">
                <Figure label="Не ушло бы мошенникам за день" value={money(day.saved)} />
                <Figure label="Срабатываний в день на разбор" value={count(day.alerts)} />
                <Figure label="Честных переводов приостановлено зря за день" value={count(day.falseHolds)} />
                <Figure label="Честных переводов с предупреждением за день" value={count(day.falseWarnings)} />
              </dl>
              <div className="mt-6 border-t border-line pt-5 text-[15px]">
                <div className="flex flex-wrap justify-between gap-x-6 gap-y-1">
                  <span className="text-ink-2">Затраты на разбор и ложные приостановки за день</span>
                  <span className="tabular">{money(day.costs)}</span>
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-x-6 gap-y-1 text-[17px] font-semibold">
                  <span>Итог за день</span>
                  <span className="tabular">{money(day.net)}</span>
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-x-6 gap-y-1 text-ink-2">
                  <span>За 30 дней</span>
                  <span className="tabular">{money(day.net * 30)}</span>
                </div>
              </div>

              <table className="mt-8 w-full text-left text-[15px]">
                <caption className="mb-2 text-left text-[14px] text-ink-2">Те же числа при разной строгости, за день</caption>
                <thead className="border-b border-ink text-[14px] text-ink-2">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Пороги</th>
                    <th className="py-2 pl-3 text-right font-medium">Не ушло</th>
                    <th className="py-2 pl-3 text-right font-medium">На разбор</th>
                    <th className="hidden py-2 pl-3 text-right font-medium sm:table-cell">Итог</th>
                  </tr>
                </thead>
                <tbody>
                  {PRESETS.map((p) => {
                    const row = perDay(p, inputs)
                    return (
                      <tr key={p.id} className={'border-b border-line ' + (p.id === presetId ? 'font-semibold' : '')}>
                        <td className="py-2.5 pr-3">{p.name}</td>
                        <td className="tabular py-2.5 pl-3 text-right whitespace-nowrap">{money(row.saved)}</td>
                        <td className="tabular py-2.5 pl-3 text-right">{count(row.alerts)}</td>
                        <td className="tabular hidden py-2.5 pl-3 text-right whitespace-nowrap sm:table-cell">{money(row.net)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-[14px] text-muted">
                Строже — больше замечено, но разбор ложных срабатываний может съесть выгоду: мошеннических переводов мало, честных много.
                Пороги банк выбирает после пилота в теневом режиме.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Figure(props: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[14px] text-ink-2">{props.label}</dt>
      <dd className="tabular mt-1 font-display text-[28px] leading-tight font-semibold">{props.value}</dd>
    </div>
  )
}
