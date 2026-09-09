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

let swRegistration: ServiceWorkerRegistration | undefined
let reloadingForServiceWorker = false
const hadServiceWorkerControllerAtStartup = Boolean(navigator.serviceWorker?.controller)

log.info('App startup', {
  navigationType: navigationEntry?.type ?? 'unknown',
  standalone,
  visibility: document.visibilityState,
  href: window.location.href,
  userAgent: navigator.userAgent,
})

// iOS can keep a Home Screen PWA's old JavaScript alive even after a newer
// service worker has activated. Reload exactly once when an existing install
// changes controllers so the page immediately starts using the new app bundle.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadServiceWorkerControllerAtStartup || reloadingForServiceWorker) return
    reloadingForServiceWorker = true
    log.info('New Service Worker activated; reloading app shell')
    window.location.reload()
  })
}

document.addEventListener('visibilitychange', () => {
  log.info('Visibility changed', { state: document.visibilityState })
  if (document.visibilityState === 'hidden') {
    logStore.flushPersistence()
  } else {
    // Check promptly when an installed PWA returns to the foreground instead
    // of waiting for WebKit's normal service-worker update interval.
    void swRegistration?.update().catch((error) => {
      log.warn('Service Worker update check failed', { error })
    })
  }
})

window.addEventListener('pagehide', (event) => {
  log.info('App pagehide', { persisted: event.persisted })
  logStore.flushPersistence()
})

const updateSW = registerSW({
  immediate: true,
  onRegistered(registration) {
    swRegistration = registration
    log.info('Service Worker registered', { scope: registration?.scope })
    void registration?.update().catch((error) => {
      log.warn('Initial Service Worker update check failed', { error })
    })
  },
  onNeedRefresh() {
    log.info('Service Worker update available; activating now')
    void updateSW(true)
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
