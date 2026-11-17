import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'
import { devServerPort } from './devServerPort'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}', 'devServerPort.test.ts'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  },
  server: {
    // FRONTEND_PORT (shell, else backend/.env, else 5173) also decides the port in derived Codespaces
    // links (backend/src/lib/frontendUrl.ts).
    port: devServerPort(process.env, loadEnv(mode, path.resolve(__dirname, '../backend'), '')),
    strictPort: true, // a silently different port would break the links the backend derives
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    }
  }
}))
