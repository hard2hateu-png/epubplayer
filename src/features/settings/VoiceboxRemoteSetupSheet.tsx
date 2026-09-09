import { useEffect, useState } from 'react'
import { pocketService, ttsManager, voiceboxRemoteService } from '@/services/tts'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { playbackController } from '@/features/player/PlaybackController'
import { useFocusTrap } from '@/ui/accessibility'

const KAGGLE_URL = 'https://www.kaggle.com/notebooks/welcome?src=https://github.com/hard2hateu-png/epubplayer/blob/main/tools/Voicebox_Free_Kaggle.ipynb'

export function VoiceboxRemoteSetupSheet({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  const initial = voiceboxRemoteService.getConfig()
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [accessToken, setAccessToken] = useState(initial.accessToken)
  const [hasReference, setHasReference] = useState(false)
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const sheetRef = useFocusTrap<HTMLDivElement>({ isActive: isOpen, onEscape: onClose })

  useEffect(() => {
    if (!isOpen) return
    const config = voiceboxRemoteService.getConfig()
    setBaseUrl(config.baseUrl)
    setAccessToken(config.accessToken)
    setMessage(null)
    setError(null)
    void Promise.all([
      voiceboxRemoteService.hasLeoReference(),
      settingsRepository.get('ttsEngine'),
    ]).then(([reference, engine]) => {
      setHasReference(reference)
      setActive(engine === 'voicebox')
    })
  }, [isOpen])

  if (!isOpen) return null

  const installReference = async (file: File | null) => {
    if (!file) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await pocketService.installLeoVoiceSample(file)
      await voiceboxRemoteService.resetLeoProfile()
      setHasReference(true)
      setMessage('Leo reference saved privately on this iPhone.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the Leo recording.')
    } finally {
      setBusy(false)
    }
  }

  const connectAndActivate = async () => {
    setBusy(true)
    setMessage('Connecting to the free Voicebox session…')
    setError(null)
    try {
      voiceboxRemoteService.configure(baseUrl, accessToken)
      const status = await voiceboxRemoteService.testConnection()
      await settingsRepository.set('voiceId', 'voicebox:leo')
      await settingsRepository.set('ttsEngine', 'voicebox')
      ttsManager.destroy()
      await playbackController.reloadTTSSettings()
      setActive(true)
      setMessage(`Connected (${status}). Press Play to prepare Leo and start Voicebox.`)
      setBusy(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect to Voicebox.')
      setBusy(false)
    }
  }

  const disconnect = async () => {
    voiceboxRemoteService.clearConfig()
    setBaseUrl('')
    setAccessToken('')
    setMessage('Voicebox connection removed from this iPhone.')
    if (active) {
      await settingsRepository.set('ttsEngine', 'supertonic')
      await settingsRepository.set('supertonicVoice', 'F1')
      ttsManager.destroy()
      window.location.reload()
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="voicebox-setup-title"
        className="fixed inset-x-0 bottom-0 z-50 max-h-[86vh] overflow-y-auto rounded-t-2xl bg-surface-1 shadow-2xl md:inset-auto md:left-1/2 md:top-1/2 md:w-full md:max-w-md md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl"
      >
        <div className="flex justify-center py-3 md:hidden" aria-hidden="true"><div className="h-1 w-10 rounded-full bg-surface-4" /></div>
        <div className="flex items-start justify-between gap-4 border-b border-border-muted px-5 pb-4 md:pt-5">
          <div>
            <h3 id="voicebox-setup-title" className="text-lg font-semibold text-text-primary">Voicebox — Leo</h3>
            <p className="mt-1 text-sm text-text-muted">Free/open-source Voicebox + Qwen3-TTS. The GPU runs in Kaggle, not on your iPhone.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="pressable rounded-lg px-2 py-1 text-sm font-medium text-accent disabled:opacity-50">Done</button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm leading-relaxed text-text-muted">
            <p className="font-medium text-text-primary">No paid TTS API</p>
            <p className="mt-1">This uses the actual jamiepine/voicebox backend. A free Kaggle GPU session supplies the compute. Kaggle sessions can keep running in the cloud while you switch back to this reader; sessions are temporary and use your Kaggle GPU quota.</p>
          </div>

          <a
            href={KAGGLE_URL}
            target="_blank"
            rel="noreferrer"
            className="pressable block min-h-12 w-full rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white"
          >
            Open Free Voicebox Kaggle
          </a>
          <p className="text-xs leading-relaxed text-text-muted">In Kaggle, turn Internet ON, choose a GPU accelerator, then Run All. The final cell intentionally stays running and gives you a button that pairs the Voicebox server with this reader automatically.</p>

          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-text-primary">Leo recording</span>
              <span className={hasReference ? 'text-sm text-accent' : 'text-sm text-text-muted'}>{hasReference ? 'Ready' : 'Needed'}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">Voicebox uses the full Leo recording stored on this iPhone. The recording is sent only to your temporary Kaggle session when that session needs to rebuild the Leo profile.</p>
          </div>

          {!hasReference && (
            <label className="pressable block min-h-12 w-full cursor-pointer rounded-xl bg-surface-3 px-4 py-3 text-center font-semibold text-text-primary">
              Select Leo audio
              <input type="file" accept="audio/*" className="hidden" disabled={busy} onChange={(event) => void installReference(event.target.files?.[0] || null)} />
            </label>
          )}

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-primary" htmlFor="voicebox-url">Voicebox server URL</label>
            <input
              id="voicebox-url"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://…trycloudflare.com"
              className="min-h-12 w-full rounded-xl border border-border-muted bg-surface-2 px-3 text-text-primary outline-none focus:border-accent"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-text-primary" htmlFor="voicebox-token">Temporary access token</label>
            <input
              id="voicebox-token"
              type="password"
              autoCapitalize="none"
              autoCorrect="off"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder="Generated by the Kaggle notebook"
              className="min-h-12 w-full rounded-xl border border-border-muted bg-surface-2 px-3 text-text-primary outline-none focus:border-accent"
            />
          </div>

          {message && <div className="rounded-xl bg-accent/10 px-4 py-3 text-sm leading-relaxed text-accent">{message}</div>}
          {error && <div className="rounded-xl bg-error/10 px-4 py-3 text-sm leading-relaxed text-error">{error}</div>}

          <button
            type="button"
            disabled={busy || !hasReference || !baseUrl.trim() || !accessToken.trim()}
            onClick={() => void connectAndActivate()}
            className="pressable min-h-12 w-full rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white disabled:opacity-50"
          >
            {busy ? 'Connecting Voicebox…' : active ? 'Reconnect Voicebox Leo' : 'Use Voicebox Leo for TTS'}
          </button>

          {(baseUrl || accessToken) && (
            <button type="button" disabled={busy} onClick={() => void disconnect()} className="pressable min-h-11 w-full rounded-xl px-4 py-2 text-center text-sm font-medium text-warning disabled:opacity-50">Remove Voicebox connection</button>
          )}
        </div>
      </div>
    </>
  )
}
