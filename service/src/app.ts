// HTTP-интерфейс сервиса: POST /score, очередь алертов GET /alerts, выгрузка GET /flagged и GET /flagged.csv,
// расследование сети /graph/* (graph/routes.ts).

import express, { type NextFunction, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createAlertQueue, NO_SIGNALS, type Alert } from './alerts.ts'
import { FEATURE_KEYS, PURPOSES } from './features.ts'
import { createDemoGraphSource } from './graph/demo-source.ts'
import { graphRoutes } from './graph/routes.ts'
import { incomingRoutes } from './incoming.ts'
import type { BankGraphSource } from './graph/types.ts'
import { decide, riskLevel, type Model } from './model.ts'
import { createStore, toCsv } from './store.ts'
import { clientMessage, reasonText } from './texts.ts'

const feature = (max: number) => z.number().min(0).max(max).nullable().default(null)

const ScoreRequest = z.object({
  transfer_id: z.string().min(1).max(100).optional(),
  lang: z.enum(['ru', 'kk', 'en']).default('ru'),
  // псевдоним клиента-отправителя; попадает в алерт, чтобы система банка подставила его контакты
  client_ref: z.string().min(1).max(100).optional(),
  recipient: z.object({
    // псевдоним счёта: токен или хеш, который банк может сопоставить со счётом; ИИН, ФИО и номер счёта не нужны
    account_id: z.string().min(1).max(100),
    account_age_days: feature(40000),
    unrelated_senders_7d: feature(100000),
    fast_outflow_share_7d: feature(1),
    shared_device_accounts: feature(100000),
    // банк видит, что получатель продаёт криптовалюту на P2P-площадках
    p2p_trader_profile: z.boolean().nullable().default(null),
  }),
  context: z.object({
    amount: z.number().positive().max(1e12),
    sender_on_call: z.boolean().nullable().default(null),
    remote_access_active: z.boolean().nullable().default(null),
    first_transfer_to_recipient: z.boolean().nullable().default(null),
    amount_to_typical_ratio: z.number().min(0).max(1e6).nullable().default(null),
    payment_purpose: z.enum(PURPOSES).nullable().default(null),
  }),
})

const FlaggedQuery = z.object({
  since: z.iso.datetime().optional(),
  min_risk: z.coerce.number().min(0).max(1).optional(),
  action: z.enum(['warn', 'hold']).optional(),
  separator: z.enum(['comma', 'semicolon']).default('comma'),
})

const AlertsQuery = z.object({
  status: z.enum(['new', 'in_progress', 'closed']).optional(),
  priority: z.enum(['high', 'medium']).optional(),
  since: z.iso.datetime().optional(),
})

// Копия алерта, которую стенд присылает вместе с изменением. На хостинге экземпляр сервиса может
// перезапуститься и забыть очередь; по копии он восстанавливает алерт вместо ответа «не найден».
const AlertSnapshot = z.object({
  alert_id: z.string().min(1).max(40),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  priority: z.enum(['high', 'medium']),
  status: z.enum(['new', 'in_progress', 'closed']),
  resolution: z.enum(['fraud', 'legit']).nullable(),
  transfer_id: z.string().max(100).nullable(),
  client_ref: z.string().max(100).nullable(),
  account_id: z.string().min(1).max(100),
  amount: z.number().positive().max(1e12),
  action: z.enum(['warn', 'hold']),
  risk: z.number().min(0).max(1),
  triggers: z.array(z.object({ code: z.string().max(40), text: z.string().max(300) })).max(12),
  signals: z
    .object({
      on_call: z.boolean().nullable(),
      remote_access: z.boolean().nullable(),
      first_transfer: z.boolean().nullable(),
      purpose: z.enum(PURPOSES).nullable().default(null),
    })
    .default({ ...NO_SIGNALS, purpose: null }),
  model_version: z.string().max(60),
})

const AlertPatch = z.object({
  status: z.enum(['new', 'in_progress', 'closed']),
  resolution: z.enum(['fraud', 'legit']).optional(),
  snapshot: AlertSnapshot.optional(),
})

