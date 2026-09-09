/**
 * Pocket TTS Service — local custom voice (Leo)
 *
 * Browser integration for Kyutai Pocket TTS using the community ONNX browser
 * worker from vlapky/pocket-tts-js. The third-party runtime source is fetched
 * at runtime from a commit-pinned URL and executed in a same-origin Blob worker;
 * no Pocket code or private voice audio is committed to this repository.
 *
 * Leo's reference audio is stored only in this browser's Cache Storage.
 */

import { createLogger } from '@/services/logging'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { splitTextIntoChunks } from './textChunking'

const log = createLogger('tts')

const POCKET_VENDOR_COMMIT = '7d7a27423b0845eb0425c81a8aa5ed3f3d973eef'
const POCKET_VENDOR_BASE = `https://cdn.jsdelivr.net/gh/vlapky/pocket-tts-js@${POCKET_VENDOR_COMMIT}/src`
const POCKET_MODEL_BASE = 'https://huggingface.co/vlapky/pocket-tts-onnx/resolve/main/onnx'
const POCKET_ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/'
const POCKET_RUNTIME_CACHE = 'epub-player-pocket-runtime-v1'
const POCKET_MODEL_CACHE = 'epub-player-pocket-models-v1'
const POCKET_VOICE_CACHE = 'epub-player-pocket-voices-v1'
const LEO_VOICE_CACHE_PATH = '/__epubplayer/pocket/voices/leo'
const LEO_VOICE_REF = 'custom:leo'
const POCKET_SAMPLE_RATE = 24_000
const MAX_REFERENCE_SECONDS = 10
const POCKET_MAX_CHUNK_CHARS = 220

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

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

type PocketBundle = {
  language: string
  sampleRate: number
  samplesPerFrame: number
  predefinedVoices: string[]
}

type PocketMetrics = {
  rtfx?: number
  genTime?: number
  audioDuration?: number
  stopped?: boolean
}

function voiceCacheUrl(): string {
  if (typeof window === 'undefined') return `https://local.invalid${LEO_VOICE_CACHE_PATH}`
  return new URL(LEO_VOICE_CACHE_PATH, window.location.origin).toString()
}

async function fetchVendorText(fileName: string): Promise<string> {
  const url = `${POCKET_VENDOR_BASE}/${fileName}`

  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(POCKET_RUNTIME_CACHE)
      const cached = await cache.match(url)
      if (cached) return await cached.text()

      const response = await fetch(url, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`Pocket runtime ${fileName} returned ${response.status}`)
      await cache.put(url, response.clone())
      return await response.text()
    } catch (error) {
      log.warn('Pocket runtime cache unavailable; falling back to network', { fileName, error })
    }
  }

  const response = await fetch(url, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`Pocket runtime ${fileName} returned ${response.status}`)
  return response.text()
}

/**
 * Tiny host for the public pocket-tts-js worker protocol.
 * We fetch the commit-pinned worker/tokenizer/binary modules and turn them into
 * Blob module URLs so Worker() remains same-origin on Safari/iOS.
 */
class PocketWorkerRuntime {
  private worker: Worker | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private objectUrls: string[] = []
  private activeChunkCallback: ((audio: Float32Array) => void) | null = null
  private progressCallback: ((status: string, progress?: number) => void) | null = null

  bundle: PocketBundle | null = null

  async initialize(onProgress?: (status: string, progress?: number) => void): Promise<void> {
    if (this.worker && this.bundle) return
    this.progressCallback = onProgress ?? null

    const [workerSource, tokenizerSource, binarySource] = await Promise.all([
      fetchVendorText('worker.js'),
      fetchVendorText('tokenizer.js'),
      fetchVendorText('binary.js'),
    ])

    const tokenizerUrl = URL.createObjectURL(new Blob([tokenizerSource], { type: 'text/javascript' }))
    const binaryUrl = URL.createObjectURL(new Blob([binarySource], { type: 'text/javascript' }))
    this.objectUrls.push(tokenizerUrl, binaryUrl)

    // Rewrite only the worker's two local imports. Everything else (ORT/model
    // fetches) remains driven by the explicit config below.
    const patchedWorker = workerSource
      .replace('"./tokenizer.js"', JSON.stringify(tokenizerUrl))
      .replace('"./binary.js"', JSON.stringify(binaryUrl))

    const workerUrl = URL.createObjectURL(new Blob([patchedWorker], { type: 'text/javascript' }))
    this.objectUrls.push(workerUrl)

    this.worker = new Worker(workerUrl, { type: 'module', name: 'pocket-tts-leo' })
    this.worker.onmessage = (event) => this.handleMessage(event.data)
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Pocket TTS worker error')
      log.error('Pocket TTS worker error', error)
      this.rejectAll(error)
    }

