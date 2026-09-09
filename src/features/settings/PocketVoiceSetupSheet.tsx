import { useEffect, useState } from 'react'
import { pocketService } from '@/services/tts'
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

    pocketService
      .hasLeoVoiceSample()
      .then((hasReference) => {
        if (cancelled) return
        setInstalled(hasReference)
        onInstalledChange?.(hasReference)
      })
      .catch(() => {
        if (cancelled) return
        setInstalled(false)
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
      setMessage(
        'Leo is ready. The saved voice fingerprint will make future starts faster.'
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not install and prepare the Leo reference.'
      )
    } finally {
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
                {checking ? 'Checking…' : installed ? 'Installed' : 'Not installed'}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              Pocket TTS now uses the complete stored Leo clip—up to 42 seconds—instead
              of choosing only the loudest 10-second section. The previous app's saved
              reference is recovered automatically when available.
            </p>
          </div>

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
            <span className="pressable flex min-h-12 w-full cursor-pointer items-center justify-center rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white">
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
