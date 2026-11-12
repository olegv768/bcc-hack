import metrics from '../../ml/metrics.json'
import { KIND_LABELS, percent } from './scenarios.ts'
import { TradeoffChart } from './TradeoffChart.tsx'

const warn = metrics.account_level.find((m) => m.threshold === 'warn')!
const hold = metrics.account_level.find((m) => m.threshold === 'hold')!
const withCall = metrics.transfer_level.with_call_signal
const withoutCall = metrics.transfer_level.without_call_signal
const count = (value: number) => value.toLocaleString('ru-RU')

// Метрики из ml/metrics.json — файл пишет npm run train.
export function Metrics() {
  const cell = 'px-3 py-2'
  const number = 'tabular px-3 py-2 text-right'

  return (
    <div className="space-y-8">
      <p className="max-w-[70ch] text-ink-2">
        Данные синтетические: {count(metrics.data.accounts)} счетов из нашего генератора, дропперов {percent(metrics.data.dropper_share, 0)}. Цифры
        показывают, как модель ведёт себя на заложенных нами типах счетов, а не качество на реальных данных банка. Проверка — на отложенной
        выборке: {count(metrics.data.test_droppers)} дропперов и {count(metrics.data.test_honest)} честных счетов, которых модель не видела.
      </p>

      <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        <Figure value={percent(warn.droppers_found, 0)} label="дропперов найдено на пороге «предупредить»" />
        <Figure value={percent(warn.honest_flagged)} label="честных счетов помечено по ошибке на этом пороге" />
        <Figure value={percent(hold.droppers_found, 0)} label="дропперов найдено на пороге «придержать»" />
        <Figure value={percent(hold.honest_flagged)} label="честных счетов помечено по ошибке на этом пороге" />
      </div>

      <div>
        <h3 className="font-semibold">Цена порога</h3>
        <p className="mb-3 text-[14px] text-ink-2">
          Доля найденных дропперов при разной доле ложных срабатываний. Банк двигает порог сам: правее — ловим больше, но чаще беспокоим честных.
        </p>
        <TradeoffChart
          points={metrics.roc}
          marks={[
            { label: 'Придержать', ...hold },
            { label: 'Предупредить', ...warn },
          ]}
        />
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <div className="min-w-0">
          <h3 className="mb-2 font-semibold">Кого модель находит и кого беспокоит зря</h3>
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[440px] text-left text-[13px]">
              <thead className="border-b border-line text-ink-2">
                <tr>
                  <th className={cell + ' font-medium'}>Тип счёта</th>
                  <th className={number + ' font-medium'}>Счетов</th>
                  <th className={number + ' font-medium'}>Предупредить</th>
                  <th className={number + ' font-medium'}>Придержать</th>
                </tr>
              </thead>
              {[true, false].map((isDropper) => (
                <tbody key={String(isDropper)}>
                  <tr className="border-b border-line bg-paper/60">
                    <th colSpan={4} className={cell + ' font-semibold'}>
                      {isDropper ? 'Дропперы — доля найденных' : 'Честные — доля помеченных по ошибке'}
                    </th>
                  </tr>
                  {metrics.by_kind
                    .filter((k) => k.is_dropper === isDropper)
                    .sort((a, b) => b.count - a.count)
                    .map((k) => (
                      <tr key={k.kind} className="border-b border-line last:border-0">
                        <td className={cell}>{KIND_LABELS[k.kind]}</td>
                        <td className={number}>{count(k.count)}</td>
                        <td className={number}>{percent(k.above_warn)}</td>
                        <td className={number}>{percent(k.above_hold)}</td>
                      </tr>
                    ))}
                </tbody>
              ))}
            </table>
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="mb-2 font-semibold">Что даёт сигнал звонка</h3>
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full min-w-[440px] text-left text-[13px]">
              <thead className="border-b border-line text-ink-2">
                <tr>
                  <th className={cell + ' font-medium'}>Переводы</th>
                  <th className={number + ' font-medium'}>Без сигнала</th>
                  <th className={number + ' font-medium'}>С сигналом</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['Мошеннические: придержано', withoutCall.fraud.hold, withCall.fraud.hold],
                    ['Мошеннические: предупреждение', withoutCall.fraud.warn, withCall.fraud.warn],
                    ['Мошеннические: пропущено', 1 - withoutCall.fraud.hold - withoutCall.fraud.warn, 1 - withCall.fraud.hold - withCall.fraud.warn],
                    ['Честные: придержано', withoutCall.honest.hold, withCall.honest.hold],
                    ['Честные: предупреждение', withoutCall.honest.warn, withCall.honest.warn],
                  ] as const
                ).map(([label, before, after]) => (
                  <tr key={label} className="border-b border-line last:border-0">
                    <td className={cell}>{label}</td>
                    <td className={number}>{percent(before)}</td>
                    <td className={number}>{percent(after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[13px] text-ink-2">
            Допущение, а не измерение: {percent(metrics.transfer_level.assumptions.fraud.on_call, 0)} обманутых клиентов переводят во время
            звонка, среди честных переводов на звонке {percent(metrics.transfer_level.assumptions.honest.on_call, 0)}. Реальные доли банк
            узнает после подключения клиентского модуля.
          </p>
        </div>
      </div>
    </div>
  )
}

function Figure(props: { value: string; label: string }) {
  return (
    <div className="border-t-2 border-ink pt-2">
      <div className="text-3xl font-semibold">{props.value}</div>
      <div className="text-[14px] text-ink-2">{props.label}</div>
    </div>
  )
}
