from pathlib import Path
import json


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"Expected text not found in {path}: {old[:140]!r}")
    p.write_text(s.replace(old, new, 1))


# ---------------------------------------------------------------------------
# New Voicebox remote service
# ---------------------------------------------------------------------------
voicebox_service = r'''/**
 * Voicebox remote TTS service for the free Google Colab workflow.
 *
 * The actual jamiepine/voicebox backend and Qwen3-TTS model run remotely.
 * The iPhone only uploads the private Leo reference when a new ephemeral
 * Voicebox session needs its profile, requests generated audio, and caches it.
 */
import { splitTextIntoChunks } from './textChunking'

const BASE_URL_KEY = 'epubplayer.voiceboxBaseUrl'
const ACCESS_TOKEN_KEY = 'epubplayer.voiceboxAccessToken'
const PROFILE_ID_KEY = 'epubplayer.voiceboxLeoProfileId'
const REFERENCE_TEXT_KEY = 'epubplayer.voiceboxLeoReferenceText'

const POCKET_VOICE_CACHE = 'epub-player-pocket-voices-v2'
const POCKET_REFERENCE_PATH = '/__epubplayer/pocket/voices/leo-reference-v2'
const LEGACY_VOICE_CACHE = 'epub-player-pocket-voices-v1'
const LEGACY_REFERENCE_PATH = '/__epubplayer/pocket/voices/leo'

const MAX_CHUNK_CHARS = 700
const PROFILE_NAME = 'Leo — EPUB Player'
const GENERATION_TIMEOUT_MS = 8 * 60 * 1000

export const VOICEBOX_VOICE_ID = 'voicebox:leo'
export const VOICEBOX_VOICE_NAME = 'Leo'

type AudioCallback = (audio: VoiceboxGeneratedAudio) => void
type ProgressCallback = (status: string, progress?: number) => void
type ErrorCallback = (error: string) => void
type ReadyCallback = () => void

export interface VoiceboxGeneratedAudio {
  requestId: string
  blob: Blob
  duration: number
  chunkIndex: number
  text: string
}

type VoiceboxProfile = {
  id: string
  name: string
  sample_count?: number
  default_engine?: string | null
}

type VoiceboxGeneration = {
  id: string
  status?: string
  duration?: number | null
  error?: string | null
}

function localUrl(path: string): string {
  if (typeof window === 'undefined') return `https://local.invalid${path}`
  return new URL(path, window.location.origin).toString()
}

function normalizeBaseUrl(value: string): string {
  const clean = value.trim().replace(/\/+$/, '')
  if (!clean) throw new Error('Voicebox server URL is required')
  const parsed = new URL(clean)
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && parsed.protocol !== 'https:') {
    throw new Error('Voicebox must use an HTTPS address on iPhone')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function guessFilename(blob: Blob): string {
  if (blob.type.includes('mpeg')) return 'leo-reference.mp3'
  if (blob.type.includes('mp4') || blob.type.includes('m4a')) return 'leo-reference.m4a'
  if (blob.type.includes('ogg')) return 'leo-reference.ogg'
  if (blob.type.includes('webm')) return 'leo-reference.webm'
  return 'leo-reference.wav'
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function audioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const audio = new Audio()
    const finish = (value: number) => {
      URL.revokeObjectURL(url)
      resolve(Number.isFinite(value) && value > 0 ? value : 1)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => finish(audio.duration)
    audio.onerror = () => finish(1)
    audio.src = url
  })
}

class VoiceboxRemoteService {
  private isReady = false
  private isLoading = false
  private initPromise: Promise<void> | null = null
  private requestCounter = 0
  private cancelEpoch = 0
  private activeGenerationIds = new Set<string>()

  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  configure(baseUrl: string, accessToken: string): void {
    const normalized = normalizeBaseUrl(baseUrl)
    const token = accessToken.trim()
    if (!token) throw new Error('Voicebox access token is required')
    localStorage.setItem(BASE_URL_KEY, normalized)
    localStorage.setItem(ACCESS_TOKEN_KEY, token)
    this.destroy()
  }

  getConfig(): { baseUrl: string; accessToken: string } {
    if (typeof localStorage === 'undefined') return { baseUrl: '', accessToken: '' }
    return {
      baseUrl: localStorage.getItem(BASE_URL_KEY)?.trim() || '',
      accessToken: localStorage.getItem(ACCESS_TOKEN_KEY)?.trim() || '',
    }
  }

  hasConfig(): boolean {
    const { baseUrl, accessToken } = this.getConfig()
    return Boolean(baseUrl && accessToken)
  }

  clearConfig(): void {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(BASE_URL_KEY)
      localStorage.removeItem(ACCESS_TOKEN_KEY)
      localStorage.removeItem(PROFILE_ID_KEY)
    }
    this.destroy()
  }

  async resetLeoProfile(): Promise<void> {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(PROFILE_ID_KEY)
    this.destroy()
  }

  private headers(extra?: HeadersInit): Headers {
    const { accessToken } = this.getConfig()
    const headers = new Headers(extra)
    headers.set('X-Voicebox-Token', accessToken)
    return headers
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const { baseUrl, accessToken } = this.getConfig()
    if (!baseUrl || !accessToken) throw new Error('Voicebox Colab server is not connected')
    return fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      ...init,
      headers: this.headers(init.headers),
      cache: 'no-store',
      credentials: 'omit',
    })
  }

  private async errorDetail(response: Response): Promise<string> {
    try {
      const data = await response.json() as { detail?: unknown; error?: unknown }
      const detail = data.detail ?? data.error
      return typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : `HTTP ${response.status}`
    } catch {
      return `HTTP ${response.status}`
    }
  }

  async testConnection(): Promise<string> {
    const response = await this.request('/health')
    if (!response.ok) throw new Error(`Voicebox connection failed: ${await this.errorDetail(response)}`)
    const health = await response.json() as { status?: string; gpu?: string; gpu_available?: boolean }
    if (health.status && health.status !== 'healthy') throw new Error(`Voicebox is ${health.status}`)
    return health.gpu || (health.gpu_available ? 'GPU ready' : 'Voicebox ready')
  }

  async hasLeoReference(): Promise<boolean> {
    try {
      await this.getLeoReferenceBlob()
      return true
    } catch {
      return false
    }
  }

  private async getLeoReferenceBlob(): Promise<Blob> {
    if (typeof caches === 'undefined') throw new Error('Browser Cache Storage is unavailable')
    const current = await caches.open(POCKET_VOICE_CACHE)
    const hit = await current.match(localUrl(POCKET_REFERENCE_PATH))
    if (hit) return hit.blob()
    const legacy = await caches.open(LEGACY_VOICE_CACHE)
    const old = await legacy.match(localUrl(LEGACY_REFERENCE_PATH))
    if (old) return old.blob()
    throw new Error('Leo reference audio is not installed on this iPhone')
  }

  private async transcribeReference(reference: Blob): Promise<string> {
    const cached = typeof localStorage !== 'undefined'
      ? localStorage.getItem(REFERENCE_TEXT_KEY)?.trim() || ''
      : ''
    if (cached) return cached

    this.onProgressCallback?.('Transcribing Leo once in Voicebox…', 35)
    const started = Date.now()
    while (Date.now() - started < 4 * 60 * 1000) {
      const form = new FormData()
      form.append('file', reference, guessFilename(reference))
      form.append('language', 'en')
      form.append('model', 'base')
      const response = await this.request('/transcribe', { method: 'POST', body: form })
      if (response.status === 202) {
        this.onProgressCallback?.('Voicebox is downloading Whisper for the one-time transcript…', 40)
        await delay(2500)
        continue
      }
      if (!response.ok) throw new Error(`Leo transcription failed: ${await this.errorDetail(response)}`)
      const data = await response.json() as { text?: string }
      const text = data.text?.trim() || ''
      if (!text) throw new Error('Voicebox returned an empty Leo transcript')
      localStorage.setItem(REFERENCE_TEXT_KEY, text)
      return text
    }
    throw new Error('Voicebox took too long to prepare the Leo transcript')
  }

  private async listProfiles(): Promise<VoiceboxProfile[]> {
    const response = await this.request('/profiles')
    if (!response.ok) throw new Error(`Could not read Voicebox profiles: ${await this.errorDetail(response)}`)
    return response.json() as Promise<VoiceboxProfile[]>
  }

  async ensureLeoProfile(): Promise<string> {
    const reference = await this.getLeoReferenceBlob()
    const profiles = await this.listProfiles()
    const savedId = localStorage.getItem(PROFILE_ID_KEY)?.trim() || ''
    const saved = savedId ? profiles.find((profile) => profile.id === savedId) : undefined
    if (saved && (saved.sample_count || 0) > 0) return saved.id

    const existing = profiles.find((profile) => profile.name === PROFILE_NAME && (profile.sample_count || 0) > 0)
    if (existing) {
      localStorage.setItem(PROFILE_ID_KEY, existing.id)
      return existing.id
    }

    this.onProgressCallback?.('Creating Leo inside Voicebox…', 20)
    let profile = profiles.find((item) => item.name === PROFILE_NAME)
    if (!profile) {
      const response = await this.request('/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: PROFILE_NAME,
          description: 'Private Leo audiobook voice for EPUB Player',
          language: 'en',
          voice_type: 'cloned',
          default_engine: 'qwen',
        }),
      })
      if (!response.ok) throw new Error(`Could not create Leo profile: ${await this.errorDetail(response)}`)
      profile = await response.json() as VoiceboxProfile
    }

    const transcript = await this.transcribeReference(reference)
    this.onProgressCallback?.('Uploading the full Leo reference to Voicebox…', 65)
    const form = new FormData()
    form.append('file', reference, guessFilename(reference))
    form.append('reference_text', transcript)
    const sampleResponse = await this.request(`/profiles/${encodeURIComponent(profile.id)}/samples`, {
      method: 'POST',
      body: form,
    })
    if (!sampleResponse.ok) {
      throw new Error(`Could not add the Leo sample: ${await this.errorDetail(sampleResponse)}`)
    }

    localStorage.setItem(PROFILE_ID_KEY, profile.id)
    return profile.id
  }

  async initialize(): Promise<void> {
    if (this.isReady) return
    if (this.isLoading && this.initPromise) return this.initPromise
    this.isLoading = true
    this.initPromise = this.doInitialize()
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async doInitialize(): Promise<void> {
    try {
      this.onProgressCallback?.('Connecting to Voicebox…', 5)
      await this.testConnection()
      await this.ensureLeoProfile()
      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Voicebox — Leo ready', 100)
      this.onReadyCallback?.()
    } catch (error) {
      this.isReady = false
      this.isLoading = false
      const message = error instanceof Error ? error.message : String(error)
      this.onErrorCallback?.(message)
      throw error
    }
  }

  private async waitForGeneration(id: string, epoch: number): Promise<VoiceboxGeneration> {
    const started = Date.now()
    while (Date.now() - started < GENERATION_TIMEOUT_MS) {
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
      const response = await this.request(`/history/${encodeURIComponent(id)}`)
      if (!response.ok) throw new Error(`Voicebox generation status failed: ${await this.errorDetail(response)}`)
      const generation = await response.json() as VoiceboxGeneration
      const status = generation.status || 'completed'
      if (status === 'completed') return generation
      if (status === 'failed' || status === 'canceled') {
        throw new Error(generation.error || `Voicebox generation ${status}`)
      }
      if (status === 'loading_model') {
        this.onProgressCallback?.('Voicebox is loading Qwen3-TTS…')
      }
      await delay(650)
    }
    throw new Error('Voicebox generation timed out')
  }

  async generateChunk(text: string, chunkIndex: number): Promise<VoiceboxGeneratedAudio> {
    await this.initialize()
    const profileId = await this.ensureLeoProfile()
    const epoch = this.cancelEpoch
    const requestId = `voicebox_${++this.requestCounter}_${Date.now()}`

    const response = await this.request('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile_id: profileId,
        text,
        language: 'en',
        engine: 'qwen',
        model_size: '1.7B',
        seed: 42,
        normalize: true,
        max_chunk_chars: 800,
        crossfade_ms: 80,
      }),
    })
    if (!response.ok) throw new Error(`Voicebox generation failed: ${await this.errorDetail(response)}`)
    const created = await response.json() as VoiceboxGeneration
    if (!created.id) throw new Error('Voicebox did not return a generation ID')
    this.activeGenerationIds.add(created.id)

    try {
      const finished = await this.waitForGeneration(created.id, epoch)
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
      const audioResponse = await this.request(`/audio/${encodeURIComponent(created.id)}`)
      if (!audioResponse.ok) throw new Error(`Voicebox audio download failed: ${await this.errorDetail(audioResponse)}`)
      const blob = await audioResponse.blob()
      if (!blob.size) throw new Error('Voicebox returned empty audio')
      const result: VoiceboxGeneratedAudio = {
        requestId,
        blob,
        duration: Number(finished.duration) || await audioDuration(blob),
        chunkIndex,
        text,
      }
      this.onAudioCallback?.(result)
      return result
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const message = error instanceof Error ? error.message : String(error)
        this.onErrorCallback?.(message)
      }
      throw error
    } finally {
      this.activeGenerationIds.delete(created.id)
    }
  }

  splitIntoChunks(text: string): string[] {
    return splitTextIntoChunks(text, MAX_CHUNK_CHARS)
  }

  cancelAll(): void {
    this.cancelEpoch += 1
    for (const id of this.activeGenerationIds) {
      void this.request(`/generate/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).catch(() => undefined)
    }
    this.activeGenerationIds.clear()
  }

  destroy(): void {
    this.cancelAll()
    this.isReady = false
    this.isLoading = false
    this.initPromise = null
  }

  getIsReady(): boolean { return this.isReady }
  getIsLoading(): boolean { return this.isLoading }
  onAudio(callback: AudioCallback): void { this.onAudioCallback = callback }
  onProgress(callback: ProgressCallback): void { this.onProgressCallback = callback }
  onError(callback: ErrorCallback): void { this.onErrorCallback = callback }
  onReady(callback: ReadyCallback): void { this.onReadyCallback = callback }
}

export const voiceboxRemoteService = new VoiceboxRemoteService()
'''
Path('src/services/tts/voiceboxRemoteService.ts').write_text(voicebox_service)


