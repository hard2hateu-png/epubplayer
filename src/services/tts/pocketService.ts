/**
 * Pocket TTS — experimental JAX-JS on-device Leo runtime.
 *
 * This branch keeps the stable Pocket service contract used by the reader but
 * swaps ONNX Runtime Web for JAX-JS. All model inference and voice encoding run
 * in a dedicated Web Worker; no narration text or Leo audio is sent to a server.
 */
import { createLogger } from '@/services/logging'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { splitTextIntoChunks } from './textChunking'

const log = createLogger('tts')
const VOICE_CACHE = 'epub-player-pocket-voices-v2'
const REFERENCE_PATH = '/__epubplayer/pocket/voices/leo-reference-v2'
const JAX_EMBEDDING_PATH = '/__epubplayer/pocket/voices/leo-jax-embedding-v1-10s'
const JAX_EMBEDDING_MAGIC = 'LEOJAX01'
const SAMPLE_RATE = 24_000
const REFERENCE_SECONDS = 42.65
const CONDITIONING_SECONDS = 10
const MAX_CHUNK_CHARS = 220

type Backend = 'webgpu' | 'wasm'
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type VoiceEmbedding = { data: Float32Array; shape: number[] }
type RuntimeInfo = { backend: Backend; sampleRate: number }
type GenerateResult = { pcm: Float32Array; sampleRate: number; rtfx: number }

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

function localUrl(path: string): string {
  if (typeof window === 'undefined') return `https://local.invalid${path}`
  return new URL(path, window.location.origin).toString()
}

class JaxPocketRuntime {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private statusCallback?: ProgressCallback
  info: RuntimeInfo | null = null

  async initialize(
    mode: 'clone' | 'synthesis',
    onProgress?: ProgressCallback,
  ): Promise<RuntimeInfo> {
    this.statusCallback = onProgress
    this.worker = new Worker(
      new URL('./jaxPocket/worker.ts', import.meta.url),
      { type: 'module', name: `pocket-jax-${mode}` },
    )
    this.worker.onmessage = (event) => this.handleMessage(event.data)
    this.worker.onerror = (event) => {
      this.rejectAll(new Error(event.message || 'JAX Pocket worker crashed'))
    }

    this.info = await this.request('init', { mode }) as RuntimeInfo
    return this.info
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message.type === 'status') {
      this.statusCallback?.(
        typeof message.status === 'string' ? message.status : 'Loading Pocket TTS…',
        typeof message.progress === 'number' ? message.progress : undefined,
      )
      return
    }

    const id = typeof message.id === 'number' ? message.id : null
    if (id == null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)

    if (message.type === 'result') pending.resolve(message.result)
    else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'JAX Pocket error'))
  }

  private request(
    type: string,
    payload: Record<string, unknown> = {},
    transfer: Transferable[] = [],
  ): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error('JAX Pocket worker is not initialized'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.worker!.postMessage({ id, type, payload }, transfer)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async cloneVoice(audio: Float32Array): Promise<VoiceEmbedding> {
    const copy = audio.slice()
    const result = await this.request(
      'cloneVoice',
      { audio: copy },
      [copy.buffer],
    ) as { data?: Float32Array; shape?: number[] }
    if (!(result.data instanceof Float32Array) || !Array.isArray(result.shape)) {
      throw new Error('JAX Pocket did not return Leo voice data')
    }
    return { data: result.data, shape: result.shape.map(Number) }
  }

  async loadVoice(embedding: VoiceEmbedding): Promise<void> {
    const copy = embedding.data.slice()
    await this.request(
      'loadVoice',
      { data: copy, shape: [...embedding.shape] },
      [copy.buffer],
    )
  }

  async generate(text: string): Promise<GenerateResult> {
    const result = await this.request('generate', { text }) as GenerateResult
    if (!(result.pcm instanceof Float32Array) || !result.pcm.length) {
      throw new Error('JAX Pocket returned no audio')
    }
    return result
  }

  async cancel(): Promise<void> {
    try {
      await this.request('cancel')
    } catch {
      // Best effort. Termination below remains the hard cancellation path.
    }
  }

  destroy(): void {
    this.rejectAll(new DOMException('JAX Pocket worker destroyed', 'AbortError') as unknown as Error)
    this.worker?.terminate()
    this.worker = null
    this.info = null
    this.statusCallback = undefined
  }

  private rejectAll(error: Error): void {
    this.pending.forEach(({ reject }) => reject(error))
    this.pending.clear()
  }
}

