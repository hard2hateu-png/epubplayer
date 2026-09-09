/**
 * Pocket TTS Service — bundled custom voice (Leo)
 *
 * Browser integration for Kyutai Pocket TTS using the community ONNX browser
 * worker from vlapky/pocket-tts-js. Leo's full reference is bundled with the app.
 *
 * The first preparation encodes the reference and stores the compact voice
 * embedding in Cache Storage. Later launches import that embedding and skip the
 * expensive audio encoder.
 */

import { createLogger } from '@/services/logging'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { splitTextIntoChunks } from './textChunking'

const log = createLogger('tts')

const POCKET_VENDOR_COMMIT = '7d7a27423b0845eb0425c81a8aa5ed3f3d973eef'
const POCKET_VENDOR_BASE = `https://cdn.jsdelivr.net/gh/vlapky/pocket-tts-js@${POCKET_VENDOR_COMMIT}/src`
const POCKET_MODEL_BASE = 'https://huggingface.co/vlapky/pocket-tts-onnx/resolve/main/onnx'
const POCKET_ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/'
const POCKET_RUNTIME_CACHE = 'epub-player-pocket-runtime-v2'
const POCKET_MODEL_CACHE = 'epub-player-pocket-models-v1'
const POCKET_VOICE_CACHE = 'epub-player-pocket-voices-v2'

const LEO_BUNDLED_REFERENCE_PATH = '/voices/leo-reference-full.m4a'
const LEO_CUSTOM_REFERENCE_CACHE_PATH = '/__epubplayer/pocket/voices/leo-custom-reference-v2'
const LEO_EMBEDDING_CACHE_PATH = '/__epubplayer/pocket/voices/leo-embedding-v2-full-42650'
const LEO_VOICE_REF = 'custom:leo'
const LEO_EMBEDDING_MAGIC = 'LEOEMB02'

const POCKET_SAMPLE_RATE = 24_000
const MAX_REFERENCE_SECONDS = 45
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

type PocketVoiceEmbedding = {
  data: Float32Array
  shape: number[]
}

type PocketWorkerOptions = {
  useVoiceEncoder: boolean
  useCachedEmbedding: boolean
  onProgress?: (status: string, progress?: number) => void
}

function appUrl(path: string): string {
  if (typeof window === 'undefined') return `https://local.invalid${path}`
  return new URL(path, window.location.origin).toString()
}

function customReferenceCacheUrl(): string {
  return appUrl(LEO_CUSTOM_REFERENCE_CACHE_PATH)
}

function embeddingCacheUrl(): string {
  return appUrl(LEO_EMBEDDING_CACHE_PATH)
}

