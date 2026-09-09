from pathlib import Path
import json


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'Expected text not found in {path}: {old[:120]!r}')
    p.write_text(s.replace(old, new, 1))

# --- Canonical engine type ---
replace_once(
    'src/services/tts/types.ts',
    "export type TTSEngine = 'browser' | 'piper' | 'kokoro' | 'supertonic' | 'sherpa' | 'kitten' | 'pocket'",
    "export type TTSEngine = 'browser' | 'piper' | 'kokoro' | 'supertonic' | 'sherpa' | 'kitten' | 'pocket' | 'qwen'",
)

# --- Public TTS exports ---
replace_once(
    'src/services/tts/index.ts',
    "// Pocket TTS custom voice service\nexport { pocketService, POCKET_VOICE_NAME, POCKET_VOICE_ID } from './pocketService'\nexport type { PocketConfig, PocketGeneratedAudio } from './pocketService'\n",
    "// Pocket TTS custom voice service\nexport { pocketService, POCKET_VOICE_NAME, POCKET_VOICE_ID } from './pocketService'\nexport type { PocketConfig, PocketGeneratedAudio } from './pocketService'\n\n// Qwen3-TTS cloud custom voice service\nexport { qwenCloudService, QWEN_VOICE_NAME, QWEN_VOICE_ID } from './qwenCloudService'\nexport type { QwenCloudGeneratedAudio } from './qwenCloudService'\n",
)

# --- Qwen service: keep the reusable reference small and use longer narration chunks ---
replace_once(
    'src/services/tts/qwenCloudService.ts',
    "const REFERENCE_DATA_PATH = '/__epubplayer/qwen/leo-reference-18s-v1'",
    "const REFERENCE_DATA_PATH = '/__epubplayer/qwen/leo-reference-12s-v1'",
)
replace_once('src/services/tts/qwenCloudService.ts', 'const REFERENCE_SECONDS = 18', 'const REFERENCE_SECONDS = 12')
replace_once('src/services/tts/qwenCloudService.ts', 'const MAX_CHUNK_CHARS = 420', 'const MAX_CHUNK_CHARS = 600')

# --- Manager registry + lifecycle ---
p = Path('src/services/tts/ttsManager.ts')
s = p.read_text()
s = s.replace("import { pocketService } from './pocketService'", "import { pocketService } from './pocketService'\nimport { qwenCloudService } from './qwenCloudService'", 1)

pocket_registry = """  pocket: {
    id: 'pocket',
    name: 'Pocket TTS (Leo)',
    description: 'Custom local Leo voice clone. Runs on-device and uses the normal generated-audio cache.',
    available: true,
    capabilities: {
      generatesBlobs: true,
      requiresInit: true,
      slowOnCPU: false,
    },
  },
"""
qwen_registry = """  qwen: {
    id: 'qwen',
    name: 'Qwen3-TTS Cloud (Leo)',
    description: 'Higher-quality Leo voice clone. Neural inference runs in the cloud instead of on your iPhone.',
    available: true,
    capabilities: {
      generatesBlobs: true,
      requiresInit: true,
      slowOnCPU: false,
    },
  },
"""
if pocket_registry not in s:
    raise SystemExit('Pocket registry block not found')
s = s.replace(pocket_registry, qwen_registry + pocket_registry, 1)

s = s.replace(
    """        case 'pocket':
          this.wireUpService(pocketService, 'pocket')
          await pocketService.initialize()
          break

        case 'browser':""",
    """        case 'pocket':
          this.wireUpService(pocketService, 'pocket')
          await pocketService.initialize()
          break

        case 'qwen':
          this.wireUpService(qwenCloudService, 'qwen')
          await qwenCloudService.initialize()
          break

        case 'browser':""",
    1,
)

s = s.replace(
    """        case 'pocket': {
          const result = await pocketService.generateChunk(text, chunkIndex)
          return {
            requestId: result.requestId,
            blob: result.blob,
            duration: result.duration,
            chunkIndex: result.chunkIndex,
            text: result.text,
          }
        }

        default:""",
    """        case 'pocket': {
          const result = await pocketService.generateChunk(text, chunkIndex)
          return {
            requestId: result.requestId,
            blob: result.blob,
            duration: result.duration,
            chunkIndex: result.chunkIndex,
            text: result.text,
          }
        }

        case 'qwen': {
          const result = await qwenCloudService.generateChunk(text, chunkIndex)
          return {
            requestId: result.requestId,
            blob: result.blob,
            duration: result.duration,
            chunkIndex: result.chunkIndex,
            text: result.text,
          }
        }

        default:""",
    1,
)

s = s.replace(
    """      case 'pocket':
        return pocketService.splitIntoChunks(text)
      default:""",
    """      case 'pocket':
        return pocketService.splitIntoChunks(text)
      case 'qwen':
        return qwenCloudService.splitIntoChunks(text)
      default:""",
    1,
)

