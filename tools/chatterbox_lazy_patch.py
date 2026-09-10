from pathlib import Path

p = Path('src/services/tts/ttsManager.ts')
text = p.read_text()
old = """  chatterbox: {
    id: 'chatterbox',
    name: 'Chatterbox (Leo)',
    description: 'English Chatterbox-Turbo voice cloning using the saved Leo reference.',
    available: true,
    capabilities: {
      generatesBlobs: true,
      requiresInit: true,
      slowOnCPU: false,
    },
  },"""
new = """  chatterbox: {
    id: 'chatterbox',
    name: 'Chatterbox (Leo)',
    description: 'English Chatterbox-Turbo voice cloning using the saved Leo reference.',
    available: true,
    capabilities: {
      generatesBlobs: true,
      // Remote initialization is intentionally deferred until Play/generation.
      // This avoids consuming ZeroGPU time just from browsing or selecting the engine.
      requiresInit: false,
      slowOnCPU: false,
    },
  },"""
if text.count(old) != 1:
    raise SystemExit('Could not find exact Chatterbox registry block')
p.write_text(text.replace(old, new, 1))
print('Chatterbox initialization is now on-demand.')