function bundledReferenceUrl(): string {
  return appUrl(LEO_BUNDLED_REFERENCE_PATH)
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

function patchPocketWorker(
  workerSource: string,
  tokenizerUrl: string,
  binaryUrl: string
): string {
  let patched = workerSource
    .replace('"./tokenizer.js"', JSON.stringify(tokenizerUrl))
    .replace('"./binary.js"', JSON.stringify(binaryUrl))

  const originalCloneVoice = `async function cloneVoice(audioData, ref) {
    const emb = await encodeVoiceAudio(audioData);
    customEmbeddings.set(ref, emb);
    voiceStateCache.set(ref, await buildVoiceConditionedState(emb));
    return ref;
}`

  const patchedCloneVoice = `async function cloneVoice(audioData, ref) {
    const emb = await encodeVoiceAudio(audioData);
    customEmbeddings.set(ref, emb);
    voiceStateCache.set(ref, await buildVoiceConditionedState(emb));
    return ref;
}

async function loadCustomVoiceEmbedding(embeddingData, shape, ref) {
    const emb = {
        data: embeddingData instanceof Float32Array
            ? new Float32Array(embeddingData)
            : new Float32Array(embeddingData),
        shape: Array.from(shape || [], Number),
    };
    if (!emb.data.length || !emb.shape.length) {
        throw new Error("Saved custom voice embedding is empty.");
    }
    customEmbeddings.set(ref, emb);
    voiceStateCache.set(ref, await buildVoiceConditionedState(emb));
    return ref;
}

function exportCustomVoiceEmbedding(ref) {
    const emb = customEmbeddings.get(ref);
    if (!emb) throw new Error("Custom voice embedding is unavailable.");
    return {
        data: new Float32Array(emb.data),
        shape: Array.from(emb.shape),
    };
}`

  if (!patched.includes(originalCloneVoice)) {
    throw new Error('Pocket worker patch failed: cloneVoice implementation changed')
  }
  patched = patched.replace(originalCloneVoice, patchedCloneVoice)

  const originalBosCondition =
    'if (config.voiceCloning && bundleMetadata.bos_before_voice_file) {'
  const patchedBosCondition =
    'if ((config.voiceCloning || config.customVoiceEmbedding) && bundleMetadata.bos_before_voice_file) {'

  if (!patched.includes(originalBosCondition)) {
    throw new Error('Pocket worker patch failed: BOS loading condition changed')
  }
  patched = patched.replace(originalBosCondition, patchedBosCondition)

  const originalDispatch = `} else if (type === "cloneVoice") {
            const ref = await cloneVoice(payload.audio, payload.ref);
            post({ id, type: "result", result: { ref } });
        } else if (type === "loadBuiltinVoice") {`

  const patchedDispatch = `} else if (type === "cloneVoice") {
            const ref = await cloneVoice(payload.audio, payload.ref);
            const embedding = exportCustomVoiceEmbedding(ref);
            post(
                {
                    id,
                    type: "result",
                    result: {
                        ref,
                        embedding: embedding.data,
                        shape: embedding.shape,
                    },
                },
                [embedding.data.buffer]
            );
        } else if (type === "loadCustomVoiceEmbedding") {
            const ref = await loadCustomVoiceEmbedding(
                payload.embedding,
                payload.shape,
                payload.ref
            );
            post({ id, type: "result", result: { ref } });
        } else if (type === "loadBuiltinVoice") {`

  if (!patched.includes(originalDispatch)) {
    throw new Error('Pocket worker patch failed: message dispatcher changed')
  }
  patched = patched.replace(originalDispatch, patchedDispatch)

  return patched
}

/**
 * Tiny host for the public pocket-tts-js worker protocol.
 * The commit-pinned worker is patched to import/export Leo's voice embedding so
 * later app launches do not need to run the audio encoder again.
 */
class PocketWorkerRuntime {
  private worker: Worker | null = null
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private objectUrls: string[] = []
  private activeChunkCallback: ((audio: Float32Array) => void) | null = null
  private progressCallback: ((status: string, progress?: number) => void) | null = null

  bundle: PocketBundle | null = null

  async initialize(options: PocketWorkerOptions): Promise<void> {
    if (this.worker && this.bundle) return
    this.progressCallback = options.onProgress ?? null

    const [workerSource, tokenizerSource, binarySource] = await Promise.all([
      fetchVendorText('worker.js'),
      fetchVendorText('tokenizer.js'),
      fetchVendorText('binary.js'),
    ])

    const tokenizerUrl = URL.createObjectURL(
      new Blob([tokenizerSource], { type: 'text/javascript' })
    )
    const binaryUrl = URL.createObjectURL(
      new Blob([binarySource], { type: 'text/javascript' })
    )
    this.objectUrls.push(tokenizerUrl, binaryUrl)

    const patchedWorker = patchPocketWorker(workerSource, tokenizerUrl, binaryUrl)
    const workerUrl = URL.createObjectURL(
      new Blob([patchedWorker], { type: 'text/javascript' })
    )
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
      voiceCloning: options.useVoiceEncoder,
      customVoiceEmbedding: options.useCachedEmbedding,
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
      const label =
        typeof message.label === 'string' ? message.label : 'Downloading Pocket TTS'
      const loaded = typeof message.loaded === 'number' ? message.loaded : 0
      const total = typeof message.total === 'number' ? message.total : 0
      const progress =
        total > 0 ? Math.max(0, Math.min(100, (loaded / total) * 100)) : undefined
      this.progressCallback?.(label, progress)
      return
    }

    if (type === 'status') {
      const status =
        typeof message.status === 'string' ? message.status : 'Loading Pocket TTS'
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
      pending.reject(
        new Error(typeof message.error === 'string' ? message.error : 'Pocket TTS error')
      )
    }
  }

  private request(
    type: string,
    payload: Record<string, unknown>,
    transfer: Transferable[] = []
  ): Promise<unknown> {
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

  async cloneVoice(audio: Float32Array, ref: string): Promise<PocketVoiceEmbedding> {
    const copy = audio.slice()
    const result = (await this.request(
      'cloneVoice',
      { audio: copy, ref },
      [copy.buffer]
    )) as {
      ref?: string
      embedding?: Float32Array
      shape?: number[]
    }

    if (!(result.embedding instanceof Float32Array) || !Array.isArray(result.shape)) {
      throw new Error('Pocket TTS did not return Leo voice embedding data')
    }

    return {
      data: result.embedding,
      shape: result.shape.map(Number),
    }
  }

  async loadVoiceEmbedding(
    embedding: PocketVoiceEmbedding,
    ref: string
  ): Promise<string> {
    const copy = embedding.data.slice()
    const result = (await this.request(
      'loadCustomVoiceEmbedding',
      {
        embedding: copy,
        shape: embedding.shape,
        ref,
      },
      [copy.buffer]
    )) as { ref?: string }

    return result.ref || ref
  }

  async generate(
    text: string,
    voiceRef: string,
    onChunk: (audio: Float32Array) => void
  ): Promise<PocketMetrics> {
    this.activeChunkCallback = onChunk
    try {
      const result = (await this.request('generate', {
        text,
        voiceRef,
      })) as { metrics?: PocketMetrics }
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
    const error = new DOMException(
      'Pocket TTS worker destroyed',
      'AbortError'
    ) as unknown as Error
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

function resampleLinear(
  data: Float32Array,
  sourceRate: number,
  targetRate: number
): Float32Array {
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

function selectReferenceWindow(input: Float32Array, sampleRate: number): Float32Array {
  const maxSamples = Math.floor(sampleRate * MAX_REFERENCE_SECONDS)
  if (input.length <= maxSamples) return input.slice()

  // Uploaded replacements longer than 45 seconds are capped for iPhone memory.
  // The bundled 42.65-second Leo reference is retained in full.
  const step = Math.max(1, Math.floor(sampleRate * 0.5))
  let bestStart = 0
  let bestEnergy = -Infinity

  for (let start = 0; start + maxSamples <= input.length; start += step) {
    let sumSquares = 0
    let count = 0
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

  if (peak > 0.05) {
    const gain = Math.min(4, 0.7 / peak)
    for (let i = 0; i < out.length; i++) out[i] *= gain
  }

  return out
}

async function decodeReferenceAudio(
  blob: Blob,
  targetRate: number
): Promise<Float32Array> {
  const AudioContextCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  if (!AudioContextCtor) throw new Error('Web Audio is unavailable on this device')

  const context = new AudioContextCtor()
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer())
    const mono = new Float32Array(buffer.length)

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel)
      for (let i = 0; i < samples.length; i++) {
        mono[i] += samples[i] / buffer.numberOfChannels
      }
    }

    const resampled = resampleLinear(mono, buffer.sampleRate, targetRate)
    return normalizeReference(selectReferenceWindow(resampled, targetRate))
  } finally {
    await context.close().catch(() => {})
  }
}

function serializeVoiceEmbedding(embedding: PocketVoiceEmbedding): ArrayBuffer {
  const dims = embedding.shape.map((value) => Math.max(0, Math.trunc(value)))
  const headerBytes = 16 + dims.length * 4
  const buffer = new ArrayBuffer(headerBytes + embedding.data.byteLength)
  const view = new DataView(buffer)

  for (let i = 0; i < LEO_EMBEDDING_MAGIC.length; i++) {
    view.setUint8(i, LEO_EMBEDDING_MAGIC.charCodeAt(i))
  }
  view.setUint32(8, dims.length, true)
  view.setUint32(12, embedding.data.length, true)

  for (let i = 0; i < dims.length; i++) {
    view.setUint32(16 + i * 4, dims[i], true)
  }

  const target = new Uint8Array(buffer, headerBytes)
  target.set(
    new Uint8Array(
      embedding.data.buffer,
      embedding.data.byteOffset,
      embedding.data.byteLength
    )
  )

  return buffer
}

function deserializeVoiceEmbedding(buffer: ArrayBuffer): PocketVoiceEmbedding {
  if (buffer.byteLength < 20) throw new Error('Saved Leo voice embedding is incomplete')
  const view = new DataView(buffer)

  let magic = ''
  for (let i = 0; i < LEO_EMBEDDING_MAGIC.length; i++) {
    magic += String.fromCharCode(view.getUint8(i))
  }
  if (magic !== LEO_EMBEDDING_MAGIC) {
    throw new Error('Saved Leo voice embedding uses an old format')
  }

  const dimsLength = view.getUint32(8, true)
  const dataLength = view.getUint32(12, true)
  if (dimsLength < 1 || dimsLength > 8 || dataLength < 1) {
    throw new Error('Saved Leo voice embedding metadata is invalid')
  }

  const headerBytes = 16 + dimsLength * 4
  const expectedBytes = headerBytes + dataLength * Float32Array.BYTES_PER_ELEMENT
  if (buffer.byteLength !== expectedBytes) {
    throw new Error('Saved Leo voice embedding length is invalid')
  }

  const shape: number[] = []
  for (let i = 0; i < dimsLength; i++) {
    shape.push(view.getUint32(16 + i * 4, true))
  }

  const data = new Float32Array(dataLength)
  new Uint8Array(data.buffer).set(new Uint8Array(buffer, headerBytes))

  return { data, shape }
}

function floatChunksToWav(chunks: Float32Array[], sampleRate: number): Blob {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const bytesPerSample = 2
  const dataSize = totalSamples * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
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
      const pcm =
        sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff)
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
    try {
      await this.getLeoVoiceSample()
      return true
    } catch {
      return false
    }
  }

  async hasCustomLeoVoiceSample(): Promise<boolean> {
    if (typeof caches === 'undefined') return false
    try {
      const cache = await caches.open(POCKET_VOICE_CACHE)
      return Boolean(await cache.match(customReferenceCacheUrl()))
    } catch {
      return false
    }
  }

  async installLeoVoiceSample(blob: Blob): Promise<void> {
    if (!blob || blob.size === 0) throw new Error('Leo voice sample is empty')
    if (blob.size > 30 * 1024 * 1024) {
      throw new Error('Voice sample is too large; use no more than 45 seconds')
    }
    if (typeof caches === 'undefined') {
      throw new Error('Cache Storage is unavailable on this device')
    }

    const cache = await caches.open(POCKET_VOICE_CACHE)
    await cache.put(
      customReferenceCacheUrl(),
      new Response(blob, {
        headers: {
          'Content-Type': blob.type || 'audio/wav',
          'X-Voice-Name': 'Leo',
        },
      })
    )
    await cache.delete(embeddingCacheUrl())

    this.destroy()
    log.info('Installed custom Pocket TTS reference', {
      name: 'Leo',
      bytes: blob.size,
    })
  }

  /**
   * Removes an uploaded replacement and returns to the bundled full Leo clip.
   */
  async removeLeoVoiceSample(): Promise<void> {
    this.destroy()
    if (typeof caches === 'undefined') return
    try {
      const cache = await caches.open(POCKET_VOICE_CACHE)
      await Promise.all([
        cache.delete(customReferenceCacheUrl()),
        cache.delete(embeddingCacheUrl()),
      ])
    } catch {
      // Best effort.
    }
  }

  private async getLeoVoiceSample(): Promise<Blob> {
    if (typeof caches !== 'undefined') {
      try {
        const cache = await caches.open(POCKET_VOICE_CACHE)
        const custom = await cache.match(customReferenceCacheUrl())
        if (custom) return custom.blob()
      } catch {
        // Fall through to the bundled reference.
      }
    }

    const response = await fetch(bundledReferenceUrl(), { cache: 'force-cache' })
    if (!response.ok) {
      throw new Error(`Bundled Leo reference returned ${response.status}`)
    }
    const blob = await response.blob()
    if (blob.size === 0) throw new Error('Bundled Leo reference is empty')
    return blob
  }

  private async getCachedLeoEmbedding(): Promise<PocketVoiceEmbedding | null> {
    if (typeof caches === 'undefined') return null
    try {
      const cache = await caches.open(POCKET_VOICE_CACHE)
      const response = await cache.match(embeddingCacheUrl())
      if (!response) return null
      return deserializeVoiceEmbedding(await response.arrayBuffer())
    } catch (error) {
      log.warn('Ignoring invalid cached Leo embedding', { error })
      await this.deleteCachedLeoEmbedding()
      return null
    }
  }

  private async cacheLeoEmbedding(embedding: PocketVoiceEmbedding): Promise<void> {
    if (typeof caches === 'undefined') return
    const cache = await caches.open(POCKET_VOICE_CACHE)
    const serialized = serializeVoiceEmbedding(embedding)
    await cache.put(
      embeddingCacheUrl(),
      new Response(serialized, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Voice-Name': 'Leo',
          'X-Voice-Format': LEO_EMBEDDING_MAGIC,
        },
      })
    )

    try {
      await navigator.storage?.persist?.()
    } catch {
      // Persistence is optional.
    }
  }

  private async deleteCachedLeoEmbedding(): Promise<void> {
    if (typeof caches === 'undefined') return
    try {
      const cache = await caches.open(POCKET_VOICE_CACHE)
      await cache.delete(embeddingCacheUrl())
    } catch {
      // Best effort.
    }
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
    useCachedEmbedding: boolean
  ): Promise<PocketWorkerRuntime> {
    const runtime = new PocketWorkerRuntime()
    await runtime.initialize({
      useVoiceEncoder: !useCachedEmbedding,
      useCachedEmbedding,
      onProgress: (status, progress) =>
        this.onProgressCallback?.(status, progress),
    })
    return runtime
  }

  private async prepareVoiceFromReference(
    runtime: PocketWorkerRuntime
  ): Promise<void> {
    const reference = await this.getLeoVoiceSample()
    const sampleRate = runtime.bundle?.sampleRate || POCKET_SAMPLE_RATE

    this.onProgressCallback?.('Preparing full Leo voice reference...', 99)
    const pcm = await decodeReferenceAudio(reference, sampleRate)
    if (pcm.length < sampleRate) {
      throw new Error('Leo voice sample is too short. Use at least a few seconds of clear speech.')
    }

    const embedding = await runtime.cloneVoice(pcm, LEO_VOICE_REF)
    await this.cacheLeoEmbedding(embedding)
    log.info('Prepared and cached Leo voice embedding', {
      sampleRate,
      referenceSeconds: pcm.length / sampleRate,
      embeddingValues: embedding.data.length,
      embeddingShape: embedding.shape,
    })
  }

  private async doInitialize(): Promise<void> {
    try {
      const maxChunkChars = await settingsRepository.get('maxChunkChars')
      this.config = {
        maxChunkChars: Math.min(
          POCKET_MAX_CHUNK_CHARS,
          Math.max(120, maxChunkChars)
        ),
      }

      this.onProgressCallback?.('Loading Pocket TTS...', 0)
      log.info('Pocket TTS initializing', {
        voice: 'Leo',
        maxChunkChars: this.config.maxChunkChars,
      })

      const cachedEmbedding = await this.getCachedLeoEmbedding()
      let runtime: PocketWorkerRuntime | null = null

      if (cachedEmbedding) {
        try {
          runtime = await this.createRuntime(true)
          this.onProgressCallback?.('Loading saved Leo voice...', 99)
          await runtime.loadVoiceEmbedding(cachedEmbedding, LEO_VOICE_REF)
          log.info('Pocket TTS loaded cached Leo embedding', {
            embeddingValues: cachedEmbedding.data.length,
            embeddingShape: cachedEmbedding.shape,
          })
        } catch (error) {
          runtime?.destroy()
          runtime = null
          await this.deleteCachedLeoEmbedding()
          log.warn('Cached Leo embedding failed; rebuilding it once', { error })
        }
      }

      if (!runtime) {
        runtime = await this.createRuntime(false)
        await this.prepareVoiceFromReference(runtime)
      }

      this.runtime = runtime
      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Pocket TTS ready', 100)
      this.onReadyCallback?.()
      log.info('Pocket TTS ready', {
        voice: 'Leo',
        sampleRate: runtime.bundle?.sampleRate || POCKET_SAMPLE_RATE,
        reusedSavedVoice: Boolean(cachedEmbedding),
      })
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

  async generateChunk(
    text: string,
    chunkIndex: number
  ): Promise<PocketGeneratedAudio> {
    await this.initialize()
    const runtime = this.runtime
    if (!runtime || !this.isReady) throw new Error('Pocket TTS is not initialized')

    const epoch = this.cancelEpoch
    const requestId = `pocket_${++this.requestCounter}_${Date.now()}`
    const chunks: Float32Array[] = []
    log.debug('Pocket TTS generating chunk', {
      chunkIndex,
      textLength: text.length,
      requestId,
    })

    try {
      const metrics = await runtime.generate(text, LEO_VOICE_REF, (audio) => {
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

      const result: PocketGeneratedAudio = {
        requestId,
        blob,
        duration,
        chunkIndex,
        text,
      }
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
    return splitTextIntoChunks(
      text,
      Math.min(maxChars, POCKET_MAX_CHUNK_CHARS)
    )
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
