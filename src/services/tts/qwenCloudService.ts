/** Qwen3-TTS cloud voice clone for Leo via the app's same-origin Vercel proxy. */
import { createLogger } from '@/services/logging'
import { splitTextIntoChunks } from './textChunking'

const log = createLogger('tts')

const TOKEN_KEY = 'epubplayer.replicateApiToken'
const QWEN_CACHE = 'epub-player-qwen-cloud-v1'
const REFERENCE_DATA_PATH = '/__epubplayer/qwen/leo-reference-18s-v1'
const REFERENCE_TEXT_PATH = '/__epubplayer/qwen/leo-reference-text-v1'
const POCKET_VOICE_CACHE = 'epub-player-pocket-voices-v2'
const POCKET_REFERENCE_PATH = '/__epubplayer/pocket/voices/leo-reference-v2'
const LEGACY_VOICE_CACHE = 'epub-player-pocket-voices-v1'
const LEGACY_REFERENCE_PATH = '/__epubplayer/pocket/voices/leo'
const TARGET_RATE = 16_000
const REFERENCE_SECONDS = 18
const MAX_CHUNK_CHARS = 420

export const QWEN_VOICE_ID = 'qwen:leo'
export const QWEN_VOICE_NAME = 'Leo'

export interface QwenCloudGeneratedAudio {
  requestId: string
  blob: Blob
  duration: number
  chunkIndex: number
  text: string
}

type AudioCallback = (audio: QwenCloudGeneratedAudio) => void
type ProgressCallback = (status: string, progress?: number) => void
type ErrorCallback = (error: string) => void
type ReadyCallback = () => void

type PreparedReference = {
  dataUrl: string
  transcript: string
}

function localUrl(path: string): string {
  if (typeof window === 'undefined') return `https://local.invalid${path}`
  return new URL(path, window.location.origin).toString()
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null
  return window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext || null
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input.slice()
  const outputLength = Math.max(1, Math.round(input.length * toRate / fromRate))
  const output = new Float32Array(outputLength)
  const ratio = fromRate / toRate
  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio
    const left = Math.min(input.length - 1, Math.floor(position))
    const right = Math.min(input.length - 1, left + 1)
    const fraction = position - left
    output[i] = input[left] * (1 - fraction) + input[right] * fraction
  }
  return output
}

function normalizePcm(input: Float32Array): Float32Array {
  if (!input.length) return input
  let mean = 0
  for (let i = 0; i < input.length; i++) mean += input[i]
  mean /= input.length
  let peak = 0
  const output = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] - mean
    peak = Math.max(peak, Math.abs(output[i]))
  }
  if (peak > 0.0001) {
    const gain = Math.min(1.0, 0.92 / peak)
    for (let i = 0; i < output.length; i++) output[i] *= gain
  }
  return output
}

function selectSpeechDenseWindow(input: Float32Array, sampleRate: number, seconds: number): Float32Array {
  const wanted = Math.min(input.length, Math.floor(sampleRate * seconds))
  if (input.length <= wanted) return input.slice()
  const block = Math.max(1, Math.floor(sampleRate * 0.25))
  const blocks = Math.ceil(input.length / block)
  const energy = new Float64Array(blocks)
  for (let b = 0; b < blocks; b++) {
    const start = b * block
    const end = Math.min(input.length, start + block)
    let sum = 0
    for (let i = start; i < end; i++) sum += input[i] * input[i]
    energy[b] = sum / Math.max(1, end - start)
  }
  const width = Math.max(1, Math.ceil(wanted / block))
  let running = 0
  for (let i = 0; i < width; i++) running += energy[i] || 0
  let best = running
  let bestBlock = 0
  for (let b = 1; b + width <= blocks; b++) {
    running += energy[b + width - 1] - energy[b - 1]
    if (running > best) {
      best = running
      bestBlock = b
    }
  }
  const start = Math.min(bestBlock * block, input.length - wanted)
  return input.slice(start, start + wanted)
}

function pcmToWav(pcm: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  let offset = 44
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    const sample = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Could not read Leo reference'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(blob)
  })
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

async function decodeReference(blob: Blob): Promise<Float32Array> {
  const Ctor = getAudioContextCtor()
  if (!Ctor) throw new Error('Web Audio is unavailable on this device')
  const context = new Ctor()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const mono = new Float32Array(decoded.length)
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const data = decoded.getChannelData(channel)
      for (let i = 0; i < decoded.length; i++) mono[i] += data[i] / decoded.numberOfChannels
    }
    const resampled = resampleLinear(mono, decoded.sampleRate, TARGET_RATE)
    return normalizePcm(selectSpeechDenseWindow(resampled, TARGET_RATE, REFERENCE_SECONDS))
  } finally {
    void context.close().catch(() => undefined)
  }
}

async function readCachedText(path: string): Promise<string | null> {
  if (typeof caches === 'undefined') return null
  const cache = await caches.open(QWEN_CACHE)
  const hit = await cache.match(localUrl(path))
  return hit ? hit.text() : null
}

