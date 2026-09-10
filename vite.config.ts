import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { lingui } from '@lingui/vite-plugin'
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'


const LITERT_RUNTIME_FILES = [
  'litert_wasm_internal.js',
  'litert_wasm_internal.wasm',
  'litert_wasm_compat_internal.js',
  'litert_wasm_compat_internal.wasm',
]

function copyLiteRtRuntime() {
  return {
    name: 'copy-litert-runtime',
    closeBundle() {
      const sourceDir = resolve(process.cwd(), 'node_modules/@litertjs/core/wasm')
      const outputDir = resolve(process.cwd(), 'dist/litert-wasm')
      mkdirSync(outputDir, { recursive: true })
      for (const file of LITERT_RUNTIME_FILES) {
        copyFileSync(resolve(sourceDir, file), resolve(outputDir, file))
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ['@lingui/babel-plugin-lingui-macro'],
      },
    }),
    lingui(),
    tailwindcss(),
    copyLiteRtRuntime(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon-v2.png', 'app-icon-192.png', 'app-icon-512.png', 'og-image.png'],
      manifest: {
        name: 'EPUB Player',
        short_name: 'EPUBPlayer',
        description: 'Turn your EPUBs into audiobooks with AI-powered text-to-speech. Free, offline, private.',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        orientation: 'portrait',
        scope: '/',
        start_url: '/',
        id: 'com.epubplayer.app',
        categories: ['books', 'entertainment', 'productivity'],
        lang: 'en',
        dir: 'ltr',
        icons: [
          {
            src: 'app-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'app-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'app-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'Open Library',
            short_name: 'Library',
            url: '/app',
            icons: [{ src: 'app-icon-192.png', sizes: '192x192' }],
          },
        ],
        screenshots: [
          {
            src: 'screenshots/library.png',
            sizes: '1080x2340',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Library - Your audiobook collection',
          },
          {
            src: 'screenshots/now-playing.png',
            sizes: '1080x2340',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Now Playing - Listen with full controls',
          },
          {
            src: 'screenshots/settings.png',
            sizes: '1080x2340',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Settings - Customize TTS and playback',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cdn-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  // LiteRT's worker-side WASM bootstrap uses importScripts(). Keep worker
  // bundles classic/IIFE so Safari does not reject that API as a module worker.
  worker: {
    format: 'iife',
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
