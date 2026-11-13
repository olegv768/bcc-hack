// Собирает стенд и сервис для размещения на Vercel: статические файлы стенда и одна серверная
// функция с сервисом оценки на /api/*. Запускается после vite build (npm run build), когда сборка
// идёт на Vercel, или вручную: node scripts/hosted-output.mjs --force

import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

if (!process.env.VERCEL && !process.argv.includes('--force')) process.exit(0)

const out = '.vercel/output'
rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}/functions/api.func`, { recursive: true })

cpSync('dist', `${out}/static`, { recursive: true })

await build({
  entryPoints: ['service/src/hosted.ts'],
  outfile: `${out}/functions/api.func/index.js`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  loader: { '.yaml': 'text' },
  footer: { js: 'module.exports = module.exports.default;' },
})

writeFileSync(
  `${out}/functions/api.func/.vc-config.json`,
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.js', launcherType: 'Nodejs', shouldAddHelpers: false }, null, 2),
)

// index.js собран как CommonJS; говорим об этом явно, чтобы Node не гадал
writeFileSync(`${out}/functions/api.func/package.json`, JSON.stringify({ type: 'commonjs' }))

writeFileSync(
  `${out}/config.json`,
  JSON.stringify({ version: 3, routes: [{ src: '^/api(/.*)?$', dest: '/api' }, { handle: 'filesystem' }] }, null, 2),
)

console.log('Готово: ' + out)