# ---------------------------------------------------------------------------
# Setup sheet
# ---------------------------------------------------------------------------
setup_sheet = r'''import { useEffect, useState } from 'react'
import { pocketService, ttsManager, voiceboxRemoteService } from '@/services/tts'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { useFocusTrap } from '@/ui/accessibility'

const COLAB_URL = 'https://colab.research.google.com/github/hard2hateu-png/epubplayer/blob/main/tools/Voicebox_Free_Colab.ipynb'

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
      setMessage(`Connected (${status}). Preparing Leo…`)
      await voiceboxRemoteService.initialize()
      await settingsRepository.set('voiceId', 'voicebox:leo')
      await settingsRepository.set('ttsEngine', 'voicebox')
      setActive(true)
      ttsManager.destroy()
      window.location.reload()
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
            <p className="mt-1 text-sm text-text-muted">Free/open-source Voicebox + Qwen3-TTS. The GPU runs in Google Colab, not on your iPhone.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} className="pressable rounded-lg px-2 py-1 text-sm font-medium text-accent disabled:opacity-50">Done</button>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm leading-relaxed text-text-muted">
            <p className="font-medium text-text-primary">No paid TTS API</p>
            <p className="mt-1">This uses the actual jamiepine/voicebox backend. A free Colab GPU session supplies the compute. Free Colab sessions are temporary, so you will start the notebook again when a session expires.</p>
          </div>

          <a
            href={COLAB_URL}
            target="_blank"
            rel="noreferrer"
            className="pressable block min-h-12 w-full rounded-xl bg-accent px-4 py-3 text-center font-semibold text-white"
          >
            Open Free Voicebox Colab
          </a>
          <p className="text-xs leading-relaxed text-text-muted">In Colab choose a GPU runtime, then Run all. The last cell gives you a button that pairs the temporary Voicebox server with this reader automatically.</p>

          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium text-text-primary">Leo recording</span>
              <span className={hasReference ? 'text-sm text-accent' : 'text-sm text-text-muted'}>{hasReference ? 'Ready' : 'Needed'}</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-text-muted">Voicebox uses the full Leo recording stored on this iPhone. The recording is sent only to your temporary Colab session when that session needs to rebuild the Leo profile.</p>
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
              placeholder="Generated by the Colab notebook"
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
            {busy ? 'Preparing Voicebox Leo…' : active ? 'Reconnect Voicebox Leo' : 'Use Voicebox Leo for TTS'}
          </button>

          {(baseUrl || accessToken) && (
            <button type="button" disabled={busy} onClick={() => void disconnect()} className="pressable min-h-11 w-full rounded-xl px-4 py-2 text-center text-sm font-medium text-warning disabled:opacity-50">Remove Voicebox connection</button>
          )}
        </div>
      </div>
    </>
  )
}
'''
Path('src/features/settings/VoiceboxRemoteSetupSheet.tsx').write_text(setup_sheet)


