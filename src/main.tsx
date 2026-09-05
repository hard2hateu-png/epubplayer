import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { initDebug } from './debug'
import { installConsoleCapture, initLogging, createLogger, logStore } from '@/services/logging'

// Initialize structured logging system first
initLogging()

// Capture console + runtime errors for in-app debugging (useful on mobile)
// This catches any raw console.log calls and routes them to logStore
installConsoleCapture({ source: 'console' })

// Initialize debug utilities (auto-clears state in dev mode)
initDebug()

// Register PWA service worker
import { registerSW } from 'virtual:pwa-register'

const log = createLogger('app')
const navigationEntry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
const standalone =
  window.matchMedia?.('(display-mode: standalone)').matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone)

log.info('App startup', {
  navigationType: navigationEntry?.type ?? 'unknown',
  standalone,
  visibility: document.visibilityState,
  href: window.location.href,
  userAgent: navigator.userAgent,
})

document.addEventListener('visibilitychange', () => {
  log.info('Visibility changed', { state: document.visibilityState })
  if (document.visibilityState === 'hidden') {
    logStore.flushPersistence()
  }
})

window.addEventListener('pagehide', (event) => {
  log.info('App pagehide', { persisted: event.persisted })
  logStore.flushPersistence()
})

registerSW({
  immediate: true,
  onRegistered(r) {
    log.info('Service Worker registered', { scope: r?.scope })
  },
  onRegisterError(error) {
    log.error('Service Worker registration failed', error)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
