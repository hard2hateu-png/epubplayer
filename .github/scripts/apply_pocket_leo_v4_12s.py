from pathlib import Path

p = Path('src/services/tts/pocketService.ts')
s = p.read_text()

s = s.replace("const EMBEDDING_PATH = '/__epubplayer/pocket/voices/leo-embedding-v3-single-30s'", "const EMBEDDING_PATH = '/__epubplayer/pocket/voices/leo-embedding-v4-single-12s'")
s = s.replace("const EMBEDDING_MAGIC = 'LEOEMB03'", "const EMBEDDING_MAGIC = 'LEOEMB04'")
s = s.replace("const CONDITIONING_SECONDS = 30", "const CONDITIONING_SECONDS = 12")

anchor = "async function decodeReference(blob: Blob, targetRate: number): Promise<Float32Array> {"
helper = '''function selectRepresentativeWindow(input: Float32Array, sampleRate: number, seconds: number): Float32Array {
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
assert anchor in s, 'decodeReference anchor not found'
s = s.replace(anchor, helper + anchor, 1)

old = '''        // Pocket's voice embedding is a temporal sequence. Never average embeddings
        // from different portions of speech. Use one continuous conditioning clip.
        // Pocket's official export/server path truncates uploaded references to 30s;
        // keeping the same limit also avoids the 42s WebKit memory spike.
        const conditioningSamples = Math.min(pcm.length, Math.floor(rate * CONDITIONING_SECONDS))
        const conditioningPcm = pcm.slice(0, conditioningSamples)
        if (conditioningPcm.length < rate) throw new Error('Leo conditioning clip is too short')
        this.onProgressCallback?.('Preparing Leo from the original continuous reference...', 99)
        const embedding = await candidate.cloneVoice(conditioningPcm)

        await this.saveEmbedding(embedding)
        log.info('Prepared Leo from one continuous reference', {
          storedSeconds: pcm.length / rate,
          conditioningSeconds: conditioningPcm.length / rate,
        })
'''
new = '''        // Keep Pocket's conditioning memory small enough for iOS WebKit while
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
'''
assert old in s, '30-second conditioning block not found'
s = s.replace(old, new, 1)
p.write_text(s)

p = Path('src/features/player/TTSBufferManager.ts')
s = p.read_text()
s = s.replace("const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v3'", "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v4-12s'")
p.write_text(s)

# trigger workflow
