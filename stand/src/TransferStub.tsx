import { useRef, useState } from 'react'
import { callSignal, remoteAccessSignal, showWarning, type Lang } from '../../sdk/web/dropper-guard.ts'
import { score, type ScoreRequest, type ScoreResponse } from './api.ts'
import { CLIENT_REF, money, SCENARIOS, TYPICAL_TRANSFER } from './scenarios.ts'

type Outcome = 'sent' | 'cancelled' | 'held'

const OUTCOME_TEXT: Record<Outcome, { title: string; note: string; className: string }> = {
  sent: { title: 'Перевод отправлен', note: 'Деньги ушли получателю.', className: 'bg-allow-bg text-allow-ink' },
  cancelled: { title: 'Перевод отменён', note: 'Клиент прочитал предупреждение и отказался.', className: 'bg-warn-bg text-warn-ink' },
  held: { title: 'Перевод приостановлен', note: 'Деньги остались на счёте клиента до проверки.', className: 'bg-hold-bg text-hold-ink' },
}

// цвета кружков с первой буквой имени — чтобы получатели различались с одного взгляда
const AVATAR = [
  'bg-[#dfe7ff] text-[#1f3fb8]',
  'bg-[#d8f4e6] text-[#06603a]',
  'bg-[#ffedc2] text-[#6b4300]',
  'bg-[#e9e2ff] text-[#4a2fa8]',
  'bg-[#ffe1e1] text-[#8f1216]',
]

