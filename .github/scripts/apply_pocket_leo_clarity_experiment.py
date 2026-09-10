from pathlib import Path

p = Path('src/services/tts/pocketService.ts')
s = p.read_text()

# Force one fresh embedding for this experiment only. The stable branch keeps v4.
old = "const EMBEDDING_PATH = '/__epubplayer/pocket/voices/leo-embedding-v4-single-12s'"
new = "const EMBEDDING_PATH = '/__epubplayer/pocket/voices/leo-embedding-v5-clarity-12s'"
assert old in s
s = s.replace(old, new, 1)

old = "const EMBEDDING_MAGIC = 'LEOEMB04'"
new = "const EMBEDDING_MAGIC = 'LEOEMB05'"
assert old in s
s = s.replace(old, new, 1)

old = "const CONDITIONING_SECONDS = 12\nconst MAX_CHUNK_CHARS = 220"
new = "const CONDITIONING_SECONDS = 12\n// Spectral analysis of the fixed Leo reference found this continuous region to\n// be clearer than the prior loudness-only winner while preserving the same\n// 12-second iOS memory budget. This is an experiment branch only.\nconst LEO_CLARITY_START_SECONDS = 21.25\nconst MAX_CHUNK_CHARS = 220"
assert old in s
s = s.replace(old, new, 1)

old = '''function selectRepresentativeWindow(input: Float32Array, sampleRate: number, seconds: number): Float32Array {
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
'''

new = '''function selectRepresentativeWindow(input: Float32Array, sampleRate: number, seconds: number): Float32Array {
  const windowSamples = Math.min(input.length, Math.max(1, Math.floor(sampleRate * seconds)))
  if (input.length <= windowSamples) return input.slice()

  // Leo uses a fixed private reference clip. The previous loudness-only selector
  // consistently chose about 18.5–30.5 s. Offline spectral analysis of the same
  // recording found 21.25–33.25 s to have a higher speech centroid/rolloff and
  // less low-mid concentration, so test that cleaner continuous region first.
  // No EQ, denoising, resynthesis, splicing, or runtime playback processing is
  // applied; Pocket still receives ordinary mono PCM and exactly 12 seconds.
  const preferredStart = Math.floor(sampleRate * LEO_CLARITY_START_SECONDS)
  if (input.length >= preferredStart + windowSamples) {
    return input.slice(preferredStart, preferredStart + windowSamples)
  }

  // Safety fallback for an unexpectedly shorter replacement reference: retain
  // the stable speech-density selector rather than failing voice preparation.
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
'''

assert old in s
s = s.replace(old, new, 1)

old = "this.onProgressCallback?.('Preparing Leo from a continuous 12-second reference...', 99)"
new = "this.onProgressCallback?.('Preparing Leo from the clearer 12-second reference window...', 99)"
assert old in s
s = s.replace(old, new, 1)

old = "          conditioningSeconds: conditioningPcm.length / rate,\n        })"
new = "          conditioningSeconds: conditioningPcm.length / rate,\n          conditioningStartSeconds: LEO_CLARITY_START_SECONDS,\n        })"
assert old in s
s = s.replace(old, new, 1)

p.write_text(s)
