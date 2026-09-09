/**
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
