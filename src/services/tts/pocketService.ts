/**
 * Pocket TTS — native/server-backed Leo voice.
 *
 * Clean experiment: this is the only frontend file changed from the stable
 * reader. Home, Settings UI, PDF handling, playback, buffering, highlighting,
 * PWA/service-worker setup, and every non-Pocket engine remain untouched.
 */
import { createLogger } from '@/services/logging'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { splitTextIntoChunks } from './textChunking'

const log = createLogger('tts')
const SERVER_BASE = 'https://pocket-native-production.up.railway.app'
const MAX_CHUNK_CHARS = 220
const REQUEST_TIMEOUT_MS = 45_000

export interface PocketConfig {
  maxChunkChars: number
}

export interface PocketGeneratedAudio {
  requestId: string
  blob: Blob
  duration: number
  chunkIndex: number
  text: string
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

async function responseError(response: Response): Promise<Error> {
  try {
    const body = await response.clone().json() as { detail?: unknown }
    if (typeof body.detail === 'string') return new Error(body.detail)
  } catch {
    // Fall through to text/status below.
  }
  const text = await response.text().catch(() => '')
  return new Error(text || `Pocket server returned ${response.status}`)
}

function parseWavDuration(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < 44) return null
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const fourCC = (offset: number) => String.fromCharCode(
    bytes[offset] || 0,
    bytes[offset + 1] || 0,
    bytes[offset + 2] || 0,
    bytes[offset + 3] || 0,
  )

  if (fourCC(0) !== 'RIFF' || fourCC(8) !== 'WAVE') return null

  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const id = fourCC(offset)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8

    if (id === 'fmt ' && size >= 16 && start + 16 <= buffer.byteLength) {
      // Keep scanning until the data chunk so we can use the byte rate.
      const byteRate = view.getUint32(start + 8, true)
      let next = start + size + (size % 2)
      while (next + 8 <= buffer.byteLength) {
        const nextId = fourCC(next)
        const nextSize = view.getUint32(next + 4, true)
        const nextStart = next + 8
        if (nextId === 'data') {
          const dataBytes = Math.min(nextSize, Math.max(0, buffer.byteLength - nextStart))
          return byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : null
        }
        next = nextStart + nextSize + (nextSize % 2)
      }
      return null
    }

