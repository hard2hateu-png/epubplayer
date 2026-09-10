/**
 * Pocket TTS — native/server-backed Leo voice.
 *
 * The iPhone remains a lightweight playback client. The official Kyutai
 * pocket-tts model and Leo voice state stay resident on the private server,
 * while this adapter preserves the same blob/caching interface used by the
 * stable player.
 */
import { createLogger } from '@/services/logging'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { splitTextIntoChunks } from './textChunking'

const log = createLogger('tts')
const MAX_CHUNK_CHARS = 220
const REQUEST_TIMEOUT_MS = 30_000

export interface PocketConfig { maxChunkChars: number }
export interface PocketGeneratedAudio {
  requestId: string
  blob: Blob
  duration: number
  chunkIndex: number
  text: string
}

export interface PocketServerStatus {
  configured: boolean
  reachable: boolean
  modelReady: boolean
  voiceInstalled: boolean
  sampleRate: number
  quantized?: boolean
  language?: string
}

type AudioCallback = (audio: PocketGeneratedAudio) => void
type ProgressCallback = (status: string, progress?: number) => void
type ErrorCallback = (error: string, requestId?: string) => void
type ReadyCallback = () => void

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function getServerBase(): string {
  const configured = String(import.meta.env.VITE_POCKET_NATIVE_URL || '').trim()
  return configured.replace(/\/+$/, '')
}

function getAccessToken(): string {
  return String(import.meta.env.VITE_POCKET_API_KEY || '').trim()
}

function errorMessageFromResponse(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body && typeof body.detail === 'string') {
    return body.detail
  }
  return `Pocket server returned ${status}`
}

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.clone().json() as unknown
    return new Error(errorMessageFromResponse(response.status, body))
  } catch {
    const text = await response.text().catch(() => '')
    return new Error(text || `Pocket server returned ${response.status}`)
  }
}

function parseWavDuration(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < 44) return null
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const fourCC = (offset: number) => String.fromCharCode(
    bytes[offset] || 0, bytes[offset + 1] || 0, bytes[offset + 2] || 0, bytes[offset + 3] || 0
  )
  if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WAVE') return null

  let sampleRate = 0
  let byteRate = 0
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const id = fourCC(offset)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (id === 'fmt ' && size >= 16 && start + 16 <= buffer.byteLength) {
      sampleRate = view.getUint32(start + 4, true)
      byteRate = view.getUint32(start + 8, true)
    } else if (id === 'data') {
      dataBytes = Math.min(size, Math.max(0, buffer.byteLength - start))
      break
    }
    offset = start + size + (size % 2)
  }

  if (byteRate > 0 && dataBytes > 0) return dataBytes / byteRate
  if (sampleRate > 0 && dataBytes > 0) return dataBytes / (sampleRate * 2)
  return null
}

class PocketService {
  private isReady = false
  private isLoading = false
  private initPromise: Promise<void> | null = null
  private config: PocketConfig | null = null
  private requestCounter = 0
  private cancelEpoch = 0
  private generationTail: Promise<void> = Promise.resolve()
  private activeControllers = new Set<AbortController>()
  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  private requireServerBase(): string {
    const base = getServerBase()
    if (!base) {
      throw new Error('Native Pocket server is not configured for this build.')
    }
    return base
  }

