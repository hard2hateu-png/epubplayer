import { useEffect, useState } from 'react'
import { pocketService, qwenCloudService, ttsManager } from '@/services/tts'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { useFocusTrap } from '@/ui/accessibility'

export function QwenCloudSetupSheet({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  const [hasReference, setHasReference] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [active, setActive] = useState(false)
  const [token, setToken] = useState('')
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
    setMessage(null)
    setError(null)
    Promise.all([
      qwenCloudService.hasLeoReference(),
      settingsRepository.get('ttsEngine'),
    ]).then(([reference, engine]) => {
      if (cancelled) return
      setHasReference(reference)
      setConfigured(qwenCloudService.hasToken())
      setActive(engine === 'qwen')
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [isOpen])

  if (!isOpen) return null

  const connect = async () => {
    const clean = token.trim()
    if (!clean && !qwenCloudService.hasToken()) {
      setError('Paste your Replicate API token first.')
      return
    }
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      if (clean) qwenCloudService.setToken(clean)
      const account = await qwenCloudService.testConnection()
      setConfigured(true)
      setToken('')
      setMessage(`Connected to Replicate${account ? ` (${account})` : ''}.`)
    } catch (err) {
      if (clean) qwenCloudService.setToken('')
      setConfigured(false)
      setError(err instanceof Error ? err.message : 'Could not connect to Replicate.')
    } finally {
      setBusy(false)
    }
  }

  const installReference = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    setMessage(null)
    setError(null)
    try {
      await pocketService.installLeoVoiceSample(file)
      await qwenCloudService.clearPreparedReference()
      setHasReference(true)
      setMessage('Leo reference saved privately on this device. Qwen will prepare an 18-second speech sample from it.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the Leo reference.')
    } finally {
      setBusy(false)
    }
  }

  const activate = async () => {
    if (!configured) {
      setError('Connect your Replicate token first.')
      return
    }
    if (!hasReference) {
      setError('The Leo reference audio is not installed on this device.')
      return
    }
    setBusy(true)
    setMessage('Preparing Leo for Qwen. The first setup also transcribes the reference once…')
    setError(null)
    try {
      await qwenCloudService.initialize()
      await settingsRepository.set('voiceId', 'qwen:leo')
      await settingsRepository.set('ttsEngine', 'qwen')
      setActive(true)
      ttsManager.destroy()
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not activate Qwen3-TTS — Leo.')
      setBusy(false)
    }
  }

  const removeToken = async () => {
    qwenCloudService.setToken('')
    setConfigured(false)
    setToken('')
    setMessage('Replicate token removed from this device.')
    if (active) {
      await settingsRepository.set('ttsEngine', 'supertonic')
      await settingsRepository.set('supertonicVoice', 'F1')
      ttsManager.destroy()
      window.location.reload()
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
        aria-labelledby="qwen-cloud-setup-title"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[82vh] overflow-y-auto rounded-t-2xl bg-surface-1 shadow-2xl md:inset-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
      >
        <div className="flex justify-center py-3 md:hidden" aria-hidden="true">
          <div className="h-1 w-10 rounded-full bg-surface-4" />
        </div>
        <div className="flex items-start justify-between gap-4 border-b border-border-muted px-5 pb-4 md:pt-5">
          <div>
            <h3 id="qwen-cloud-setup-title" className="text-lg font-semibold text-text-primary">
              Qwen3-TTS — Leo
            </h3>
            <p className="mt-1 text-sm text-text-muted">Cloud voice cloning; no model runs on your iPhone.</p>
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
              <span className={hasReference ? 'text-sm text-accent' : 'text-sm text-text-muted'}>
                {hasReference ? 'Found on this device' : 'Not installed'}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              Qwen uses one continuous 18-second speech-dense section from the Leo audio already saved in the reader. The original audio is never committed to GitHub.
            </p>
          </div>

          {!hasReference && (
            <label className="pressable block min-h-12 w-full cursor-pointer rounded-xl border border-border-muted bg-surface-2 px-4 py-3 text-center font-medium text-text-primary">
              Select Leo audio
              <input
                type="file"
                accept="audio/*"
                className="sr-only"
                disabled={busy}
                onChange={(event) => void installReference(event.target.files?.[0] || null)}
              />
            </label>
          )}

          <div className="rounded-xl bg-surface-2 px-4 py-4">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-text-primary">Replicate connection</span>
              <span className={configured ? 'text-sm text-accent' : 'text-sm text-text-muted'}>
                {configured ? 'Configured' : 'Token required'}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">
              Your token stays in this browser and is sent over HTTPS only when the reader asks its own Qwen proxy to generate audio. It is never added to the repository.
            </p>

            <a
              href="https://replicate.com/account/api-tokens"
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-block text-sm font-medium text-accent"
            >
              Open Replicate API tokens ↗
            </a>

            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={configured ? 'Paste a new token to replace it' : 'Paste token (r8_…)'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="mt-3 w-full rounded-xl border border-border-muted bg-surface-1 px-3 py-3 text-sm text-text-primary outline-none focus:border-accent"
            />
            <button
              type="button"
              disabled={busy || (!token.trim() && !configured)}
              onClick={() => void connect()}
              className="pressable mt-3 min-h-11 w-full rounded-xl bg-surface-3 px-4 py-2.5 font-medium text-text-primary disabled:opacity-50"
            >
              {busy ? 'Checking…' : configured && !token.trim() ? 'Test connection' : 'Save & test token'}
            </button>
          </div>

          <div className="rounded-xl border border-border-muted px-4 py-3 text-xs leading-relaxed text-text-muted">
            First setup automatically transcribes the short Leo reference once so Qwen has both the audio and its words. Narration is then generated by Qwen3-TTS in the cloud and cached in this reader like the other AI engines. Replicate currently prices this model by text length, so audiobook use is not free.
          </div>

          {configured && hasReference && !active && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void activate()}
              className="pressable min-h-12 w-full rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Preparing Leo…' : 'Use Qwen Leo for TTS'}
            </button>
          )}

          {active && (
            <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm font-medium text-accent">
              Qwen3-TTS — Leo is the active reader voice.
            </div>
          )}

          {message && <p className="text-sm leading-relaxed text-text-muted">{message}</p>}
          {error && <p className="text-sm leading-relaxed text-red-400">{error}</p>}

          {configured && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void removeToken()}
              className="pressable w-full rounded-xl px-4 py-2.5 text-sm font-medium text-red-400 disabled:opacity-50"
            >
              Remove Replicate token
            </button>
          )}
        </div>
      </div>
    </>
  )
}
