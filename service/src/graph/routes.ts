// HTTP-интерфейс расследования сети. Основной антифрод банка передаёт сюда счёт, клиента,
// перевод или номер своего алерта — модуль строит граф связей вокруг него.

import { Router } from 'express'
import { z } from 'zod'
import { createInvestigator } from './investigate.ts'
import type { BankGraphSource, LinkFilter } from './types.ts'

const LINKS = ['transfer', 'device', 'ip', 'phone', 'card'] as const satisfies readonly LinkFilter[]
const id = z.string().min(1).max(100)

const Filters = {
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  min_amount: z.coerce.number().min(0).max(1e12).optional(),
}

const InvestigateRequest = z
  .object({
    entity_id: id.optional(),
    transfer_id: id.optional(),
    // алерт очереди сервиса (al_…) или сигнал основного антифрода (AF-…)
    alert_id: id.optional(),
    depth: z.number().int().min(1).max(4).default(2),
    links: z.array(z.enum(LINKS)).max(LINKS.length).default([...LINKS]),
    expand: z.array(id).max(50).default([]),
    ...Filters,
  })
  .refine((r) => r.entity_id || r.transfer_id || r.alert_id, { message: 'Нужен entity_id, transfer_id или alert_id' })

const DetailsQuery = z.object({
  ...Filters,
  links: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',') : [...LINKS]))
    .pipe(z.array(z.enum(LINKS))),
})

export function graphRoutes(source: BankGraphSource) {
  const router = Router()

  // что основной антифрод и очередь алертов передали на расследование
  router.get('/graph/cases', (_req, res) => {
    const items = source.incoming().sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || b.at.localeCompare(a.at))
    res.json({ count: items.length, items })
  })

  router.get('/graph/search', (req, res) => {
    const q = z.string().max(100).safeParse(req.query.q)
    if (!q.success) {
      res.status(400).json({ error: 'invalid_request', message: 'Нужен параметр q до 100 символов' })
      return
    }
    const transfer = source.transfer(q.data.trim())
    const items = source.search(q.data, 20).map((e) => ({ id: e.id, type: e.type, label: e.label }))
    res.json({ items, transfer: transfer ? { id: transfer.id, from: transfer.from, to: transfer.to, amount: transfer.amount, at: transfer.at } : null })
  })

  router.post('/graph/investigate', (req, res) => {
    const parsed = InvestigateRequest.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', message: z.prettifyError(parsed.error) })
      return
    }
    const r = parsed.data
    let root = r.entity_id
    let transferId = r.transfer_id
    if (!root && r.alert_id) {
      const incoming = source.findCase(r.alert_id)
      root = incoming?.entity_id
      transferId ??= incoming?.transfer_id ?? undefined
    }
    if (!root && transferId) root = source.transfer(transferId)?.to
    if (!root || !source.entity(root)) {
      res.status(404).json({ error: 'not_found', message: 'В данных банка нет такого счёта, клиента, перевода или алерта' })
      return
    }
    const investigator = createInvestigator(source, { from: r.from, to: r.to, minAmount: r.min_amount, links: r.links })
    res.json(investigator.investigate(root, r.depth, r.expand, transferId))
  })

  router.get('/graph/entities/:id', (req, res) => {
    const query = DetailsQuery.safeParse(req.query)
    if (!query.success) {
      res.status(400).json({ error: 'invalid_request', message: z.prettifyError(query.error) })
      return
    }
    const investigator = createInvestigator(source, { from: query.data.from, to: query.data.to, minAmount: query.data.min_amount, links: query.data.links })
    const details = investigator.details(req.params.id)
    if (!details) {
      res.status(404).json({ error: 'not_found', message: 'Сущность не найдена' })
      return
    }
    res.json(details)
  })

  return router
}
