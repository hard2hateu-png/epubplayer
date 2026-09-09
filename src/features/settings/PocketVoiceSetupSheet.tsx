import { useEffect, useState } from 'react'
import { pocketService, ttsManager } from '@/services/tts'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { useFocusTrap } from '@/ui/accessibility'

export function PocketVoiceSetupSheet({
  isOpen,
  onClose,
  onInstalledChange,
}: {
  isOpen: boolean
  onClose: () => void
  onInstalledChange?: (installed: boolean) => void
}) {
  const [installed, setInstalled] = useState(false)
  const [active, setActive] = useState(false)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sheetRef = useFocusTrap<HTMLDivElement>({
    isActive: isOpen,
    onEscape: onClose,
  })

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setChecking(true)
    setMessage(null)
    setError(null)

    Promise.all([
      pocketService.hasLeoVoiceSample(),
      settingsRepository.get('ttsEngine'),
    ])
      .then(([hasReference, engine]) => {
        if (cancelled) return
        setInstalled(hasReference)
        setActive(engine === 'pocket')
        onInstalledChange?.(hasReference)
      })
      .catch(() => {
        if (cancelled) return
        setInstalled(false)
        setActive(false)
        onInstalledChange?.(false)
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })

    return () => {
      cancelled = true
    }
  }, [isOpen, onInstalledChange])

  if (!isOpen) return null

  const activateLeo = async () => {
    const hasReference = await pocketService.hasLeoVoiceSample()
    if (!hasReference) {
      setInstalled(false)
      onInstalledChange?.(false)
      throw new Error('Install the Leo reference before using Pocket TTS.')
    }

    // Pocket has one custom voice. Keep its engine + cache identity in sync so
    // Settings, playback, and generated-audio caching all agree that Leo is active.
    await settingsRepository.set('voiceId', 'pocket:leo')
    await settingsRepository.set('ttsEngine', 'pocket')
    setActive(true)
    ttsManager.destroy()

    // The settings page already renders Pocket-specific controls from ttsEngine.
    // Reload once so Supertonic/Kokoro controls disappear immediately and Voice = Leo.
    window.location.reload()
  }

  const handleUseLeo = async () => {
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      await activateLeo()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not activate Pocket TTS — Leo.')
      setBusy(false)
    }
  }

  const handleFile = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    setMessage(null)
    setError(null)

    try {
      await pocketService.installLeoVoiceSample(file)
      setInstalled(true)
      onInstalledChange?.(true)
      setMessage(
        'Preparing Leo from the complete reference. The first preparation can take a while; later launches reuse the saved voice fingerprint.'
      )
      await pocketService.initialize()
      setMessage('Leo is ready. Activating Pocket TTS…')
      await activateLeo()
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not install and prepare the Leo reference.'
      )
      setBusy(false)
    }
  }

  const handleRemove = async () => {
    setBusy(true)
    setMessage(null)
    setError(null)

    try {
      await pocketService.removeLeoVoiceSample()
      setInstalled(false)
      onInstalledChange?.(false)

      // Never leave the app pointing at Pocket when its only voice was removed.
      if (active) {
        await settingsRepository.set('supertonicVoice', 'F1')
        await settingsRepository.set('ttsEngine', 'supertonic')
        ttsManager.destroy()
        window.location.reload()
        return
      }

      setMessage('Leo voice reference and saved fingerprint were removed from this device.')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not remove the Leo voice reference.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        onClick={busy ? undefined : onClose}
        aria-hidden="true"
      />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pocket-leo-setup-title"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[78vh] overflow-y-auto rounded-t-2xl bg-surface-1 shadow-2xl md:inset-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
      >
        <div className="flex justify-center py-3 md:hidden" aria-hidden="true">
          <div className="h-1 w-10 rounded-full bg-surface-4" />
        </div>

        <div className="flex items-start justify-between gap-4 border-b border-border-muted px-5 pb-4 md:pt-5">
          <div>
            <h3
              id="pocket-leo-setup-title"
              className="text-lg font-semibold text-text-primary"
            >
              Pocket TTS — Leo
            </h3>
            <p className="mt-1 text-sm text-text-muted">
              Private custom voice stored only on this device.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="pressable rounded-lg px-2 py-1 text-sm font-medium text-accent disabled:opacity-50"
          >
            Done
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-text-primary">Leo reference</span>
              <span
                className={
                  installed
                    ? 'text-sm text-accent'
                    : 'text-sm text-text-muted'
                }
              >
                {checking ? 'Checking…' : active ? 'Active' : installed ? 'Installed' : 'Not installed'}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              Pocket TTS uses the complete stored Leo clip—up to 42 seconds—instead
              of choosing only the loudest 10-second section. The previous app's saved
              reference is recovered automatically when available.
            </p>
          </div>

          {installed && !active && (
            <button
              type="button"
              disabled={busy || checking}
              onClick={() => void handleUseLeo()}
              className="pressable min-h-12 w-full rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Switching to Leo…' : 'Use Leo for TTS'}
            </button>
          )}

          {active && (
            <div className="rounded-xl bg-accent/10 px-4 py-3">
              <p className="text-sm font-medium text-text-primary">Leo is the active voice</p>
              <p className="mt-1 text-xs leading-relaxed text-text-muted">
                TTS Engine is Pocket TTS and the reader voice is Leo.
              </p>
            </div>
          )}

          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <p className="text-sm font-medium text-text-primary">
              Faster after the first preparation
            </p>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              The first run creates a compact Leo voice fingerprint. It stays on this
              device, so later launches skip re-analyzing the full audio and avoid
              loading the extra voice-encoder model.
            </p>
          </div>

          <label
            className={`block ${busy ? 'pointer-events-none opacity-60' : ''}`}
          >
            <span className={`pressable flex min-h-12 w-full cursor-pointer items-center justify-center rounded-xl px-4 py-3 text-center font-semibold ${active || installed ? 'bg-surface-2 text-text-primary' : 'bg-accent text-white'}`}>
              {busy
                ? 'Preparing Leo…'
                : installed
                  ? 'Replace Leo reference'
                  : 'Install Leo reference'}
            </span>
            <input
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.aac"
              className="sr-only"
              disabled={busy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] ?? null
                event.currentTarget.value = ''
                void handleFile(file)
              }}
            />
          </label>

          {installed && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRemove()}
              className="pressable min-h-11 w-full rounded-xl bg-surface-2 px-4 py-3 text-sm font-medium text-error disabled:opacity-50"
            >
              Remove Leo reference
            </button>
          )}

          {message && (
            <div className="rounded-xl bg-accent/10 px-4 py-3 text-sm leading-relaxed text-text-primary">
              {message}
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-error/10 px-4 py-3 text-sm leading-relaxed text-error">
              {error}
            </div>
          )}

          <p className="text-xs leading-relaxed text-text-muted">
            Pocket TTS still downloads its on-device model files the first time.
            The reference, model files, and prepared fingerprint remain in browser
            storage for later use.
          </p>
        </div>
      </div>
    </>
  )
}