# Two lifecycle switches contain the same Pocket snippet; replace each one explicitly.
old_cancel = """      case 'pocket':
        pocketService.cancelAll()
        break
    }
  }

  destroy(): void {"""
new_cancel = """      case 'pocket':
        pocketService.cancelAll()
        break
      case 'qwen':
        qwenCloudService.cancelAll()
        break
    }
  }

  destroy(): void {"""
if old_cancel not in s:
    raise SystemExit('cancelAll Pocket block not found')
s = s.replace(old_cancel, new_cancel, 1)

old_destroy = """      case 'pocket':
        pocketService.destroy()
        break
    }
    this.isInitialized = false
"""
new_destroy = """      case 'pocket':
        pocketService.destroy()
        break
      case 'qwen':
        qwenCloudService.destroy()
        break
    }
    this.isInitialized = false
"""
if old_destroy not in s:
    raise SystemExit('destroy Pocket block not found')
s = s.replace(old_destroy, new_destroy, 1)
p.write_text(s)

# --- Generated audio cache identity ---
p = Path('src/features/player/TTSBufferManager.ts')
s = p.read_text()
s = s.replace(
    "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'\n\nfunction cacheModelConfig(ctx: BufferContext): string {\n  return ctx.engine === 'pocket' ? `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}` : ctx.modelConfig\n}",
    "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'\nconst QWEN_AUDIO_CACHE_VERSION = 'qwen3-leo-cloud-v1'\n\nfunction cacheModelConfig(ctx: BufferContext): string {\n  if (ctx.engine === 'pocket') return `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}`\n  if (ctx.engine === 'qwen') return `${ctx.modelConfig}:${QWEN_AUDIO_CACHE_VERSION}`\n  return ctx.modelConfig\n}",
    1,
)
p.write_text(s)

# --- Settings UI ---
p = Path('src/features/settings/SettingsPage.tsx')
s = p.read_text()
s = s.replace("import { PocketVoiceSetupSheet } from './PocketVoiceSetupSheet'", "import { PocketVoiceSetupSheet } from './PocketVoiceSetupSheet'\nimport { QwenCloudSetupSheet } from './QwenCloudSetupSheet'", 1)
s = s.replace("import { ttsManager, pocketService, type TTSEngine } from '@/services/tts'", "import { ttsManager, pocketService, qwenCloudService, type TTSEngine } from '@/services/tts'", 1)

s = s.replace(
    "    { id: 'supertonic' as TTSEngine, name: t`Supertonic (Recommended)`, description: t`AI voice with great quality and speed. Works on most devices. ~260MB download.` },\n    { id: 'pocket' as TTSEngine,",
    "    { id: 'supertonic' as TTSEngine, name: t`Supertonic (Recommended)`, description: t`AI voice with great quality and speed. Works on most devices. ~260MB download.` },\n    { id: 'qwen' as TTSEngine, name: t`Qwen3-TTS Cloud (Leo)`, description: t`Higher-quality Leo voice clone. Runs remotely so the heavy model never loads on your iPhone.` },\n    { id: 'pocket' as TTSEngine,",
    1,
)

s = s.replace("    if (settings.ttsEngine === 'pocket') {\n      return 'Leo'\n    }", "    if (settings.ttsEngine === 'pocket' || settings.ttsEngine === 'qwen') {\n      return 'Leo'\n    }", 1)

pocket_row = """          {settings.ttsEngine !== 'pocket' && (
            <SettingsItem
              icon={<VolumeIcon className=\"h-5 w-5\" />}
              label={t`Pocket TTS — Leo`}
              value={pocketVoiceInstalled === null ? t`Checking…` : pocketVoiceInstalled ? t`Installed` : t`Set up`}
              description={t`Install or replace the private local Leo voice sample`}
              onClick={() => setActiveSheet('pocketLeo')}
            />
          )}
"""
qwen_row = """          {settings.ttsEngine !== 'qwen' && (
            <SettingsItem
              icon={<VolumeIcon className=\"h-5 w-5\" />}
              label={t`Qwen3-TTS — Leo`}
              value={qwenCloudService.hasToken() ? t`Configured` : t`Set up`}
              description={t`Higher-quality cloud Leo clone; no neural model runs on this iPhone`}
              onClick={() => setActiveSheet('qwenLeo')}
            />
          )}

"""
if pocket_row not in s:
    raise SystemExit('Pocket Settings row not found')
s = s.replace(pocket_row, qwen_row + pocket_row, 1)

