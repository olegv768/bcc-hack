import type { ScoreRequest, ScoreResponse } from './api.ts'
import { ContributionChart } from './ContributionChart.tsx'
import { ACTION_LABELS } from './scenarios.ts'

const ACTION_CLASS = {
  allow: 'bg-allow-bg text-allow-ink',
  warn: 'bg-warn-bg text-warn-ink',
  hold: 'bg-hold-bg text-hold-ink',
}

export function ActionBadge(props: { action: keyof typeof ACTION_CLASS }) {
  return (
    <span className={'inline-block rounded px-2 py-0.5 text-[13px] font-semibold whitespace-nowrap ' + ACTION_CLASS[props.action]}>
      {ACTION_LABELS[props.action]}
    </span>
  )
}

// Что ушло в сервис оценки и что он ответил.
export function ScorePanel(props: { request: ScoreRequest | null; response: ScoreResponse | null }) {
  const { request, response } = props
  if (!request || !response) {
    return (
      <p className="rounded-lg border border-dashed border-line p-5 text-ink-2">
        Сделайте перевод в заглушке — здесь появятся запрос банка в <code className="font-mono text-[13px]">POST /score</code> и ответ сервиса.
      </p>
    )
  }

  const { account_id, ...features } = request.recipient

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <div>
          <div className="text-[13px] text-ink-2">Риск получателя, от 0 до 1</div>
          <div className="text-5xl leading-none font-semibold">
            {response.risk.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="pb-1">
          <div className="text-[13px] text-ink-2">Рекомендация банку</div>
          <ActionBadge action={response.action} />
        </div>
      </div>

      <div>
        <h3 className="mb-1.5 font-semibold">Причины</h3>
        {response.reasons.length === 0 ? (
          <p className="text-ink-2">Подозрительных признаков нет.</p>
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {response.reasons.map((reason) => (
              <li key={reason.code}>{reason.text}</li>
            ))}
          </ul>
        )}
      </div>

      <ContributionChart contributions={response.contributions} features={features} />

      <details className="rounded-lg border border-line bg-surface">
        <summary className="cursor-pointer px-3 py-2 text-[14px] font-medium">Запрос и ответ целиком (JSON)</summary>
        <div className="grid gap-3 border-t border-line p-3 text-[12px]">
          <pre className="overflow-x-auto font-mono">POST /score{'\n' + JSON.stringify(request, null, 2)}</pre>
          <pre className="overflow-x-auto border-t border-line pt-3 font-mono">200 OK{'\n' + JSON.stringify(response, null, 2)}</pre>
        </div>
      </details>
    </div>
  )
}
