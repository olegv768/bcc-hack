// Замер скорости сервиса: npm run bench
// Поднимает сервис в этом же процессе и шлёт запросы POST /score по сети на этот же компьютер.
// Цифры зависят от машины; смысл замера — порядок величины, а не точное значение.

import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateAccounts, generateContext } from '../ml/generate.ts'
import { createRng } from '../ml/random.ts'
import { createApp } from './src/app.ts'
import { loadModel } from './src/model.ts'

const REQUESTS = 3000
const PARALLEL = 16

const server = createApp({
  model: loadModel(new URL('./model/model.json', import.meta.url)),
  dataFile: join(mkdtempSync(join(tmpdir(), 'dropper-guard-bench-')), 'flagged.json'),
  openapi: '',
}).listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/score`

const rng = createRng(1)
const bodies = generateAccounts(REQUESTS, rng).map((account, i) =>
  JSON.stringify({
    transfer_id: 'bench_' + i,
    client_ref: 'cl_' + (i % 500),
    recipient: { account_id: account.account_id, ...account.features },
    context: generateContext(account.is_dropper, rng),
  }),
)

async function run(parallel: number) {
  const times: number[] = []
  let next = 0
  const started = performance.now()
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < bodies.length) {
        const body = bodies[next++]!
        const t = performance.now()
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        await response.arrayBuffer()
        times.push(performance.now() - t)
      }
    }),
  )
  const seconds = (performance.now() - started) / 1000
  times.sort((a, b) => a - b)
  const at = (q: number) => times[Math.floor(times.length * q)]!.toFixed(1)
  console.log(
    `${String(parallel).padStart(2)} одновременно: ${Math.round(times.length / seconds)} запросов/с, ` +
      `половина быстрее ${at(0.5)} мс, 99% быстрее ${at(0.99)} мс`,
  )
}

await run(1) // прогрев и последовательный режим
await run(1)
await run(PARALLEL)
server.close()
