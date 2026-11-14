import model from '../../service/model/model.json'
import type { ScoreRequest, ScoreResponse } from './api.ts'
import { ContributionChart } from './ContributionChart.tsx'
import { ACTION_LABELS } from './scenarios.ts'

const BADGE_CLASS = {
  allow: 'bg-allow-bg text-allow-ink',
  warn: 'bg-warn-bg text-warn-ink',
  hold: 'bg-hold-bg text-hold-ink',
}

// плашка вердикта: сплошной цвет решения; на жёлтом текст тёмный, иначе не читается
const VERDICT_CLASS = {
  allow: 'bg-allow text-white',
  warn: 'bg-warn text-ink',
  hold: 'bg-hold text-white',
}

const ACTION_NOTE = {
  allow: 'Перевод уходит как обычно.',
  warn: 'Клиент видит предупреждение и сам решает, продолжать ли.',
  hold: 'Перевод не уходит, пока банк его не проверит.',
}

const fixed = (value: number) => value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function ActionBadge(props: { action: keyof typeof BADGE_CLASS }) {
  return (
    <span className={'inline-block rounded-full px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap ' + BADGE_CLASS[props.action]}>
      {ACTION_LABELS[props.action]}
    </span>
  )
}

// Шкала риска с порогами модели: видно, насколько оценка далека от границы решения.
function RiskScale(props: { risk: number }) {
  const { warn, hold } = model.thresholds
  const left = (value: number) => `${value * 100}%`
  return (
    <div>
      <div
        className="relative h-2.5 rounded-full bg-allow-bg"
        role="img"
        aria-label={`Риск ${fixed(props.risk)} на шкале от 0 до 1; предупреждение от ${fixed(warn)}, приостановка от ${fixed(hold)}`}
      >
        <div className="absolute inset-y-0 bg-warn-bg" style={{ left: left(warn), right: left(1 - hold) }} />
        <div className="absolute inset-y-0 right-0 rounded-r-full bg-hold-bg" style={{ left: left(hold) }} />
        <div
          className="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-ink shadow-[0_1px_4px_rgb(11_22_56/0.35)] transition-[left] duration-500"
          style={{ left: left(props.risk) }}
        />
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-allow" /> пропустить
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-warn" /> предупредить, от {fixed(warn)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-full bg-hold" /> придержать, от {fixed(hold)}
        </span>
      </div>
    </div>
  )
}

const HISTORY_CODES = ['CONFIRMED_FRAUD', 'REPEAT_TARGET']

function ReasonList(props: { title: string; reasons: ScoreResponse['reasons']; tone?: 'alarm' }) {
  if (props.reasons.length === 0) return null
  return (
    <div>
      <h4 className={'mb-2 text-[14px] ' + (props.tone ? 'opacity-80' : 'text-muted')}>{props.title}</h4>
      <ul className="space-y-2">
        {props.reasons.map((reason) => (
          <li key={reason.code} className="flex gap-2.5">
            <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
            {reason.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// Что ушло в сервис оценки и что он ответил.
export function ScorePanel(props: { request: ScoreRequest | null; response: ScoreResponse | null }) {
  const { request, response } = props
  if (!request || !response) {
    return (
      <div className="rounded-[20px] border border-dashed border-line p-6">
        <p className="text-[19px] font-semibold">Ответа пока нет</p>
        <p className="mt-2 max-w-[52ch] text-ink-2">
          Нажмите «Перевести» в заглушке. Здесь появится то, что сервис вернул банку: риск получателя, причины и рекомендация.
        </p>
      </div>
    )
  }

  const { account_id, ...features } = request.recipient
  // причины из памяти сервиса о счёте: прошлые разборы аналитика и переводы других клиентов
  const fromHistory = response.reasons.filter((r) => HISTORY_CODES.includes(r.code))
  const aboutAccount = response.reasons.filter((r) => r.contribution !== null)
  const aboutTransfer = response.reasons.filter((r) => r.contribution === null && !HISTORY_CODES.includes(r.code))

  return (
    <div className="space-y-4">
      <div key={response.request_id} className={'verdict-in flex flex-wrap items-end justify-between gap-x-8 gap-y-4 rounded-[20px] p-7 ' + VERDICT_CLASS[response.action]}>
        <div>
          <div className="text-[14px] opacity-80">Рекомендация банку</div>
          <div className="font-display text-[34px] leading-tight font-semibold sm:text-[42px]">{ACTION_LABELS[response.action]}</div>
          <div className="mt-1 text-[16px]">{ACTION_NOTE[response.action]}</div>
        </div>
        <div className="sm:text-right">
          <div className="text-[14px] opacity-80">Риск получателя</div>
          <div className="tabular font-display text-[34px] leading-tight font-semibold sm:text-[42px]">{fixed(response.risk)}</div>
        </div>
      </div>

      <div className="space-y-9 pt-4">
        <RiskScale risk={response.risk} />

        <div>
          <h3 className="mb-3 text-[19px] font-semibold">Причины</h3>
          {response.reasons.length === 0 ? (
            <p className="text-ink-2">Подозрительных признаков нет.</p>
          ) : (
            <div className="grid gap-x-10 gap-y-5 md:grid-cols-2">
              {fromHistory.length > 0 && (
                <div className="rounded-[16px] bg-hold-bg p-4 text-hold-ink md:col-span-2">
                  <ReasonList title="Что сервис уже знает об этом счёте" reasons={fromHistory} tone="alarm" />
                </div>
              )}
              <ReasonList title="Счёт получателя" reasons={aboutAccount} />
              <ReasonList title="Обстоятельства перевода" reasons={aboutTransfer} />
            </div>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-[19px] font-semibold">Из чего сложилась оценка</h3>
          <ContributionChart contributions={response.contributions} features={features} />
        </div>

        <details className="rounded-[16px] bg-field">
          <summary className="cursor-pointer rounded-[16px] px-4 py-3 text-[15px] font-medium">Запрос и ответ целиком (JSON)</summary>
          <div className="grid gap-3 px-4 pb-4 text-[12px]">
            <pre className="overflow-x-auto font-mono">POST /score{'\n' + JSON.stringify(request, null, 2)}</pre>
            <pre className="overflow-x-auto border-t border-line pt-3 font-mono">200 OK{'\n' + JSON.stringify(response, null, 2)}</pre>
          </div>
        </details>
      </div>
    </div>
  )
}
