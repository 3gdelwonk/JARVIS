import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Set VITE_BASE_PATH env var when deploying to a GitHub Pages sub-path, e.g.:
//   VITE_BASE_PATH=/iga-milk-manager/ npm run build
const base = process.env.VITE_BASE_PATH ?? './'
// PWA start_url must be the absolute sub-path so home screen launch works on GitHub Pages
const startUrl = process.env.VITE_BASE_PATH ?? './'

export default defineConfig({
  base,
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          xlsx: ['xlsx'],
          pdf: ['pdfjs-dist'],
          vendor: ['react', 'react-dom', 'recharts', 'dexie', 'dexie-react-hooks'],
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'IGA Milk Manager',
        short_name: 'Milk Manager',
        description: 'Automates milk ordering for IGA Camberwell',
        theme_color: '#2563eb',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: startUrl,
        icons: [
          {
            src: './manifest-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: './manifest-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    }),
  ],
})