async function writeCachedText(path: string, value: string): Promise<void> {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(QWEN_CACHE)
  await cache.put(localUrl(path), new Response(value, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
}

class QwenCloudService {
  private isReady = false
  private isLoading = false
  private initPromise: Promise<void> | null = null
  private prepared: PreparedReference | null = null
  private requestCounter = 0
  private cancelEpoch = 0
  private onAudioCallback?: AudioCallback
  private onProgressCallback?: ProgressCallback
  private onErrorCallback?: ErrorCallback
  private onReadyCallback?: ReadyCallback

  getToken(): string {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(TOKEN_KEY)?.trim() || ''
  }

  setToken(token: string): void {
    if (typeof localStorage === 'undefined') return
    const clean = token.trim()
    if (clean) localStorage.setItem(TOKEN_KEY, clean)
    else localStorage.removeItem(TOKEN_KEY)
    this.destroy()
  }

  hasToken(): boolean {
    return Boolean(this.getToken())
  }

  async hasLeoReference(): Promise<boolean> {
    try {
      await this.getLeoReferenceBlob()
      return true
    } catch {
      return false
    }
  }

  async testConnection(): Promise<string> {
    const response = await this.callApi({ action: 'health' })
    const data = await response.json() as { ok?: boolean; account?: string; error?: string }
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not connect to Replicate')
    return data.account || 'Replicate'
  }

  private async getLeoReferenceBlob(): Promise<Blob> {
    if (typeof caches === 'undefined') throw new Error('Browser Cache Storage is unavailable')
    const current = await caches.open(POCKET_VOICE_CACHE)
    const hit = await current.match(localUrl(POCKET_REFERENCE_PATH))
    if (hit) return hit.blob()
    const legacy = await caches.open(LEGACY_VOICE_CACHE)
    const old = await legacy.match(localUrl(LEGACY_REFERENCE_PATH))
    if (old) return old.blob()
    throw new Error('Leo reference is not installed on this device')
  }

  private async prepareReference(transcribe = true): Promise<PreparedReference> {
    if (this.prepared) return this.prepared
    const cachedDataUrl = await readCachedText(REFERENCE_DATA_PATH)
    let dataUrl = cachedDataUrl || ''
    if (!dataUrl) {
      this.onProgressCallback?.('Preparing Leo reference for Qwen…', 20)
      const pcm = await decodeReference(await this.getLeoReferenceBlob())
      if (pcm.length < TARGET_RATE * 3) throw new Error('Leo reference is too short')
      dataUrl = await blobToDataUrl(pcmToWav(pcm, TARGET_RATE))
      await writeCachedText(REFERENCE_DATA_PATH, dataUrl)
    }

    let transcript = (await readCachedText(REFERENCE_TEXT_PATH)) || ''
    if (!transcript && transcribe) {
      this.onProgressCallback?.('Transcribing Leo once for a closer clone…', 55)
      const response = await this.callApi({ action: 'transcribe', referenceAudio: dataUrl })
      const data = await response.json() as { transcript?: string; error?: string }
      if (!response.ok) throw new Error(data.error || 'Could not transcribe Leo reference')
      transcript = data.transcript?.trim() || ''
      if (transcript) await writeCachedText(REFERENCE_TEXT_PATH, transcript)
    }

    this.prepared = { dataUrl, transcript }
    return this.prepared
  }

  private async callApi(body: Record<string, unknown>): Promise<Response> {
    const token = this.getToken()
    if (!token) throw new Error('Replicate API token is not configured')
    return fetch('/api/qwen-cloud', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
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
      this.onProgressCallback?.('Connecting to Qwen3-TTS…', 5)
      await this.testConnection()
      await this.prepareReference(true)
      this.isReady = true
      this.isLoading = false
      this.onProgressCallback?.('Qwen3-TTS — Leo ready', 100)
      this.onReadyCallback?.()
    } catch (error) {
      this.isReady = false
      this.isLoading = false
      const message = error instanceof Error ? error.message : String(error)
      this.onErrorCallback?.(message)
      throw error
    }
  }

  async generateChunk(text: string, chunkIndex: number): Promise<QwenCloudGeneratedAudio> {
    await this.initialize()
    const prepared = await this.prepareReference(false)
    const epoch = this.cancelEpoch
    const requestId = `qwen_${++this.requestCounter}_${Date.now()}`
    try {
      const response = await this.callApi({
        action: 'synthesize',
        text,
        referenceAudio: prepared.dataUrl,
        referenceText: prepared.transcript,
        styleInstruction: 'Natural audiobook narration. Preserve the reference speaker voice and accent. Speak clearly at a steady conversational pace with natural sentence-level pauses. Avoid whispering, exaggerated breaths, dramatic acting, or rushing.',
      })
      if (!response.ok) {
        let message = `Qwen generation failed (${response.status})`
        try {
          const data = await response.json() as { error?: string }
          if (data.error) message = data.error
        } catch { /* audio/json mismatch */ }
        throw new Error(message)
      }
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
      const blob = await response.blob()
      if (!blob.size) throw new Error('Qwen returned empty audio')
      const result: QwenCloudGeneratedAudio = {
        requestId,
        blob,
        duration: await audioDuration(blob),
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
    }
  }

  splitIntoChunks(text: string): string[] {
    return splitTextIntoChunks(text, MAX_CHUNK_CHARS)
  }

  cancelAll(): void {
    this.cancelEpoch += 1
  }

  destroy(): void {
    this.cancelAll()
    this.isReady = false
    this.isLoading = false
    this.initPromise = null
  }

  async clearPreparedReference(): Promise<void> {
    this.prepared = null
    if (typeof caches === 'undefined') return
    const cache = await caches.open(QWEN_CACHE)
    await Promise.all([
      cache.delete(localUrl(REFERENCE_DATA_PATH)),
      cache.delete(localUrl(REFERENCE_TEXT_PATH)),
    ])
    this.destroy()
  }

  getIsReady(): boolean { return this.isReady }
  getIsLoading(): boolean { return this.isLoading }
  onAudio(callback: AudioCallback): void { this.onAudioCallback = callback }
  onProgress(callback: ProgressCallback): void { this.onProgressCallback = callback }
  onError(callback: ErrorCallback): void { this.onErrorCallback = callback }
  onReady(callback: ReadyCallback): void { this.onReadyCallback = callback }
}

export const qwenCloudService = new QwenCloudService()
