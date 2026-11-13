import model from '../../service/model/model.json'
import type { ScoreRequest, ScoreResponse } from './api.ts'
import { ContributionChart } from './ContributionChart.tsx'
import { ACTION_LABELS } from './scenarios.ts'

const ACTION_CLASS = {
  allow: 'bg-allow-bg text-allow-ink',
  warn: 'bg-warn-bg text-warn-ink',
  hold: 'bg-hold-bg text-hold-ink',
}

const ACTION_NOTE = {
  allow: 'Перевод уходит как обычно.',
  warn: 'Клиент видит предупреждение и сам решает, продолжать ли.',
  hold: 'Перевод не уходит, пока банк его не проверит.',
}

const fixed = (value: number) => value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function ActionBadge(props: { action: keyof typeof ACTION_CLASS }) {
  return (
    <span className={'inline-block rounded px-2 py-0.5 text-[13px] font-semibold whitespace-nowrap ' + ACTION_CLASS[props.action]}>
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
        className="relative h-3 rounded-full bg-allow-bg"
        role="img"
        aria-label={`Риск ${fixed(props.risk)} на шкале от 0 до 1; предупреждение от ${fixed(warn)}, приостановка от ${fixed(hold)}`}
      >
        <div className="absolute inset-y-0 bg-warn-bg" style={{ left: left(warn), right: left(1 - hold) }} />
        <div className="absolute inset-y-0 right-0 rounded-r-full bg-hold-bg" style={{ left: left(hold) }} />
        <div
          className="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-surface bg-ink transition-[left] duration-300"
          style={{ left: left(props.risk) }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-allow-bg ring-1 ring-line" /> пропустить
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-warn-bg ring-1 ring-line" /> предупредить — от {fixed(warn)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-2.5 rounded-sm bg-hold-bg ring-1 ring-line" /> придержать — от {fixed(hold)}
        </span>
      </div>
    </div>
  )
}

function ReasonList(props: { title: string; reasons: ScoreResponse['reasons'] }) {
  if (props.reasons.length === 0) return null
  return (
    <div>
      <h4 className="mb-1 text-[13px] text-ink-2">{props.title}</h4>
      <ul className="list-disc space-y-1 pl-5">
        {props.reasons.map((reason) => (
          <li key={reason.code}>{reason.text}</li>
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
      <p className="rounded-lg border border-dashed border-line p-5 text-ink-2">
        Нажмите «Перевести» в заглушке — здесь появятся запрос банка в <code className="font-mono text-[13px]">POST /score</code> и ответ
        сервиса: риск, причины и рекомендация.
      </p>
    )
  }

  const { account_id, ...features } = request.recipient
  const aboutAccount = response.reasons.filter((r) => r.contribution !== null)
  const aboutTransfer = response.reasons.filter((r) => r.contribution === null)

  return (
    <div className="space-y-6">
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-[auto_1fr]">
        <div>
          <div className="text-[13px] text-ink-2">Риск получателя</div>
          <div className="text-5xl leading-none font-semibold">{fixed(response.risk)}</div>
        </div>
        <div>
          <div className="text-[13px] text-ink-2">Рекомендация банку</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <ActionBadge action={response.action} />
            <span className="text-[14px]">{ACTION_NOTE[response.action]}</span>
          </div>
        </div>
        <div className="sm:col-span-2">
          <RiskScale risk={response.risk} />
        </div>
      </div>

      <div>
        <h3 className="mb-2 font-semibold">Причины</h3>
        {response.reasons.length === 0 ? (
          <p className="text-ink-2">Подозрительных признаков нет.</p>
        ) : (
          <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
            <ReasonList title="Счёт получателя" reasons={aboutAccount} />
            <ReasonList title="Обстоятельства перевода" reasons={aboutTransfer} />
          </div>
        )}
      </div>

      <ContributionChart contributions={response.contributions} features={features} />

      <details className="rounded-lg border border-line bg-surface">
        <summary className="cursor-pointer px-3 py-2.5 text-[14px] font-medium">Запрос и ответ целиком (JSON)</summary>
        <div className="grid gap-3 border-t border-line p-3 text-[12px]">
          <pre className="overflow-x-auto font-mono">POST /score{'\n' + JSON.stringify(request, null, 2)}</pre>
          <pre className="overflow-x-auto border-t border-line pt-3 font-mono">200 OK{'\n' + JSON.stringify(response, null, 2)}</pre>
        </div>
      </details>
    </div>
  )
}