# ---------------------------------------------------------------------------
# Canonical type + exports
# ---------------------------------------------------------------------------
replace_once(
    'src/services/tts/types.ts',
    "export type TTSEngine = 'browser' | 'piper' | 'kokoro' | 'supertonic' | 'sherpa' | 'kitten' | 'pocket'",
    "export type TTSEngine = 'browser' | 'piper' | 'kokoro' | 'supertonic' | 'sherpa' | 'kitten' | 'pocket' | 'voicebox'",
)

replace_once(
    'src/services/tts/index.ts',
    "// Pocket TTS custom voice service\nexport { pocketService, POCKET_VOICE_NAME, POCKET_VOICE_ID } from './pocketService'\nexport type { PocketConfig, PocketGeneratedAudio } from './pocketService'",
    "// Pocket TTS custom voice service\nexport { pocketService, POCKET_VOICE_NAME, POCKET_VOICE_ID } from './pocketService'\nexport type { PocketConfig, PocketGeneratedAudio } from './pocketService'\n\n// Voicebox remote custom voice service\nexport { voiceboxRemoteService, VOICEBOX_VOICE_NAME, VOICEBOX_VOICE_ID } from './voiceboxRemoteService'\nexport type { VoiceboxGeneratedAudio } from './voiceboxRemoteService'",
)


