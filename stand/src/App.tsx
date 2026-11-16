import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { Alert } from '../../service/src/alerts.ts'
import type { FlaggedAccount } from '../../service/src/store.ts'
import { loadAlerts, loadFlagged, type ScoreRequest, type ScoreResponse } from './api.ts'
import { DutyPanel } from './DutyPanel.tsx'
import { ExportPanel } from './ExportPanel.tsx'
import { Metrics } from './Metrics.tsx'
import { NetworkPage } from './network/NetworkPage.tsx'
import { ACTION_LABELS, money, riskText } from './scenarios.ts'
import { ScorePanel } from './ScorePanel.tsx'
import { TransferScreen } from './TransferScreen.tsx'

const CONTAINER = 'mx-auto max-w-[1180px] px-4 sm:px-6'

const CONTAINER_WIDE = 'mx-auto max-w-[1640px] px-4 sm:px-6'

// Две вкладки стенда: путь перевода и расследование сети (#network/<счёт, клиент или алерт>).
const useHash = () =>
  useSyncExternalStore(
    (on) => {
      window.addEventListener('hashchange', on)
      return () => window.removeEventListener('hashchange', on)
    },
    () => location.hash,
  )

export function App() {
  const hash = useHash()
  const network = hash.startsWith('#network')
  useEffect(() => {
    document.title = network ? 'Network Investigation — расследование сети' : 'Стенд: оценка получателя перевода'
  }, [network])

  if (network) {
    const ref = decodeURIComponent(hash.slice('#network/'.length))
    return (
      <>
        <header className="bg-navy text-white">
          <div className={CONTAINER_WIDE + ' pt-4 pb-5'}>
            <Tabs network />
            <h1 className="mt-5 font-display text-[26px] leading-tight font-semibold sm:text-[32px]">Network Investigation</h1>
            <p className="mt-1.5 max-w-[80ch] text-[15px] text-white/75">
              Не отдельный перевод, а вся сеть вокруг него: кто ещё переводил на этот счёт, куда ушли деньги, с каких устройств входили. Модуль только показывает связи и объясняет их — решает сотрудник.
            </p>
          </div>
        </header>
        <main className="min-h-[70vh] bg-field">
          {/* key: переход по другой ссылке #network/… начинает новое расследование */}
          <NetworkPage key={ref} initial={ref || null} />
        </main>
      </>
    )
  }
  return <TransferStand />
}

function Tabs(props: { network?: boolean }) {
  const tab = 'rounded-full px-4 py-2 text-[14px] font-semibold'
  return (
    <nav className="flex flex-wrap gap-1" aria-label="Разделы стенда">
      <a href="#" aria-current={!props.network ? 'page' : undefined} className={tab + (!props.network ? ' bg-white text-navy' : ' text-white/75 hover:text-white')}>
        Перевод и оценка
      </a>
      <a href="#network" aria-current={props.network ? 'page' : undefined} className={tab + (props.network ? ' bg-white text-navy' : ' text-white/75 hover:text-white')}>
        Network Investigation
      </a>
    </nav>
  )
}

