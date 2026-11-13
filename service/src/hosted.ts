// Вход для размещения сервиса как серверной функции рядом со стендом (см. scripts/hosted-output.mjs).
// Запросы приходят с префиксом /api, как на локальном стенде через прокси.

import express from 'express'
import openapi from '../../docs/openapi.yaml'
import model from '../model/model.json'
import { createApp } from './app.ts'
import type { Model } from './model.ts'

const app = express()
app.disable('x-powered-by')
app.use(
  '/api',
  createApp({
    model: model as Model,
    openapi,
    // У функции доступна на запись только временная папка; список помеченных счетов живёт, пока жив её экземпляр.
    dataFile: '/tmp/flagged.json',
    demo: true,
  }),
)

export default app
