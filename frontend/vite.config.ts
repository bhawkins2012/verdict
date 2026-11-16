import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  },
  server: {
    // FRONTEND_PORT also decides the port in derived Codespaces links (backend/src/lib/frontendUrl.ts).
    port: Number(process.env.FRONTEND_PORT) || 5173,
    strictPort: true, // a silently different port would break the links the backend derives
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    }
  }
})
