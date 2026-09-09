from pathlib import Path

# Narrow Pocket TTS stability patch. Deliberately leaves Leo's reference,
# embedding format/creation, vendor worker, and model sampling untouched.
p = Path('src/services/tts/pocketService.ts')
s = p.read_text()

# Add conservative guard constants.
needle = "const MAX_CHUNK_CHARS = 220\n"
replacement = """const MAX_CHUNK_CHARS = 220
const WARMUP_TEXT = 'The room was quiet, and the evening felt calm.'
const MAX_GENERATION_ATTEMPTS = 2
"""
assert needle in s
s = s.replace(needle, replacement, 1)

# Add a conservative signal/duration sanity check before WAV creation.
needle = """function chunksToWav(chunks: Float32Array[], sampleRate: number): Blob {
"""
quality = """function getGeneratedAudioIssue(chunks: Float32Array[], sampleRate: number, text: string): string | null {
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  if (!totalSamples || sampleRate <= 0) return 'no audio samples'

  let sumSquares = 0
  let peak = 0
  let finiteSamples = 0
  for (const chunk of chunks) {
    for (const sample of chunk) {
      if (!Number.isFinite(sample)) return 'non-finite audio samples'
      const abs = Math.abs(sample)
      peak = Math.max(peak, abs)
      sumSquares += sample * sample
      finiteSamples++
    }
  }
  if (!finiteSamples) return 'no finite audio samples'

  const rms = Math.sqrt(sumSquares / finiteSamples)
  const duration = totalSamples / sampleRate
  const words = text.trim().split(/\\s+/).filter(Boolean).length

  // Hyper-rushed / prematurely terminated output is one of the Pocket failures
  // we have observed. Keep this threshold intentionally loose so normal fast
  // narration is not rejected.
  if (words >= 8) {
    const minimumDuration = Math.max(1.25, words / 5.5)
    if (duration < minimumDuration) {
      return `audio too short (${duration.toFixed(2)}s for ${words} words)`
    }
  }

  // Only reject near-silent output. We do not try to classify timbre here.
  if (peak < 0.015 || rms < 0.002) {
    return `audio unusually quiet (peak ${peak.toFixed(4)}, rms ${rms.toFixed(4)})`
  }

  return null
}

function chunksToWav(chunks: Float32Array[], sampleRate: number): Blob {
"""
assert needle in s
s = s.replace(needle, quality, 1)

# Add the generation mutex and per-runtime warm-up state.
needle = """  private requestCounter = 0
  private cancelEpoch = 0
  private onAudioCallback?: AudioCallback
"""
replacement = """  private requestCounter = 0
  private cancelEpoch = 0
  private generationTail: Promise<void> = Promise.resolve()
  private hasWarmedUp = false
  private onAudioCallback?: AudioCallback
"""
assert needle in s
s = s.replace(needle, replacement, 1)

# Every newly loaded runtime gets exactly one discarded warm-up generation.
needle = """      this.runtime = candidate
      this.isReady = true
      this.isLoading = false
"""
replacement = """      this.runtime = candidate
      this.hasWarmedUp = false
      this.isReady = true
      this.isLoading = false
"""
assert needle in s
s = s.replace(needle, replacement, 1)