function resample(data: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return data.slice()
  const ratio = sourceRate / targetRate
  const output = new Float32Array(Math.max(1, Math.floor(data.length / ratio)))
  for (let i = 0; i < output.length; i++) {
    const position = i * ratio
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, data.length - 1)
    const fraction = position - lower
    output[i] = data[lower] * (1 - fraction) + data[upper] * fraction
  }
  return output
}

function normalizeReference(input: Float32Array, sampleRate: number): Float32Array {
  const limit = Math.min(input.length, Math.floor(sampleRate * REFERENCE_SECONDS))
  const output = input.slice(0, limit)
  if (!output.length) return output

  let mean = 0
  for (const sample of output) mean += sample
  mean /= output.length

  let peak = 0
  for (let i = 0; i < output.length; i++) {
    output[i] -= mean
    peak = Math.max(peak, Math.abs(output[i]))
  }
  if (peak > 0.05) {
    const gain = Math.min(4, 0.7 / peak)
    for (let i = 0; i < output.length; i++) output[i] *= gain
  }
  return output
}

function selectRepresentativeWindow(
  input: Float32Array,
  sampleRate: number,
  seconds: number,
): Float32Array {
  const windowSamples = Math.min(input.length, Math.max(1, Math.floor(sampleRate * seconds)))
  if (input.length <= windowSamples) return input.slice()

  // Use one continuous speech-dense window. JAX-JS's Pocket implementation was
  // developed around ~10 seconds of audio preconditioning; no averaging/splicing.
  const blockSamples = Math.max(1, Math.floor(sampleRate * 0.25))
  const blockCount = Math.ceil(input.length / blockSamples)
  const energies = new Float64Array(blockCount)
  for (let block = 0; block < blockCount; block++) {
    const start = block * blockSamples
    const end = Math.min(input.length, start + blockSamples)
    let sumSquares = 0
    for (let i = start; i < end; i++) sumSquares += input[i] * input[i]
    energies[block] = sumSquares / Math.max(1, end - start)
  }

  const windowBlocks = Math.max(1, Math.ceil(windowSamples / blockSamples))
  let running = 0
  for (let i = 0; i < windowBlocks; i++) running += energies[i] || 0
  let bestScore = running
  let bestBlock = 0
  for (let block = 1; block + windowBlocks <= blockCount; block++) {
    running += energies[block + windowBlocks - 1] - energies[block - 1]
    if (running > bestScore) {
      bestScore = running
      bestBlock = block
    }
  }

  const start = Math.min(bestBlock * blockSamples, input.length - windowSamples)
  return input.slice(start, start + windowSamples)
}

async function decodeReference(blob: Blob, targetRate: number): Promise<Float32Array> {
  const Ctor = window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) throw new Error('Web Audio is unavailable on this device')

  const context = new Ctor()
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer())
    const mono = new Float32Array(buffer.length)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const source = buffer.getChannelData(channel)
      for (let i = 0; i < source.length; i++) mono[i] += source[i] / buffer.numberOfChannels
    }
    return normalizeReference(resample(mono, buffer.sampleRate, targetRate), targetRate)
  } finally {
    await context.close().catch(() => {})
  }
}

function serializeEmbedding(embedding: VoiceEmbedding): ArrayBuffer {
  const shape = embedding.shape.map((value) => Math.max(0, Math.trunc(value)))
  const headerBytes = 16 + shape.length * 4
  const buffer = new ArrayBuffer(headerBytes + embedding.data.byteLength)
  const view = new DataView(buffer)
  for (let i = 0; i < JAX_EMBEDDING_MAGIC.length; i++) {
    view.setUint8(i, JAX_EMBEDDING_MAGIC.charCodeAt(i))
  }
  view.setUint32(8, shape.length, true)
  view.setUint32(12, embedding.data.length, true)
  shape.forEach((value, index) => view.setUint32(16 + index * 4, value, true))
  new Uint8Array(buffer, headerBytes).set(
    new Uint8Array(
      embedding.data.buffer,
      embedding.data.byteOffset,
      embedding.data.byteLength,
    ),
  )
  return buffer
}