# ---------------------------------------------------------------------------
# TTS manager
# ---------------------------------------------------------------------------
p = Path('src/services/tts/ttsManager.ts')
s = p.read_text()
s = s.replace("import { pocketService } from './pocketService'", "import { pocketService } from './pocketService'\nimport { voiceboxRemoteService } from './voiceboxRemoteService'", 1)

pocket_registry = """  pocket: {
    id: 'pocket',
    name: 'Pocket TTS (Leo)',
    description: 'Custom local Leo voice clone. Runs on-device and uses the normal generated-audio cache.',
    available: true,
    capabilities: {
      generatesBlobs: true,
      requiresInit: true,
      slowOnCPU: false,
    },
  },
"""
voicebox_registry = """  voicebox: {
    id: 'voicebox',
    name: 'Voicebox (Leo)',
    description: 'Free/open-source Voicebox + Qwen3-TTS on a remote GPU such as Google Colab.',
    available: true,
    capabilities: {
      generatesBlobs: true,
      requiresInit: true,
      slowOnCPU: false,
    },
  },
"""
if pocket_registry not in s:
    raise SystemExit('Pocket registry not found')
s = s.replace(pocket_registry, voicebox_registry + pocket_registry, 1)

s = s.replace(
    """        case 'pocket':
          this.wireUpService(pocketService, 'pocket')
          await pocketService.initialize()
          break

        case 'browser':""",
    """        case 'pocket':
          this.wireUpService(pocketService, 'pocket')
          await pocketService.initialize()
          break

        case 'voicebox':
          this.wireUpService(voiceboxRemoteService, 'voicebox')
          await voiceboxRemoteService.initialize()
          break

        case 'browser':""",
    1,
)

s = s.replace(
    """        case 'pocket': {
          const result = await pocketService.generateChunk(text, chunkIndex)
          return {
            requestId: result.requestId,
            blob: result.blob,
            duration: result.duration,
            chunkIndex: result.chunkIndex,
            text: result.text,
          }
        }

        default:""",
    """        case 'pocket': {
          const result = await pocketService.generateChunk(text, chunkIndex)
          return {
            requestId: result.requestId,
            blob: result.blob,
            duration: result.duration,
            chunkIndex: result.chunkIndex,
            text: result.text,
          }
        }

        case 'voicebox': {
          const result = await voiceboxRemoteService.generateChunk(text, chunkIndex)
          return {
            requestId: result.requestId,
            blob: result.blob,
            duration: result.duration,
            chunkIndex: result.chunkIndex,
            text: result.text,
          }
        }

        default:""",
    1,
)

s = s.replace(
    """      case 'pocket':
        return pocketService.splitIntoChunks(text)
      default:""",
    """      case 'pocket':
        return pocketService.splitIntoChunks(text)
      case 'voicebox':
        return voiceboxRemoteService.splitIntoChunks(text)
      default:""",
    1,
)

