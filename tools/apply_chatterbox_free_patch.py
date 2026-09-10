from pathlib import Path


def replace_one(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, found {count}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Canonical engine type.
replace_one(
    "src/services/tts/types.ts",
    "export type TTSEngine = 'browser' | 'piper' | 'kokoro' | 'supertonic' | 'sherpa' | 'kitten' | 'pocket'",
    "export type TTSEngine = 'browser' | 'piper' | 'kokoro' | 'supertonic' | 'sherpa' | 'kitten' | 'pocket' | 'chatterbox'",
)

# Stored settings can retain Chatterbox once the endpoint is configured.
replace_one(
    "src/services/storage/settingsRepository.ts",
    "  'pocket',\n])",
    "  'pocket',\n  'chatterbox',\n])",
)

# Expose only a short, in-memory WAV derived from the locally stored private Leo reference.
# No reference audio or embedding is written to the repository.
replace_one(
    "src/services/tts/pocketService.ts",
    "  async hasCustomLeoVoiceSample(): Promise<boolean> { return this.hasLeoVoiceSample() }\n\n  async installLeoVoiceSample(blob: Blob): Promise<void> {",
    "  async hasCustomLeoVoiceSample(): Promise<boolean> { return this.hasLeoVoiceSample() }\n\n  /** Return a short speech-dense WAV derived from the private on-device Leo reference. */\n  async getLeoPromptWav(seconds = 10): Promise<Blob> {\n    const safeSeconds = Math.max(6, Math.min(15, seconds))\n    const reference = await this.getReference()\n    const pcm = await decodeReference(reference, SAMPLE_RATE)\n    if (pcm.length < SAMPLE_RATE * 5) throw new Error('Leo voice sample is too short')\n    const prompt = selectRepresentativeWindow(pcm, SAMPLE_RATE, safeSeconds)\n    return chunksToWav([prompt], SAMPLE_RATE)\n  }\n\n  async installLeoVoiceSample(blob: Blob): Promise<void> {",
)

# Isolated browser adapter. It is hidden from Settings unless VITE_CHATTERBOX_ENDPOINT
# is supplied at build time. The endpoint is a Gradio Space URL or owner/space id.
Path("src/services/tts/chatterboxService.ts").write_text(r'''/**
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
''')

# Public export.
replace_one(
    "src/services/tts/index.ts",
    "// Pocket TTS custom voice service\nexport { pocketService, POCKET_VOICE_NAME, POCKET_VOICE_ID } from './pocketService'\nexport type { PocketConfig, PocketGeneratedAudio } from './pocketService'\n",
    "// Pocket TTS custom voice service\nexport { pocketService, POCKET_VOICE_NAME, POCKET_VOICE_ID } from './pocketService'\nexport type { PocketConfig, PocketGeneratedAudio } from './pocketService'\n\n// Chatterbox remote voice-clone service\nexport { chatterboxService, isChatterboxConfigured } from './chatterboxService'\nexport type { ChatterboxGeneratedAudio } from './chatterboxService'\n",
)

# TTS manager registration/lifecycle. Existing engines are not modified.
replace_one(
    "src/services/tts/ttsManager.ts",
    "import { pocketService } from './pocketService'\n",
    "import { pocketService } from './pocketService'\nimport { chatterboxService, isChatterboxConfigured } from './chatterboxService'\n",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "  piper: {\n",
    "  chatterbox: {\n    id: 'chatterbox',\n    name: 'Chatterbox',\n    description: 'English Leo voice cloning on a remote free host.',\n    available: isChatterboxConfigured(),\n    capabilities: {\n      generatesBlobs: true,\n      requiresInit: true,\n      slowOnCPU: false,\n    },\n  },\n  piper: {\n",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "        case 'browser':\n          // Browser TTS doesn't need initialization\n          break\n",
    "        case 'chatterbox':\n          this.wireUpService(chatterboxService, 'chatterbox')\n          await chatterboxService.initialize()\n          break\n\n        case 'browser':\n          // Browser TTS doesn't need initialization\n          break\n",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "        default:\n          throw new Error(`Unknown TTS engine: ${this.currentEngine}`)\n",
    "        case 'chatterbox': {\n          const result = await chatterboxService.generateChunk(text, chunkIndex)\n          return {\n            requestId: result.requestId,\n            blob: result.blob,\n            duration: result.duration,\n            chunkIndex: result.chunkIndex,\n            text: result.text,\n          }\n        }\n\n        default:\n          throw new Error(`Unknown TTS engine: ${this.currentEngine}`)\n",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "      case 'pocket':\n        return pocketService.splitIntoChunks(text)\n      default:\n",
    "      case 'pocket':\n        return pocketService.splitIntoChunks(text)\n      case 'chatterbox':\n        return chatterboxService.splitIntoChunks(text)\n      default:\n",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "      case 'pocket':\n        pocketService.cancelAll()\n        break\n    }\n  }\n\n  destroy(): void {",
    "      case 'pocket':\n        pocketService.cancelAll()\n        break\n      case 'chatterbox':\n        chatterboxService.cancelAll()\n        break\n    }\n  }\n\n  destroy(): void {",
)
replace_one(
    "src/services/tts/ttsManager.ts",
    "      case 'pocket':\n        pocketService.destroy()\n        break\n    }\n    this.isInitialized = false\n",
    "      case 'pocket':\n        pocketService.destroy()\n        break\n      case 'chatterbox':\n        chatterboxService.destroy()\n        break\n    }\n    this.isInitialized = false\n",
)

# Keep Chatterbox cache/versioning independent and limit free-host lookahead on iOS.
replace_one(
    "src/features/player/TTSBufferManager.ts",
    "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'\n\nfunction cacheModelConfig(ctx: BufferContext): string {\n  return ctx.engine === 'pocket' ? `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}` : ctx.modelConfig\n}",
    "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'\nconst CHATTERBOX_AUDIO_CACHE_VERSION = 'chatterbox-free-leo-v1'\n\nfunction cacheModelConfig(ctx: BufferContext): string {\n  if (ctx.engine === 'pocket') return `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}`\n  if (ctx.engine === 'chatterbox') return `${ctx.modelConfig}:${CHATTERBOX_AUDIO_CACHE_VERSION}`\n  return ctx.modelConfig\n}",
)
replace_one(
    "src/features/player/TTSBufferManager.ts",
    "const IOS_POCKET_MAX_BUFFER_CHUNKS = 2\n\nfunction getIOSBufferLimit(engine?: TTSEngine): number {\n  return engine === 'pocket' ? IOS_POCKET_MAX_BUFFER_CHUNKS : IOS_MAX_BUFFER_CHUNKS\n}",
    "const IOS_POCKET_MAX_BUFFER_CHUNKS = 2\nconst IOS_CHATTERBOX_MAX_BUFFER_CHUNKS = 3\n\nfunction getIOSBufferLimit(engine?: TTSEngine): number {\n  if (engine === 'pocket') return IOS_POCKET_MAX_BUFFER_CHUNKS\n  if (engine === 'chatterbox') return IOS_CHATTERBOX_MAX_BUFFER_CHUNKS\n  return IOS_MAX_BUFFER_CHUNKS\n}",
)

# Settings: preserve the restored labels/layout; add Chatterbox only when configured.
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "import { ttsManager, pocketService, type TTSEngine } from '@/services/tts'",
    "import { ttsManager, pocketService, isChatterboxConfigured, type TTSEngine } from '@/services/tts'",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "    { id: 'pocket' as TTSEngine, name: t`Pocket TTS`, description: t`Custom on-device voice.` },\n",
    "    { id: 'pocket' as TTSEngine, name: t`Pocket TTS`, description: t`Custom on-device voice.` },\n    ...(isChatterboxConfigured() ? [{ id: 'chatterbox' as TTSEngine, name: t`Chatterbox`, description: t`English Leo voice clone on a remote free host.` }] : []),\n",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "          {settings.ttsEngine === 'piper' && (\n",
    "          {settings.ttsEngine === 'chatterbox' && (\n            <>\n              <SettingsItem\n                icon={<VolumeIcon className=\"h-5 w-5\" />}\n                label={t`Voice`}\n                value=\"Leo\"\n                onClick={() => setActiveSheet('pocketLeo')}\n              />\n              <SettingsItem\n                label={t`Buffer Ahead`}\n                value={getBufferAheadLabel()}\n                description={t`Keeps generating ahead even while paused`}\n                onClick={() => setActiveSheet('bufferAhead')}\n              />\n            </>\n          )}\n          {settings.ttsEngine === 'piper' && (\n",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "              settings.ttsEngine === 'pocket' ? 'Pocket TTS — Leo' :\n",
    "              settings.ttsEngine === 'pocket' ? 'Pocket TTS — Leo' :\n              settings.ttsEngine === 'chatterbox' ? 'Chatterbox — Leo' :\n",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "        onInstalledChange={setPocketVoiceInstalled}\n      />",
    "        onInstalledChange={setPocketVoiceInstalled}\n        engine={settings.ttsEngine === 'chatterbox' ? 'chatterbox' : 'pocket'}\n      />",
)
# Fix the confirmed Pocket bug: selecting the engine must never open setup automatically.
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "          if (engine === 'pocket') {\n            const installed = await pocketService.hasLeoVoiceSample()\n            setPocketVoiceInstalled(installed)\n            if (!installed) {\n              setActiveSheet('pocketLeo')\n              return\n            }\n          }\n          \n",
    "",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "          } else if (engine === 'pocket') {\n            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.\n            await settingsRepository.set('voiceId', 'pocket:leo')\n            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))\n          }\n",
    "          } else if (engine === 'pocket') {\n            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.\n            await settingsRepository.set('voiceId', 'pocket:leo')\n            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))\n          } else if (engine === 'chatterbox') {\n            await settingsRepository.set('voiceId', 'chatterbox:leo')\n            setSettings((prev) => ({ ...prev, voiceId: 'chatterbox:leo' }))\n          }\n",
)
replace_one(
    "src/features/settings/SettingsPage.tsx",
    "          const switchingToOrFromPocket = engine === 'pocket' || settings.ttsEngine === 'pocket'\n          if (switchingToOrFromPocket) {",
    "          const switchingToOrFromLeoEngine =\n            engine === 'pocket' || engine === 'chatterbox' ||\n            settings.ttsEngine === 'pocket' || settings.ttsEngine === 'chatterbox'\n          if (switchingToOrFromLeoEngine) {",
)