function deserializeEmbedding(buffer: ArrayBuffer): VoiceEmbedding {
  if (buffer.byteLength < 20) throw new Error('Saved Leo JAX voice data is incomplete')
  const view = new DataView(buffer)
  let magic = ''
  for (let i = 0; i < JAX_EMBEDDING_MAGIC.length; i++) {
    magic += String.fromCharCode(view.getUint8(i))
  }
  if (magic !== JAX_EMBEDDING_MAGIC) throw new Error('Saved Leo JAX voice data uses an old format')

  const dimensions = view.getUint32(8, true)
  const length = view.getUint32(12, true)
  if (dimensions !== 2 || length < 1) throw new Error('Saved Leo JAX voice metadata is invalid')
  const headerBytes = 16 + dimensions * 4
  if (buffer.byteLength !== headerBytes + length * 4) {
    throw new Error('Saved Leo JAX voice length is invalid')
  }

  const shape = Array.from(
    { length: dimensions },
    (_, index) => view.getUint32(16 + index * 4, true),
  )
  if (shape[1] !== 1024 || shape[0] * shape[1] !== length) {
    throw new Error('Saved Leo JAX voice shape is invalid')
  }

  const data = new Float32Array(length)
  new Uint8Array(data.buffer).set(new Uint8Array(buffer, headerBytes))
  return { data, shape }
}

function pcmToWav(pcm: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.length * 2, true)

  let offset = 44
  for (const value of pcm) {
    const sample = Math.max(-1, Math.min(1, value))
    view.setInt16(
      offset,
      sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff),
      true,
    )
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

