/** Chatterbox-Turbo — English zero-shot Leo voice cloning via ResembleAI's official Space. */
import { Client, handle_file } from '@gradio/client'
import { createLogger } from '@/services/logging'
import { splitTextIntoChunks } from './textChunking'
import { pocketService } from './pocketService'

const log = createLogger('tts')
const SPACE_ID = 'ResembleAI/chatterbox-turbo-demo'
const SPACE_ORIGIN = 'https://resembleai-chatterbox-turbo-demo.hf.space'
const DEFAULT_ENDPOINT = '/generate'
const MAX_CHUNK_CHARS = 300
const REFERENCE_SECONDS = 10

type GradioClient = Awaited<ReturnType<typeof Client.connect>>

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

function getMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/quota|zero.?gpu|gpu.*limit|exceeded|rate.?limit/i.test(raw)) {
    return 'Chatterbox free GPU limit reached. Try again later.'
  }
  if (/space.*(sleep|stopp|unavailable)|503|502|504/i.test(raw)) {
    return 'Chatterbox is temporarily unavailable. Try again in a moment.'
  }
  return raw || 'Chatterbox generation failed.'
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

function floatAudioToWav(sampleRate: number, samples: number[]): Blob {
  const pcm = Float32Array.from(samples)
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  let offset = 44
  for (const value of pcm) {
    const sample = Math.max(-1, Math.min(1, value))
    view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

async function outputToBlob(value: unknown): Promise<Blob> {
  // Gradio normally post-processes gr.Audio output into FileData with an absolute URL.
  let url: string | null = null
  if (typeof value === 'string') {
    url = value
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.url === 'string') url = record.url
  }

  if (url) {
    const response = await fetch(new URL(url, SPACE_ORIGIN).toString())
    if (!response.ok) throw new Error(`Chatterbox audio returned ${response.status}`)
    return response.blob()
  }

  // Defensive fallback if a Gradio version returns the raw (sampleRate, samples) tuple.
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number' && Array.isArray(value[1])) {
    const samples = value[1].filter((item): item is number => typeof item === 'number')
    if (samples.length) return floatAudioToWav(value[0], samples)
  }

  throw new Error('Chatterbox returned an unsupported audio format.')
}

class ChatterboxService {
  private client: GradioClient | null = null
  private endpoint = DEFAULT_ENDPOINT
  private promptWav: Blob | null = null
  private isReady = false
  private isLoading = false
  private initPromise: Promise<void> | null = null
  private requestCounter = 0
  private cancelEpoch = 0
  private generationTail: Promise<void> = Promise.resolve()
  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  async initialize(): Promise<void> {
    if (this.isReady && this.client && this.promptWav) return
    if (this.isLoading && this.initPromise) return this.initPromise
    this.isLoading = true
    this.initPromise = this.doInitialize()
    try { await this.initPromise } finally { this.initPromise = null }
  }

  private async doInitialize(): Promise<void> {
    try {
      if (!(await pocketService.hasLeoVoiceSample())) {
        throw new Error('Leo is not installed. Open Settings → Voice → Leo.')
      }

      this.onProgressCallback?.('Preparing Leo...', 10)
      this.promptWav = await pocketService.getLeoPromptWav(REFERENCE_SECONDS)

      this.onProgressCallback?.('Connecting to Chatterbox...', 30)
      this.client = await Client.connect(SPACE_ID)

      // Discover the endpoint once so a harmless Gradio endpoint rename does not break the reader.
      try {
        const api = await this.client.view_api() as unknown as { named_endpoints?: Record<string, unknown> }
        const names = Object.keys(api.named_endpoints || {})
        this.endpoint = names.includes(DEFAULT_ENDPOINT) ? DEFAULT_ENDPOINT : (names[0] || DEFAULT_ENDPOINT)
      } catch (error) {
        log.warn('Could not inspect Chatterbox API; using /generate', { error })
        this.endpoint = DEFAULT_ENDPOINT
      }

      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Chatterbox ready', 100)
      this.onReadyCallback?.()
      log.info('Chatterbox connected', { endpoint: this.endpoint })
    } catch (error) {
      this.client = null
      this.promptWav = null
      this.isReady = false
      this.isLoading = false
      const message = getMessage(error)
      this.onErrorCallback?.(message)
      log.error('Chatterbox initialization failed', error)
      throw new Error(message)
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
    await this.initialize()
    if (!this.client || !this.promptWav) throw new Error('Chatterbox is not ready.')

    const requestId = `chatterbox_${++this.requestCounter}_${Date.now()}`
    const epoch = this.cancelEpoch
    this.onProgressCallback?.('Generating with Chatterbox...', 50)

    try {
      const result = await this.client.predict(this.endpoint, [
        text,
        handle_file(this.promptWav),
        0.8,  // temperature
        42,   // deterministic seed for consistent audiobook voice
        0.0,  // min_p
        0.95, // top_p
        1000, // top_k
        1.2,  // repetition penalty
        true, // normalize loudness
      ])
      if (epoch !== this.cancelEpoch) throw new DOMException('Aborted', 'AbortError')

      const payload = result as unknown as { data?: unknown[] }
      if (!Array.isArray(payload.data) || payload.data.length === 0) {
        throw new Error('Chatterbox returned no audio.')
      }
      const blob = await outputToBlob(payload.data[0])
      if (epoch !== this.cancelEpoch) throw new DOMException('Aborted', 'AbortError')
      if (!blob.size) throw new Error('Chatterbox returned empty audio.')

      const buffer = await blob.arrayBuffer()
      const duration = wavDuration(buffer) ?? Math.max(1, text.length / 13)
      const audioBlob = blob.type ? blob : new Blob([buffer], { type: 'audio/wav' })
      const audio = { requestId, blob: audioBlob, duration, chunkIndex, text }
      this.onAudioCallback?.(audio)
      this.onProgressCallback?.('Chatterbox ready', 100)
      return audio
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const message = getMessage(error)
      this.onErrorCallback?.(message, requestId)
      throw new Error(message)
    }
  }

  splitIntoChunks(text: string): string[] {
    return splitTextIntoChunks(text, MAX_CHUNK_CHARS)
  }

  cancelAll(): void {
    this.cancelEpoch++
  }

  destroy(): void {
    this.cancelAll()
    this.client = null
    this.promptWav = null
    this.isReady = false
    this.isLoading = false
    this.initPromise = null
  }

  onAudio(callback: AudioCallback): void { this.onAudioCallback = callback }
  onProgress(callback: ProgressCallback): void { this.onProgressCallback = callback }
  onError(callback: ErrorCallback): void { this.onErrorCallback = callback }
  onReady(callback: ReadyCallback): void { this.onReadyCallback = callback }
  getIsReady(): boolean { return this.isReady }
  getIsLoading(): boolean { return this.isLoading }
}

export const chatterboxService = new ChatterboxService()