s = s.replace(
    """      case 'pocket':
        pocketService.cancelAll()
        break
    }
  }

  destroy(): void {""",
    """      case 'pocket':
        pocketService.cancelAll()
        break
      case 'voicebox':
        voiceboxRemoteService.cancelAll()
        break
    }
  }

  destroy(): void {""",
    1,
)

s = s.replace(
    """      case 'pocket':
        pocketService.destroy()
        break
    }
    this.isInitialized = false""",
    """      case 'pocket':
        pocketService.destroy()
        break
      case 'voicebox':
        voiceboxRemoteService.destroy()
        break
    }
    this.isInitialized = false""",
    1,
)
p.write_text(s)


# ---------------------------------------------------------------------------
# Generated audio cache identity
# ---------------------------------------------------------------------------
p = Path('src/features/player/TTSBufferManager.ts')
s = p.read_text()
s = s.replace(
    "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'\n\nfunction cacheModelConfig(ctx: BufferContext): string {\n  return ctx.engine === 'pocket' ? `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}` : ctx.modelConfig\n}",
    "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'\nconst VOICEBOX_AUDIO_CACHE_VERSION = 'voicebox-leo-qwen17-v1'\n\nfunction cacheModelConfig(ctx: BufferContext): string {\n  if (ctx.engine === 'pocket') return `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}`\n  if (ctx.engine === 'voicebox') return `${ctx.modelConfig}:${VOICEBOX_AUDIO_CACHE_VERSION}`\n  return ctx.modelConfig\n}",
    1,
)
p.write_text(s)


# ---------------------------------------------------------------------------
# Settings UI
# ---------------------------------------------------------------------------
p = Path('src/features/settings/SettingsPage.tsx')
s = p.read_text()
s = s.replace("import { PocketVoiceSetupSheet } from './PocketVoiceSetupSheet'", "import { PocketVoiceSetupSheet } from './PocketVoiceSetupSheet'\nimport { VoiceboxRemoteSetupSheet } from './VoiceboxRemoteSetupSheet'", 1)
s = s.replace("import { ttsManager, pocketService, type TTSEngine } from '@/services/tts'", "import { ttsManager, pocketService, voiceboxRemoteService, type TTSEngine } from '@/services/tts'", 1)

s = s.replace(
    "    { id: 'supertonic' as TTSEngine, name: t`Supertonic (Recommended)`, description: t`AI voice with great quality and speed. Works on most devices. ~260MB download.` },\n    { id: 'pocket' as TTSEngine,",
    "    { id: 'supertonic' as TTSEngine, name: t`Supertonic (Recommended)`, description: t`AI voice with great quality and speed. Works on most devices. ~260MB download.` },\n    { id: 'voicebox' as TTSEngine, name: t`Voicebox + Qwen3-TTS (Leo)`, description: t`Free/open-source Leo clone using a remote GPU such as a free Google Colab session.` },\n    { id: 'pocket' as TTSEngine,",
    1,
)

s = s.replace(
    "    if (settings.ttsEngine === 'pocket') {\n      return 'Leo'\n    }",
    "    if (settings.ttsEngine === 'pocket' || settings.ttsEngine === 'voicebox') {\n      return 'Leo'\n    }",
    1,
)

pocket_row = """          {settings.ttsEngine !== 'pocket' && (
            <SettingsItem
              icon={<VolumeIcon className=\"h-5 w-5\" />}
              label={t`Pocket TTS — Leo`}
              value={pocketVoiceInstalled === null ? t`Checking…` : pocketVoiceInstalled ? t`Installed` : t`Set up`}
              description={t`Install or replace the private local Leo voice sample`}
              onClick={() => setActiveSheet('pocketLeo')}
            />
          )}
"""
voicebox_row = """          {settings.ttsEngine !== 'voicebox' && (
            <SettingsItem
              icon={<VolumeIcon className=\"h-5 w-5\" />}
              label={t`Voicebox — Leo`}
              value={voiceboxRemoteService.hasConfig() ? t`Paired` : t`Set up`}
              description={t`Free/open-source Voicebox + Qwen3-TTS using a remote Colab GPU`}
              onClick={() => setActiveSheet('voiceboxLeo')}
            />
          )}

"""
if pocket_row not in s:
    raise SystemExit('Pocket setup row not found')
s = s.replace(pocket_row, voicebox_row + pocket_row, 1)

pocket_voice_block = """          {settings.ttsEngine === 'pocket' && (
            <>
              <SettingsItem
                icon={<VolumeIcon className=\"h-5 w-5\" />}
                label={t`Voice`}
                value=\"Leo\"
                description={pocketVoiceInstalled ? t`Local custom Pocket TTS voice` : t`Voice sample required`}
                onClick={() => setActiveSheet('pocketLeo')}
              />
              <SettingsItem
                label={t`Buffer Ahead`}
                value={getBufferAheadLabel()}
                description={t`Uses the same generated-audio cache and iPhone safety limit`}
                onClick={() => setActiveSheet('bufferAhead')}
              />
            </>
          )}
"""
voicebox_voice_block = """          {settings.ttsEngine === 'voicebox' && (
            <>
              <SettingsItem
                icon={<VolumeIcon className=\"h-5 w-5\" />}
                label={t`Voice`}
                value=\"Leo\"
                description={t`Voicebox Qwen3-TTS 1.7B clone`}
                onClick={() => setActiveSheet('voiceboxLeo')}
              />
              <SettingsItem
                label={t`Buffer Ahead`}
                value={getBufferAheadLabel()}
                description={t`Generated Voicebox audio is cached on this iPhone for smooth playback`}
                onClick={() => setActiveSheet('bufferAhead')}
              />
            </>
          )}
"""
if pocket_voice_block not in s:
    raise SystemExit('Pocket active voice block not found')