    await this.request('init', {
      language: 'english_2026-04',
      quantized: true,
      voiceCloning: true,
      modelBaseUrl: POCKET_MODEL_BASE,
      ortBaseUrl: POCKET_ORT_BASE,
      voicesUrl: null,
      // The worker automatically uses one thread when cross-origin isolation is
      // unavailable. We deliberately do not change the app's COOP/COEP headers.
      maxThreads: 4,
      cache: true,
      cacheName: POCKET_MODEL_CACHE,
    })

    if (!this.bundle) {
      throw new Error('Pocket TTS initialized without bundle metadata')
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    const type = String(message.type || '')

    if (type === 'ready') {
      this.bundle = message.bundle as PocketBundle
      return
    }

    if (type === 'chunk') {
      const audio = message.audio
      if (audio instanceof Float32Array) this.activeChunkCallback?.(audio)
      return
    }

    if (type === 'progress') {
      const label = typeof message.label === 'string' ? message.label : 'Downloading Pocket TTS'
      const loaded = typeof message.loaded === 'number' ? message.loaded : 0
      const total = typeof message.total === 'number' ? message.total : 0
      const progress = total > 0 ? Math.max(0, Math.min(100, (loaded / total) * 100)) : undefined
      this.progressCallback?.(label, progress)
      return
    }

    if (type === 'status') {
      const status = typeof message.status === 'string' ? message.status : 'Loading Pocket TTS'
      this.progressCallback?.(status)
      return
    }

    const id = typeof message.id === 'number' ? message.id : null
    if (id == null) return
    const pending = this.pending.get(id)
    if (!pending) return

    if (type === 'result') {
      this.pending.delete(id)
      pending.resolve(message.result)
    } else if (type === 'error') {
      this.pending.delete(id)
      pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Pocket TTS error'))
    }
  }

  private request(type: string, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error('Pocket TTS worker is not initialized'))
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

  async cloneVoice(audio: Float32Array, ref: string): Promise<string> {
    // Transfer a dedicated copy so the caller's working buffer isn't detached.
    const copy = audio.slice()
    const result = await this.request('cloneVoice', { audio: copy.buffer, ref }, [copy.buffer]) as { ref?: string }
    return result.ref || ref
  }

  async generate(text: string, voiceRef: string, onChunk: (audio: Float32Array) => void): Promise<PocketMetrics> {
    this.activeChunkCallback = onChunk
    try {
      const result = await this.request('generate', { text, voiceRef }) as { metrics?: PocketMetrics }
      return result.metrics || {}
    } finally {
      this.activeChunkCallback = null
    }
  }

  async stop(): Promise<void> {
    if (!this.worker) return
    try {
      await this.request('stop', {})
    } catch {
      // Destroy/cancel paths are best-effort.
    }
  }