# Let the same Leo sheet manage either clone engine while keeping Pocket behavior intact.
replace_one(
    "src/features/settings/PocketVoiceSetupSheet.tsx",
    "  onInstalledChange,\n}: {\n  isOpen: boolean\n  onClose: () => void\n  onInstalledChange?: (installed: boolean) => void\n}) {",
    "  onInstalledChange,\n  engine = 'pocket',\n}: {\n  isOpen: boolean\n  onClose: () => void\n  onInstalledChange?: (installed: boolean) => void\n  engine?: 'pocket' | 'chatterbox'\n}) {",
)
replace_one(
    "src/features/settings/PocketVoiceSetupSheet.tsx",
    "      .then(([hasReference, engine]) => {\n        if (cancelled) return\n        setInstalled(hasReference)\n        setActive(engine === 'pocket')",
    "      .then(([hasReference, selectedEngine]) => {\n        if (cancelled) return\n        setInstalled(hasReference)\n        setActive(hasReference && selectedEngine === engine)",
)
replace_one(
    "src/features/settings/PocketVoiceSetupSheet.tsx",
    "  }, [isOpen, onInstalledChange])",
    "  }, [isOpen, onInstalledChange, engine])",
)
replace_one(
    "src/features/settings/PocketVoiceSetupSheet.tsx",
    "      throw new Error('Install the Leo reference before using Pocket TTS.')\n    }\n\n    // Pocket has one custom voice. Keep its engine + cache identity in sync so\n    // Settings, playback, and generated-audio caching all agree that Leo is active.\n    await settingsRepository.set('voiceId', 'pocket:leo')\n    await settingsRepository.set('ttsEngine', 'pocket')",
    "      throw new Error('Install the Leo reference first.')\n    }\n\n    const voiceId = engine === 'chatterbox' ? 'chatterbox:leo' : 'pocket:leo'\n    await settingsRepository.set('voiceId', voiceId)\n    await settingsRepository.set('ttsEngine', engine)",
)
replace_one(
    "src/features/settings/PocketVoiceSetupSheet.tsx",
    "      setMessage(\n        'Preparing Leo. First setup can take a while.'\n      )\n      await pocketService.initialize()\n      setMessage('Leo is ready.')",
    "      if (engine === 'pocket') {\n        setMessage('Preparing Leo. First setup can take a while.')\n        await pocketService.initialize()\n      }\n      setMessage('Leo is ready.')",
)
replace_one(
    "src/features/settings/PocketVoiceSetupSheet.tsx",
    "              Pocket TTS on this device.\n",
    "              {engine === 'chatterbox' ? 'Chatterbox voice clone.' : 'Pocket TTS on this device.'}\n",
)
replace_one(
    "src/features/settings/PocketVoiceSetupSheet.tsx",
    "                Pocket TTS is selected.\n",
    "                {engine === 'chatterbox' ? 'Chatterbox is selected.' : 'Pocket TTS is selected.'}\n",
)
replace_one(
    "src/features/settings/PocketVoiceSetupSheet.tsx",
    "          <p className=\"text-xs leading-relaxed text-text-muted\">\n            Pocket downloads its model once and keeps it on this device.\n          </p>",
    "          <p className=\"text-xs leading-relaxed text-text-muted\">\n            {engine === 'chatterbox'\n              ? 'Leo stays saved on this device. A short reference is sent only when the Chatterbox session needs conditioning.'\n              : 'Pocket downloads its model once and keeps it on this device.'}\n          </p>",
)