s = s.replace(pocket_voice_block, voicebox_voice_block + pocket_voice_block, 1)

s = s.replace(
    "              settings.ttsEngine === 'supertonic' ? 'Supertonic 66M' :\n              settings.ttsEngine === 'pocket' ? 'Pocket TTS — Leo' :",
    "              settings.ttsEngine === 'supertonic' ? 'Supertonic 66M' :\n              settings.ttsEngine === 'voicebox' ? 'Voicebox + Qwen3-TTS — Leo' :\n              settings.ttsEngine === 'pocket' ? 'Pocket TTS — Leo' :",
    1,
)

pocket_sheet = """      <PocketVoiceSetupSheet
        isOpen={activeSheet === 'pocketLeo'}
        onClose={() => setActiveSheet(null)}
        onInstalledChange={setPocketVoiceInstalled}
      />

"""
voicebox_sheet = """      <VoiceboxRemoteSetupSheet
        isOpen={activeSheet === 'voiceboxLeo'}
        onClose={() => setActiveSheet(null)}
      />

"""
if pocket_sheet not in s:
    raise SystemExit('Pocket setup sheet not found')
s = s.replace(pocket_sheet, pocket_sheet + voicebox_sheet, 1)

engine_guard = """          if (engine === 'pocket') {
            const installed = await pocketService.hasLeoVoiceSample()
            setPocketVoiceInstalled(installed)
            if (!installed) {
              setActiveSheet('pocketLeo')
              return
            }
          }
          
"""
voicebox_guard = """          if (engine === 'voicebox') {
            const hasReference = await voiceboxRemoteService.hasLeoReference()
            if (!hasReference || !voiceboxRemoteService.hasConfig()) {
              setActiveSheet('voiceboxLeo')
              return
            }
          }

"""
if engine_guard not in s:
    raise SystemExit('Pocket engine guard not found')
s = s.replace(engine_guard, engine_guard + voicebox_guard, 1)

s = s.replace(
    """          } else if (engine === 'pocket') {
            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.
            await settingsRepository.set('voiceId', 'pocket:leo')
            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))
          }

          // PlaybackController currently resolves the outgoing engine's voice during a hot-swap.
          // A one-time page reload when switching to/from Pocket avoids a transient wrong cache key
          // without changing the stable playback controller used by the existing engines.
          const switchingToOrFromPocket = engine === 'pocket' || settings.ttsEngine === 'pocket'
          if (switchingToOrFromPocket) {""",
    """          } else if (engine === 'pocket') {
            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.
            await settingsRepository.set('voiceId', 'pocket:leo')
            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))
          } else if (engine === 'voicebox') {
            await settingsRepository.set('voiceId', 'voicebox:leo')
            setSettings((prev) => ({ ...prev, voiceId: 'voicebox:leo' }))
          }

          // Custom Leo engines use distinct generated-audio cache identities. Reload once
          // when switching to/from either one so PlaybackController cannot retain the old voice.
          const switchingToOrFromCustomLeo =
            engine === 'pocket' || engine === 'voicebox' ||
            settings.ttsEngine === 'pocket' || settings.ttsEngine === 'voicebox'
          if (switchingToOrFromCustomLeo) {""",
    1,
)

# One-tap pairing from the Colab notebook uses the URL fragment so the temporary
# token is never sent to Vercel or written to server logs.
needle = """  // Load settings on mount
  useEffect(() => {
"""
pairing = """  // One-tap pairing from the free Colab notebook. URL fragments stay client-side.
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '')
    const voiceboxUrl = params.get('voiceboxUrl')
    const voiceboxToken = params.get('voiceboxToken')
    if (!voiceboxUrl || !voiceboxToken) return
    try {
      voiceboxRemoteService.configure(voiceboxUrl, voiceboxToken)
      setActiveSheet('voiceboxLeo')
      window.history.replaceState(null, '', window.location.pathname + window.location.search)
    } catch {
      // Leave manual fields available in the setup sheet if pairing data is malformed.
    }
  }, [])

  // Load settings on mount
  useEffect(() => {
"""
if needle not in s:
    raise SystemExit('Settings load marker not found')
s = s.replace(needle, pairing, 1)
p.write_text(s)