class PocketService {
  private runtime: JaxPocketRuntime | null = null
  private isReady = false
  private isLoading = false
  private initPromise: Promise<void> | null = null
  private config: PocketConfig | null = null
  private requestCounter = 0
  private cancelEpoch = 0
  private generationTail: Promise<void> = Promise.resolve()
  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  async hasLeoVoiceSample(): Promise<boolean> {
    try {
      await this.getReference()
      return true
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
    if (typeof caches === 'undefined') throw new Error('Cache Storage is unavailable on this device')

    const cache = await caches.open(VOICE_CACHE)
    await cache.put(
      localUrl(REFERENCE_PATH),
      new Response(blob, {
        headers: {
          'Content-Type': blob.type || 'audio/wav',
          'X-Voice-Name': 'Leo',
        },
      }),
    )
    await cache.delete(localUrl(JAX_EMBEDDING_PATH))
    this.destroy()
  }

  async removeLeoVoiceSample(): Promise<void> {
    this.destroy()
    if (typeof caches === 'undefined') return
    const cache = await caches.open(VOICE_CACHE)
    await Promise.all([
      cache.delete(localUrl(REFERENCE_PATH)),
      cache.delete(localUrl(JAX_EMBEDDING_PATH)),
    ])
  }

  private async getReference(): Promise<Blob> {
    if (typeof caches === 'undefined') {
      throw new Error('Cache Storage is unavailable on this device')
    }
    const cache = await caches.open(VOICE_CACHE)
    const response = await cache.match(localUrl(REFERENCE_PATH))
    if (!response) {
      throw new Error(
        'Leo reference is not installed. Open Settings → Pocket TTS — Leo and select the voice clip.',
      )
    }
    const blob = await response.blob()
    if (!blob.size) throw new Error('Saved Leo reference is empty')
    return blob
  }

  private async getEmbedding(): Promise<VoiceEmbedding | null> {
    if (typeof caches === 'undefined') return null
    try {
      const cache = await caches.open(VOICE_CACHE)
      const response = await cache.match(localUrl(JAX_EMBEDDING_PATH))
      return response ? deserializeEmbedding(await response.arrayBuffer()) : null
    } catch (error) {
      log.warn('Discarding invalid saved JAX Leo data', { error })
      await this.deleteEmbedding()
      return null
    }
  }

  private async saveEmbedding(embedding: VoiceEmbedding): Promise<void> {
    if (typeof caches === 'undefined') return
    const cache = await caches.open(VOICE_CACHE)
    await cache.put(
      localUrl(JAX_EMBEDDING_PATH),
      new Response(serializeEmbedding(embedding), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Voice-Format': JAX_EMBEDDING_MAGIC,
        },
      }),
    )
    try {
      await navigator.storage?.persist?.()
    } catch {
      // Persistence is optional.
    }
  }

  private async deleteEmbedding(): Promise<void> {
    if (typeof caches === 'undefined') return
    const cache = await caches.open(VOICE_CACHE)
    await cache.delete(localUrl(JAX_EMBEDDING_PATH))
  }

  async initialize(): Promise<void> {
    if (this.isReady && this.runtime) return
    if (this.isLoading && this.initPromise) return this.initPromise

    this.isLoading = true
    this.initPromise = this.doInitialize()
    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async createRuntime(
    mode: 'clone' | 'synthesis',
  ): Promise<JaxPocketRuntime> {
    const runtime = new JaxPocketRuntime()
    const info = await runtime.initialize(
      mode,
      (status, progress) => this.onProgressCallback?.(status, progress),
    )
    log.info('JAX Pocket runtime initialized', { mode, backend: info.backend })
    return runtime
  }

  private async doInitialize(): Promise<void> {
    let narrationRuntime: JaxPocketRuntime | null = null
    let cloneRuntime: JaxPocketRuntime | null = null

    try {
      const configuredMax = Number(await settingsRepository.get('maxChunkChars'))
      const deviceMax = isIOSDevice() ? 150 : MAX_CHUNK_CHARS
      const requested = Number.isFinite(configuredMax) ? configuredMax : deviceMax
      this.config = {
        maxChunkChars: Math.min(deviceMax, Math.max(120, requested)),
      }

      let embedding = await this.getEmbedding()
      if (!embedding) {
        const reference = await this.getReference()
        const pcm = await decodeReference(reference, SAMPLE_RATE)
        if (pcm.length < SAMPLE_RATE) throw new Error('Leo voice sample is too short')
        const conditioning = selectRepresentativeWindow(
          pcm,
          SAMPLE_RATE,
          CONDITIONING_SECONDS,
        )

        this.onProgressCallback?.(
          'Preparing Leo locally from one continuous 10-second reference…',
          1,
        )
        cloneRuntime = await this.createRuntime('clone')
        embedding = await cloneRuntime.cloneVoice(conditioning)
        await this.saveEmbedding(embedding)
        cloneRuntime.destroy()
        cloneRuntime = null

        // Use a fresh worker for narration. This deliberately drops all cloning
        // intermediates before the long-lived audiobook synthesis runtime loads.
        this.onProgressCallback?.('Reloading Pocket for audiobook playback…', 1)
      }

      narrationRuntime = await this.createRuntime('synthesis')
      this.onProgressCallback?.('Loading saved Leo voice…', 99)
      await narrationRuntime.loadVoice(embedding)

      this.runtime = narrationRuntime
      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Pocket TTS ready', 100)
      this.onReadyCallback?.()
    } catch (error) {
      cloneRuntime?.destroy()
      narrationRuntime?.destroy()
      this.runtime = null
      this.isReady = false
      this.isLoading = false
      const message = error instanceof Error ? error.message : String(error)
      this.onErrorCallback?.(message)
      log.error('JAX Pocket initialization failed', error)
      throw error
    }
  }

  async generateChunk(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    // Keep the stable single-generation contract. The existing buffer manager can
    // queue ahead, but JAX Pocket itself receives one generation at a time.
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
    const runtime = this.runtime
    if (!runtime || !this.isReady) throw new Error('JAX Pocket is not initialized')

    const epoch = this.cancelEpoch
    const requestId = `pocket_jax_${++this.requestCounter}_${Date.now()}`
    try {
      const generated = await runtime.generate(text)
      if (epoch !== this.cancelEpoch) {
        throw new DOMException('Pocket generation cancelled', 'AbortError')
      }

      const sampleRate = generated.sampleRate || SAMPLE_RATE
      const duration = generated.pcm.length / sampleRate
      const result: PocketGeneratedAudio = {
        requestId,
        blob: pcmToWav(generated.pcm, sampleRate),
        duration,
        chunkIndex,
        text,
      }
      log.debug('JAX Pocket generated audio', {
        requestId,
        rtfx: generated.rtfx,
        duration,
      })
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
    const maxChars = Math.min(
      this.config?.maxChunkChars || (isIOSDevice() ? 150 : MAX_CHUNK_CHARS),
      MAX_CHUNK_CHARS,
    )
    return splitTextIntoChunks(text, maxChars)
  }

  cancelAll(): void {
    this.cancelEpoch++
    void this.runtime?.cancel()
  }

  destroy(): void {
    this.cancelEpoch++
    this.runtime?.destroy()
    this.runtime = null
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
