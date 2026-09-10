from pathlib import Path


def replace_one(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


# 1. Canonical engine type
replace_one(
    "src/services/tts/types.ts",
    "export type TTSEngine = 'browser' | 'piper' | 'kokoro' | 'supertonic' | 'sherpa' | 'kitten' | 'pocket'",
    "export type TTSEngine = 'browser' | 'piper' | 'kokoro' | 'supertonic' | 'sherpa' | 'kitten' | 'pocket' | 'chatterbox'",
)

# 2. Persisted settings accept Chatterbox
replace_one(
    "src/services/storage/settingsRepository.ts",
    "  'pocket',\n])",
    "  'pocket',\n  'chatterbox',\n])",
)

# 3. Reuse the private Leo reference already stored on-device for both clone engines.
replace_one(
    "src/services/tts/pocketService.ts",
    "  async hasCustomLeoVoiceSample(): Promise<boolean> { return this.hasLeoVoiceSample() }\n\n  async installLeoVoiceSample(blob: Blob): Promise<void> {",
    "  async hasCustomLeoVoiceSample(): Promise<boolean> { return this.hasLeoVoiceSample() }\n\n  /** Return a short speech-dense WAV derived from the private Leo reference. */\n  async getLeoPromptWav(seconds = 10): Promise<Blob> {\n    const safeSeconds = Math.max(6, Math.min(15, seconds))\n    const reference = await this.getReference()\n    const pcm = await decodeReference(reference, SAMPLE_RATE)\n    if (pcm.length < SAMPLE_RATE * 5) throw new Error('Leo voice sample is too short')\n    const prompt = selectRepresentativeWindow(pcm, SAMPLE_RATE, safeSeconds)\n    return chunksToWav([prompt], SAMPLE_RATE)\n  }\n\n  async installLeoVoiceSample(blob: Blob): Promise<void> {",
)

# 4. New Chatterbox service. The model is NOT bundled into Safari: this talks to
# ResembleAI's official public Chatterbox-Turbo Space and stores generated WAVs in
# the reader's existing local cache.
Path("src/services/tts/chatterboxService.ts").write_text(r'''/** Chatterbox-Turbo — English zero-shot Leo voice cloning via ResembleAI's official Space. */
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
''')

# 5. Public service export
replace_one(
    "src/services/tts/index.ts",
    "// Pocket TTS custom voice service\nexport { pocketService, POCKET_VOICE_NAME, POCKET_VOICE_ID } from './pocketService'\nexport type { PocketConfig, PocketGeneratedAudio } from './pocketService'\n",
    "// Pocket TTS custom voice service\nexport { pocketService, POCKET_VOICE_NAME, POCKET_VOICE_ID } from './pocketService'\nexport type { PocketConfig, PocketGeneratedAudio } from './pocketService'\n\n// Chatterbox-Turbo remote voice-clone service\nexport { chatterboxService } from './chatterboxService'\nexport type { ChatterboxGeneratedAudio } from './chatterboxService'\n",
)

# 6. TTS manager registration / lifecycle
replace_one(
    "src/services/tts/ttsManager.ts",
    "import { pocketService } from './pocketService'\n",
    "import { pocketService } from './pocketService'\nimport { chatterboxService } from './chatterboxService'\n",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "  pocket: {\n    id: 'pocket',\n    name: 'Pocket TTS (Leo)',\n    description: 'Custom local Leo voice clone. Runs on-device and uses the normal generated-audio cache.',\n    available: true,\n    capabilities: {\n      generatesBlobs: true,\n      requiresInit: true,\n      slowOnCPU: false,\n    },\n  },\n  piper: {",
    "  pocket: {\n    id: 'pocket',\n    name: 'Pocket TTS (Leo)',\n    description: 'Custom local Leo voice clone. Runs on-device and uses the normal generated-audio cache.',\n    available: true,\n    capabilities: {\n      generatesBlobs: true,\n      requiresInit: true,\n      slowOnCPU: false,\n    },\n  },\n  chatterbox: {\n    id: 'chatterbox',\n    name: 'Chatterbox (Leo)',\n    description: 'English Chatterbox-Turbo voice cloning using the saved Leo reference.',\n    available: true,\n    capabilities: {\n      generatesBlobs: true,\n      requiresInit: true,\n      slowOnCPU: false,\n    },\n  },\n  piper: {",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "        case 'pocket':\n          this.wireUpService(pocketService, 'pocket')\n          await pocketService.initialize()\n          break\n\n        case 'browser':",
    "        case 'pocket':\n          this.wireUpService(pocketService, 'pocket')\n          await pocketService.initialize()\n          break\n\n        case 'chatterbox':\n          this.wireUpService(chatterboxService, 'chatterbox')\n          await chatterboxService.initialize()\n          break\n\n        case 'browser':",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "        case 'pocket': {\n          const result = await pocketService.generateChunk(text, chunkIndex)\n          return {\n            requestId: result.requestId,\n            blob: result.blob,\n            duration: result.duration,\n            chunkIndex: result.chunkIndex,\n            text: result.text,\n          }\n        }\n\n        default:",
    "        case 'pocket': {\n          const result = await pocketService.generateChunk(text, chunkIndex)\n          return {\n            requestId: result.requestId,\n            blob: result.blob,\n            duration: result.duration,\n            chunkIndex: result.chunkIndex,\n            text: result.text,\n          }\n        }\n\n        case 'chatterbox': {\n          const result = await chatterboxService.generateChunk(text, chunkIndex)\n          return {\n            requestId: result.requestId,\n            blob: result.blob,\n            duration: result.duration,\n            chunkIndex: result.chunkIndex,\n            text: result.text,\n          }\n        }\n\n        default:",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "      case 'pocket':\n        return pocketService.splitIntoChunks(text)\n      default:",
    "      case 'pocket':\n        return pocketService.splitIntoChunks(text)\n      case 'chatterbox':\n        return chatterboxService.splitIntoChunks(text)\n      default:",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "      case 'pocket':\n        pocketService.cancelAll()\n        break\n    }\n  }\n\n  destroy(): void {",
    "      case 'pocket':\n        pocketService.cancelAll()\n        break\n      case 'chatterbox':\n        chatterboxService.cancelAll()\n        break\n    }\n  }\n\n  destroy(): void {",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "      case 'pocket':\n        pocketService.destroy()\n        break\n    }\n    this.isInitialized = false\n  }",
    "      case 'pocket':\n        pocketService.destroy()\n        break\n      case 'chatterbox':\n        chatterboxService.destroy()\n        break\n    }\n    this.isInitialized = false\n    this.isInitializing = false\n    this.initPromise = null\n  }",
)

# 7. Settings UI: preserve the old layout and simply add Chatterbox + Voice = Leo.
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "    { id: 'pocket' as TTSEngine, name: t`Pocket TTS`, description: t`Custom on-device voice.` },\n    { id: 'sherpa' as TTSEngine,",
    "    { id: 'pocket' as TTSEngine, name: t`Pocket TTS`, description: t`Custom on-device voice.` },\n    { id: 'chatterbox' as TTSEngine, name: t`Chatterbox`, description: t`High-quality English voice cloning.` },\n    { id: 'sherpa' as TTSEngine,",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "          {settings.ttsEngine === 'piper' && (",
    "          {settings.ttsEngine === 'chatterbox' && (\n            <>\n              <SettingsItem\n                icon={<VolumeIcon className=\"h-5 w-5\" />}\n                label={t`Voice`}\n                value=\"Leo\"\n                onClick={() => setActiveSheet('pocketLeo')}\n              />\n              <SettingsItem\n                label={t`Buffer Ahead`}\n                value={getBufferAheadLabel()}\n                description={t`Keeps generating ahead even while paused`}\n                onClick={() => setActiveSheet('bufferAhead')}\n              />\n            </>\n          )}\n          {settings.ttsEngine === 'piper' && (",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "              settings.ttsEngine === 'pocket' ? 'Pocket TTS — Leo' :\n              settings.ttsEngine === 'sherpa' ? 'Sherpa-ONNX' :",
    "              settings.ttsEngine === 'pocket' ? 'Pocket TTS — Leo' :\n              settings.ttsEngine === 'chatterbox' ? 'Chatterbox-Turbo — Leo' :\n              settings.ttsEngine === 'sherpa' ? 'Sherpa-ONNX' :",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "      <PocketVoiceSetupSheet\n        isOpen={activeSheet === 'pocketLeo'}\n        onClose={() => setActiveSheet(null)}\n        onInstalledChange={setPocketVoiceInstalled}\n      />",
    "      <PocketVoiceSetupSheet\n        isOpen={activeSheet === 'pocketLeo'}\n        onClose={() => setActiveSheet(null)}\n        onInstalledChange={setPocketVoiceInstalled}\n        engine={settings.ttsEngine === 'chatterbox' ? 'chatterbox' : 'pocket'}\n      />",
)
# Selecting Pocket used to force the setup sheet. Remove that behavior: engine first, Voice row second.
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "          if (engine === 'pocket') {\n            const installed = await pocketService.hasLeoVoiceSample()\n            setPocketVoiceInstalled(installed)\n            if (!installed) {\n              setActiveSheet('pocketLeo')\n              return\n            }\n          }\n          \n",
    "",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "          } else if (engine === 'pocket') {\n            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.\n            await settingsRepository.set('voiceId', 'pocket:leo')\n            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))\n          }\n\n          // PlaybackController currently resolves the outgoing engine's voice during a hot-swap.\n          // A one-time page reload when switching to/from Pocket avoids a transient wrong cache key\n          // without changing the stable playback controller used by the existing engines.\n          const switchingToOrFromPocket = engine === 'pocket' || settings.ttsEngine === 'pocket'\n          if (switchingToOrFromPocket) {\n            await settingsRepository.set('ttsEngine', engine)\n            setSettings((prev) => ({ ...prev, ttsEngine: engine }))\n            setActiveSheet(null)\n            ttsManager.destroy()\n            window.location.reload()\n            return\n          }\n          \n          // Now update the engine (which triggers reloadTTSSettings with correct voice)\n          await updateSetting('ttsEngine', engine)",
    "          } else if (engine === 'pocket') {\n            await settingsRepository.set('voiceId', 'pocket:leo')\n            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))\n          } else if (engine === 'chatterbox') {\n            await settingsRepository.set('voiceId', 'chatterbox:leo')\n            setSettings((prev) => ({ ...prev, voiceId: 'chatterbox:leo' }))\n          }\n\n          // Apply the selected engine without forcing a page reload.\n          await updateSetting('ttsEngine', engine)",
)