# ---------------------------------------------------------------------------
# Colab notebook: actual Voicebox, free Colab GPU, protected Cloudflare tunnel
# ---------------------------------------------------------------------------
notebook_cells = [
    {
        "cell_type": "markdown",
        "metadata": {},
        "source": [
            "# Voicebox + Qwen3-TTS for EPUB Player (free Colab trial)\n",
            "This notebook runs the **actual open-source [jamiepine/voicebox](https://github.com/jamiepine/voicebox)** backend on a Google Colab GPU and gives the iPhone EPUB reader a temporary HTTPS connection.\n\n",
            "**Before Run all:** Runtime → Change runtime type → choose a GPU (T4 is fine when Colab offers one). Free GPU availability and session length are controlled by Google and are not guaranteed.\n\n",
            "Keep this runtime alive while you listen. When Colab disconnects, run the notebook again and tap the new pairing button. Your generated audiobook chunks remain cached in EPUB Player."
        ],
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "import os, subprocess, sys, time, pathlib\n",
            "try:\n",
            "    import torch\n",
            "    print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NONE')\n",
            "except Exception as e:\n",
            "    print('GPU check:', e)\n",
            "if not __import__('torch').cuda.is_available():\n",
            "    raise RuntimeError('No GPU is attached. In Colab choose Runtime → Change runtime type → GPU, then Run all again.')\n"
        ],
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Install the Voicebox backend exactly from the open-source project. First run can take several minutes.\n",
            "import os, subprocess, sys, pathlib\n",
            "root = pathlib.Path('/content/voicebox')\n",
            "if not root.exists():\n",
            "    subprocess.run(['git','clone','--depth','1','https://github.com/jamiepine/voicebox.git',str(root)], check=True)\n",
            "# Pin the Voicebox revision used when this EPUB integration was built.\n",
            "subprocess.run(['git','-C',str(root),'fetch','--depth','1','origin','51f49dea198384b4eb6087b72c17057c6eb1c1cd'], check=True)\n",
            "subprocess.run(['git','-C',str(root),'checkout','--detach','51f49dea198384b4eb6087b72c17057c6eb1c1cd'], check=True)\n",
            "sentinel = pathlib.Path('/content/.voicebox_epub_ready')\n",
            "if not sentinel.exists():\n",
            "    subprocess.run([sys.executable,'-m','pip','install','-q','-r',str(root/'backend/requirements.txt')], check=True)\n",
            "    subprocess.run([sys.executable,'-m','pip','install','-q','--no-deps','chatterbox-tts','hume-tada'], check=True)\n",
            "    subprocess.run([sys.executable,'-m','pip','install','-q','git+https://github.com/QwenLM/Qwen3-TTS.git'], check=True)\n",
            "    sentinel.write_text('ready')\n",
            "print('Voicebox backend installed.')\n"
        ],
    },
    {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [
            "# Start Voicebox, put a small token-protected proxy in front of it, then make a free HTTPS Quick Tunnel.\n",
            "import os, subprocess, sys, time, pathlib, secrets, re, urllib.request, textwrap, html\n",
            "from IPython.display import display, HTML\n",
            "\n",
            "for name in ('VOICEBOX_PROCESS','VOICEBOX_PROXY','VOICEBOX_TUNNEL'):\n",
            "    old = globals().get(name)\n",
            "    if old is not None:\n",
            "        try: old.terminate()\n",
            "        except Exception: pass\n",
            "\n",
            "token = secrets.token_urlsafe(32)\n",
            "env = os.environ.copy()\n",
            "env['VOICEBOX_CORS_ORIGINS'] = 'https://epubplayer-eta.vercel.app'\n",
            "env['PYTHONUNBUFFERED'] = '1'\n",
            "voicebox_log = open('/content/voicebox-backend.log','w')\n",
            "VOICEBOX_PROCESS = subprocess.Popen([sys.executable,'-m','backend.main','--host','127.0.0.1','--port','17493','--data-dir','/content/voicebox-data'], cwd='/content/voicebox', env=env, stdout=voicebox_log, stderr=subprocess.STDOUT)\n",
            "\n",
            "import requests\n",
            "for _ in range(120):\n",
            "    try:\n",
            "        r = requests.get('http://127.0.0.1:17493/health', timeout=2)\n",
            "        if r.ok: break\n",
            "    except Exception: pass\n",
            "    if VOICEBOX_PROCESS.poll() is not None:\n",
            "        raise RuntimeError(pathlib.Path('/content/voicebox-backend.log').read_text()[-5000:])\n",
            "    time.sleep(1)\n",
            "else:\n",
            "    raise RuntimeError('Voicebox did not start. See /content/voicebox-backend.log')\n",
            "\n",
            "proxy_code = r'''\n",
            "import os\n",
            "import httpx\n",
            "from fastapi import FastAPI, Request\n",
            "from fastapi.responses import Response\n",
            "from fastapi.middleware.cors import CORSMiddleware\n",
            "TOKEN = os.environ['VOICEBOX_EPUB_TOKEN']\n",
            "UPSTREAM = 'http://127.0.0.1:17493'\n",
            "app = FastAPI()\n",
            "app.add_middleware(CORSMiddleware, allow_origins=['https://epubplayer-eta.vercel.app'], allow_credentials=False, allow_methods=['*'], allow_headers=['*'])\n",
            "@app.api_route('/{path:path}', methods=['GET','POST','PUT','DELETE','PATCH','OPTIONS'])\n",
            "async def proxy(path: str, request: Request):\n",
            "    if request.method != 'OPTIONS' and request.headers.get('x-voicebox-token') != TOKEN:\n",
            "        return Response('Unauthorized', status_code=401)\n",
            "    body = await request.body()\n",
            "    headers = {k:v for k,v in request.headers.items() if k.lower() not in {'host','content-length','x-voicebox-token','origin','referer'}}\n",
            "    async with httpx.AsyncClient(timeout=600.0) as client:\n",
            "        resp = await client.request(request.method, f'{UPSTREAM}/{path}', params=request.query_params, content=body, headers=headers)\n",
            "    out_headers = {k:v for k,v in resp.headers.items() if k.lower() not in {'content-length','content-encoding','transfer-encoding','connection','access-control-allow-origin','access-control-allow-credentials'}}\n",
            "    return Response(resp.content, status_code=resp.status_code, headers=out_headers, media_type=resp.headers.get('content-type'))\n",
            "'''\n",
            "pathlib.Path('/content/voicebox_secure_proxy.py').write_text(proxy_code)\n",
            "proxy_env = os.environ.copy(); proxy_env['VOICEBOX_EPUB_TOKEN'] = token\n",
            "proxy_log = open('/content/voicebox-proxy.log','w')\n",
            "VOICEBOX_PROXY = subprocess.Popen([sys.executable,'-m','uvicorn','voicebox_secure_proxy:app','--host','127.0.0.1','--port','7860'], cwd='/content', env=proxy_env, stdout=proxy_log, stderr=subprocess.STDOUT)\n",
            "for _ in range(30):\n",
            "    try:\n",
            "        if requests.get('http://127.0.0.1:7860/health', headers={'X-Voicebox-Token':token}, timeout=2).ok: break\n",
            "    except Exception: pass\n",
            "    time.sleep(1)\n",
            "else: raise RuntimeError('Secure proxy did not start')\n",
            "\n",
            "cloudflared = pathlib.Path('/content/cloudflared')\n",
            "if not cloudflared.exists():\n",
            "    urllib.request.urlretrieve('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', cloudflared)\n",
            "    cloudflared.chmod(0o755)\n",
            "VOICEBOX_TUNNEL = subprocess.Popen([str(cloudflared),'tunnel','--url','http://127.0.0.1:7860','--no-autoupdate'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)\n",
            "tunnel_url = None\n",
            "deadline = time.time() + 45\n",
            "while time.time() < deadline:\n",
            "    line = VOICEBOX_TUNNEL.stdout.readline()\n",
            "    if not line:\n",
            "        time.sleep(.2); continue\n",
            "    m = re.search(r'https://[a-zA-Z0-9.-]+\\.trycloudflare\\.com', line)\n",
            "    if m:\n",
            "        tunnel_url = m.group(0); break\n",
            "if not tunnel_url: raise RuntimeError('Cloudflare tunnel did not provide a URL')\n",
            "\n",
            "from urllib.parse import urlencode\n",
            "pair = 'https://epubplayer-eta.vercel.app/app/settings#' + urlencode({'voiceboxUrl': tunnel_url, 'voiceboxToken': token})\n",
            "print('VOICEBOX SERVER:', tunnel_url)\n",
            "print('ACCESS TOKEN:', token)\n",
            "display(HTML(f'''<div style=\"font-family:-apple-system;padding:18px;border:1px solid #ddd;border-radius:14px\"><h2>Voicebox is ready</h2><p>Keep this Colab runtime running while you listen.</p><a href=\"{html.escape(pair)}\" target=\"_blank\" style=\"display:inline-block;padding:14px 18px;background:#6d5dfc;color:white;text-decoration:none;border-radius:12px;font-weight:700\">Connect EPUB Player to Voicebox</a></div>'''))\n"
        ],
    },
]

