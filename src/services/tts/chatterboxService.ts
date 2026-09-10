/**
 * Chatterbox adapter for the EPUB reader.
 *
 * The model runs remotely; the iPhone keeps Leo's source recording private in
 * Cache Storage. A short prompt is uploaded only when a backend session needs
 * conditioning. Generated WAV bytes flow through the reader's existing cache.
 */
import { Client, handle_file } from '@gradio/client'
import { createLogger } from '@/services/logging'
import { splitTextIntoChunks } from './textChunking'
import { pocketService } from './pocketService'

const log = createLogger('tts')
const ENDPOINT = String(import.meta.env.VITE_CHATTERBOX_ENDPOINT || '').trim()
const API_NAME = '/synthesize'
const MAX_CHUNK_CHARS = 180
const REFERENCE_SECONDS = 10
const CONNECT_TIMEOUT_MS = 15_000
const GENERATE_TIMEOUT_MS = 90_000

type GradioClient = Awaited<ReturnType<typeof Client.connect>>

type AudioCallback = (audio: ChatterboxGeneratedAudio) => void
type ProgressCallback = (status: string, progress?: number) => void
type ErrorCallback = (error: string, requestId?: string) => void
type ReadyCallback = () => void

export interface ChatterboxGeneratedAudio {
  requestId: string
  blob: Blob
  duration: number
  chunkIndex: number
  text: string
}

export function isChatterboxConfigured(): boolean {
  return ENDPOINT.length > 0
}

