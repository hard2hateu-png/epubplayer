/** Pocket TTS — private local Leo voice with a reusable cached embedding. */
import { createLogger } from '@/services/logging'
import { settingsRepository } from '@/services/storage/settingsRepository'
import { splitTextIntoChunks } from './textChunking'

const log = createLogger('tts')
const VENDOR_COMMIT = '7d7a27423b0845eb0425c81a8aa5ed3f3d973eef'
const VENDOR_BASE = `https://cdn.jsdelivr.net/gh/vlapky/pocket-tts-js@${VENDOR_COMMIT}/src`
const MODEL_BASE = 'https://huggingface.co/vlapky/pocket-tts-onnx/resolve/main/onnx'
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/'
const RUNTIME_CACHE = 'epub-player-pocket-runtime-v2'
const MODEL_CACHE = 'epub-player-pocket-models-v1'
const VOICE_CACHE = 'epub-player-pocket-voices-v2'
const LEGACY_VOICE_CACHE = 'epub-player-pocket-voices-v1'
const LEGACY_REFERENCE_PATH = '/__epubplayer/pocket/voices/leo'
const REFERENCE_PATH = '/__epubplayer/pocket/voices/leo-reference-v2'
const EMBEDDING_PATH = '/__epubplayer/pocket/voices/leo-embedding-v4-single-12s'
const VOICE_REF = 'custom:leo'
const EMBEDDING_MAGIC = 'LEOEMB04'
const SAMPLE_RATE = 24_000
const REFERENCE_SECONDS = 42.65
const CONDITIONING_SECONDS = 12
const MAX_CHUNK_CHARS = 220

export interface PocketConfig { maxChunkChars: number }
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
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type Bundle = { language: string; sampleRate: number; samplesPerFrame: number; predefinedVoices: string[] }
type Metrics = { rtfx?: number; genTime?: number; audioDuration?: number; stopped?: boolean }
type VoiceEmbedding = { data: Float32Array; shape: number[] }

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

async function fetchVendorText(name: string): Promise<string> {
  const url = `${VENDOR_BASE}/${name}`
  if (typeof caches !== 'undefined') {
    try {
      const cache = await caches.open(RUNTIME_CACHE)
      const hit = await cache.match(url)
      if (hit) return hit.text()
      const response = await fetch(url, { cache: 'force-cache' })
      if (!response.ok) throw new Error(`${name} returned ${response.status}`)
      await cache.put(url, response.clone())
      return response.text()
    } catch (error) {
      log.warn('Pocket runtime cache unavailable', { name, error })
    }
  }
  const response = await fetch(url, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`${name} returned ${response.status}`)
  return response.text()
}

