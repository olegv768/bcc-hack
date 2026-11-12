// Запуск сервиса: npm run service
// Настройки (все необязательные): PORT, HOST, SCORE_API_KEY, DATA_FILE, DEMO=0

import { fileURLToPath } from 'node:url'
import { createApp } from './app.ts'
import { loadModel } from './model.ts'

const port = Number(process.env.PORT ?? 8787)
// По умолчанию слушаем только этот компьютер; в контуре банка адрес задаётся явно.
const host = process.env.HOST ?? '127.0.0.1'

const app = createApp({
  model: loadModel(new URL('../model/model.json', import.meta.url)),
  dataFile: process.env.DATA_FILE ?? fileURLToPath(new URL('../data/flagged.json', import.meta.url)),
  apiKey: process.env.SCORE_API_KEY,
  demo: process.env.DEMO !== '0',
})

app.listen(port, host, () => {
  console.log(`Сервис оценки получателя: http://${host}:${port}`)
})
