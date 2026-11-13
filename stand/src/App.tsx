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
    <>
      <header className="bg-navy text-white">
        <div className="mx-auto max-w-[1180px] px-4 pt-10 pb-10 sm:px-6 sm:pt-14">
          <h1 className="max-w-[18ch] font-display text-[30px] leading-[1.12] font-semibold sm:text-[46px]">
            Перевод мошеннику останавливается здесь
          </h1>
          <p className="mt-4 max-w-[60ch] text-[17px] text-white/75">
            Перед отправкой денег банк спрашивает сервис о счёте получателя. Сделайте перевод в заглушке ниже и проследите его путь.
          </p>
          <Rail request={request} response={response} flagged={flagged} />
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-4 pt-10 pb-16 sm:px-6">
        <div className="grid gap-x-12 gap-y-12 lg:grid-cols-[372px_1fr]">
          <Step number={1} sticky title="Приложение банка" note="Условная заглушка экрана перевода с клиентским модулем.">
            <TransferStub
              onScored={(req, res) => {
                setRequest(req)
                setResponse(res)
                refreshFlagged()
              }}
            />
          </Step>

          <div className="min-w-0 space-y-14">
            <Step number={2} title="Сервис оценки получателя" note="Считает локально, внешних сервисов не вызывает.">
              <ScorePanel request={request} response={response} />
            </Step>

            <Step number={3} title="Выгрузка для аналитика" note="Помеченные счета с причинами — файлом или по API, для инструментов, которые у банка уже есть.">
              <ExportPanel items={flagged} error={flaggedError} onChanged={refreshFlagged} />
            </Step>
          </div>
        </div>

        <section className="mt-20">
          <h2 className="mb-4 font-display text-[26px] font-semibold">Метрики модели</h2>
          <Metrics />
        </section>

        <footer className="mt-16 border-t border-line pt-5 text-[14px] text-muted">
          Демонстрационный стенд. Данные синтетические, счета и клиенты вымышлены. Описание API —{' '}
          <a className="text-accent underline underline-offset-2" href="/api/openapi.yaml" target="_blank" rel="noreferrer">
            openapi.yaml
          </a>
          .
        </footer>
      </main>
    </>
  )
}

// Маршрут перевода: точка бежит от приложения к сервису, а если счёт помечен — дальше к аналитику.
function Rail(props: { request: ScoreRequest | null; response: ScoreResponse | null; flagged: FlaggedAccount[] | null }) {
  const { request, response, flagged } = props
  const isFlagged = response !== null && response.action !== 'allow'

  const signals = []
  if (request?.context.sender_on_call) signals.push('клиент на звонке')
  if (request?.context.remote_access_active) signals.push('включён удалённый доступ')

  return (
    <ol className="rail mt-10" aria-label="Путь перевода">
      <li className="rail-line" aria-hidden="true" />
      {response && <li key={response.request_id} className="rail-pulse" data-run={isFlagged ? 'analyst' : 'service'} aria-hidden="true" />}

      <Station title="Приложение банка" tone={request ? 'on' : undefined}>
        {request ? (
          <>
            Перевод {money(request.context.amount)}
            {signals.length > 0 && <span className="block text-white/70">{signals.join(', ')}</span>}
          </>
        ) : (
          'Клиент нажимает «Перевести»'
        )}
      </Station>

      <Station title="Сервис оценки" tone={response?.action}>
        {response ? (
          <>
            {ACTION_LABELS[response.action]}
            <span className="block text-white/70">риск {response.risk.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </>
        ) : (
          'Отвечает риском и рекомендацией'
        )}
      </Station>

      <Station title="Аналитик" tone={isFlagged ? 'on' : undefined}>
        {flagged ? (
          <>
            {isFlagged ? 'Счёт попал в выгрузку' : 'Получает помеченные счета'}
            <span className="block text-white/70">всего помечено: {flagged.length}</span>
          </>
        ) : (
          'Получает помеченные счета'
        )}
      </Station>
    </ol>
  )
}

function Station(props: { title: string; tone?: string; children: React.ReactNode }) {
  return (
    <li className="rail-station">
      <span className="rail-node" data-tone={props.tone} aria-hidden="true" />
      <div className="text-[14px] text-white/60">{props.title}</div>
      <div className="text-[17px] font-medium" aria-live="polite">
        {props.children}
      </div>
    </li>
  )
}

function Step(props: { number: number; title: string; note: string; sticky?: boolean; children: React.ReactNode }) {
  return (
    <section className={'min-w-0 ' + (props.sticky ? '[@media(min-height:900px)]:lg:sticky lg:top-6 lg:self-start' : '')}>
      <h2 className="flex items-center gap-3 font-display text-[20px] font-semibold">
        <span className="tabular grid size-8 shrink-0 place-items-center rounded-full bg-ink text-[14px] text-white">{props.number}</span>
        {props.title}
      </h2>
      <p className="mt-2 mb-5 text-[15px] text-ink-2">{props.note}</p>
      {props.children}
    </section>
  )
}