function patchWorker(source: string, tokenizerUrl: string, binaryUrl: string): string {
  let result = source
    .replace('"./tokenizer.js"', JSON.stringify(tokenizerUrl))
    .replace('"./binary.js"', JSON.stringify(binaryUrl))

  const cloneOriginal = `async function cloneVoice(audioData, ref) {
    const emb = await encodeVoiceAudio(audioData);
    customEmbeddings.set(ref, emb);
    voiceStateCache.set(ref, await buildVoiceConditionedState(emb));
    return ref;
}`
  const clonePatched = `${cloneOriginal}

async function loadCustomVoiceEmbedding(data, shape, ref) {
    const emb = { data: new Float32Array(data), shape: Array.from(shape || [], Number) };
    if (!emb.data.length || !emb.shape.length) throw new Error("Saved voice embedding is empty.");
    customEmbeddings.set(ref, emb);
    voiceStateCache.set(ref, await buildVoiceConditionedState(emb));
    return ref;
}

function exportCustomVoiceEmbedding(ref) {
    const emb = customEmbeddings.get(ref);
    if (!emb) throw new Error("Custom voice embedding is unavailable.");
    return { data: new Float32Array(emb.data), shape: Array.from(emb.shape) };
}`
  if (!result.includes(cloneOriginal)) throw new Error('Pocket worker clone patch no longer matches')
  result = result.replace(cloneOriginal, clonePatched)

  const bosOriginal = 'if (config.voiceCloning && bundleMetadata.bos_before_voice_file) {'
  const bosPatched = 'if ((config.voiceCloning || config.customVoiceEmbedding) && bundleMetadata.bos_before_voice_file) {'
  if (!result.includes(bosOriginal)) throw new Error('Pocket worker BOS patch no longer matches')
  result = result.replace(bosOriginal, bosPatched)

  const dispatchOriginal = `} else if (type === "cloneVoice") {
            const ref = await cloneVoice(payload.audio, payload.ref);
            post({ id, type: "result", result: { ref } });
        } else if (type === "loadBuiltinVoice") {`
  const dispatchPatched = `} else if (type === "cloneVoice") {
            const ref = await cloneVoice(payload.audio, payload.ref);
            const embedding = exportCustomVoiceEmbedding(ref);
            post({ id, type: "result", result: { ref, embedding: embedding.data, shape: embedding.shape } }, [embedding.data.buffer]);
        } else if (type === "loadCustomVoiceEmbedding") {
            const ref = await loadCustomVoiceEmbedding(payload.embedding, payload.shape, payload.ref);
            post({ id, type: "result", result: { ref } });
        } else if (type === "loadBuiltinVoice") {`
  if (!result.includes(dispatchOriginal)) throw new Error('Pocket worker dispatch patch no longer matches')
  return result.replace(dispatchOriginal, dispatchPatched)
}

class PocketWorkerRuntime {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private urls: string[] = []
  private chunkCallback: ((audio: Float32Array) => void) | null = null
  private progressCallback: ProgressCallback | null = null
  bundle: Bundle | null = null

  async initialize(useCachedEmbedding: boolean, onProgress?: ProgressCallback): Promise<void> {
    this.progressCallback = onProgress ?? null
    const [workerSource, tokenizerSource, binarySource] = await Promise.all([
      fetchVendorText('worker.js'), fetchVendorText('tokenizer.js'), fetchVendorText('binary.js'),
    ])
    const tokenizerUrl = URL.createObjectURL(new Blob([tokenizerSource], { type: 'text/javascript' }))
    const binaryUrl = URL.createObjectURL(new Blob([binarySource], { type: 'text/javascript' }))
    const workerUrl = URL.createObjectURL(new Blob([
      patchWorker(workerSource, tokenizerUrl, binaryUrl),
    ], { type: 'text/javascript' }))
    this.urls.push(tokenizerUrl, binaryUrl, workerUrl)
    this.worker = new Worker(workerUrl, { type: 'module', name: 'pocket-tts-leo' })
    this.worker.onmessage = (event) => this.handleMessage(event.data)
    this.worker.onerror = (event) => this.rejectAll(new Error(event.message || 'Pocket TTS worker error'))

    await this.request('init', {
      language: 'english_2026-04',
      quantized: true,
      voiceCloning: !useCachedEmbedding,
      customVoiceEmbedding: useCachedEmbedding,
      modelBaseUrl: MODEL_BASE,
      ortBaseUrl: ORT_BASE,
      voicesUrl: null,
      maxThreads: isIOSDevice() ? 1 : 4,
      cache: true,
      cacheName: MODEL_CACHE,
    })
    if (!this.bundle) throw new Error('Pocket TTS initialized without bundle metadata')
  }

