import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// Mobile app (IMPLEMENTATION-PLAN §3.11): a second, independent SPA served under /m/ with its
// own design and a strict bundle budget. Shares only the non-visual core (@/shared, chat-core,
// aidev-router) with the workbench. `npm run build:client:mobile` → dist-mobile/.
const pkg = createRequire(import.meta.url)('./package.json')
const root = fileURLToPath(new URL('./src-mobile', import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const configuredHost = env.HOST || '0.0.0.0'
  const host = normalizeLoopbackHost(configuredHost)
  const proxyHost = getConnectableHost(configuredHost)
  const serverPort = env.SERVER_PORT || env.PORT || 3001
  const ws = { target: `ws://${proxyHost}:${serverPort}`, ws: true }
  return {
    root,
    base: '/m/',
    publicDir: fileURLToPath(new URL('./src-mobile/public', import.meta.url)),
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    resolve: {
      alias: {
        '@m': root,
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    css: {
      postcss: {
        plugins: [tailwindcss({ config: fileURLToPath(new URL('./src-mobile/tailwind.config.js', import.meta.url)) }), autoprefixer()],
      },
    },
    server: {
      host,
      port: parseInt(env.VITE_MOBILE_PORT) || 5174,
      proxy: { '/api': `http://${proxyHost}:${serverPort}`, '/ws': ws, '/shell': ws, '/plugin-ws': ws },
    },
    build: {
      outDir: fileURLToPath(new URL('./dist-mobile', import.meta.url)),
      emptyOutDir: true,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks: { 'vendor-react': ['react', 'react-dom', 'react-router-dom'] },
        },
      },
    },
  }
})