  destroy(): void {
    const error = new DOMException('Pocket TTS worker destroyed', 'AbortError') as unknown as Error
    this.rejectAll(error)
    this.worker?.terminate()
    this.worker = null
    this.bundle = null
    this.activeChunkCallback = null
    this.progressCallback = null
    for (const url of this.objectUrls) URL.revokeObjectURL(url)
    this.objectUrls = []
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

function resampleLinear(data: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return data.slice()
  const ratio = sourceRate / targetRate
  const outLength = Math.max(1, Math.floor(data.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const sourceIndex = i * ratio
    const lower = Math.floor(sourceIndex)
    const upper = Math.min(lower + 1, data.length - 1)
    const fraction = sourceIndex - lower
    out[i] = data[lower] * (1 - fraction) + data[upper] * fraction
  }
  return out
}

function selectBestReferenceWindow(input: Float32Array, sampleRate: number): Float32Array {
  const maxSamples = Math.floor(sampleRate * MAX_REFERENCE_SECONDS)
  if (input.length <= maxSamples) return input.slice()

  // Select the strongest contiguous ten-second window. This is intentionally
  // conservative: it avoids long silence without performing voice-altering denoise.
  const step = Math.max(1, Math.floor(sampleRate * 0.5))
  let bestStart = 0
  let bestEnergy = -Infinity

  for (let start = 0; start + maxSamples <= input.length; start += step) {
    let sumSquares = 0
    let count = 0
    // Sample every 8 points — enough for window ranking and much cheaper on iOS.
    for (let i = start; i < start + maxSamples; i += 8) {
      const sample = input[i]
      sumSquares += sample * sample
      count++
    }
    const energy = count > 0 ? sumSquares / count : 0
    if (energy > bestEnergy) {
      bestEnergy = energy
      bestStart = start
    }
  }

  return input.slice(bestStart, Math.min(input.length, bestStart + maxSamples))
}

function normalizeReference(input: Float32Array): Float32Array {
  const out = input.slice()
  if (out.length === 0) return out

  let mean = 0
  for (let i = 0; i < out.length; i++) mean += out[i]
  mean /= out.length

  let peak = 0
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean
    peak = Math.max(peak, Math.abs(out[i]))
  }

  // Leave headroom and avoid boosting very quiet/noisy clips excessively.
  if (peak > 0.05) {
    const gain = Math.min(4, 0.70 / peak)
    for (let i = 0; i < out.length; i++) out[i] *= gain
  }

  return out
}

async function decodeReferenceAudio(blob: Blob, targetRate: number): Promise<Float32Array> {
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) throw new Error('Web Audio is unavailable on this device')

  const context = new AudioContextCtor()
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer())
    const mono = new Float32Array(buffer.length)

    // Average channels instead of arbitrarily choosing left/right.
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel)
      for (let i = 0; i < samples.length; i++) mono[i] += samples[i] / buffer.numberOfChannels
    }

    const resampled = resampleLinear(mono, buffer.sampleRate, targetRate)
    return normalizeReference(selectBestReferenceWindow(resampled, targetRate))
  } finally {
    await context.close().catch(() => {})
  }
}

function floatChunksToWav(chunks: Float32Array[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytesPerSample = 2
  const dataSize = totalSamples * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true)
  view.setUint16(32, bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]))
      const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
      view.setInt16(offset, pcm, true)
      offset += 2
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

class PocketService {
  private runtime: PocketWorkerRuntime | null = null
  private isReady = false
  private isLoading = false
  private initPromise: Promise<void> | null = null
  private config: PocketConfig | null = null
  private requestCounter = 0
  private cancelEpoch = 0

  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  async hasLeoVoiceSample(): Promise<boolean> {
    if (typeof caches === 'undefined') return false
    try {
      const cache = await caches.open(POCKET_VOICE_CACHE)
      return Boolean(await cache.match(voiceCacheUrl()))
    } catch {
      return false
    }
  }

  async installLeoVoiceSample(blob: Blob): Promise<void> {
    if (!blob || blob.size === 0) throw new Error('Leo voice sample is empty')
    if (blob.size > 30 * 1024 * 1024) throw new Error('Voice sample is too large; use a short audio clip')
    if (typeof caches === 'undefined') throw new Error('Cache Storage is unavailable on this device')

    const cache = await caches.open(POCKET_VOICE_CACHE)
    await cache.put(
      voiceCacheUrl(),
      new Response(blob, {
        headers: {
          'Content-Type': blob.type || 'audio/wav',
          'X-Voice-Name': 'Leo',
        },
      })
    )

    // Force a fresh clone next time Pocket initializes.
    this.destroy()
    log.info('Installed local Pocket TTS voice sample', { name: 'Leo', bytes: blob.size })
  }

