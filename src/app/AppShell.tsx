import { useEffect, useState, useRef } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Trans } from '@lingui/react/macro'
import { MiniPlayer } from '@/features/player/MiniPlayer'
import { AppNav } from '@/ui/components/AppNav'
import { usePlayerStore } from '@/features/player/playerStore'
import { playbackController } from '@/features/player/PlaybackController'
import { ttsManager } from '@/services/tts'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { bookRepository } from '@/services/storage'
import { getPopularBooks } from '@/services/gutendex'
import { createLogger } from '@/services/logging'

const log = createLogger('app')

export function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const currentBook = usePlayerStore((s) => s.currentBook)
  const setCurrentBook = usePlayerStore((s) => s.setCurrentBook)
  const [ttsPreloadStatus, setTtsPreloadStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const rehydrationAttempted = useRef(false)

  // Importing/parsing a large file is memory-intensive on iOS. Keep resource-heavy
  // playback/TTS initialization off Import and Debug Logs so those screens do not
  // compete with EPUB parsing or immediately refill memory after a WebKit reload.
  // Once the user leaves these routes, the effects below run normally.
  const isQuietRoute =
    location.pathname === '/app/import' || location.pathname === '/app/debug-logs'

  // Warm the Gutendex cache so Browse loads instantly. Skip on quiet routes so an
  // import/debug session does not do unrelated background work.
  useEffect(() => {
    if (isQuietRoute) return
    getPopularBooks(1).catch(() => {})
  }, [isQuietRoute])

  // Rehydrate playback state after page refresh
  // When the store has a persisted currentBook but the controller isn't loaded,
  // we need to reload the book from IndexedDB to restore full playback capability.
  // Do not do this while importing/debugging; it can start chunk loading/buffering.
  useEffect(() => {
    if (isQuietRoute) {
      log.debug('Skipping playback rehydration on quiet route', { path: location.pathname })
      return
    }

    const rehydratePlayback = async () => {
      // Only attempt once per app load, after we reach a normal playback-capable route.
      if (rehydrationAttempted.current) return
      rehydrationAttempted.current = true

      // If no persisted book, nothing to rehydrate
      if (!currentBook?.id) return

      try {
        // Fetch the full book from IndexedDB (includes coverUrl from blob)
        const fullBook = await bookRepository.get(currentBook.id)

        if (!fullBook) {
          // Book was deleted - clear the stale state
          log.warn('Persisted book not found in IndexedDB, clearing state', { id: currentBook.id })
          setCurrentBook(null)
          return
        }

        // Refresh only the cover URL in the live player store. Blob URLs are
        // session-scoped, so a persisted/stale URL can become a broken image
        // after a reload or deployment. This does not reset playback position.
        if (fullBook.coverUrl) {
          usePlayerStore.setState((state) => ({
            currentBook:
              state.currentBook?.id === fullBook.id
                ? { ...state.currentBook, coverUrl: fullBook.coverUrl }
                : state.currentBook,
          }))
        }

        // Build the book object for the player (with fresh coverUrl from IndexedDB)
        const bookForPlayer = {
          id: fullBook.id,
          title: fullBook.title,
          author: fullBook.author,
          coverUrl: fullBook.coverUrl, // Fresh blob URL from IndexedDB
        }

        log.info('Rehydrating playback state', { title: fullBook.title })

        // Load the book into the playback controller
        // This restores sections, chunks, saved position, etc.
        await playbackController.loadBook(bookForPlayer)

        log.info('Playback state rehydrated successfully')
      } catch (err) {
        log.error('Failed to rehydrate playback state', err)
        // Don't clear the state - user can still navigate to the book manually
      }
    }

    rehydratePlayback()
  }, [isQuietRoute, location.pathname, currentBook?.id, setCurrentBook])

  // Eager TTS preloading - start model download on normal app screens so playback
  // remains quick, but never compete with file import or crash-log inspection.
  useEffect(() => {
    if (isQuietRoute) {
      setTtsPreloadStatus('idle')
      log.debug('Skipping TTS preload on quiet route', { path: location.pathname })
      return
    }

    const checkAndPreloadTTS = async () => {
      try {
        const settings = await settingsRepository.getAll()
        const engine = settings.ttsEngine
        const capabilities = ttsManager.getEngineCapabilities(engine)

        // Only preload if engine requires initialization (Supertonic, Kokoro, Piper)
        // Browser TTS is instant and doesn't need preloading
        if (!capabilities.requiresInit) {
          log.debug('TTS engine does not require preloading', { engine })
          setTtsPreloadStatus('ready')
          return
        }

        // If already ready, we're done
        if (ttsManager.getIsReady()) {
          log.debug('TTS already ready')
          setTtsPreloadStatus('ready')
          return
        }

        // If loading (e.g., started by onboarding), just track the status
        if (ttsManager.getIsLoading()) {
          log.debug('TTS already loading, tracking status')
          setTtsPreloadStatus('loading')
          // Wait for it to complete
          try {
            await ttsManager.initialize() // Will return existing promise
            setTtsPreloadStatus('ready')
          } catch {
            setTtsPreloadStatus('error')
          }
          return
        }

        // Start preloading
        log.info('Preloading TTS engine', { engine })
        setTtsPreloadStatus('loading')

        await ttsManager.initialize()

        log.info('TTS preload complete', { engine })
        setTtsPreloadStatus('ready')
      } catch (err) {
        log.error('TTS preload failed', err)
        setTtsPreloadStatus('error')
        // Don't throw - preload failure shouldn't break the app
        // User will see loading when they try to play
      }
    }

    checkAndPreloadTTS()

    // Also poll briefly to catch loading started by onboarding
    // (onboarding starts preload after settings saved, before navigation completes)
    const pollInterval = setInterval(() => {
      if (ttsManager.getIsLoading() && ttsPreloadStatus !== 'loading') {
        setTtsPreloadStatus('loading')
        // Wait for completion
        ttsManager.initialize()
          .then(() => setTtsPreloadStatus('ready'))
          .catch(() => setTtsPreloadStatus('error'))
        clearInterval(pollInterval)
      } else if (ttsManager.getIsReady() && ttsPreloadStatus === 'loading') {
        setTtsPreloadStatus('ready')
        clearInterval(pollInterval)
      }
    }, 500)

    // Stop polling after 30 seconds (model should be loaded by then)
    const timeout = setTimeout(() => clearInterval(pollInterval), 30000)

    return () => {
      clearInterval(pollInterval)
      clearTimeout(timeout)
    }
  }, [isQuietRoute, location.pathname, ttsPreloadStatus])

  // Hide mini-player on the full Now Playing screen. Also hide it on quiet routes
  // so importing/debugging does not present playback controls while the controller
  // is intentionally not being rehydrated.
  const showMiniPlayer = currentBook && location.pathname !== '/app/playing' && !isQuietRoute

  // Now Playing page needs full-bleed layout
  const isFullBleed = location.pathname === '/app/playing'

  // Give Now Playing two deterministic exits so users do not need to walk
  // backward through browser history. This is navigation-only and sits outside
  // the reader/player component itself.
  const showPlayerQuickNav = currentBook && location.pathname === '/app/playing'

  // Show bottom nav on Library and Browse pages
  const showNav = location.pathname === '/app' || location.pathname === '/app/browse'

  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* TTS preload indicator - subtle, non-blocking */}
      {ttsPreloadStatus === 'loading' && !isQuietRoute && (
        <div className="flex items-center justify-center gap-2 bg-surface-1 px-3 py-1.5 text-xs text-text-muted">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span><Trans>Loading TTS engine...</Trans></span>
        </div>
      )}

      {/* Main content area — offset for desktop sidebar when nav is visible */}
      <main id="main-content" className={`flex-1 overflow-y-auto overflow-x-hidden ${showNav ? 'md:ml-[60px]' : ''}`}>
        <div className={isFullBleed ? 'h-full' : 'mx-auto h-full max-w-6xl'}>
          <Outlet />
        </div>
      </main>

      {/* One-tap navigation from Now Playing (mobile only).
          The app shell/body already reserves the iPhone safe area, so this bar
          deliberately does not add a second safe-area bottom inset. */}
      {showPlayerQuickNav && currentBook && (
        <nav className="flex flex-shrink-0 gap-2 border-t border-border-muted bg-surface-1 px-4 py-2 md:hidden" aria-label="Player navigation">
          <button
            onClick={() => navigate('/app')}
            className="pressable flex-1 rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            Library
          </button>
          <button
            onClick={() => navigate(`/app/book/${currentBook.id}`)}
            className="pressable flex-1 rounded-xl bg-surface-2 px-4 py-2.5 text-sm font-medium text-text-secondary hover:text-text-primary"
          >
            Book
          </button>
        </nav>
      )}

      {/* Mini player (shows when a book is active and not on Now Playing/quiet pages) */}
      {showMiniPlayer && <MiniPlayer />}

      {/* Bottom tab bar (mobile) + sidebar (desktop) */}
      {showNav && <AppNav />}
    </div>
  )
}
