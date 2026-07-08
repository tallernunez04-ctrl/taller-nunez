import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'Taller Nuñez',
        short_name: 'T. Nuñez',
        description: 'Gestión de taller mecánico - Transportes Nuñez',
        lang: 'es',
        display: 'standalone',
        start_url: '/',
        theme_color: '#1A1A1A',
        background_color: '#1A1A1A',
        icons: [
          { src: 'icons/pwa-72.png', sizes: '72x72', type: 'image/png' },
          { src: 'icons/pwa-96.png', sizes: '96x96', type: 'image/png' },
          { src: 'icons/pwa-128.png', sizes: '128x128', type: 'image/png' },
          { src: 'icons/pwa-144.png', sizes: '144x144', type: 'image/png' },
          { src: 'icons/pwa-152.png', sizes: '152x152', type: 'image/png' },
          { src: 'icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/pwa-384.png', sizes: '384x384', type: 'image/png' },
          { src: 'icons/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
      },
    }),
  ],
})
