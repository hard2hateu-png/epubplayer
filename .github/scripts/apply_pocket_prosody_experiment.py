from pathlib import Path

p = Path('src/services/tts/pocketService.ts')
s = p.read_text()

old = "import { splitTextIntoChunks } from './textChunking'"
new = "import { splitTextIntoChunks } from './textChunking'\nimport { ensurePocketTailPause } from './pocketProsody'"
assert old in s
s = s.replace(old, new, 1)

old = """      const rate = runtime.bundle?.sampleRate || SAMPLE_RATE\n      const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)\n      const result: PocketGeneratedAudio = {\n        requestId, blob: chunksToWav(chunks, rate), duration: samples / rate, chunkIndex, text,\n      }"""
new = """      const rate = runtime.bundle?.sampleRate || SAMPLE_RATE\n      // Pocket does not support pause markup in its text prompt. Keep the model,\n      // text, chunking, and generation path untouched; only fill in a very small\n      // missing quiet tail when a generated chunk ends too abruptly. Existing\n      // model-produced silence is measured first and preserved as-is.\n      const pacedChunks = ensurePocketTailPause(chunks, rate, text)\n      const samples = pacedChunks.reduce((sum, chunk) => sum + chunk.length, 0)\n      const result: PocketGeneratedAudio = {\n        requestId, blob: chunksToWav(pacedChunks, rate), duration: samples / rate, chunkIndex, text,\n      }"""
assert old in s
s = s.replace(old, new, 1)

p.write_text(s)