# 8. Make the existing Leo sheet engine-aware and lightweight. Installing a
# reference no longer downloads/initializes Pocket unless the user actually plays Pocket.
p = Path("src/features/settings/PocketVoiceSetupSheet.tsx")
text = p.read_text()
text = text.replace(
    "  onInstalledChange,\n}: {\n  isOpen: boolean\n  onClose: () => void\n  onInstalledChange?: (installed: boolean) => void\n}) {",
    "  onInstalledChange,\n  engine = 'pocket',\n}: {\n  isOpen: boolean\n  onClose: () => void\n  onInstalledChange?: (installed: boolean) => void\n  engine?: 'pocket' | 'chatterbox'\n}) {",
)
text = text.replace("        setActive(engine === 'pocket')", "        setActive(hasReference && engine === arguments[0])")
# The replacement above would be invalid because Promise callback shadows engine; use a precise rewrite below.
text = text.replace(
    ".then(([hasReference, engine]) => {\n        if (cancelled) return\n        setInstalled(hasReference)\n        setActive(hasReference && engine === arguments[0])",
    ".then(([hasReference, selectedEngine]) => {\n        if (cancelled) return\n        setInstalled(hasReference)\n        setActive(hasReference && selectedEngine === engine)",
)
text = text.replace("  }, [isOpen, onInstalledChange])", "  }, [isOpen, onInstalledChange, engine])")
text = text.replace("      throw new Error('Install the Leo reference before using Pocket TTS.')", "      throw new Error('Install the Leo reference first.')")
text = text.replace(
    "    // Pocket has one custom voice. Keep its engine + cache identity in sync so\n    // Settings, playback, and generated-audio caching all agree that Leo is active.\n    await settingsRepository.set('voiceId', 'pocket:leo')\n    await settingsRepository.set('ttsEngine', 'pocket')",
    "    const voiceId = engine === 'chatterbox' ? 'chatterbox:leo' : 'pocket:leo'\n    await settingsRepository.set('voiceId', voiceId)\n    await settingsRepository.set('ttsEngine', engine)",
)
text = text.replace(
    "    // The settings page already renders Pocket-specific controls from ttsEngine.\n    // Reload once so Supertonic/Kokoro controls disappear immediately and Voice = Leo.\n    window.location.reload()",
    "    window.location.reload()",
)
text = text.replace(
    "      setMessage(\n        'Preparing Leo. First setup can take a while.'\n      )\n      await pocketService.initialize()\n      setMessage('Leo is ready.')\n      await activateLeo()",
    "      setMessage('Leo is ready.')\n      await activateLeo()",
)
text = text.replace("              Pocket TTS on this device.", "              {engine === 'chatterbox' ? 'Chatterbox voice clone.' : 'Pocket TTS on this device.'}")
text = text.replace("                Pocket TTS is selected.", "                {engine === 'chatterbox' ? 'Chatterbox is selected.' : 'Pocket TTS is selected.'}")
text = text.replace(
    "            Pocket downloads its model once and keeps it on this device.",
    "            {engine === 'chatterbox'\n              ? 'Chatterbox sends a short Leo reference to ResembleAI’s Hugging Face Space when it generates audio.'\n              : 'Pocket downloads its model once and keeps it on this device.'}",
)
p.write_text(text)

