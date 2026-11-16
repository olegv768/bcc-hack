import { useState } from 'react'
import { generateAccounts, generateContext } from '../../ml/generate.ts'
import { createRng } from '../../ml/random.ts'
import type { FlaggedAccount } from '../../service/src/store.ts'
import { clearFlagged, score } from './api.ts'
import { ActionBadge } from './ScorePanel.tsx'
import { money, riskText } from './scenarios.ts'

const BATCH_HONEST = 22
const BATCH_FRAUD = 8

// Предпросмотр выгрузки для аналитика: то же, что отдают GET /flagged и GET /flagged.csv.
export function ExportPanel(props: { items: FlaggedAccount[] | null; error: string; onChanged: () => void }) {
  const [progress, setProgress] = useState<string | null>(null)
  const [batchError, setBatchError] = useState('')

  // Пачка случайных переводов из того же генератора, на котором считались метрики.
  async function runBatch() {
    setBatchError('')
    const rng = createRng(Date.now())
    const accounts = generateAccounts(1500, rng)
    const batch = [
      ...accounts.filter((a) => a.is_dropper).slice(0, BATCH_FRAUD),
      ...accounts.filter((a) => !a.is_dropper).slice(0, BATCH_HONEST),
    ]
    try {
      for (const [i, account] of batch.entries()) {
        setProgress(`Перевод ${i + 1} из ${batch.length}…`)
        await score({
          transfer_id: `batch_${Date.now().toString(36)}_${i}`,
          lang: 'ru',
          client_ref: 'cl_' + String(Math.floor(rng() * 90000) + 10000),
          recipient: { account_id: account.account_id, ...account.features },
          context: generateContext(account.is_dropper, rng),
        })
      }
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Не удалось отправить переводы')
    }
    setProgress(null)
    props.onChanged()
  }

  async function clear() {
    setBatchError('')
    await clearFlagged().catch((e: Error) => setBatchError(e.message))
    props.onChanged()
  }

  const button = 'min-h-11 cursor-pointer rounded-full px-5 text-[15px] font-semibold disabled:cursor-default disabled:opacity-50'
  const link = 'text-accent underline underline-offset-2'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={runBatch} disabled={progress !== null} className={button + ' bg-ink text-white'}>
          {progress ?? `Прогнать ${BATCH_HONEST + BATCH_FRAUD} случайных переводов`}
        </button>
        <button type="button" onClick={clear} disabled={progress !== null || !props.items?.length} className={button + ' bg-field text-ink'}>
          Очистить список
        </button>
      </div>
      {(batchError || props.error) && <p className="rounded-[16px] bg-hold-bg px-4 py-3 text-hold-ink">{batchError || props.error}</p>}

      <p className="text-[14px] text-ink-2">
        Скачать:{' '}
        <a className={link} href="/api/flagged.csv?separator=semicolon">
          CSV для Excel
        </a>
        ,{' '}
        <a className={link} href="/api/flagged.csv">
          CSV через запятую
        </a>
        ,{' '}
        <a className={link} href="/api/flagged" target="_blank" rel="noreferrer">
          JSON
        </a>
        . Фильтры: <code className="font-mono text-[13px]">?min_risk=0.9&amp;action=hold&amp;since=2026-11-01T00:00:00Z</code>
      </p>

      {props.items && props.items.length > 0 && (
        <p className="text-[14px]">
          Помечено счетов: <b className="tabular">{props.items.length}</b>, из них к приостановке —{' '}
          <b className="tabular">{props.items.filter((a) => a.last_action === 'hold').length}</b>
        </p>
      )}

      {props.items === null ? (
        !props.error && <p className="text-ink-2">Загружаем…</p>
      ) : props.items.length === 0 ? (
        <p className="rounded-[20px] border border-dashed border-line p-6 text-ink-2">
          Пока пусто. Счёт попадает в выгрузку, когда сервис рекомендует предупредить клиента или придержать перевод.
        </p>
      ) : (
        <div className="max-h-[480px] overflow-auto border-y border-line">
          <table className="w-full min-w-[540px] text-left text-[14px]">
            <thead className="sticky top-0 border-b border-line bg-surface text-ink-2 shadow-[0_1px_0_var(--color-line)]">
              <tr>
                <th className="px-4 py-3 font-medium">Счёт</th>
                <th className="px-4 py-3 text-right font-medium">Риск</th>
                <th className="px-4 py-3 font-medium">Решение</th>
                <th className="px-4 py-3 text-right font-medium">Переводы</th>
                <th className="px-4 py-3 font-medium">Причины</th>
              </tr>
            </thead>
            <tbody>
              {props.items.map((item) => (
                <tr key={item.account_id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3 font-mono">{item.account_id}</td>
                  <td className="tabular px-4 py-3 text-right">{riskText(item.max_risk)}</td>
                  <td className="px-4 py-3">
                    <ActionBadge action={item.last_action} />
                  </td>
                  <td className="tabular px-4 py-3 text-right whitespace-nowrap">
                    {item.flagged_transfers} шт.
                    <span className="block text-muted">{money(item.flagged_amount)}</span>
                  </td>
                  <td className="min-w-[220px] px-4 py-3">
                    <ul className="list-disc space-y-0.5 pl-4">
                      {item.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
