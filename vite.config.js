import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { singleFileOffline } from 'vite-plugin-singlefile-offline'
import { VitePWA } from 'vite-plugin-pwa'

function singleFilePwaStubPlugin() {
  const virtualId = 'virtual:pwa-register'
  const resolvedVirtualId = '\0' + virtualId
  return {
    name: 'inknote-singlefile-pwa-stub',
    resolveId(id) {
      if (id === virtualId) return resolvedVirtualId
    },
    load(id) {
      if (id === resolvedVirtualId) {
        return 'export function registerSW() { return () => Promise.resolve(); }'
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const isSingleFile = mode === 'singlefile' || mode === 'singlefileoffline'
  let plugins = [tailwindcss()]

  if (mode === 'singlefile') {
    plugins = plugins.concat(singleFilePwaStubPlugin(), viteSingleFile())
  } else if (mode === 'singlefileoffline') {
    plugins = plugins.concat(singleFilePwaStubPlugin(), singleFileOffline())
  } else {
    plugins = plugins.concat(
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg', 'apple-touch-icon.png'],
        manifest: {
          id: '/',
          name: 'InkNote Studio',
          short_name: 'InkNote',
          description: 'Prendi appunti a mano su iPad e desktop con penna vettoriale, riconoscimento forme e sincronizzazione cloud.',
          theme_color: '#4f46e5',
          background_color: '#f8fafc',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          lang: 'it',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
          maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/__\//],
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/fonts\.(?:googleapis|gstatic)\.com\/.*/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'google-fonts-cache',
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 365,
                },
                cacheableResponse: { statuses: [0, 200] },
              },
            },
          ],
        },
        devOptions: {
          enabled: true,
          type: 'module',
        },
      })
    )
  }

  return {
    base: isSingleFile ? './' : '/',
    plugins,
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
  }
})