pocket_voice_block = """          {settings.ttsEngine === 'pocket' && (
            <>
              <SettingsItem
                icon={<VolumeIcon className=\"h-5 w-5\" />}
                label={t`Voice`}
                value=\"Leo\"
                description={pocketVoiceInstalled ? t`Local custom Pocket TTS voice` : t`Voice sample required`}
                onClick={() => setActiveSheet('pocketLeo')}
              />
              <SettingsItem
                label={t`Buffer Ahead`}
                value={getBufferAheadLabel()}
                description={t`Uses the same generated-audio cache and iPhone safety limit`}
                onClick={() => setActiveSheet('bufferAhead')}
              />
            </>
          )}
"""
qwen_voice_block = """          {settings.ttsEngine === 'qwen' && (
            <>
              <SettingsItem
                icon={<VolumeIcon className=\"h-5 w-5\" />}
                label={t`Voice`}
                value=\"Leo\"
                description={t`Qwen3-TTS cloud voice clone`}
                onClick={() => setActiveSheet('qwenLeo')}
              />
              <SettingsItem
                label={t`Buffer Ahead`}
                value={getBufferAheadLabel()}
                description={t`Generated cloud audio is cached on this device for smooth playback`}
                onClick={() => setActiveSheet('bufferAhead')}
              />
            </>
          )}
"""
if pocket_voice_block not in s:
    raise SystemExit('Pocket voice block not found')
s = s.replace(pocket_voice_block, qwen_voice_block + pocket_voice_block, 1)

s = s.replace(
    "              settings.ttsEngine === 'supertonic' ? 'Supertonic 66M' :\n              settings.ttsEngine === 'pocket' ? 'Pocket TTS — Leo' :",
    "              settings.ttsEngine === 'supertonic' ? 'Supertonic 66M' :\n              settings.ttsEngine === 'qwen' ? 'Qwen3-TTS Cloud — Leo' :\n              settings.ttsEngine === 'pocket' ? 'Pocket TTS — Leo' :",
    1,
)

pocket_sheet = """      <PocketVoiceSetupSheet
        isOpen={activeSheet === 'pocketLeo'}
        onClose={() => setActiveSheet(null)}
        onInstalledChange={setPocketVoiceInstalled}
      />

"""
qwen_sheet = """      <QwenCloudSetupSheet
        isOpen={activeSheet === 'qwenLeo'}
        onClose={() => setActiveSheet(null)}
      />

"""
if pocket_sheet not in s:
    raise SystemExit('Pocket setup sheet placement not found')
s = s.replace(pocket_sheet, pocket_sheet + qwen_sheet, 1)

# Opening Qwen from the generic engine picker should route through setup if needed.
engine_guard = """          if (engine === 'pocket') {
            const installed = await pocketService.hasLeoVoiceSample()
            setPocketVoiceInstalled(installed)
            if (!installed) {
              setActiveSheet('pocketLeo')
              return
            }
          }
          
"""
qwen_guard = """          if (engine === 'qwen') {
            const hasReference = await qwenCloudService.hasLeoReference()
            if (!hasReference || !qwenCloudService.hasToken()) {
              setActiveSheet('qwenLeo')
              return
            }
          }

"""
if engine_guard not in s:
    raise SystemExit('Pocket engine guard not found')
s = s.replace(engine_guard, engine_guard + qwen_guard, 1)

s = s.replace(
    """          } else if (engine === 'pocket') {
            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.
            await settingsRepository.set('voiceId', 'pocket:leo')
            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))
          }

          // PlaybackController currently resolves the outgoing engine's voice during a hot-swap.
          // A one-time page reload when switching to/from Pocket avoids a transient wrong cache key
          // without changing the stable playback controller used by the existing engines.
          const switchingToOrFromPocket = engine === 'pocket' || settings.ttsEngine === 'pocket'
          if (switchingToOrFromPocket) {""",
    """          } else if (engine === 'pocket') {
            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.
            await settingsRepository.set('voiceId', 'pocket:leo')
            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))
          } else if (engine === 'qwen') {
            await settingsRepository.set('voiceId', 'qwen:leo')
            setSettings((prev) => ({ ...prev, voiceId: 'qwen:leo' }))
          }

          // Custom Leo engines use distinct generated-audio cache identities. Reload once
          // when switching to/from either one so PlaybackController cannot retain the old voice.
          const switchingToOrFromCustomLeo =
            engine === 'pocket' || engine === 'qwen' ||
            settings.ttsEngine === 'pocket' || settings.ttsEngine === 'qwen'
          if (switchingToOrFromCustomLeo) {""",
    1,
)

p.write_text(s)

# --- Qwen setup wording tracks the actual 12-second reference ---
p = Path('src/features/settings/QwenCloudSetupSheet.tsx')
s = p.read_text().replace('continuous 18-second speech-dense section', 'continuous 12-second speech-dense section')
p.write_text(s)

# --- Vercel function timeout ---
p = Path('vercel.json')
data = json.loads(p.read_text())
data['functions'] = {'api/qwen-cloud.js': {'maxDuration': 60}}
p.write_text(json.dumps(data, indent=2) + '\n')
