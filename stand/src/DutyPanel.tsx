import { useState } from 'react'
import type { Alert, AlertSignals } from '../../service/src/alerts.ts'
import { updateAlert } from './api.ts'
import { ActionBadge } from './ScorePanel.tsx'
import { clientContacts, money, riskText } from './scenarios.ts'

const STATUS_LABEL = { new: 'Новый', in_progress: 'В работе', closed: 'Закрыт' }
const RESOLUTION_LABEL = { fraud: 'мошенничество подтверждено', legit: 'ложное срабатывание' }

const clock = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Рабочая панель дежурного сотрудника фрод-мониторинга: настоящие алерты из очереди сервиса (GET /alerts).
// В банке их показывает его система ведения инцидентов — она получает те же алерты по вебхуку или опросом.
export function DutyPanel(props: { alerts: Alert[] | null; error: string; onChanged: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  const alerts = props.alerts ?? []
  const open = alerts.filter((a) => a.status !== 'closed')
  const urgent = open.filter((a) => a.priority === 'high').length
  const selected = alerts.find((a) => a.alert_id === selectedId) ?? alerts[0]
  const contacts = selected?.client_ref ? clientContacts(selected.client_ref) : null

  async function change(status: Alert['status'], resolution?: 'fraud' | 'legit') {
    if (!selected) return
    setBusy(true)
    setActionError('')
    try {
      await updateAlert(selected, status, resolution)
      props.onChanged()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Не удалось сохранить изменение. Попробуйте ещё раз.')
      props.onChanged()
    }
    setBusy(false)
  }

  const button = 'min-h-11 cursor-pointer rounded-full px-5 text-[15px] font-semibold disabled:cursor-default disabled:opacity-50'

  return (
    <div className="overflow-hidden rounded-[20px] border border-line bg-white shadow-[0_30px_60px_-45px_rgb(11_22_56/0.6)]">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line px-5 py-3.5">
        <span className="text-[15px] font-semibold">Очередь инцидентов</span>
        <div className="flex flex-wrap gap-2 text-[13px] font-semibold">
          <span className="tabular rounded-full bg-field px-3 py-1">В очереди: {open.length}</span>
          <span className={'tabular rounded-full px-3 py-1 ' + (urgent ? 'bg-hold text-white' : 'bg-field')}>Высокий приоритет: {urgent}</span>
        </div>
      </div>

      {!selected ? (
        <div className="px-6 py-14 text-center">
          <p className="text-[19px] font-semibold">{props.alerts === null ? props.error || 'Загружаем очередь…' : 'Очередь пуста'}</p>
          {props.alerts !== null && (
            <p className="mx-auto mt-2 max-w-[52ch] text-ink-2">
              Алерт появляется, когда сервис рекомендует предупредить клиента или придержать перевод. Сделайте перевод на «Безопасный счёт» —
              карточка появится здесь сразу.
            </p>
          )}
        </div>
      ) : (
        <div className="grid md:grid-cols-[minmax(0,270px)_1fr]">
          <ul className="max-h-[230px] overflow-auto border-b border-line p-2 md:max-h-[520px] md:border-b-0" aria-label="Очередь алертов">
            {alerts.map((alert) => (
              <li key={alert.alert_id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(alert.alert_id)}
                  aria-current={alert.alert_id === selected.alert_id}
                  className={
                    'flex w-full cursor-pointer items-center gap-3 rounded-[14px] px-3 py-2.5 text-left ' +
                    (alert.alert_id === selected.alert_id ? 'bg-[#eef2ff]' : 'hover:bg-field') +
                    (alert.status === 'closed' ? ' opacity-55' : '')
                  }
                >
                  <span className={'size-2.5 shrink-0 rounded-full ' + (alert.priority === 'high' ? 'bg-hold' : 'bg-warn')} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="tabular block text-[15px] font-semibold">{money(alert.amount)}</span>
                    <span className="block text-[13px] text-muted">{alert.priority === 'high' ? 'Высокий приоритет' : 'Средний приоритет'}</span>
                  </span>
                  <span className="text-right text-[13px] text-muted">
                    <span className="tabular block">{clock(alert.created_at)}</span>
                    <span className="block">{STATUS_LABEL[alert.status].toLowerCase()}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <article className="border-line p-6 sm:p-8 md:border-l" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
              <span className={'rounded-full px-3 py-1 ' + (selected.priority === 'high' ? 'bg-hold text-white' : 'bg-warn-bg text-warn-ink')}>
                {selected.priority === 'high' ? 'Высокий приоритет' : 'Средний приоритет'}
              </span>
              <span className="rounded-full bg-field px-3 py-1">
                {STATUS_LABEL[selected.status]}
                {selected.resolution ? ': ' + RESOLUTION_LABEL[selected.resolution] : ''}
              </span>
              <span className="tabular ml-auto font-normal text-muted">получен в {clock(selected.created_at)}</span>
            </div>

            <div className="mt-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
              <div>
                <div className="text-[14px] text-muted">Сумма перевода</div>
                <div className="tabular font-display text-[34px] leading-tight font-semibold">{money(selected.amount)}</div>
              </div>
              <div className="text-[15px]">
                {selected.model_version.startsWith('incoming') ? (
                  <>
                    <span className="rounded-full bg-[#e6ecff] px-2.5 py-0.5 text-[13px] font-semibold text-[#1d3fbf]">
                      {selected.action === 'hold' ? 'Зачисление придержано' : 'Получатель предупреждён'}
                    </span>{' '}
                    проверка поступления на счёт клиента банка
                  </>
                ) : (
                  <>
                    <ActionBadge action={selected.action} /> риск получателя <b className="tabular">{riskText(selected.risk)}</b>
                  </>
                )}
              </div>
            </div>

            <PhoneSignals signals={selected.signals ?? NO_SIGNALS} />

            <div className="mt-7 grid gap-x-12 gap-y-7 lg:grid-cols-[1.6fr_1fr]">
              <div>
                <h4 className="mb-2.5 text-[14px] text-muted">Сработавшие триггеры</h4>
                <ul className="space-y-2">
                  {selected.triggers.map((trigger) => (
                    <li key={trigger.code} className="flex gap-2.5">
                      <span className="mt-[10px] size-1.5 shrink-0 rounded-full bg-ink" aria-hidden="true" />
                      {trigger.text}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-6">
                <div>
                  <h4 className="mb-2.5 text-[14px] text-muted">Клиент</h4>
                  {contacts ? (
                    <>
                      <div className="text-[17px] font-semibold">{contacts.name}</div>
                      <div className="tabular text-[17px]">{contacts.phone}</div>
                      <p className="mt-2 text-[13px] text-muted">
                        Контакты по псевдониму {selected.client_ref} подставила система банка. Сервис оценки их не получает. Данные вымышлены.
                      </p>
                    </>
                  ) : (
                    <p className="text-ink-2">Банк не передал псевдоним клиента.</p>
                  )}
                </div>
                <div>
                  <h4 className="mb-1.5 text-[14px] text-muted">Счёт получателя</h4>
                  <div className="font-mono text-[15px]">{selected.account_id}</div>
                </div>
              </div>
            </div>

            <div className="mt-8 flex flex-wrap gap-2 border-t border-line pt-6">
              {selected.status === 'new' && (
                <button type="button" disabled={busy} onClick={() => change('in_progress')} className={button + ' bg-ink text-white'}>
                  Взять в работу
                </button>
              )}
              {selected.status !== 'closed' ? (
                <>
                  <button type="button" disabled={busy} onClick={() => change('closed', 'fraud')} className={button + ' bg-field'}>
                    Мошенничество подтверждено
                  </button>
                  <button type="button" disabled={busy} onClick={() => change('closed', 'legit')} className={button + ' bg-field'}>
                    Ложное срабатывание
                  </button>
                </>
              ) : (
                <button type="button" disabled={busy} onClick={() => change('new')} className={button + ' bg-field'}>
                  Вернуть в очередь
                </button>
              )}
              {/* не отдельный перевод, а вся сеть вокруг счёта получателя */}
              <a href={'#network/' + encodeURIComponent(selected.account_id)} className={button + ' inline-flex items-center bg-accent text-white sm:ml-auto'}>
                Расследовать сеть
              </a>
            </div>
            {actionError && <p className="mt-3 rounded-[14px] bg-hold-bg px-4 py-3 text-hold-ink">{actionError}</p>}
          </article>
        </div>
      )}
    </div>
  )
}

// у алертов, созданных до появления сигналов, их нет
const NO_SIGNALS: AlertSignals = { on_call: null, remote_access: null, first_transfer: null }

// Что сообщил телефон клиента в момент перевода. Сработавший сигнал выделен красным.
function PhoneSignals(props: { signals: AlertSignals }) {
  const rows: [string, boolean | null, string, string][] = [
    ['Звонок', props.signals.on_call, 'Клиент разговаривал по телефону', 'Не разговаривал'],
    ['Удалённый доступ', props.signals.remote_access, 'Телефоном могли управлять', 'Не обнаружен'],
    ['Получатель', props.signals.first_transfer, 'Переводит ему впервые', 'Уже переводил раньше'],
  ]
  return (
    <div className="mt-7">
      <h4 className="mb-2.5 text-[14px] text-muted">Телефон клиента во время перевода</h4>
      <ul className="grid gap-2 sm:grid-cols-3">
        {rows.map(([label, value, yes, no]) => (
          <li
            key={label}
            className={'rounded-[14px] px-4 py-3 ' + (value === true ? 'bg-hold-bg text-hold-ink' : 'bg-field text-ink')}
          >
            <span className={'block text-[13px] ' + (value === true ? '' : 'text-muted')}>{label}</span>
            <span className="block text-[15px] leading-snug font-semibold">
              {value === null ? 'Не передано' : value ? yes : no}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
