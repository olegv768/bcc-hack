import { useRef, useState } from 'react'
import { callSignal, showWarning, type Lang } from '../../sdk/web/dropper-guard.ts'
import { score, type ScoreRequest, type ScoreResponse } from './api.ts'
import { money, SCENARIOS, TYPICAL_TRANSFER } from './scenarios.ts'

type Outcome = 'sent' | 'cancelled' | 'held'

const OUTCOME_TEXT: Record<Outcome, { title: string; note: string; className: string }> = {
  sent: { title: 'Перевод отправлен', note: 'Деньги ушли получателю.', className: 'bg-allow-bg text-allow-ink' },
  cancelled: { title: 'Перевод отменён', note: 'Клиент прочитал предупреждение и отказался.', className: 'bg-warn-bg text-warn-ink' },
  held: { title: 'Перевод приостановлен', note: 'Деньги остались на счёте клиента до проверки.', className: 'bg-hold-bg text-hold-ink' },
}

// Условная заглушка экрана перевода. Вместо неё в банке — его собственное приложение.
export function TransferStub(props: { onScored: (request: ScoreRequest, response: ScoreResponse) => void }) {
  const phone = useRef<HTMLDivElement>(null)
  const [scenarioId, setScenarioId] = useState('fresh')
  const [amount, setAmount] = useState(450000)
  const [onCall, setOnCall] = useState(true)
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
      recipient: { account_id: scenario.account_id, ...scenario.features },
      context: {
        amount,
        // на стенде сигнал звонка задаёт переключатель; в приложении его отдаёт нативная часть модуля
        sender_on_call: callSignal(() => onCall),
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

  const field = 'mt-1 block w-full rounded-lg border border-line bg-white px-3 py-2.5 text-[15px]'

  return (
    <div ref={phone} className="relative mx-auto w-full max-w-[340px] overflow-hidden rounded-[28px] border-[6px] border-ink bg-white">
      <form onSubmit={submit} className="flex min-h-[520px] flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Перевод</h3>
          <label className="text-[13px] text-muted">
            <span className="sr-only">Язык приложения</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="rounded border border-line bg-white px-1.5 py-1 text-ink">
              <option value="ru">RU</option>
              <option value="kk">KK</option>
              <option value="en">EN</option>
            </select>
          </label>
        </div>

        <label className="text-[13px] text-ink-2">
          Получатель
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} className={field}>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-muted">
            {scenario.note} · {scenario.first_transfer ? 'раньше не переводил' : 'переводил раньше'}
          </span>
        </label>

        <label className="text-[13px] text-ink-2">
          Сумма, ₸
          <input
            type="number"
            inputMode="numeric"
            min={100}
            step={100}
            value={Number.isFinite(amount) ? amount : ''}
            onChange={(e) => setAmount(e.target.valueAsNumber)}
            className={field + ' tabular'}
          />
          <span className="mt-1 block text-muted">
            {amountValid ? `обычный перевод этого клиента — ${money(TYPICAL_TRANSFER)}` : 'Введите сумму от 100 ₸'}
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-[14px]">
          <input type="checkbox" checked={onCall} onChange={(e) => setOnCall(e.target.checked)} className="mt-1 size-4 accent-accent" />
          <span>
            Клиент сейчас на звонке
            <span className="block text-[13px] text-muted">на стенде — переключатель; в приложении сигнал даёт клиентский модуль</span>
          </span>
        </label>

        <div className="mt-auto space-y-3">
          <div aria-live="polite">
            {outcome && (
              <div className={'rounded-lg px-3 py-2.5 text-[14px] ' + OUTCOME_TEXT[outcome].className}>
                <b>{OUTCOME_TEXT[outcome].title}</b>
                <span className="block">{OUTCOME_TEXT[outcome].note}</span>
              </div>
            )}
            {error && <div className="rounded-lg bg-hold-bg px-3 py-2.5 text-[14px] text-hold-ink">{error}</div>}
          </div>
          <button
            type="submit"
            disabled={!amountValid || busy}
            className="min-h-12 w-full rounded-xl bg-accent font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Проверяем получателя…' : `Перевести ${amountValid ? money(amount) : ''}`}
          </button>
        </div>
      </form>
    </div>
  )
}
