import { useEffect, useState } from 'react'
import { runLiteRTPocketProbe, type LiteRTPocketProbeResult } from '@/services/tts/litertPocketProbe'
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
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [detail, setDetail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LiteRTPocketProbeResult | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)

  const sheetRef = useFocusTrap<HTMLDivElement>({
    isActive: isOpen,
    onEscape: busy ? undefined : onClose,
  })

  useEffect(() => {
    if (isOpen) onInstalledChange?.(false)
  }, [isOpen, onInstalledChange])

  useEffect(() => {
    if (!result) return
    const url = URL.createObjectURL(result.blob)
    setAudioUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [result])

  if (!isOpen) return null

  const runTest = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    setStage('Starting Pocket LiteRT…')
    setDetail('Keep this screen open during the first test.')
    try {
      const next = await runLiteRTPocketProbe((nextStage, nextDetail) => {
        setStage(nextStage)
        setDetail(nextDetail || '')
      })
      setResult(next)
      setStage('Alba sample is ready.')
      setDetail('Pocket was not activated and your current TTS engine was not changed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pocket LiteRT test failed.')
      setStage('LiteRT test stopped.')
      setDetail('Your current TTS engine is still unchanged.')
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
        aria-labelledby="pocket-litert-test-title"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[82vh] overflow-y-auto rounded-t-2xl bg-surface-1 shadow-2xl md:inset-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
      >
        <div className="flex justify-center py-3 md:hidden" aria-hidden="true">
          <div className="h-1 w-10 rounded-full bg-surface-4" />
        </div>

        <div className="flex items-start justify-between gap-4 border-b border-border-muted px-5 pb-4 md:pt-5">
          <div>
            <h3 id="pocket-litert-test-title" className="text-lg font-semibold text-text-primary">
              Pocket LiteRT Test
            </h3>
            <p className="mt-1 text-sm text-text-muted">
              Safe on-device Alba compatibility check.
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
            <p className="text-sm font-medium text-text-primary">This does not activate Pocket TTS</p>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              It runs one fixed Alba sample in an isolated Web Worker. No Leo upload, no page reload, no audiobook buffer changes, and no server inference.
            </p>
          </div>

          <button
            type="button"
            disabled={busy}
            onClick={() => void runTest()}
            className="pressable min-h-12 w-full rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white disabled:opacity-60"
          >
            {busy ? 'Running LiteRT test…' : result ? 'Run Alba Test Again' : 'Run Alba LiteRT Test'}
          </button>

          {(busy || stage) && (
            <div className="rounded-xl bg-surface-2 px-4 py-3">
              <p className="text-sm font-medium text-text-primary">{stage}</p>
              {detail && <p className="mt-1 text-xs leading-relaxed text-text-muted">{detail}</p>}
              {busy && (
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-4">
                  <div className="h-full w-1/2 animate-pulse rounded-full bg-accent" />
                </div>
              )}
            </div>
          )}

          {result && audioUrl && (
            <div className="space-y-3 rounded-xl bg-accent/10 px-4 py-4">
              <div>
                <p className="text-sm font-semibold text-text-primary">Alba generated successfully</p>
                <p className="mt-1 text-xs leading-relaxed text-text-muted">“{result.text}”</p>
              </div>
              <audio className="w-full" controls preload="metadata" src={audioUrl} />
              <div className="grid grid-cols-2 gap-2 text-xs text-text-muted">
                <span>Audio: {result.duration.toFixed(1)} s</span>
                <span>Generation: {(result.generationMs / 1000).toFixed(1)} s</span>
                <span>Decode: {(result.decodeMs / 1000).toFixed(1)} s</span>
                <span>Speed: {result.rtfx.toFixed(2)}× realtime</span>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-xl bg-error/10 px-4 py-3 text-sm leading-relaxed text-error">
              {error}
            </div>
          )}

          <p className="text-xs leading-relaxed text-text-muted">
            The first run downloads roughly 200 MB of Pocket LiteRT assets. If the page freezes or Safari reloads, stop there; that result is useful and we will not add Leo on top of it.
          </p>
        </div>
      </div>
    </>
  )
}