function messageFor(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/timeout/i.test(raw)) return 'Chatterbox took too long to respond. Try again.'
  if (/quota|zero.?gpu|rate.?limit|exceeded/i.test(raw)) return 'The free Chatterbox host has reached its usage limit.'
  if (/503|502|504|sleep|unavailable|stopped/i.test(raw)) return 'Chatterbox is temporarily unavailable.'
  return raw || 'Chatterbox generation failed.'
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function createSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `leo-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function base64ToBlob(value: string, mime = 'audio/wav'): Blob {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

function wavDuration(buffer: ArrayBuffer): number | null {
  if (buffer.byteLength < 44) return null
  const view = new DataView(buffer)
  const tag = (offset: number, length: number) =>
    String.fromCharCode(...new Uint8Array(buffer, offset, Math.min(length, buffer.byteLength - offset)))
  if (tag(0, 4) !== 'RIFF' || tag(8, 4) !== 'WAVE') return null

  let offset = 12
  let byteRate = 0
  let dataSize = 0
  while (offset + 8 <= buffer.byteLength) {
    const id = tag(offset, 4)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && size >= 12 && body + 12 <= buffer.byteLength) {
      byteRate = view.getUint32(body + 8, true)
    } else if (id === 'data') {
      dataSize = Math.min(size, Math.max(0, buffer.byteLength - body))
      break
    }
    offset = body + size + (size % 2)
  }
  return byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null
}

function parseAudioPayload(value: unknown): Blob {
  if (!value || typeof value !== 'object') throw new Error('Chatterbox returned an invalid response.')
  const record = value as Record<string, unknown>
  const audioBase64 = typeof record.audio_base64 === 'string' ? record.audio_base64 : ''
  if (!audioBase64) throw new Error('Chatterbox returned no audio.')
  const mime = typeof record.mime === 'string' ? record.mime : 'audio/wav'
  return base64ToBlob(audioBase64, mime)
}

class ChatterboxService {
  private client: GradioClient | null = null
  private isReady = false
  private isLoading = false
  private initPromise: Promise<void> | null = null
  private sessionId = createSessionId()
  private referenceSent = false
  private requestCounter = 0
  private cancelEpoch = 0
  private generationTail: Promise<void> = Promise.resolve()
  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  async initialize(): Promise<void> {
    if (this.isReady) return
    if (this.isLoading && this.initPromise) return this.initPromise
    this.isLoading = true
    this.initPromise = this.doInitialize()
    try { await this.initPromise } finally { this.initPromise = null }
  }

  private async doInitialize(): Promise<void> {
    try {
      if (!ENDPOINT) throw new Error('Chatterbox endpoint is not configured.')
      if (!(await pocketService.hasLeoVoiceSample())) {
        throw new Error('Leo is not installed. Open Settings → Voice → Leo.')
      }
      // Deliberately do not contact the remote host here. Selecting an engine or
      // opening a book must never leave the reader waiting on a sleeping Space.
      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Chatterbox ready', 100)
      this.onReadyCallback?.()
    } catch (error) {
      this.isReady = false
      this.isLoading = false
      const message = messageFor(error)
      this.onErrorCallback?.(message)
      throw new Error(message)
    }
  }

  private async ensureClient(): Promise<GradioClient> {
    if (this.client) return this.client
    this.onProgressCallback?.('Connecting to Chatterbox...', 20)
    this.client = await withTimeout(Client.connect(ENDPOINT), CONNECT_TIMEOUT_MS, 'Chatterbox connection')
    return this.client
  }

  async generateChunk(text: string, chunkIndex: number): Promise<ChatterboxGeneratedAudio> {
    const run = this.generationTail.then(
      () => this.generateChunkSerial(text, chunkIndex),
      () => this.generateChunkSerial(text, chunkIndex),
    )
    this.generationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async predict(text: string, includeReference: boolean): Promise<unknown> {
    const client = await this.ensureClient()
    const reference = includeReference ? await pocketService.getLeoPromptWav(REFERENCE_SECONDS) : null
    return withTimeout(
      client.predict(API_NAME, [
        text,
        reference ? handle_file(reference) : null,
        this.sessionId,
      ]),
      GENERATE_TIMEOUT_MS,
      'Chatterbox generation',
    )
  }

  private async generateChunkSerial(text: string, chunkIndex: number): Promise<ChatterboxGeneratedAudio> {
    await this.initialize()
    const requestId = `chatterbox_${++this.requestCounter}_${Date.now()}`
    const epoch = this.cancelEpoch
    this.onProgressCallback?.('Generating with Chatterbox...', 45)

    try {
      let result: unknown
      try {
        result = await this.predict(text, !this.referenceSent)
        this.referenceSent = true
      } catch (firstError) {
        // A free Space can restart at any time, which clears its in-memory voice
        // conditionals. Retry exactly once with the local reference when that happens.
        const firstMessage = messageFor(firstError)
        if (!this.referenceSent || !/reference|required|session|condition/i.test(firstMessage)) throw firstError
        this.referenceSent = false
        result = await this.predict(text, true)
        this.referenceSent = true
      }

      if (epoch !== this.cancelEpoch) throw new DOMException('Aborted', 'AbortError')
      const payload = result as { data?: unknown[] }
      if (!Array.isArray(payload.data) || payload.data.length === 0) throw new Error('Chatterbox returned no audio.')
      const blob = parseAudioPayload(payload.data[0])
      if (!blob.size) throw new Error('Chatterbox returned empty audio.')
      const duration = wavDuration(await blob.arrayBuffer()) ?? Math.max(1, text.length / 13)
      const audio = { requestId, blob, duration, chunkIndex, text }
      this.onAudioCallback?.(audio)
      this.onProgressCallback?.('Chatterbox ready', 100)
      return audio
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const message = messageFor(error)
      this.onErrorCallback?.(message, requestId)
      log.error('Chatterbox generation failed', { error: message })
      throw new Error(message)
    }
  }

  splitIntoChunks(text: string): string[] {
    return splitTextIntoChunks(text, MAX_CHUNK_CHARS)
  }

  cancelAll(): void { this.cancelEpoch++ }

  destroy(): void {
    this.cancelAll()
    this.client = null
    this.isReady = false
    this.isLoading = false
    this.initPromise = null
    this.sessionId = createSessionId()
    this.referenceSent = false
  }

  getIsReady(): boolean { return this.isReady }
  getIsLoading(): boolean { return this.isLoading }
  onAudio(callback: AudioCallback): void { this.onAudioCallback = callback }
  onProgress(callback: ProgressCallback): void { this.onProgressCallback = callback }
  onError(callback: ErrorCallback): void { this.onErrorCallback = callback }
  onReady(callback: ReadyCallback): void { this.onReadyCallback = callback }
}

export const chatterboxService = new ChatterboxService()
