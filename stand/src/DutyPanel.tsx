import { useState } from 'react'
import type { Alert } from '../../service/src/alerts.ts'
import { updateAlert } from './api.ts'
import { ActionBadge } from './ScorePanel.tsx'
import { clientContacts, money } from './scenarios.ts'

const STATUS_LABEL = { new: 'Новый', in_progress: 'В работе', closed: 'Закрыт' }
const RESOLUTION_LABEL = { fraud: 'мошенничество подтверждено', legit: 'ложное срабатывание' }

const clock = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Заглушка рабочей панели дежурного сотрудника фрод-мониторинга. В банке вместо неё —
// его система ведения инцидентов: она получает те же алерты через GET /alerts или по вебхуку.
export function DutyPanel(props: { alerts: Alert[] | null; error: string; onChanged: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  if (props.alerts === null) {
    return <p className="text-ink-2">{props.error || 'Загружаем очередь…'}</p>
  }
  if (props.alerts.length === 0) {
    return (
      <div className="rounded-[20px] border border-dashed border-line p-6">
        <p className="text-[19px] font-semibold">Очередь пуста</p>
        <p className="mt-2 max-w-[52ch] text-ink-2">
          Алерт появляется, когда сервис рекомендует предупредить клиента или придержать перевод. Сделайте перевод на «Безопасный счёт» — карточка
          упадёт сюда сразу.
        </p>
      </div>
    )
  }

  const open = props.alerts.filter((a) => a.status !== 'closed')
  const selected = props.alerts.find((a) => a.alert_id === selectedId) ?? props.alerts[0]!
  const contacts = selected.client_ref ? clientContacts(selected.client_ref) : null

  async function change(status: Alert['status'], resolution?: 'fraud' | 'legit') {
    setBusy(true)
    setActionError('')
    try {
      await updateAlert(selected.alert_id, status, resolution)
      props.onChanged()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Не удалось изменить алерт')
    }
    setBusy(false)
  }

  const button = 'min-h-11 cursor-pointer rounded-full px-5 text-[15px] font-semibold disabled:cursor-default disabled:opacity-50'

  return (
    <div className="space-y-3">
      <p className="text-[15px]">
        В очереди: <b className="tabular">{open.length}</b>, из них с высоким приоритетом —{' '}
        <b className="tabular">{open.filter((a) => a.priority === 'high').length}</b>
      </p>

      <div className="grid gap-3 md:grid-cols-[minmax(0,210px)_1fr]">
        <ul className="max-h-[420px] space-y-1 overflow-auto rounded-[20px] border border-line p-1.5" aria-label="Очередь алертов">
          {props.alerts.map((alert) => (
            <li key={alert.alert_id}>
              <button
                type="button"
                onClick={() => setSelectedId(alert.alert_id)}
                aria-current={alert.alert_id === selected.alert_id}
                className={
                  'flex w-full cursor-pointer items-center gap-2.5 rounded-[16px] px-3 py-2.5 text-left ' +
                  (alert.alert_id === selected.alert_id ? 'bg-[#eef2ff]' : 'hover:bg-field') +
                  (alert.status === 'closed' ? ' opacity-55' : '')
                }
              >
                <span className={'size-2.5 shrink-0 rounded-full ' + (alert.priority === 'high' ? 'bg-hold' : 'bg-warn')} aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="tabular block text-[15px] font-semibold">{money(alert.amount)}</span>
                  <span className="tabular block text-[13px] text-muted">
                    {clock(alert.created_at)}, {STATUS_LABEL[alert.status].toLowerCase()}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>

        <article className="rounded-[20px] border border-line p-6" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
            <span className={'rounded-full px-3 py-1 ' + (selected.priority === 'high' ? 'bg-hold text-white' : 'bg-warn-bg text-warn-ink')}>
              {selected.priority === 'high' ? 'Высокий приоритет' : 'Средний приоритет'}
            </span>
            <span className="rounded-full bg-field px-3 py-1">
              {STATUS_LABEL[selected.status]}
              {selected.resolution ? ': ' + RESOLUTION_LABEL[selected.resolution] : ''}
            </span>
            <span className="tabular ml-auto font-normal text-muted">{clock(selected.created_at)}</span>
          </div>

          <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
            <div>
              <div className="text-[14px] text-muted">Сумма перевода</div>
              <div className="tabular font-display text-[30px] leading-tight font-semibold">{money(selected.amount)}</div>
            </div>
            <div className="text-[15px]">
              <ActionBadge action={selected.action} /> риск{' '}
              <span className="tabular">{selected.risk.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
          </div>

          <div className="mt-5 grid gap-x-8 gap-y-5 xl:grid-cols-[1.5fr_1fr]">
            <div>
              <h4 className="mb-2 text-[14px] text-muted">Сработавшие триггеры</h4>
              <ul className="space-y-1.5 text-[15px]">
                {selected.triggers.map((trigger) => (
                  <li key={trigger.code} className="flex gap-2.5">
                    <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-ink" aria-hidden="true" />
                    {trigger.text}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="mb-2 text-[14px] text-muted">Клиент</h4>
              {contacts ? (
                <div className="space-y-1 text-[15px]">
                  <div className="font-semibold">{contacts.name}</div>
                  <div className="tabular">{contacts.phone}</div>
                  <div className="text-[13px] text-muted">
                    {selected.client_ref}. Контакты подставила система банка: сервис оценки их не получает. Данные вымышлены.
                  </div>
                </div>
              ) : (
                <p className="text-[15px] text-ink-2">Банк не передал псевдоним клиента.</p>
              )}
              <h4 className="mt-4 mb-1 text-[14px] text-muted">Счёт получателя</h4>
              <div className="font-mono text-[14px]">{selected.account_id}</div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
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
          </div>
          {actionError && <p className="mt-3 rounded-[16px] bg-hold-bg px-4 py-3 text-hold-ink">{actionError}</p>}
        </article>
      </div>
    </div>
  )
}
