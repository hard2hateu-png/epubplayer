/**
 * Experimental Voicebox REST client.
 *
 * This file is intentionally NOT wired into the production TTS registry yet.
 * It gives us a typed, serial client for a future Voicebox trial without
 * changing the reader's current Pocket TTS behavior.
 */

export type VoiceboxTrialEngine =
  | 'qwen'
  | 'luxtts'
  | 'chatterbox'
  | 'chatterbox_turbo'
  | 'tada'
  | 'kokoro'

export interface VoiceboxTrialConfig {
  /** HTTPS URL reachable from the iPhone, e.g. https://voicebox.example.ts.net */
  baseUrl: string
  /** Voicebox voice profile UUID for Leo. */
  profileId: string
  /** Start with qwen for the first Leo comparison. */
  engine?: VoiceboxTrialEngine
  /** Qwen example: 1.7B or 0.6B. Omit to use Voicebox's engine default. */
  modelSize?: string
  language?: string
  /** Voicebox does its own sentence-aware long-text chunking and crossfade. */
  maxChunkChars?: number
  /** Fixed seed makes A/B comparisons reproducible. */
  seed?: number
}

export interface VoiceboxHealth {
  status: string
  model_loaded?: boolean
  gpu_available?: boolean
  backend_type?: string
  backend_variant?: string
  [key: string]: unknown
}

export interface VoiceboxGeneration {
  id: string
  profile_id: string
  text: string
  language: string
  audio_path: string
  duration: number
  seed?: number | null
  engine?: string | null
  model_size?: string | null
  instruct?: string | null
  created_at?: string
}

export interface VoiceboxTrialAudio {
  requestId: string
  blob: Blob
  duration: number
  text: string
  generation: VoiceboxGeneration
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) throw new Error('Voicebox server URL is required')

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Voicebox server URL is invalid')
  }

  // epubplayer-eta.vercel.app is HTTPS. iOS Safari blocks HTTP API calls from
  // an HTTPS page as mixed content, so the real iPhone trial needs TLS.
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && parsed.protocol !== 'https:') {
    throw new Error('Voicebox must use an HTTPS URL when the reader is opened over HTTPS')
  }

  return parsed.toString().replace(/\/+$/, '')
}

export class VoiceboxTrialClient {
  private tail: Promise<void> = Promise.resolve()

  async health(config: Pick<VoiceboxTrialConfig, 'baseUrl'>): Promise<VoiceboxHealth> {
    const baseUrl = normalizeBaseUrl(config.baseUrl)
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`Voicebox health check failed (${response.status})`)
    const health = await response.json() as VoiceboxHealth
    if (health.status !== 'healthy') throw new Error(`Voicebox is not healthy (${String(health.status)})`)
    return health
  }

  async generate(config: VoiceboxTrialConfig, text: string): Promise<VoiceboxTrialAudio> {
    const run = this.tail.then(
      () => this.generateSerial(config, text),
      () => this.generateSerial(config, text),
    )
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async generateSerial(config: VoiceboxTrialConfig, text: string): Promise<VoiceboxTrialAudio> {
    const baseUrl = normalizeBaseUrl(config.baseUrl)
    const cleanText = text.trim()
    if (!cleanText) throw new Error('Voicebox text is empty')
    if (!config.profileId.trim()) throw new Error('Leo Voicebox profile ID is required')

    const body: Record<string, unknown> = {
      profile_id: config.profileId.trim(),
      text: cleanText,
      language: config.language || 'en',
      engine: config.engine || 'qwen',
      max_chunk_chars: config.maxChunkChars ?? 800,
      seed: config.seed ?? 42,
    }
    if (config.modelSize) body.model_size = config.modelSize

    const generationResponse = await fetch(`${baseUrl}/generate`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!generationResponse.ok) {
      const detail = await generationResponse.text().catch(() => '')
      throw new Error(`Voicebox generation failed (${generationResponse.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
    }

    const generation = await generationResponse.json() as VoiceboxGeneration
    if (!generation.id) throw new Error('Voicebox generation response did not include an ID')

    const audioResponse = await fetch(`${baseUrl}/audio/${encodeURIComponent(generation.id)}`, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!audioResponse.ok) throw new Error(`Voicebox audio download failed (${audioResponse.status})`)

    const blob = await audioResponse.blob()
    if (!blob.size) throw new Error('Voicebox returned an empty audio file')

    return {
      requestId: `voicebox_${generation.id}`,
      blob,
      duration: Number(generation.duration) || 0,
      text: cleanText,
      generation,
    }
  }
}

export const voiceboxTrialClient = new VoiceboxTrialClient()
