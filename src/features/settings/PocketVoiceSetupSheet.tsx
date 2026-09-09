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
  const [available, setAvailable] = useState(false)
  const [usingCustomReference, setUsingCustomReference] = useState(false)
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
      pocketService.hasCustomLeoVoiceSample(),
    ])
      .then(([hasReference, hasCustomReference]) => {
        if (cancelled) return
        setAvailable(hasReference)
        setUsingCustomReference(hasCustomReference)
        onInstalledChange?.(hasReference)
      })
      .catch(() => {
        if (cancelled) return
        setAvailable(false)
        setUsingCustomReference(false)
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

  const prepareLeo = async () => {
    setMessage(
      'Preparing Leo from the full reference. The first preparation can take a while; later launches reuse the saved voice fingerprint.'
    )
    await pocketService.initialize()
  }

  const handleFile = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    setMessage(null)
    setError(null)

    try {
      await pocketService.installLeoVoiceSample(file)
      setUsingCustomReference(true)
      setAvailable(true)
      onInstalledChange?.(true)
      await prepareLeo()
      setMessage(
        'Leo is ready. The voice fingerprint is saved on this device, so future starts skip re-analyzing the reference.'
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

  const handleRestoreBundled = async () => {
    setBusy(true)
    setMessage(null)
    setError(null)

    try {
      await pocketService.removeLeoVoiceSample()
      setUsingCustomReference(false)
      setAvailable(true)
      onInstalledChange?.(true)
      await prepareLeo()
      setMessage(
        'The included full Leo reference is restored and ready. Future starts will reuse its saved voice fingerprint.'
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not restore and prepare the included Leo reference.'
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
              Full custom voice reference with reusable local preparation.
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
              <span className="font-medium text-text-primary">
                Leo reference
              </span>
              <span
                className={
                  available
                    ? 'text-sm text-accent'
                    : 'text-sm text-text-muted'
                }
              >
                {checking
                  ? 'Checking…'
                  : available
                    ? usingCustomReference
                      ? 'Custom'
                      : 'Included'
                    : 'Unavailable'}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              The app includes the complete 42-second Leo clip. Pocket TTS uses
              the whole reference instead of reducing it to a 10-second window.
            </p>
          </div>

          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <p className="text-sm font-medium text-text-primary">
              Faster after the first preparation
            </p>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              The first run creates a compact Leo voice fingerprint. It is saved
              on this device, so later launches skip the slow reference-audio
              encoder and load the saved fingerprint instead.
            </p>
          </div>

          <label
            className={`block ${busy ? 'pointer-events-none opacity-60' : ''}`}
          >
            <span className="pressable flex min-h-12 w-full cursor-pointer items-center justify-center rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white">
              {busy
                ? 'Preparing Leo…'
                : usingCustomReference
                  ? 'Replace custom reference'
                  : 'Use a different reference'}
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

          {usingCustomReference && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRestoreBundled()}
              className="pressable min-h-11 w-full rounded-xl bg-surface-2 px-4 py-3 text-sm font-medium text-accent disabled:opacity-50"
            >
              Restore included 42-second reference
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
            Those files, the Leo reference, and the prepared voice fingerprint
            remain in browser storage for later use.
          </p>
        </div>
      </div>
    </>
  )
}
