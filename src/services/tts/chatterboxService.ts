/**
 * Chatterbox Turbo remote TTS adapter.
 *
 * The reader remains responsible for chunking/caching/playback. This service
 * only turns one text chunk into one WAV Blob via a same-origin backend proxy.
 * Leo's reference stays in the existing private browser Cache Storage and is
 * uploaded only when the remote Space reports that its in-memory conditionals
 * are missing (for example after a ZeroGPU Space restart).
 */
import { createLogger } from '@/services/logging'
import { splitTextIntoChunks } from './textChunking'

const log = createLogger('tts')

const API_BASE = '/api/chatterbox'
const VOICE_CACHE = 'epub-player-pocket-voices-v2'
const LEGACY_VOICE_CACHE = 'epub-player-pocket-voices-v1'
const REFERENCE_PATH = '/__epubplayer/pocket/voices/leo-reference-v2'
const LEGACY_REFERENCE_PATH = '/__epubplayer/pocket/voices/leo'
const CLIENT_ID_KEY = 'epub-player-chatterbox-client-id-v1'
const MAX_CHUNK_CHARS = 280
const GENERATE_TIMEOUT_MS = 75_000
const PREPARE_TIMEOUT_MS = 75_000

export interface ChatterboxConfig {
  maxChunkChars: number
}

export interface ChatterboxGeneratedAudio {
  requestId: string
  blob: Blob
  duration: number
  chunkIndex: number
  text: string
}

type AudioCallback = (audio: ChatterboxGeneratedAudio) => void
type ProgressCallback = (status: string, progress?: number) => void
type ErrorCallback = (error: string, requestId?: string) => void
type ReadyCallback = () => void

type GenerateResponse = {
  status?: 'ok' | 'needs_voice' | 'error'
  audio_b64?: string
  mime?: string
  duration?: number
  sample_rate?: number
  error?: string
}

type PrepareResponse = {
  status?: 'ready' | 'error'
  voice?: string
  error?: string
}

function randomClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(24)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function getClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY)
    if (existing && existing.length >= 16) return existing
    const created = randomClientId()
    localStorage.setItem(CLIENT_ID_KEY, created)
    return created
  } catch {
    return randomClientId()
  }
}

function localUrl(path: string): string {
  if (typeof window === 'undefined') return `https://local.invalid${path}`
  return new URL(path, window.location.origin).toString()
}

async function findLeoReference(): Promise<Blob> {
  if (typeof caches === 'undefined') {
    throw new Error('Leo voice setup is unavailable on this device')
  }

  const candidates = [
    { cache: VOICE_CACHE, path: REFERENCE_PATH },
    { cache: LEGACY_VOICE_CACHE, path: LEGACY_REFERENCE_PATH },
  ]

  for (const candidate of candidates) {
    try {
      const cache = await caches.open(candidate.cache)
      const hit = await cache.match(localUrl(candidate.path))
      if (hit) {
        const blob = await hit.blob()
        if (blob.size > 0) return blob
      }
    } catch {
      // Try the next known cache location.
    }
  }

  throw new Error('Leo is not installed. Open Voice → Leo to add the reference recording.')
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const parts: string[] = []
  const stride = 0x8000
  for (let offset = 0; offset < bytes.length; offset += stride) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + stride))
    parts.push(String.fromCharCode(...slice))
  }
  const mime = blob.type || 'audio/wav'
  return `data:${mime};base64,${btoa(parts.join(''))}`
}