# Replace only PocketService.generateChunk. Do not touch worker internals.
start = s.index("  async generateChunk(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {")
end = s.index("\n  splitIntoChunks(text: string): string[] {", start)
old = s[start:end]
new = """  async generateChunk(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    // The underlying Pocket browser worker exposes one streaming audio callback.
    // Serialize foreground playback and background buffering so one generation
    // can never steal another generation's callback.
    const run = this.generationTail.then(
      () => this.generateChunkSerial(text, chunkIndex),
      () => this.generateChunkSerial(text, chunkIndex),
    )
    this.generationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async ensureWarmup(runtime: PocketWorkerRuntime, epoch: number): Promise<void> {
    if (this.hasWarmedUp) return
    this.onProgressCallback?.('Warming up Leo...', 100)
    const warmupChunks: Float32Array[] = []
    await runtime.generate(WARMUP_TEXT, (audio) => warmupChunks.push(audio.slice()))
    if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
    this.hasWarmedUp = true
    const rate = runtime.bundle?.sampleRate || SAMPLE_RATE
    const samples = warmupChunks.reduce((sum, chunk) => sum + chunk.length, 0)
    log.info('Pocket TTS warm-up complete', { duration: samples / rate })
  }

  private async generateChunkSerial(text: string, chunkIndex: number): Promise<PocketGeneratedAudio> {
    await this.initialize()
    const runtime = this.runtime
    if (!runtime || !this.isReady) throw new Error('Pocket TTS is not initialized')
    const epoch = this.cancelEpoch

    try {
      await this.ensureWarmup(runtime, epoch)

      for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
        const requestId = `pocket_${++this.requestCounter}_${Date.now()}`
        const chunks: Float32Array[] = []
        const metrics = await runtime.generate(text, (audio) => chunks.push(audio.slice()))
        if (epoch !== this.cancelEpoch) throw new DOMException('Generation cancelled', 'AbortError')
        if (!chunks.length) throw new Error('Pocket TTS returned no audio')

        const rate = runtime.bundle?.sampleRate || SAMPLE_RATE
        const issue = getGeneratedAudioIssue(chunks, rate, text)
        if (issue) {
          log.warn('Pocket TTS produced suspicious audio', { requestId, attempt, issue })
          if (attempt < MAX_GENERATION_ATTEMPTS) {
            this.onProgressCallback?.('Retrying an unstable Leo chunk...', 100)
            await new Promise<void>((resolve) => setTimeout(resolve, 60))
            continue
          }
          throw new Error(`Pocket TTS produced unstable audio twice: ${issue}`)
        }

        const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const result: PocketGeneratedAudio = {
          requestId, blob: chunksToWav(chunks, rate), duration: samples / rate, chunkIndex, text,
        }
        log.debug('Pocket TTS generated audio', {
          requestId, attempt, rtfx: metrics.rtfx, genTime: metrics.genTime,
        })
        this.onAudioCallback?.(result)
        return result
      }

      throw new Error('Pocket TTS generation failed')
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.onErrorCallback?.(error instanceof Error ? error.message : String(error))
      }
      throw error
    }
  }
"""
s = s[:start] + new + s[end:]

# Reset warm-up when the runtime is destroyed; do not alter the Leo embedding.
needle = """    this.runtime = null
    this.isReady = false
    this.isLoading = false
    this.initPromise = null
"""
replacement = """    this.runtime = null
    this.hasWarmedUp = false
    this.isReady = false
    this.isLoading = false
    this.initPromise = null
"""
assert needle in s
s = s.replace(needle, replacement, 1)
p.write_text(s)

# Give newly generated Pocket chunks a fresh cache key so previously glitched
# Pocket WAVs cannot bypass the new sanity check.
p = Path('src/features/player/TTSBufferManager.ts')
s = p.read_text()
needle = """type ChunkKey = string

function makeChunkKey(ctx: BufferContext, chunk: ChunkInfo): ChunkKey {
  // Include engine in the key to avoid conflicts between Kokoro and Piper cached audio
  return `${ctx.bookId}:${chunk.sectionIndex}:${chunk.chunkIndex}:${ctx.voiceId}:${ctx.modelConfig}:${ctx.engine}:${chunk.textHash}`
}
"""
replacement = """type ChunkKey = string
const POCKET_AUDIO_CACHE_VERSION = 'pocket-guard-v1'

function cacheModelConfig(ctx: BufferContext): string {
  return ctx.engine === 'pocket' ? `${ctx.modelConfig}:${POCKET_AUDIO_CACHE_VERSION}` : ctx.modelConfig
}

function makeChunkKey(ctx: BufferContext, chunk: ChunkInfo): ChunkKey {
  // Version Pocket audio independently so old bad WAVs are never replayed.
  return `${ctx.bookId}:${chunk.sectionIndex}:${chunk.chunkIndex}:${ctx.voiceId}:${cacheModelConfig(ctx)}:${ctx.engine}:${chunk.textHash}`
}
"""
assert needle in s
s = s.replace(needle, replacement, 1)

count = s.count('      this.ctx.modelConfig,')
assert count == 4, count
s = s.replace('      this.ctx.modelConfig,', '      cacheModelConfig(this.ctx),')
p.write_text(s)
