from pathlib import Path

manager = Path('src/services/tts/ttsManager.ts')
text = manager.read_text()
old = """      // Engines that don't require init are ready immediately
      if (!this.getCurrentCapabilities().requiresInit) {
        log.debug('No initialization needed', { engine })
        this.markReady()
        return
      }
"""
new = """      // Engines that don't require model preload are ready immediately.
      // Chatterbox still needs its service callbacks wired here; the remote
      // connection itself remains deferred until the first generation request.
      if (!this.getCurrentCapabilities().requiresInit) {
        if (engine === 'chatterbox') {
          this.wireUpService(chatterboxService, 'chatterbox')
        }
        log.debug('No initialization needed', { engine })
        this.markReady()
        return
      }
"""
if text.count(old) != 1:
    raise SystemExit('Could not find TTS no-init block')
manager.write_text(text.replace(old, new, 1))

settings = Path('src/features/settings/SettingsPage.tsx')
text = settings.read_text()
old = "{ id: 'chatterbox' as TTSEngine, name: t`Chatterbox`, description: t`High-quality English voice cloning.` }"
new = "{ id: 'chatterbox' as TTSEngine, name: t`Chatterbox`, description: t`English voice clone. Sends Leo reference online.` }"
if text.count(old) != 1:
    raise SystemExit('Could not find Chatterbox Settings description')
settings.write_text(text.replace(old, new, 1))