function base64ToBlob(value: string, mime = 'audio/wav'): Blob {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

class ChatterboxService {
  private config: ChatterboxConfig = { maxChunkChars: MAX_CHUNK_CHARS }
  private isReady = false
  private isLoading = false
  private requestCounter = 0
  private cancelEpoch = 0
  private controllers = new Set<AbortController>()
  private generationTail: Promise<void> = Promise.resolve()

  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  async initialize(config?: Partial<ChatterboxConfig>): Promise<void> {
    this.config = {
      maxChunkChars: Math.min(
        MAX_CHUNK_CHARS,
        Math.max(100, config?.maxChunkChars ?? this.config.maxChunkChars),
      ),
    }

    // Deliberately no network request here. ZeroGPU can sleep/queue; initialization
    // must never leave the reader stuck on a remote health check.
    this.isLoading = false
    this.isReady = true
    this.onReadyCallback?.()
  }

  private async postJson<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      })

      let payload: unknown = null
      try {
        payload = await response.json()
      } catch {
        // Preserve the HTTP status error below when the body is not JSON.
      }

      if (!response.ok) {
        const message =
          payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
            ? payload.error
            : `Chatterbox backend returned ${response.status}`
        throw new Error(message)
      }

      return payload as T
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Chatterbox request timed out. Try again when the free GPU queue is shorter.')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
  }

  private async prepareLeo(clientId: string): Promise<void> {
    this.onProgressCallback?.('Preparing Leo on Chatterbox…')
    const reference = await findLeoReference()
    const referenceBase64 = await blobToDataUrl(reference)
    const result = await this.postJson<PrepareResponse>(
      '/prepare',
      { clientId, referenceBase64 },
      PREPARE_TIMEOUT_MS,
    )

    if (result.status !== 'ready') {
      throw new Error(result.error || 'Could not prepare Leo on Chatterbox')
    }
  }

  async generateChunk(text: string, chunkIndex: number): Promise<ChatterboxGeneratedAudio> {
    const run = this.generationTail.then(
      () => this.generateChunkSerial(text, chunkIndex),
      () => this.generateChunkSerial(text, chunkIndex),
    )
    this.generationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async generateChunkSerial(text: string, chunkIndex: number): Promise<ChatterboxGeneratedAudio> {
    if (!this.isReady) await this.initialize()

    const normalized = text.replace(/\s+/g, ' ').trim()
    if (!normalized) throw new Error('Cannot synthesize empty text')
    if (normalized.length > MAX_CHUNK_CHARS) {
      throw new Error(`Chatterbox chunk exceeds ${MAX_CHUNK_CHARS} characters`)
    }

    const epoch = this.cancelEpoch
    const requestId = `chatterbox_${++this.requestCounter}_${Date.now()}`
    const clientId = getClientId()

    try {
      this.onProgressCallback?.('Generating with Chatterbox…')
      let result = await this.postJson<GenerateResponse>(
        '/generate',
        { clientId, text: normalized },
        GENERATE_TIMEOUT_MS,
      )

      if (result.status === 'needs_voice') {
        await this.prepareLeo(clientId)
        if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
        result = await this.postJson<GenerateResponse>(
          '/generate',
          { clientId, text: normalized },
          GENERATE_TIMEOUT_MS,
        )
      }

      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
      if (result.status !== 'ok' || !result.audio_b64) {
        throw new Error(result.error || 'Chatterbox returned no audio')
      }

      const audio: ChatterboxGeneratedAudio = {
        requestId,
        blob: base64ToBlob(result.audio_b64, result.mime || 'audio/wav'),
        duration: typeof result.duration === 'number' && result.duration > 0 ? result.duration : 0,
        chunkIndex,
        text,
      }
      this.onAudioCallback?.(audio)
      return audio
    } catch (error) {
      if (epoch !== this.cancelEpoch) {
        throw new DOMException('Generation cancelled', 'AbortError')
      }
      const message = error instanceof Error ? error.message : String(error)
      this.onErrorCallback?.(message, requestId)
      log.error('Chatterbox generation failed', { requestId, message })
      throw error
    }
  }

  splitIntoChunks(text: string): string[] {
    return splitTextIntoChunks(
      text,
      Math.min(this.config.maxChunkChars || MAX_CHUNK_CHARS, MAX_CHUNK_CHARS),
    )
  }

  cancelAll(): void {
    this.cancelEpoch++
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
  }

  destroy(): void {
    this.cancelAll()
    this.isReady = false
    this.isLoading = false
    this.generationTail = Promise.resolve()
  }

  getIsReady(): boolean { return this.isReady }
  getIsLoading(): boolean { return this.isLoading }
  onAudio(callback: AudioCallback): void { this.onAudioCallback = callback }
  onProgress(callback: ProgressCallback): void { this.onProgressCallback = callback }
  onError(callback: ErrorCallback): void { this.onErrorCallback = callback }
  onReady(callback: ReadyCallback): void { this.onReadyCallback = callback }
}

export const chatterboxService = new ChatterboxService()
export const CHATTERBOX_VOICE_NAME = 'Leo'
export const CHATTERBOX_VOICE_ID = 'chatterbox:leo'