// Условная заглушка экрана перевода. Вместо неё в банке — его собственное приложение.
export function TransferStub(props: { onScored: (request: ScoreRequest, response: ScoreResponse) => void }) {
  const phone = useRef<HTMLDivElement>(null)
  const [scenarioId, setScenarioId] = useState('fresh')
  const [amount, setAmount] = useState(450000)
  const [onCall, setOnCall] = useState(true)
  const [remoteAccess, setRemoteAccess] = useState(false)
  const [lang, setLang] = useState<Lang>('ru')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [error, setError] = useState('')

  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!
  const amountValid = Number.isFinite(amount) && amount >= 100

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!amountValid || busy) return
    setBusy(true)
    setOutcome(null)
    setError('')

    const request: ScoreRequest = {
      transfer_id: 'tr_' + Date.now().toString(36),
      lang,
      client_ref: CLIENT_REF,
      recipient: { account_id: scenario.account_id, ...scenario.features },
      context: {
        amount,
        // на стенде сигналы задают переключатели; в приложении их отдаёт нативная часть модуля
        sender_on_call: callSignal(() => onCall),
        remote_access_active: remoteAccessSignal(() => remoteAccess),
        first_transfer_to_recipient: scenario.first_transfer,
        amount_to_typical_ratio: Math.round((amount / TYPICAL_TRANSFER) * 10) / 10,
      },
    }

    try {
      const response = await score(request)
      props.onScored(request, response)
      if (response.action === 'allow' || !response.client_message) {
        setOutcome('sent')
      } else {
        const choice = await showWarning(phone.current!, { action: response.action, message: response.client_message, lang })
        setOutcome(choice === 'proceed' ? 'sent' : response.action === 'hold' ? 'held' : 'cancelled')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось выполнить перевод')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[372px] rounded-[46px] bg-navy p-[10px] shadow-[0_30px_60px_-30px_rgb(11_22_56/0.55)]">
      <div ref={phone} className="relative overflow-hidden rounded-[36px] bg-white">
        <div className="flex items-center justify-between px-6 pt-3 text-[13px] font-semibold" aria-hidden="true">
          <span className="tabular">12:30</span>
          <span className="h-[22px] w-[84px] rounded-full bg-navy" />
          <span className="h-[11px] w-[20px] rounded-[4px] border-[1.5px] border-ink p-[1.5px]">
            <span className="block h-full w-3/4 rounded-[1px] bg-ink" />
          </span>
        </div>

        <form onSubmit={submit} className="flex min-h-[640px] flex-col gap-5 px-5 pt-4 pb-5">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-[20px] font-semibold">Перевод</h3>
            <label>
              <span className="sr-only">Язык приложения</span>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value as Lang)}
                className="cursor-pointer rounded-full bg-field px-3 py-1.5 text-[13px] font-semibold"
              >
                <option value="ru">RU</option>
                <option value="kk">KK</option>
                <option value="en">EN</option>
              </select>
            </label>
          </div>

          <label className="block rounded-[20px] bg-field px-4 py-3 focus-within:ring-2 focus-within:ring-accent">
            <span className="text-[13px] text-muted">Сумма, ₸</span>
            <input
              type="number"
              inputMode="numeric"
              min={100}
              step={100}
              value={Number.isFinite(amount) ? amount : ''}
              onChange={(e) => setAmount(e.target.valueAsNumber)}
              className="tabular block w-full bg-transparent font-display text-[28px] font-semibold outline-none!"
            />
            <span className="text-[13px] text-muted">
              {amountValid ? `обычно этот клиент переводит ${money(TYPICAL_TRANSFER)}` : 'Введите сумму от 100 ₸'}
            </span>
          </label>

          <fieldset>
            <legend className="mb-2 text-[13px] text-muted">Кому</legend>
            <div className="space-y-1">
              {SCENARIOS.map((s, i) => {
                const selected = s.id === scenarioId
                return (
                  <label
                    key={s.id}
                    className={
                      'flex cursor-pointer items-center gap-3 rounded-[16px] px-2.5 py-2 ring-2 ring-inset has-focus-visible:ring-accent ' +
                      (selected ? 'bg-[#eef2ff] ring-accent' : 'ring-transparent hover:bg-field')
                    }
                  >
                    <input type="radio" name="recipient" value={s.id} checked={selected} onChange={() => setScenarioId(s.id)} className="sr-only" />
                    <span
                      className={'grid size-10 shrink-0 place-items-center rounded-full text-[15px] font-semibold ' + AVATAR[i % AVATAR.length]}
                      aria-hidden="true"
                    >
                      {s.name.replace(/[«»]/g, '').charAt(0)}
                    </span>
                    <span className="min-w-0 text-[15px] leading-tight font-medium">
                      {s.name}
                      <span className="block text-[13px] font-normal text-muted">
                        {s.note}
                        {s.first_transfer ? ', новый получатель' : ''}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 text-[13px] text-muted">Что сообщает телефон</legend>
            <div className="divide-y divide-line rounded-[20px] bg-field px-4 text-[15px]">
              <label className="flex cursor-pointer items-center justify-between gap-3 py-3">
                Клиент на звонке
                <input type="checkbox" className="switch" checked={onCall} onChange={(e) => setOnCall(e.target.checked)} />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-3 py-3">
                Включён удалённый доступ
                <input type="checkbox" className="switch" checked={remoteAccess} onChange={(e) => setRemoteAccess(e.target.checked)} />
              </label>
            </div>
            <p className="mt-1.5 text-[12px] text-muted">На стенде это переключатели, в приложении — сам телефон.</p>
          </fieldset>

          <div className="mt-auto space-y-3">
            <div aria-live="polite">
              {outcome && (
                <div className={'rounded-[16px] px-4 py-3 text-[14px] ' + OUTCOME_TEXT[outcome].className}>
                  <b>{OUTCOME_TEXT[outcome].title}</b>
                  <span className="block">{OUTCOME_TEXT[outcome].note}</span>
                </div>
              )}
              {error && <div className="rounded-[16px] bg-hold-bg px-4 py-3 text-[14px] text-hold-ink">{error}</div>}
            </div>
            <button
              type="submit"
              disabled={!amountValid || busy}
              className="min-h-14 w-full cursor-pointer rounded-full bg-accent text-[16px] font-semibold text-white transition-transform active:scale-[0.98] disabled:cursor-default disabled:opacity-50"
            >
              {busy ? 'Проверяем получателя…' : `Перевести ${amountValid ? money(amount) : ''}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