    offset = start + size + (size % 2)
  }

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

  private async fetchApi(
    path: string,
    init: RequestInit = {},
    timeoutMs: number | null = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController()
    this.activeControllers.add(controller)

    let timeout: ReturnType<typeof setTimeout> | null = null
    if (timeoutMs != null && timeoutMs > 0) {
      timeout = setTimeout(
        () => controller.abort(new DOMException('Pocket server timed out', 'TimeoutError')),
        timeoutMs,
      )
    }

    try {
      return await fetch(`${SERVER_BASE}${path}`, { ...init, signal: controller.signal })
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof DOMException && reason.name === 'TimeoutError') throw reason
        throw new DOMException('Pocket request cancelled', 'AbortError')
      }
      throw new Error(
        `Could not reach the Pocket server: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      if (timeout) clearTimeout(timeout)
      this.activeControllers.delete(controller)
    }
  }

  async hasLeoVoiceSample(): Promise<boolean> {
    try {
      const response = await this.fetchApi('/health', {}, 8_000)
      if (!response.ok) return false
      const status = await response.json() as { modelReady?: boolean; voiceInstalled?: boolean }
      return Boolean(status.modelReady && status.voiceInstalled)
    } catch {
      return false
    }
  }

  async hasCustomLeoVoiceSample(): Promise<boolean> {
    return this.hasLeoVoiceSample()
  }

  async installLeoVoiceSample(blob: Blob): Promise<void> {
    if (!blob?.size) throw new Error('Leo voice sample is empty')
    if (blob.size > 30 * 1024 * 1024) throw new Error('Voice sample is too large')

    this.destroy()
    this.onProgressCallback?.('Uploading Leo and preparing the native Pocket voice…', 10)

    const form = new FormData()
    const fileName = blob instanceof File && blob.name ? blob.name : 'leo-reference.wav'
    form.append('reference', blob, fileName)

    // Voice preparation can take longer than ordinary narration, but happens
    // only once per server lifetime.
    const response = await this.fetchApi('/voice/install', { method: 'POST', body: form }, null)
    if (!response.ok) throw await responseError(response)

    this.onProgressCallback?.('Leo voice prepared', 100)
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
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async doInitialize(): Promise<void> {
    try {
      const configuredMax = Number(await settingsRepository.get('maxChunkChars'))
      const deviceMax = isIOSDevice() ? 150 : MAX_CHUNK_CHARS
      const requested = Number.isFinite(configuredMax) ? configuredMax : deviceMax
      this.config = {
        maxChunkChars: Math.min(deviceMax, Math.max(120, requested)),
      }

      this.onProgressCallback?.('Connecting to Pocket TTS…', 20)
      const response = await this.fetchApi('/health', {}, 8_000)
      if (!response.ok) throw await responseError(response)

      const status = await response.json() as {
        modelReady?: boolean
        voiceInstalled?: boolean
      }

      if (!status.modelReady) throw new Error('Pocket TTS is still starting. Try again shortly.')
      if (!status.voiceInstalled) {
        throw new Error('Install the Leo reference before using Pocket TTS.')
      }

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
    // Keep exactly one Pocket generation in flight. The player can still queue
    // its usual buffer-ahead requests; they resolve in order without racing the
    // native model's voice state.
    const run = this.generationTail.then(
      () => this.generateChunkSerial(text, chunkIndex),
      () => this.generateChunkSerial(text, chunkIndex),
    )
    this.generationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async generateChunkSerial(
    text: string,
    chunkIndex: number,
  ): Promise<PocketGeneratedAudio> {
    await this.initialize()

    const epoch = this.cancelEpoch
    const requestId = `pocket_native_${++this.requestCounter}_${Date.now()}`

    try {
      const response = await this.fetchApi('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })

      if (!response.ok) throw await responseError(response)
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')

      const buffer = await response.arrayBuffer()
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
      if (!buffer.byteLength) throw new Error('Pocket server returned empty audio')

      const headerDuration = Number(response.headers.get('X-Audio-Duration'))
      const duration = Number.isFinite(headerDuration) && headerDuration > 0
        ? headerDuration
        : parseWavDuration(buffer) || 0

      if (duration <= 0) throw new Error('Pocket server returned audio with an invalid duration')

      const result: PocketGeneratedAudio = {
        requestId,
        blob: new Blob([buffer], { type: 'audio/wav' }),
        duration,
        chunkIndex,
        text,
      }

      this.onAudioCallback?.(result)
      return result
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.onErrorCallback?.(
          error instanceof Error ? error.message : String(error),
          requestId,
        )
      }
      throw error
    }
  }

  splitIntoChunks(text: string): string[] {
    // Preserve the stable Pocket chunk-size contract, including the 150-char
    // iPhone ceiling. This experiment changes synthesis location only.
    const maxChars = Math.min(
      this.config?.maxChunkChars || (isIOSDevice() ? 150 : MAX_CHUNK_CHARS),
      MAX_CHUNK_CHARS,
    )
    return splitTextIntoChunks(text, maxChars)
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

  getIsReady(): boolean {
    return this.isReady
  }

  getIsLoading(): boolean {
    return this.isLoading
  }

  onAudio(callback: AudioCallback): void {
    this.onAudioCallback = callback
  }

  onProgress(callback: ProgressCallback): void {
    this.onProgressCallback = callback
  }

  onError(callback: ErrorCallback): void {
    this.onErrorCallback = callback
  }

  onReady(callback: ReadyCallback): void {
    this.onReadyCallback = callback
  }
}

export const pocketService = new PocketService()
export const POCKET_VOICE_NAME = 'Leo'
export const POCKET_VOICE_ID = 'pocket:leo'
