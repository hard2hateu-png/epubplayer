from pathlib import Path

p = Path('src/services/tts/pocketService.ts')
s = p.read_text()

# Remove the warm-up / retry constants.
s = s.replace("const WARMUP_TEXT = 'The room was quiet, and the evening felt calm.'\n", "")
s = s.replace("const MAX_GENERATION_ATTEMPTS = 2\n", "")

# Remove the audio classifier introduced by the warm-up guard patch.
start = s.find("function getGeneratedAudioIssue(")
if start != -1:
    end = s.find("function chunksToWav(", start)
    assert end != -1
    s = s[:start] + s[end:]

# Remove warm-up state while retaining the generation serialization queue.
s = s.replace("  private hasWarmedUp = false\n", "")
s = s.replace("      this.hasWarmedUp = false\n", "")
s = s.replace("    this.hasWarmedUp = false\n", "")

# Replace the warm-up/retry implementation with the original single-generation
# behavior, but keep a mutex around it so Pocket can never have overlapping
# worker generations.
start = s.index("  async generateChunk(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {")
end = s.index("\n  splitIntoChunks(text: string): string[] {", start)
new = '''  async generateChunk(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    // Pocket's browser worker exposes a single streaming audio callback.
    // Serialize every generation so foreground playback and background buffering
    // cannot steal each other's callback. Do not warm up, retry, or otherwise
    // run hidden generations: those can alter Pocket's subsequent voice state.
    const run = this.generationTail.then(
      () => this.generateChunkSerial(text, chunkIndex),
      () => this.generateChunkSerial(text, chunkIndex),
    )
    this.generationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async generateChunkSerial(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    await this.initialize()
    const runtime = this.runtime
    if (!runtime || !this.isReady) throw new Error('Pocket TTS is not initialized')
    const epoch = this.cancelEpoch
    const requestId = `pocket_${++this.requestCounter}_${Date.now()}`
    const chunks: Float32Array[] = []
    try {
      const metrics = await runtime.generate(text, (audio) => chunks.push(audio.slice()))
      if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
      if (!chunks.length) throw new Error('Pocket TTS returned no audio')
      const rate = runtime.bundle?.sampleRate || SAMPLE_RATE
      const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const result: PocketGeneratedAudio = {
        requestId, blob: chunksToWav(chunks, rate), duration: samples / rate, chunkIndex, text,
      }
      log.debug('Pocket TTS generated audio', { requestId, rtfx: metrics.rtfx, genTime: metrics.genTime })
      this.onAudioCallback?.(result)
      return result
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.onErrorCallback?.(error instanceof Error ? error.message : String(error), requestId)
      }
      throw error
    }
  }
'''
s = s[:start] + new + s[end:]
p.write_text(s)

# Bump only Pocket's generated-audio cache identity so audio created by the bad
# warm-up build is never replayed. This does not touch the Leo reference or
# saved voice embedding.
p = Path('src/features/player/TTSBufferManager.ts')
s = p.read_text()
s = s.replace("const POCKET_AUDIO_CACHE_VERSION = 'pocket-guard-v1'", "const POCKET_AUDIO_CACHE_VERSION = 'pocket-serial-v2'")
p.write_text(s)

# Trigger after the workflow is present.