function TransferStand() {
  const [request, setRequest] = useState<ScoreRequest | null>(null)
  const [response, setResponse] = useState<ScoreResponse | null>(null)
  const [flagged, setFlagged] = useState<FlaggedAccount[] | null>(null)
  const [flaggedError, setFlaggedError] = useState('')
  const [alerts, setAlerts] = useState<Alert[] | null>(null)
  const [alertsError, setAlertsError] = useState('')

  const refreshFlagged = useCallback(() => {
    loadFlagged()
      .then((items) => {
        setFlagged(items)
        setFlaggedError('')
      })
      .catch((e: Error) => setFlaggedError(e.message))
    loadAlerts()
      .then((items) => {
        setAlerts(items)
        setAlertsError('')
      })
      .catch((e: Error) => setAlertsError(e.message))
  }, [])

  useEffect(refreshFlagged, [refreshFlagged])

  return (
    <>
      <header className="bg-navy text-white">
        <div className="mx-auto max-w-[1180px] px-4 pt-4 pb-10 sm:px-6">
          <Tabs />
          <h1 className="mt-8 max-w-[18ch] font-display text-[30px] leading-[1.12] font-semibold sm:text-[46px]">
            Перевод мошеннику останавливается здесь
          </h1>
          <p className="mt-4 max-w-[60ch] text-[17px] text-white/75">
            Перед отправкой денег банк спрашивает сервис о счёте получателя. Сделайте перевод ниже и посмотрите, что решит сервис.
          </p>
          <Rail request={request} response={response} alerts={alerts} />
        </div>
      </header>

      <main>
        <div className={CONTAINER + ' grid gap-x-14 gap-y-12 pt-12 pb-20 lg:grid-cols-[372px_1fr]'}>
          <Step number={1} sticky title="Приложение банка" note="Выберите получателя и нажмите «Перевести» — запрос уйдёт в сервис оценки.">
            <TransferScreen
              onScored={(req, res) => {
                setRequest(req)
                setResponse(res)
                refreshFlagged()
              }}
            />
          </Step>

          <Step number={2} title="Сервис оценки получателя" note="Решение и причины. Всё считается внутри банка, данные никуда не уходят.">
            <ScorePanel request={request} response={response} />
          </Step>
        </div>

        {/* сторона банка: то, что видит не клиент, а сотрудник */}
        <div className="bg-field">
          <div className={CONTAINER + ' py-16'}>
            <Step
              number={3}
              title="Панель дежурного фрод-мониторинга"
              note="Так подозрительный перевод видит дежурный сотрудник. Алерт приходит в ту же секунду, что и ответ сервиса."
            >
              <DutyPanel alerts={alerts} error={alertsError} onChanged={refreshFlagged} />
            </Step>
          </div>
        </div>

        <div className={CONTAINER + ' py-16'}>
          <Step number={4} title="Выгрузка для аналитика" note="Все помеченные счета с причинами — файлом для Excel или по API.">
            <ExportPanel items={flagged} error={flaggedError} onChanged={refreshFlagged} />
          </Step>
        </div>

        <section className={CONTAINER + ' pb-8'}>
          <div className="border-t border-ink pt-12">
            <h2 className="mb-10 max-w-[20ch] text-[30px] leading-[1.15] font-bold sm:text-[36px]">Насколько хорошо это работает</h2>
            <Metrics />
          </div>
        </section>

        <footer className={CONTAINER + ' pt-8 pb-12 text-[14px] text-muted'}>
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
function Rail(props: { request: ScoreRequest | null; response: ScoreResponse | null; alerts: Alert[] | null }) {
  const { request, response, alerts } = props
  const waiting = alerts?.filter((a) => a.status !== 'closed') ?? []
  const current = alerts?.find((a) => a.alert_id === response?.alert_id)
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
            <span className="block text-white/70">риск {riskText(response.risk)}</span>
          </>
        ) : (
          'Отвечает риском и рекомендацией'
        )}
      </Station>

      <Station title="Антифрод-аналитик" tone={isFlagged ? 'on' : undefined}>
        {alerts ? (
          <>
            {isFlagged ? (current?.priority === 'high' ? 'Алерт высокого приоритета' : 'Алерт в очереди') : 'Получает алерты'}
            <span className="block text-white/70">в очереди: {waiting.length}</span>
          </>
        ) : (
          'Получает алерты'
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
      <h2 className="flex items-center gap-3 text-[22px] leading-tight font-bold">
        <span className="tabular grid size-8 shrink-0 place-items-center rounded-full bg-ink text-[14px] text-white">{props.number}</span>
        {props.title}
      </h2>
      <p className="mt-2 mb-6 max-w-[70ch] text-[15px] text-ink-2">{props.note}</p>
      {props.children}
    </section>
  )
}