# 9. Keep free remote generation conservative on iPhone and isolate cache versions.
replace_one(
    "src/features/player/TTSBufferManager.ts",
    "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'\n\nfunction cacheModelConfig(ctx: BufferContext): string {\n  return ctx.engine === 'pocket' ? `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}` : ctx.modelConfig\n}",
    "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'\nconst CHATTERBOX_AUDIO_CACHE_VERSION = 'chatterbox-turbo-leo-v1'\n\nfunction cacheModelConfig(ctx: BufferContext): string {\n  if (ctx.engine === 'pocket') return `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}`\n  if (ctx.engine === 'chatterbox') return `${ctx.modelConfig}:${CHATTERBOX_AUDIO_CACHE_VERSION}`\n  return ctx.modelConfig\n}",
)
replace_one(
    "src/features/player/TTSBufferManager.ts",
    "function getIOSBufferLimit(engine?: TTSEngine): number {\n  return engine === 'pocket' ? IOS_POCKET_MAX_BUFFER_CHUNKS : IOS_MAX_BUFFER_CHUNKS\n}",
    "function getIOSBufferLimit(engine?: TTSEngine): number {\n  return engine === 'pocket' || engine === 'chatterbox' ? IOS_POCKET_MAX_BUFFER_CHUNKS : IOS_MAX_BUFFER_CHUNKS\n}",
)

# 10. Clarify comments in the controller; voiceId already gives Chatterbox its unique Leo cache identity.
replace_one(
    "src/features/player/PlaybackController.ts",
    "   * - kitten: kittenVoice\n   */",
    "   * - kitten: kittenVoice\n   * - pocket/chatterbox: voiceId (Leo-specific cache identity)\n   */",
)

print('Chatterbox patch applied successfully.')
