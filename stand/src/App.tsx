import { useCallback, useEffect, useState } from 'react'
import type { FlaggedAccount } from '../../service/src/store.ts'
import { loadFlagged, type ScoreRequest, type ScoreResponse } from './api.ts'
import { ExportPanel } from './ExportPanel.tsx'
import { Metrics } from './Metrics.tsx'
import { ACTION_LABELS, money } from './scenarios.ts'
import { ScorePanel } from './ScorePanel.tsx'
import { TransferStub } from './TransferStub.tsx'

export function App() {
  const [request, setRequest] = useState<ScoreRequest | null>(null)
  const [response, setResponse] = useState<ScoreResponse | null>(null)
  const [flagged, setFlagged] = useState<FlaggedAccount[] | null>(null)
  const [flaggedError, setFlaggedError] = useState('')

  const refreshFlagged = useCallback(() => {
    loadFlagged()
      .then((items) => {
        setFlagged(items)
        setFlaggedError('')
      })
      .catch((e: Error) => setFlaggedError(e.message))
  }, [])

  useEffect(refreshFlagged, [refreshFlagged])

  return (
    <div className="mx-auto max-w-[1180px] px-4 pt-8 pb-16 sm:px-6">
      <header className="mb-10 max-w-[68ch]">
        <h1 className="text-3xl leading-tight font-semibold sm:text-4xl">Где модуль встаёт в поток перевода</h1>
        <p className="mt-3 text-[17px] text-ink-2">
          Перед тем как отправить деньги, банк спрашивает сервис о получателе. Сервис отвечает риском, причинами и рекомендацией; приложение
          показывает клиенту предупреждение, а помеченный счёт уходит аналитику.
        </p>
      </header>

      <ol className="mb-10 grid overflow-hidden rounded-xl border border-line bg-surface sm:grid-cols-3" aria-label="Путь перевода">
        <FlowNode
          number={1}
          title="Приложение банка"
          text={request ? `Перевод ${money(request.context.amount)}${signals(request)}` : 'Клиент нажимает «Перевести»'}
        />
        <FlowNode
          number={2}
          title="Сервис оценки"
          text={
            response
              ? `Риск ${response.risk.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} — ${ACTION_LABELS[response.action].toLowerCase()}`
              : 'Отвечает риском и рекомендацией'
          }
          tone={response?.action}
        />
        <FlowNode
          number={3}
          title="Аналитик"
          text={flagged ? `Помеченных счетов в выгрузке: ${flagged.length}` : 'Получает помеченные счета'}
        />
      </ol>

      <div className="grid gap-x-10 gap-y-12 lg:grid-cols-[360px_1fr]">
        <Step number={1} sticky title="Приложение банка" note="Условная заглушка экрана перевода с подключённым клиентским модулем.">
          <TransferStub
            onScored={(req, res) => {
              setRequest(req)
              setResponse(res)
              refreshFlagged()
            }}
          />
        </Step>

        <div className="min-w-0 space-y-12">
          <Step number={2} title="Сервис оценки получателя" note="Считает локально, внешних сервисов не вызывает.">
            <ScorePanel request={request} response={response} />
          </Step>

          <Step number={3} title="Выгрузка для аналитика" note="Помеченные счета с причинами — файлом или по API, для инструментов, которые у банка уже есть.">
            <ExportPanel items={flagged} error={flaggedError} onChanged={refreshFlagged} />
          </Step>
        </div>
      </div>

      <section className="mt-16 border-t border-line pt-10">
        <h2 className="mb-3 text-2xl font-semibold">Метрики модели</h2>
        <Metrics />
      </section>

      <footer className="mt-16 border-t border-line pt-5 text-[13px] text-muted">
        Демонстрационный стенд. Данные синтетические, счета и клиенты вымышлены. Описание API —{' '}
        <a className="underline underline-offset-2" href="/api/openapi.yaml" target="_blank" rel="noreferrer">
          openapi.yaml
        </a>
        .
      </footer>
    </div>
  )
}

function signals(request: ScoreRequest): string {
  const parts = []
  if (request.context.sender_on_call) parts.push('на звонке')
  if (request.context.remote_access_active) parts.push('удалённый доступ')
  return parts.length ? ', ' + parts.join(', ') : ''
}

const TONE = { allow: 'bg-allow-bg', warn: 'bg-warn-bg', hold: 'bg-hold-bg' }

function FlowNode(props: { number: number; title: string; text: string; tone?: keyof typeof TONE }) {
  return (
    <li className={'border-b border-line px-4 py-3 last:border-0 sm:border-r sm:border-b-0 ' + (props.tone ? TONE[props.tone] : '')}>
      <div className="text-[13px] text-ink-2">
        <span className="tabular">{props.number}</span> · {props.title}
      </div>
      <div className="font-medium" aria-live="polite">
        {props.text}
      </div>
    </li>
  )
}

function Step(props: { number: number; title: string; note: string; sticky?: boolean; children: React.ReactNode }) {
  return (
    <section className={'min-w-0 ' + (props.sticky ? '[@media(min-height:860px)]:lg:sticky lg:top-6 lg:self-start' : '')}>
      <h2 className="flex items-baseline gap-2.5 text-xl font-semibold">
        <span className="tabular text-muted">{props.number}</span>
        {props.title}
      </h2>
      <p className="mt-1 mb-4 text-[14px] text-ink-2">{props.note}</p>
      {props.children}
    </section>
  )
}
