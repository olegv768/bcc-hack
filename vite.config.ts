/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Стенд лежит в stand/, запросы /api/* уходят в сервис оценки на этом же компьютере.
export default defineConfig({
  root: 'stand',
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  test: { root: '.', include: ['service/**/*.test.ts'] },
})