  async removeLeoVoiceSample(): Promise<void> {
    this.destroy()
    if (typeof caches === 'undefined') return
    try {
      const cache = await caches.open(POCKET_VOICE_CACHE)
      await cache.delete(voiceCacheUrl())
    } catch {
      // best effort
    }
  }

  private async getLeoVoiceSample(): Promise<Blob | null> {
    if (typeof caches === 'undefined') return null
    const cache = await caches.open(POCKET_VOICE_CACHE)
    const response = await cache.match(voiceCacheUrl())
    return response ? response.blob() : null
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

  private async doInitialize(): Promise<void> {
    try {
      const reference = await this.getLeoVoiceSample()
      if (!reference) {
        throw new Error('Leo voice sample is not installed. Open Settings → Pocket TTS and install the Leo sample first.')
      }

      const maxChunkChars = await settingsRepository.get('maxChunkChars')
      this.config = {
        maxChunkChars: Math.min(POCKET_MAX_CHUNK_CHARS, Math.max(120, maxChunkChars)),
      }

      this.onProgressCallback?.('Loading Pocket TTS...', 0)
      log.info('Pocket TTS initializing', { voice: 'Leo', maxChunkChars: this.config.maxChunkChars })

      const runtime = new PocketWorkerRuntime()
      this.runtime = runtime
      await runtime.initialize((status, progress) => this.onProgressCallback?.(status, progress))

      const sampleRate = runtime.bundle?.sampleRate || POCKET_SAMPLE_RATE
      this.onProgressCallback?.('Preparing Leo voice...', 99)
      const pcm = await decodeReferenceAudio(reference, sampleRate)
      if (pcm.length < sampleRate) {
        throw new Error('Leo voice sample is too short. Use at least a few seconds of clear speech.')
      }

      await runtime.cloneVoice(pcm, LEO_VOICE_REF)

      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Pocket TTS ready', 100)
      this.onReadyCallback?.()
      log.info('Pocket TTS ready', { voice: 'Leo', sampleRate })
    } catch (error) {
      this.runtime?.destroy()
      this.runtime = null
      this.isReady = false
      this.isLoading = false
      const message = error instanceof Error ? error.message : String(error)
      this.onErrorCallback?.(message)
      log.error('Pocket TTS initialization failed', error)
      throw error
    }
  }

  async generateChunk(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    await this.initialize()
    const runtime = this.runtime
    if (!runtime || !this.isReady) throw new Error('Pocket TTS is not initialized')

    const epoch = this.cancelEpoch
    const requestId = `pocket_${++this.requestCounter}_${Date.now()}`
    const chunks: Float32Array[] = []
    log.debug('Pocket TTS generating chunk', { chunkIndex, textLength: text.length, requestId })

    try {
      const metrics = await runtime.generate(text, LEO_VOICE_REF, (audio) => {
        // Copy because the next worker message may transfer/reuse its own buffer.
        chunks.push(audio.slice())
      })

      if (epoch !== this.cancelEpoch) {
        throw new DOMException('Generation cancelled', 'AbortError')
      }
      if (chunks.length === 0) throw new Error('Pocket TTS returned no audio')

      const sampleRate = runtime.bundle?.sampleRate || POCKET_SAMPLE_RATE
      const sampleCount = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const duration = sampleCount / sampleRate
      const blob = floatChunksToWav(chunks, sampleRate)

      log.debug('Pocket TTS generated audio', {
        requestId,
        duration,
        rtfx: metrics.rtfx,
        genTime: metrics.genTime,
      })

      const result: PocketGeneratedAudio = { requestId, blob, duration, chunkIndex, text }
      this.onAudioCallback?.(result)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.onErrorCallback?.(message, requestId)
      }
      throw error
    }
  }

  splitIntoChunks(text: string): string[] {
    const maxChars = this.config?.maxChunkChars || POCKET_MAX_CHUNK_CHARS
    return splitTextIntoChunks(text, Math.min(maxChars, POCKET_MAX_CHUNK_CHARS))
  }

  cancelAll(): void {
    this.cancelEpoch++
    void this.runtime?.stop()
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