# Free Hugging Face CPU Space backend. Default Nano is the practical free option;
# CHATTERBOX_MODEL=turbo keeps the same API for later experiments on capable hardware.
Path("infra/chatterbox-hf-space").mkdir(parents=True, exist_ok=True)
Path("infra/chatterbox-hf-space/app.py").write_text(r'''import base64
import io
import os
import threading
from collections import OrderedDict
from pathlib import Path

import gradio as gr
import torchaudio as ta
from chatterbox.tts_turbo import ChatterboxTurboTTS

MODEL_NAME = os.getenv("CHATTERBOX_MODEL", "nano").strip().lower()
if MODEL_NAME not in {"nano", "turbo"}:
    raise RuntimeError("CHATTERBOX_MODEL must be 'nano' or 'turbo'")

DEVICE = os.getenv("CHATTERBOX_DEVICE", "cpu").strip().lower()
MAX_SESSIONS = 4
MAX_TEXT_CHARS = 1200

_model = None
_model_lock = threading.Lock()
_conditionals = OrderedDict()


def get_model():
    global _model
    if _model is None:
        _model = ChatterboxTurboTTS.from_pretrained(
            device=DEVICE,
            nano=(MODEL_NAME == "nano"),
        )
    return _model


def remember(session_id, conds):
    _conditionals.pop(session_id, None)
    _conditionals[session_id] = conds
    while len(_conditionals) > MAX_SESSIONS:
        _conditionals.popitem(last=False)


def synthesize(text, reference_audio, session_id):
    text = (text or "").strip()
    session_id = (session_id or "").strip()
    if not text:
        raise gr.Error("Text is required.")
    if len(text) > MAX_TEXT_CHARS:
        raise gr.Error(f"Text is limited to {MAX_TEXT_CHARS} characters per request.")
    if not session_id:
        raise gr.Error("Session id is required.")

    reference_path = Path(reference_audio) if reference_audio else None
    with _model_lock:
        model = get_model()
        try:
            if reference_path:
                model.prepare_conditionals(str(reference_path))
                remember(session_id, model.conds)
            elif session_id in _conditionals:
                model.conds = _conditionals[session_id]
                _conditionals.move_to_end(session_id)
            else:
                raise gr.Error("Leo reference required for this session.")

            wav = model.generate(text)
            buffer = io.BytesIO()
            ta.save(buffer, wav, model.sr, format="wav")
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            return {
                "audio_base64": encoded,
                "mime": "audio/wav",
                "sample_rate": model.sr,
                "model": MODEL_NAME,
            }
        finally:
            # Gradio uploads the prompt to a temporary file. Remove it as soon as
            # conditioning is prepared; no Leo recording is intentionally persisted.
            if reference_path:
                try:
                    reference_path.unlink(missing_ok=True)
                except OSError:
                    pass


with gr.Blocks(title="EPUB Chatterbox") as demo:
    gr.Markdown("# EPUB Chatterbox\nFree CPU backend for the EPUB reader. No voice asset is bundled with this Space.")
    text = gr.Textbox(label="Text", lines=4)
    reference = gr.Audio(label="Voice reference", type="filepath")
    session = gr.Textbox(label="Session id")
    output = gr.JSON(label="Audio payload")
    run = gr.Button("Generate")
    run.click(synthesize, [text, reference, session], output, api_name="synthesize")

demo.queue(default_concurrency_limit=1).launch()
''')
Path("infra/chatterbox-hf-space/requirements.txt").write_text("chatterbox-tts==0.1.7\ngradio==6.8.0\n")
Path("infra/chatterbox-hf-space/README.md").write_text(r'''---
title: EPUB Chatterbox
emoji: 🔊
colorFrom: indigo
colorTo: gray
sdk: gradio
sdk_version: 6.8.0
app_file: app.py
pinned: false
---

# EPUB Chatterbox free backend

This backend uses ResembleAI's official `ChatterboxTurboTTS` class. It defaults to **Chatterbox-Nano on CPU** because the reader is constrained to free hosting. Nano is 110M parameters and shares Turbo's architecture/voice-cloning API.

## Privacy

No Leo recording, transcript, embedding, conditionals file, or generated WAV is included in this repository. The reader keeps the reference on the iPhone. The Space receives a short reference only when its in-memory session needs conditioning, deletes the uploaded temporary file after conditioning, and returns generated WAV bytes as base64 rather than creating a persistent output file.

## Free deployment

Create a Hugging Face **Gradio Space** using free CPU hardware and copy this folder's three files into it. Leave the default environment variables:

- `CHATTERBOX_MODEL=nano`
- `CHATTERBOX_DEVICE=cpu`

Then build the reader with `VITE_CHATTERBOX_ENDPOINT` set to the Space URL or `owner/space-name`. Chatterbox stays hidden from Settings when that value is absent.

Turbo can be selected later with `CHATTERBOX_MODEL=turbo`, but free CPU is not the recommended Turbo runtime.
''')

# Final static assertions: do not accidentally retain the auto-open bug.
settings_text = Path("src/features/settings/SettingsPage.tsx").read_text()
forbidden = "if (engine === 'pocket') {\n            const installed = await pocketService.hasLeoVoiceSample()"
if forbidden in settings_text:
    raise RuntimeError("Pocket engine selection still auto-opens Leo setup")