  private async fetchApi(
    path: string,
    init: RequestInit = {},
    timeoutMs: number | null = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const base = this.requireServerBase()
    const controller = new AbortController()
    this.activeControllers.add(controller)
    const token = getAccessToken()
    const headers = new Headers(init.headers)
    if (token) headers.set('Authorization', `Bearer ${token}`)

    let timeout: ReturnType<typeof setTimeout> | null = null
    if (timeoutMs != null && timeoutMs > 0) {
      timeout = setTimeout(() => controller.abort(new DOMException('Pocket server timed out', 'TimeoutError')), timeoutMs)
    }

    try {
      return await fetch(`${base}${path}`, { ...init, headers, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof DOMException && reason.name === 'TimeoutError') throw reason
        throw new DOMException('Pocket request cancelled', 'AbortError')
      }
      throw new Error(`Could not reach the Pocket server: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (timeout) clearTimeout(timeout)
      this.activeControllers.delete(controller)
    }
  }

  async getServerStatus(): Promise<PocketServerStatus> {
    const configured = Boolean(getServerBase())
    if (!configured) {
      return { configured: false, reachable: false, modelReady: false, voiceInstalled: false, sampleRate: 24000 }
    }
    try {
      const response = await this.fetchApi('/health', {}, 8_000)
      if (!response.ok) throw await responseError(response)
      const result = await response.json() as {
        modelReady?: boolean
        voiceInstalled?: boolean
        sampleRate?: number
        quantized?: boolean
        language?: string
      }
      return {
        configured: true,
        reachable: true,
        modelReady: Boolean(result.modelReady),
        voiceInstalled: Boolean(result.voiceInstalled),
        sampleRate: Number(result.sampleRate) || 24000,
        quantized: result.quantized,
        language: result.language,
      }
    } catch (error) {
      log.warn('Native Pocket status check failed', { error })
      return { configured: true, reachable: false, modelReady: false, voiceInstalled: false, sampleRate: 24000 }
    }
  }

  async hasLeoVoiceSample(): Promise<boolean> {
    const status = await this.getServerStatus()
    return status.reachable && status.voiceInstalled
  }

  async hasCustomLeoVoiceSample(): Promise<boolean> { return this.hasLeoVoiceSample() }

  async installLeoVoiceSample(blob: Blob): Promise<void> {
    if (!blob?.size) throw new Error('Leo voice sample is empty')
    if (blob.size > 30 * 1024 * 1024) throw new Error('Voice sample is too large')

    this.destroy()
    this.onProgressCallback?.('Uploading Leo to the private Pocket server…', 10)
    const form = new FormData()
    const fileName = blob instanceof File && blob.name ? blob.name : 'leo-reference.wav'
    form.append('reference', blob, fileName)

    // Voice encoding is intentionally allowed to take longer than ordinary
    // narration. It runs once and the resulting safetensors state is reused.
    const response = await this.fetchApi('/voice/install', { method: 'POST', body: form }, null)
    if (!response.ok) throw await responseError(response)
    this.onProgressCallback?.('Leo voice prepared on the Pocket server', 100)
  }

  async removeLeoVoiceSample(): Promise<void> {
    this.destroy()
    const response = await this.fetchApi('/voice', { method: 'DELETE' }, 15_000)
    if (!response.ok) throw await responseError(response)
  }

  async initialize(): Promise<void> {
    if (this.isReady) return
    if (this.isLoading && this.initPromise) return this.initPromise
    this.isLoading = true
    this.initPromise = this.doInitialize()
    try { await this.initPromise } finally { this.initPromise = null }
  }

  private async doInitialize(): Promise<void> {
    try {
      const maxChunkChars = await settingsRepository.get('maxChunkChars')
      const deviceMaxChunkChars = isIOSDevice() ? 150 : MAX_CHUNK_CHARS
      this.config = { maxChunkChars: Math.min(deviceMaxChunkChars, Math.max(120, maxChunkChars)) }
      this.onProgressCallback?.('Connecting to native Pocket TTS…', 20)

      const status = await this.getServerStatus()
      if (!status.configured) throw new Error('Native Pocket server is not configured for this build.')
      if (!status.reachable) throw new Error('Native Pocket server is unavailable. Check your connection and try again.')
      if (!status.modelReady) throw new Error('Native Pocket model is still starting. Try again shortly.')
      if (!status.voiceInstalled) throw new Error('Leo is not installed on the Pocket server. Open Settings → Voice → Leo.')

      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Pocket TTS ready', 100)
      this.onReadyCallback?.()
    } catch (error) {
      this.isReady = false
      this.isLoading = false
      const message = error instanceof Error ? error.message : String(error)
      this.onErrorCallback?.(message)
      log.error('Native Pocket TTS initialization failed', error)
      throw error
    }
  }

  async generateChunk(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    // Preserve stable Pocket ordering. The native model is also documented as
    // non-thread-safe, so foreground playback and buffer-ahead requests share
    // one reliable queue instead of racing a single model state.
    const run = this.generationTail.then(
      () => this.generateChunkSerial(text, chunkIndex),
      () => this.generateChunkSerial(text, chunkIndex),
    )
    this.generationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async generateChunkSerial(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    await this.initialize()
    const epoch = this.cancelEpoch
    const requestId = `pocket_native_${++this.requestCounter}_${Date.now()}`

    try {
      const response = await this.fetchApi('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }, 45_000)
      if (!response.ok) throw await responseError(response)
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')

      const buffer = await response.arrayBuffer()
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
      if (!buffer.byteLength) throw new Error('Pocket server returned empty audio')

      const blob = new Blob([buffer], { type: response.headers.get('Content-Type') || 'audio/wav' })
      const headerDuration = Number(response.headers.get('X-Audio-Duration'))
      const parsedDuration = parseWavDuration(buffer)
      const duration = Number.isFinite(headerDuration) && headerDuration > 0
        ? headerDuration
        : parsedDuration || 0
      if (duration <= 0) throw new Error('Pocket server returned audio with an invalid duration')

      const result: PocketGeneratedAudio = { requestId, blob, duration, chunkIndex, text }
      log.debug('Native Pocket generated audio', {
        requestId,
        duration,
        generationMs: response.headers.get('X-Pocket-Generation-Ms'),
      })
      this.onAudioCallback?.(result)
      return result
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.onErrorCallback?.(error instanceof Error ? error.message : String(error), requestId)
      }
      throw error
    }
  }

  splitIntoChunks(text: string): string[] {
    // Deliberately retain the stable Pocket chunking/highlight contract for the
    // first native audition. Change synthesis location, not playback semantics.
    return splitTextIntoChunks(text, Math.min(this.config?.maxChunkChars || MAX_CHUNK_CHARS, MAX_CHUNK_CHARS))
  }

  cancelAll(): void {
    this.cancelEpoch++
    for (const controller of this.activeControllers) controller.abort()
    this.activeControllers.clear()
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

export const pocketService = new PocketService()
export const POCKET_VOICE_NAME = 'Leo'
export const POCKET_VOICE_ID = 'pocket:leo'

export { parseWavDuration }