  private handleMessage(message: Record<string, unknown>): void {
    const type = String(message.type || '')
    if (type === 'ready') { this.bundle = message.bundle as Bundle; return }
    if (type === 'chunk') {
      if (message.audio instanceof Float32Array) this.chunkCallback?.(message.audio)
      return
    }
    if (type === 'progress') {
      const loaded = typeof message.loaded === 'number' ? message.loaded : 0
      const total = typeof message.total === 'number' ? message.total : 0
      this.progressCallback?.(
        typeof message.label === 'string' ? message.label : 'Downloading Pocket TTS',
        total > 0 ? Math.max(0, Math.min(100, (loaded / total) * 100)) : undefined
      )
      return
    }
    if (type === 'status') {
      this.progressCallback?.(typeof message.status === 'string' ? message.status : 'Loading Pocket TTS')
      return
    }
    const id = typeof message.id === 'number' ? message.id : null
    if (id == null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (type === 'result') pending.resolve(message.result)
    else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Pocket TTS error'))
  }

  private request(type: string, payload: Record<string, unknown>, transfer: Transferable[] = []): Promise<unknown> {
    if (!this.worker) return Promise.reject(new Error('Pocket TTS worker is not initialized'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker!.postMessage({ id, type, payload }, transfer) }
      catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async cloneVoice(audio: Float32Array): Promise<VoiceEmbedding> {
    const copy = audio.slice()
    const result = await this.request('cloneVoice', { audio: copy, ref: VOICE_REF }, [copy.buffer]) as {
      embedding?: Float32Array; shape?: number[]
    }
    if (!(result.embedding instanceof Float32Array) || !Array.isArray(result.shape)) {
      throw new Error('Pocket TTS did not return Leo voice data')
    }
    return { data: result.embedding, shape: result.shape.map(Number) }
  }

  async loadVoiceEmbedding(embedding: VoiceEmbedding): Promise<void> {
    const copy = embedding.data.slice()
    await this.request('loadCustomVoiceEmbedding', {
      embedding: copy, shape: embedding.shape, ref: VOICE_REF,
    }, [copy.buffer])
  }

  async generate(text: string, onChunk: (audio: Float32Array) => void): Promise<Metrics> {
    this.chunkCallback = onChunk
    try {
      const result = await this.request('generate', { text, voiceRef: VOICE_REF }) as { metrics?: Metrics }
      return result.metrics || {}
    } finally { this.chunkCallback = null }
  }

  async stop(): Promise<void> { try { await this.request('stop', {}) } catch { /* best effort */ } }
  destroy(): void {
    this.rejectAll(new DOMException('Pocket TTS worker destroyed', 'AbortError') as unknown as Error)
    this.worker?.terminate()
    this.worker = null
    this.bundle = null
    this.chunkCallback = null
    this.progressCallback = null
    this.urls.forEach((url) => URL.revokeObjectURL(url))
    this.urls = []
  }
  private rejectAll(error: Error): void {
    this.pending.forEach(({ reject }) => reject(error))
    this.pending.clear()
  }
}

function resample(data: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return data.slice()
  const ratio = sourceRate / targetRate
  const out = new Float32Array(Math.max(1, Math.floor(data.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, data.length - 1)
    const fraction = position - lower
    out[i] = data[lower] * (1 - fraction) + data[upper] * fraction
  }
  return out
}

function normalizeReference(input: Float32Array, sampleRate: number): Float32Array {
  const limit = Math.min(input.length, Math.floor(sampleRate * REFERENCE_SECONDS))
  const out = input.slice(0, limit)
  if (!out.length) return out
  let mean = 0
  for (const sample of out) mean += sample
  mean /= out.length
  let peak = 0
  for (let i = 0; i < out.length; i++) { out[i] -= mean; peak = Math.max(peak, Math.abs(out[i])) }
  if (peak > 0.05) {
    const gain = Math.min(4, 0.7 / peak)
    for (let i = 0; i < out.length; i++) out[i] *= gain
  }
  return out
}

function selectRepresentativeWindow(input: Float32Array, sampleRate: number, seconds: number): Float32Array {
  const windowSamples = Math.min(input.length, Math.max(1, Math.floor(sampleRate * seconds)))
  if (input.length <= windowSamples) return input.slice()

  // Pick one continuous, speech-dense window. We score 250 ms blocks by RMS
  // energy and choose the 12-second run with the highest sustained energy.
  // This avoids silence without averaging or splicing separate voice embeddings.
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
  const Ctor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
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
  } finally { await context.close().catch(() => {}) }
}

function serializeEmbedding(embedding: VoiceEmbedding): ArrayBuffer {
  const shape = embedding.shape.map((value) => Math.max(0, Math.trunc(value)))
  const header = 16 + shape.length * 4
  const buffer = new ArrayBuffer(header + embedding.data.byteLength)
  const view = new DataView(buffer)
  for (let i = 0; i < EMBEDDING_MAGIC.length; i++) view.setUint8(i, EMBEDDING_MAGIC.charCodeAt(i))
  view.setUint32(8, shape.length, true)
  view.setUint32(12, embedding.data.length, true)
  shape.forEach((value, index) => view.setUint32(16 + index * 4, value, true))
  new Uint8Array(buffer, header).set(new Uint8Array(
    embedding.data.buffer, embedding.data.byteOffset, embedding.data.byteLength
  ))
  return buffer
}

function deserializeEmbedding(buffer: ArrayBuffer): VoiceEmbedding {
  if (buffer.byteLength < 20) throw new Error('Saved Leo voice data is incomplete')
  const view = new DataView(buffer)
  let magic = ''
  for (let i = 0; i < EMBEDDING_MAGIC.length; i++) magic += String.fromCharCode(view.getUint8(i))
  if (magic !== EMBEDDING_MAGIC) throw new Error('Saved Leo voice data uses an old format')
  const dimensions = view.getUint32(8, true)
  const length = view.getUint32(12, true)
  if (dimensions < 1 || dimensions > 8 || length < 1) throw new Error('Saved Leo voice metadata is invalid')
  const header = 16 + dimensions * 4
  if (buffer.byteLength !== header + length * 4) throw new Error('Saved Leo voice length is invalid')
  const shape = Array.from({ length: dimensions }, (_, index) => view.getUint32(16 + index * 4, true))
  const data = new Float32Array(length)
  new Uint8Array(data.buffer).set(new Uint8Array(buffer, header))
  return { data, shape }
}

function chunksToWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const buffer = new ArrayBuffer(44 + total * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data')
  view.setUint32(40, total * 2, true)
  let offset = 44
  for (const chunk of chunks) for (const value of chunk) {
    const sample = Math.max(-1, Math.min(1, value))
    view.setInt16(offset, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true)
    offset += 2
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
  private generationTail: Promise<void> = Promise.resolve()
  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  async hasLeoVoiceSample(): Promise<boolean> {
    try { await this.getReference(); return true } catch { return false }
  }
  async hasCustomLeoVoiceSample(): Promise<boolean> { return this.hasLeoVoiceSample() }

  /** Return a short speech-dense WAV derived from the private Leo reference. */
  async getLeoPromptWav(seconds = 10): Promise<Blob> {
    const safeSeconds = Math.max(6, Math.min(15, seconds))
    const reference = await this.getReference()
    const pcm = await decodeReference(reference, SAMPLE_RATE)
    if (pcm.length < SAMPLE_RATE * 5) throw new Error('Leo voice sample is too short')
    const prompt = selectRepresentativeWindow(pcm, SAMPLE_RATE, safeSeconds)
    return chunksToWav([prompt], SAMPLE_RATE)
  }

  async installLeoVoiceSample(blob: Blob): Promise<void> {
    if (!blob?.size) throw new Error('Leo voice sample is empty')
    if (blob.size > 30 * 1024 * 1024) throw new Error('Voice sample is too large')
    if (typeof caches === 'undefined') throw new Error('Cache Storage is unavailable on this device')
    const cache = await caches.open(VOICE_CACHE)
    await cache.put(localUrl(REFERENCE_PATH), new Response(blob, {
      headers: { 'Content-Type': blob.type || 'audio/wav', 'X-Voice-Name': 'Leo' },
    }))
    await cache.delete(localUrl(EMBEDDING_PATH))
    this.destroy()
  }

  async removeLeoVoiceSample(): Promise<void> {
    this.destroy()
    if (typeof caches === 'undefined') return
    const [current, legacy] = await Promise.all([
      caches.open(VOICE_CACHE), caches.open(LEGACY_VOICE_CACHE),
    ])
    await Promise.all([
      current.delete(localUrl(REFERENCE_PATH)), current.delete(localUrl(EMBEDDING_PATH)),
      legacy.delete(localUrl(LEGACY_REFERENCE_PATH)),
    ])
  }

  private async migrateLegacyReference(): Promise<Blob | null> {
    if (typeof caches === 'undefined') return null
    try {
      const legacy = await caches.open(LEGACY_VOICE_CACHE)
      const response = await legacy.match(localUrl(LEGACY_REFERENCE_PATH))
      if (!response) return null
      const blob = await response.blob()
      if (!blob.size) return null
      const current = await caches.open(VOICE_CACHE)
      await current.put(localUrl(REFERENCE_PATH), new Response(blob, {
        headers: {
          'Content-Type': blob.type || 'audio/wav',
          'X-Voice-Name': 'Leo', 'X-Voice-Migrated-From': 'pocket-v1',
        },
      }))
      log.info('Migrated the existing full Leo reference', { bytes: blob.size })
      return blob
    } catch (error) {
      log.warn('Could not migrate the existing Leo reference', { error })
      return null
    }
  }

  private async getReference(): Promise<Blob> {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(VOICE_CACHE)
      const response = await cache.match(localUrl(REFERENCE_PATH))
      if (response) return response.blob()
    }
    const migrated = await this.migrateLegacyReference()
    if (migrated) return migrated
    throw new Error('Leo reference is not installed. Open Settings → Pocket TTS — Leo and select the full voice clip.')
  }

  private async getEmbedding(): Promise<VoiceEmbedding | null> {
    if (typeof caches === 'undefined') return null
    try {
      const cache = await caches.open(VOICE_CACHE)
      const response = await cache.match(localUrl(EMBEDDING_PATH))
      return response ? deserializeEmbedding(await response.arrayBuffer()) : null
    } catch (error) {
      log.warn('Discarding invalid saved Leo voice data', { error })
      await this.deleteEmbedding()
      return null
    }
  }

  private async saveEmbedding(embedding: VoiceEmbedding): Promise<void> {
    if (typeof caches === 'undefined') return
    const cache = await caches.open(VOICE_CACHE)
    await cache.put(localUrl(EMBEDDING_PATH), new Response(serializeEmbedding(embedding), {
      headers: { 'Content-Type': 'application/octet-stream', 'X-Voice-Format': EMBEDDING_MAGIC },
    }))
    try { await navigator.storage?.persist?.() } catch { /* optional */ }
  }

  private async deleteEmbedding(): Promise<void> {
    if (typeof caches === 'undefined') return
    const cache = await caches.open(VOICE_CACHE)
    await cache.delete(localUrl(EMBEDDING_PATH))
  }

  async initialize(): Promise<void> {
    if (this.isReady && this.runtime) return
    if (this.isLoading && this.initPromise) return this.initPromise
    this.isLoading = true
    this.initPromise = this.doInitialize()
    try { await this.initPromise } finally { this.initPromise = null }
  }

  private async createRuntime(cached: boolean): Promise<PocketWorkerRuntime> {
    const runtime = new PocketWorkerRuntime()
    await runtime.initialize(cached, (status, progress) => this.onProgressCallback?.(status, progress))
    return runtime
  }

  private async doInitialize(): Promise<void> {
    let candidate: PocketWorkerRuntime | null = null
    try {
      const maxChunkChars = await settingsRepository.get('maxChunkChars')
      const deviceMaxChunkChars = isIOSDevice() ? 150 : MAX_CHUNK_CHARS
      this.config = { maxChunkChars: Math.min(deviceMaxChunkChars, Math.max(120, maxChunkChars)) }
      this.onProgressCallback?.('Loading Pocket TTS...', 0)

      const saved = await this.getEmbedding()
      if (saved) {
        try {
          candidate = await this.createRuntime(true)
          this.onProgressCallback?.('Loading saved Leo voice...', 99)
          await candidate.loadVoiceEmbedding(saved)
        } catch (error) {
          candidate?.destroy(); candidate = null
          await this.deleteEmbedding()
          log.warn('Saved Leo voice failed; rebuilding it once', { error })
        }
      }

      if (!candidate) {
        const reference = await this.getReference()
        candidate = await this.createRuntime(false)
        const rate = candidate.bundle?.sampleRate || SAMPLE_RATE
        const pcm = await decodeReference(reference, rate)
        if (pcm.length < rate) throw new Error('Leo voice sample is too short')

        // Keep Pocket's conditioning memory small enough for iOS WebKit while
        // preserving speaker identity: use one continuous speech-dense window.
        // Never average or concatenate independently encoded voice sequences.
        const conditioningPcm = selectRepresentativeWindow(pcm, rate, CONDITIONING_SECONDS)
        if (conditioningPcm.length < rate) throw new Error('Leo conditioning clip is too short')
        this.onProgressCallback?.('Preparing Leo from a continuous 12-second reference...', 99)
        const embedding = await candidate.cloneVoice(conditioningPcm)

        await this.saveEmbedding(embedding)
        log.info('Prepared Leo from one continuous reference', {
          storedSeconds: pcm.length / rate,
          conditioningSeconds: conditioningPcm.length / rate,
        })

        if (isIOSDevice()) {
          // Drop the voice-cloning runtime before narration so the large encoder
          // is not resident alongside the synthesis model during playback.
          candidate.destroy()
          candidate = await this.createRuntime(true)
          this.onProgressCallback?.('Loading saved Leo voice...', 99)
          await candidate.loadVoiceEmbedding(embedding)
        }
      }

      this.runtime = candidate
      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Pocket TTS ready', 100)
      this.onReadyCallback?.()
    } catch (error) {
      candidate?.destroy()
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
    // Pocket's browser worker exposes a single streaming audio callback.
    // Serialize every generation so foreground playback and background buffering
    // cannot steal each other's callback. Do not warm up, retry, or otherwise
    // run hidden generations: those can alter Pocket's subsequent voice state.
    const run = this.generationTail.then(
      () => this.generateChunkSerial(text, chunkIndex),
      () => this.generateChunkSerial(text, chunkIndex),
    )
    this.generationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async generateChunkSerial(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    await this.initialize()
    const runtime = this.runtime
    if (!runtime || !this.isReady) throw new Error('Pocket TTS is not initialized')
    const epoch = this.cancelEpoch
    const requestId = `pocket_${++this.requestCounter}_${Date.now()}`
    const chunks: Float32Array[] = []
    try {
      const metrics = await runtime.generate(text, (audio) => chunks.push(audio.slice()))
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
      if (!chunks.length) throw new Error('Pocket TTS returned no audio')
      const rate = runtime.bundle?.sampleRate || SAMPLE_RATE
      const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const result: PocketGeneratedAudio = {
        requestId, blob: chunksToWav(chunks, rate), duration: samples / rate, chunkIndex, text,
      }
      log.debug('Pocket TTS generated audio', { requestId, rtfx: metrics.rtfx, genTime: metrics.genTime })
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
    return splitTextIntoChunks(text, Math.min(this.config?.maxChunkChars || MAX_CHUNK_CHARS, MAX_CHUNK_CHARS))
  }
  cancelAll(): void { this.cancelEpoch++; void this.runtime?.stop() }
  destroy(): void {
    this.cancelEpoch++
    this.runtime?.destroy()
    this.runtime = null
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
