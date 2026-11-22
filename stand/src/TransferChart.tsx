// Оценка перевода целиком (вторая ступень сервиса): из чего она сложилась и где пороги решения.
// Слагаемые — в тех же единицах, что вклады признаков счёта: вправо — поднимает риск, влево — снижает.
import metrics from '../../ml/metrics.json'
import type { TransferContext } from '../../service/src/features.ts'
import type { ScoreResponse } from './api.ts'

type Transfer = NonNullable<ScoreResponse['transfer']>

const number = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
const signed = (value: number) => (value > 0 ? '+' : value < 0 ? '−' : '') + number(Math.abs(value))
// «в 2 раза», «в 18 раз», «в 22 раза», «в 1,5 раза»
const times = (n: number) => {
  if (!Number.isInteger(n)) return 'раза'
  const tens = n % 100
  const units = n % 10
  return tens >= 11 && tens <= 14 ? 'раз' : units >= 2 && units <= 4 ? 'раза' : 'раз'
}

function rows(transfer: Transfer, context: TransferContext) {
  const remote = context.remote_access_active === true
  const ratio = context.amount_to_typical_ratio
  return [
    { key: 'account', label: 'Счёт получателя', value: transfer.parts.account },
    {
      key: 'call',
      label: remote ? 'Удалённый доступ к телефону' : context.sender_on_call === true ? 'Клиент на звонке' : context.sender_on_call === false ? 'Звонка нет' : 'Звонок: неизвестно',
      value: transfer.parts.call,
    },
    {
      key: 'first',
      label:
        context.first_transfer_to_recipient === true
          ? 'Переводит этому получателю впервые'
          : context.first_transfer_to_recipient === false && !remote
            ? 'Уже переводил этому получателю'
            : 'Переводил ли раньше: неизвестно',
      value: transfer.parts.first,
    },
    {
      key: 'amount',
      label: ratio === null || ratio === undefined ? 'Обычная сумма клиента: неизвестна' : ratio > 1 ? `Сумма в ${number(ratio)} ${times(ratio)} больше обычной` : 'Сумма не больше обычной',
      value: transfer.parts.amount,
    },
  ]
}

export function TransferChart(props: { transfer: Transfer; context: TransferContext }) {
  const thresholds = metrics.transfer_level.transfer_model?.thresholds
  const bias = metrics.transfer_level.transfer_model?.bias
  const items = rows(props.transfer, props.context)
  const max = Math.max(1, ...items.map((r) => Math.abs(r.value)))
  const verdict = !thresholds
    ? null
    : props.transfer.score >= thresholds.hold
      ? `выше порога «придержать» (${number(thresholds.hold)})`
      : props.transfer.score >= thresholds.warn
        ? `между порогами «предупредить» (${number(thresholds.warn)}) и «придержать» (${number(thresholds.hold)})`
        : `ниже порога «предупредить» (${number(thresholds.warn)})`

  return (
    <figure className="m-0">
      <figcaption className="mb-4 text-[13px] text-ink-2">Модель складывает риск счёта и обстоятельства перевода в одну оценку.</figcaption>
      <ul className="space-y-3.5" aria-label="Из чего сложилась оценка перевода">
        {items.map(({ key, label, value }) => {
          const share = (Math.abs(value) / max) * 50
          return (
            <li key={key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 sm:grid-cols-[minmax(0,15rem)_1fr_3.5rem]">
              <span className="text-[14px] leading-snug sm:text-[14.5px]">{label}</span>
              <span className="tabular text-right text-[14px] font-semibold text-ink sm:order-last">{signed(value)}</span>
              <span className="relative col-span-2 h-2.5 rounded-full bg-field sm:col-span-1" aria-hidden="true">
                <span className="absolute top-[-3px] bottom-[-3px] left-1/2 w-px bg-[#c5cbd8]" />
                {value !== 0 && (
                  <span
                    className={'absolute top-0 h-full ' + (value > 0 ? 'rounded-r-full bg-raise' : 'rounded-l-full bg-lower')}
                    style={value > 0 ? { left: '50%', width: `${share}%` } : { right: '50%', width: `${share}%` }}
                  />
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-4 text-[14.5px]">
        Итог <span className="tabular font-semibold">{signed(props.transfer.score)}</span>
        {bias !== undefined && <span className="text-ink-2"> с постоянной поправкой {signed(bias)}</span>}
        {verdict && <span className="text-ink-2"> — {verdict}</span>}
      </p>
    </figure>
  )
}