notebook = {
    "cells": notebook_cells,
    "metadata": {
        "accelerator": "GPU",
        "colab": {"name": "Voicebox_Free_Colab.ipynb", "provenance": []},
        "kernelspec": {"display_name": "Python 3", "name": "python3"},
        "language_info": {"name": "python"},
    },
    "nbformat": 4,
    "nbformat_minor": 0,
}
Path('tools').mkdir(exist_ok=True)
Path('tools/Voicebox_Free_Colab.ipynb').write_text(json.dumps(notebook, indent=2))


# ---------------------------------------------------------------------------
# User-facing technical note
# ---------------------------------------------------------------------------
Path('docs/VOICEBOX_FREE_COLAB.md').write_text(r'''# Voicebox + Leo without a paid TTS API

This EPUB Player integration uses the actual open-source `jamiepine/voicebox` backend.

## No-computer architecture

1. The iPhone opens `tools/Voicebox_Free_Colab.ipynb` in Google Colab.
2. A free Colab GPU session runs Voicebox and Qwen3-TTS 1.7B.
3. A temporary Cloudflare Quick Tunnel exposes a token-protected HTTPS proxy.
4. The notebook's pairing button passes the temporary URL/token to EPUB Player in the URL fragment (the secret is not sent to Vercel).
5. EPUB Player recovers the Leo recording already stored privately in browser Cache Storage.
6. The first Voicebox session transcribes Leo once. The transcript is retained locally on the iPhone.
7. Each new ephemeral Voicebox server automatically recreates the Leo profile and uploads the original full reference using that cached transcript.
8. Generated book chunks are cached locally in EPUB Player.

## Cost / limits

There is no per-character TTS API or Replicate dependency. Voicebox is MIT-licensed/open source and the model runs in the Colab session. Google controls free Colab GPU availability, idle disconnects, and session limits, so this is appropriate for a free trial and intermittent listening, not a guaranteed 24/7 server.

## Security

Voicebox itself currently has no built-in remote API authentication. The Colab notebook therefore does **not** expose port 17493 directly. It places a small proxy in front of Voicebox that requires a random 256-bit `X-Voicebox-Token`, then tunnels only that proxy over HTTPS. Do not share the pairing URL or access token.
''')
