// HTTP-интерфейс сервиса: POST /score, выгрузка GET /flagged и GET /flagged.csv.

import express, { type NextFunction, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { FEATURE_KEYS } from './features.ts'
import { decide, riskLevel, type Model } from './model.ts'
import { createStore, toCsv } from './store.ts'
import { clientMessage, reasonText } from './texts.ts'

const feature = (max: number) => z.number().min(0).max(max).nullable().default(null)

const ScoreRequest = z.object({
  transfer_id: z.string().min(1).max(100).optional(),
  lang: z.enum(['ru', 'kk', 'en']).default('ru'),
  recipient: z.object({
    // псевдоним счёта: токен или хеш, который банк может сопоставить со счётом; ИИН, ФИО и номер счёта не нужны
    account_id: z.string().min(1).max(100),
    account_age_days: feature(40000),
    unrelated_senders_7d: feature(100000),
    fast_outflow_share_7d: feature(1),
    shared_device_accounts: feature(100000),
  }),
  context: z.object({
    amount: z.number().positive().max(1e12),
    sender_on_call: z.boolean().nullable().default(null),
    first_transfer_to_recipient: z.boolean().default(false),
    amount_to_typical_ratio: z.number().min(0).max(1e6).nullable().default(null),
  }),
})

const FlaggedQuery = z.object({
  since: z.iso.datetime().optional(),
  min_risk: z.coerce.number().min(0).max(1).optional(),
  action: z.enum(['warn', 'hold']).optional(),
  separator: z.enum(['comma', 'semicolon']).default('comma'),
})

export function createApp(options: { model: Model; dataFile: string; apiKey?: string; demo?: boolean }) {
  const { model } = options
  const store = createStore(options.dataFile)
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '10kb' }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', model_version: model.version })
  })

  app.get('/openapi.yaml', (_req, res) => {
    res.type('text/yaml').send(readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8'))
  })

  // Если задан SCORE_API_KEY, все остальные запросы должны нести его в заголовке X-API-Key.
  app.use((req, res, next) => {
    if (options.apiKey && req.get('x-api-key') !== options.apiKey) {
      res.status(401).json({ error: 'unauthorized', message: 'Нужен заголовок X-API-Key' })
      return
    }
    next()
  })

  app.post('/score', (req, res) => {
    const parsed = ScoreRequest.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', details: z.flattenError(parsed.error).fieldErrors, message: z.prettifyError(parsed.error) })
      return
    }
    const { lang, context, recipient } = parsed.data
    const { account_id, ...features } = recipient

    const result = decide(model, features, context)
    const reasons = result.reasons.map((r) => ({ code: r.code, text: reasonText(r, lang), contribution: r.contribution }))

    if (result.action !== 'allow') {
      store.add({
        account_id,
        risk: result.risk,
        amount: context.amount,
        last_action: result.action,
        reason_codes: reasons.map((r) => r.code),
        reasons: reasons.map((r) => r.text),
        features,
        model_version: model.version,
      })
    }

    res.json({
      request_id: randomUUID(),
      transfer_id: parsed.data.transfer_id ?? null,
      risk: result.risk,
      risk_level: riskLevel(model, result.risk),
      action: result.action,
      reasons,
      client_message: clientMessage(result.action, context.sender_on_call === true, lang),
      // вклад каждого признака в оценку — чтобы аналитик видел, из чего она сложилась
      contributions: Object.fromEntries(FEATURE_KEYS.map((key) => [key, Math.round(result.contributions[key] * 100) / 100])),
      missing_features: result.missing,
      model_version: model.version,
    })
  })

  const flagged = (req: Request, res: Response) => {
    const query = FlaggedQuery.safeParse(req.query)
    if (!query.success) {
      res.status(400).json({ error: 'invalid_request', message: z.prettifyError(query.error) })
      return null
    }
    return { items: store.list(query.data), separator: query.data.separator === 'semicolon' ? ';' : ',' }
  }

  app.get('/flagged', (req, res) => {
    const result = flagged(req, res)
    if (result) res.json({ count: result.items.length, items: result.items })
  })

  app.get('/flagged.csv', (req, res) => {
    const result = flagged(req, res)
    if (!result) return
    res.type('text/csv').attachment('flagged-accounts.csv').send(toCsv(result.items, result.separator))
  })

  // Только для стенда: очистить список помеченных счетов перед показом.
  if (options.demo) {
    app.delete('/flagged', (_req, res) => {
      store.clear()
      res.status(204).end()
    })
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' })
  })

  app.use((error: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = error.status === 400 || error.status === 413 ? error.status : 500
    if (status === 500) console.error(error)
    res.status(status).json({ error: status === 500 ? 'internal_error' : 'invalid_request', message: status === 500 ? 'Внутренняя ошибка' : 'Тело запроса не разобрано: нужен JSON до 10 КБ' })
  })

  return app
}