export function createApp(options: {
  model: Model
  dataFile: string
  openapi: string
  apiKey?: string
  demo?: boolean
  alertWebhook?: string // адрес системы ведения инцидентов банка; если задан, каждый новый алерт уходит туда сразу
  // Теневой режим для пилота: сервис всё считает и записывает, но отвечает «пропустить» и никого не беспокоит.
  // Настоящая рекомендация — в поле recommended_action и в очереди алертов, для сравнения с подтверждёнными случаями.
  shadow?: boolean
  // данные банка для расследования сети; без них — демонстрационный набор поверх очереди алертов
  graph?: BankGraphSource
}) {
  const { model } = options
  const store = createStore(options.dataFile)
  const alerts = createAlertQueue(options.dataFile.replace(/\.json$/, '') + '-alerts.json')
  const graph = options.graph ?? createDemoGraphSource({ alerts: () => alerts.list({}) })

  // Отправка не задерживает ответ на перевод: если система банка недоступна, алерт остаётся в очереди GET /alerts.
  const notify = (alert: Alert) => {
    if (!options.alertWebhook) return
    fetch(options.alertWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(3000),
    }).catch((error: Error) => console.error(`Алерт ${alert.alert_id} не доставлен: ${error.message}`))
  }
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '10kb' }))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', model_version: model.version })
  })

  app.get('/openapi.yaml', (_req, res) => {
    res.type('text/yaml').send(options.openapi)
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
    const { account_id, p2p_trader_profile, ...features } = recipient

    const result = decide(model, features, { ...context, recipient_p2p_trader: p2p_trader_profile }, alerts.history(account_id, parsed.data.client_ref ?? null))
    const reasons = result.reasons.map((r) => ({ code: r.code, text: reasonText(r, lang), contribution: r.contribution }))

    // Тот же перевод прислали ещё раз (повтор после сбоя связи): отвечаем, но второй алерт не создаём.
    const repeated = parsed.data.transfer_id ? alerts.findByTransfer(parsed.data.transfer_id) : undefined
    let alertId: string | null = repeated?.alert_id ?? null
    if (result.action !== 'allow' && !repeated) {
      const alert = alerts.add({
        transfer_id: parsed.data.transfer_id ?? null,
        client_ref: parsed.data.client_ref ?? null,
        account_id,
        amount: context.amount,
        action: result.action,
        risk: result.risk,
        triggers: reasons.map((r) => ({ code: r.code, text: r.text })),
        signals: {
          on_call: context.sender_on_call,
          remote_access: context.remote_access_active,
          first_transfer: context.first_transfer_to_recipient,
          purpose: context.payment_purpose,
        },
        model_version: model.version,
      })
      alertId = alert.alert_id
      if (!options.shadow) notify(alert)
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
      mode: options.shadow ? 'shadow' : 'enforce',
      // в теневом режиме банк ничего не меняет в переводе: action всегда allow
      action: options.shadow ? 'allow' : result.action,
      recommended_action: result.action,
      alert_id: alertId,
      reasons,
      client_message: options.shadow ? null : clientMessage(result.action, { onCall: context.sender_on_call === true, remoteAccess: context.remote_access_active === true, triangle: result.triangle }, lang),
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

  app.get('/alerts', (req, res) => {
    const query = AlertsQuery.safeParse(req.query)
    if (!query.success) {
      res.status(400).json({ error: 'invalid_request', message: z.prettifyError(query.error) })
      return
    }
    const items = alerts.list(query.data)
    res.json({ count: items.length, items })
  })

  // Аналитик берёт алерт в работу или закрывает его с итогом разбора.
  app.patch('/alerts/:id', (req, res) => {
    const patch = AlertPatch.safeParse(req.body)
    if (!patch.success) {
      res.status(400).json({ error: 'invalid_request', message: z.prettifyError(patch.error) })
      return
    }
    // только для стенда: вернуть в очередь алерт, потерянный при перезапуске сервиса
    if (options.demo && patch.data.snapshot?.alert_id === req.params.id) alerts.restore(patch.data.snapshot)
    const alert = alerts.update(req.params.id, patch.data)
    if (!alert) {
      res.status(404).json({ error: 'not_found', message: 'Алерт не найден' })
      return
    }
    res.json(alert)
  })

  app.use(incomingRoutes(alerts))
  app.use(graphRoutes(graph))

  // Только для стенда: очистить помеченные счета и очередь алертов перед показом.
  if (options.demo) {
    app.delete('/flagged', (_req, res) => {
      alerts.clear()
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
