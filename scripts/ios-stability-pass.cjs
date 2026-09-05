const fs = require('fs')

function replaceInFile(file, oldText, newText, label) {
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes(oldText)) throw new Error(`Could not find ${label} in ${file}`)
  text = text.replace(oldText, newText)
  fs.writeFileSync(file, text)
  console.log(`Patched ${label}`)
}

// ---------------------------------------------------------------------------
// 1) IndexedDB cache checks: never materialize a whole section of audio Blobs
// just to determine whether chunks are cached.
// ---------------------------------------------------------------------------
replaceInFile(
  'src/services/storage/audioChunkRepository.ts',
`  /**
   * Get all chunks for a section (for sequential playback)
   */`,
`  /**
   * Check whether a chunk is available either at this exact position or in the
   * global text-hash cache. Uses count-only IndexedDB queries so the audio Blob
   * itself is never materialized into JS memory.
   */
  async existsWithFallback(
    bookId: string,
    sectionIndex: number,
    chunkIndex: number,
    voiceId: string,
    modelConfig: string,
    textHash: string
  ): Promise<boolean> {
    const id = audioChunkId(bookId, sectionIndex, chunkIndex, voiceId, modelConfig, textHash)
    const positionCount = await db.audioChunks.where('id').equals(id).count()
    if (positionCount > 0) return true

    const globalCount = await db.audioChunks
      .where('[textHash+voiceId+modelConfig]')
      .equals([textHash, voiceId, modelConfig])
      .count()
    return globalCount > 0
  },

  /**
   * Get all chunks for a section (for sequential playback)
   */`,
  'lightweight cache existence helper'
)

replaceInFile(
  'src/services/storage/audioChunkRepository.ts',
`  async getSizeForBook(bookId: string): Promise<number> {
    const chunks = await db.audioChunks.where('bookId').equals(bookId).toArray()
    return chunks.reduce((total, chunk) => total + chunk.audioBlob.size, 0)
  },`,
`  async getSizeForBook(bookId: string): Promise<number> {
    let total = 0
    // Cursor iteration avoids holding every cached audio Blob for the book in
    // one giant JS array at once (important on memory-constrained iOS Safari).
    await db.audioChunks.where('bookId').equals(bookId).each((chunk) => {
      total += chunk.audioBlob.size
    })
    return total
  },`,
  'streamed per-book audio size calculation'
)

replaceInFile(
  'src/services/storage/audioChunkRepository.ts',
`  async getTotalSize(): Promise<number> {
    const chunks = await db.audioChunks.toArray()
    return chunks.reduce((total, chunk) => total + chunk.audioBlob.size, 0)
  },`,
`  async getTotalSize(): Promise<number> {
    let total = 0
    await db.audioChunks.each((chunk) => {
      total += chunk.audioBlob.size
    })
    return total
  },`,
  'streamed total audio size calculation'
)

// ---------------------------------------------------------------------------
// 2) Buffer manager: remember lightweight cache hits and cap iOS look-ahead.
// ---------------------------------------------------------------------------
replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`function estimateDurationSeconds(text: string): number {
  // Heuristic: ~13 chars/sec ~= 780 chars/min (rough English TTS pacing)
  return Math.max(2, text.length / 13)
}`,
`function estimateDurationSeconds(text: string): number {
  // Heuristic: ~13 chars/sec ~= 780 chars/min (rough English TTS pacing)
  return Math.max(2, text.length / 13)
}

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

// Neural TTS + large IndexedDB audio caches can put iOS WebKit under severe
// memory pressure. A couple minutes of look-ahead is plenty for seamless 1.5x
// playback without continuously generating a whole chapter in the background.
const IOS_MAX_BUFFER_CHUNKS = 12`,
  'iOS buffer safety helpers'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`  // In-flight generation dedupe (used by both background buffering and foreground playback)
  private inFlight = new Map<ChunkKey, Promise<GeneratedAudioResult>>()`,
`  // In-flight generation dedupe (used by both background buffering and foreground playback)
  private inFlight = new Map<ChunkKey, Promise<GeneratedAudioResult>>()

  // Lightweight session cache. This stores only string keys, never audio Blobs,
  // so repeated buffer passes do not re-query or materialize large cached audio.
  private knownCached = new Set<ChunkKey>()`,
  'known cached key set'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`    this.inFlight.clear()
    this.lastError = null`,
`    this.inFlight.clear()
    this.knownCached.clear()
    this.lastError = null`,
  'clear known cache on stop'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`    if (cached) {
      const sourceLabel = cacheSource === 'textHash' ? 'GLOBAL_CACHE' : 'CACHE_HIT'
      log.debug('Cache hit', { pos, source, cacheSource: sourceLabel, duration: cached.duration })
      return {`,
`    if (cached) {
      this.knownCached.add(key)
      const sourceLabel = cacheSource === 'textHash' ? 'GLOBAL_CACHE' : 'CACHE_HIT'
      log.debug('Cache hit', { pos, source, cacheSource: sourceLabel, duration: cached.duration })
      return {`,
  'remember foreground/global cache hits'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`      await audioChunkRepository.save(
        this.ctx.bookId,
        chunk.sectionIndex,
        chunk.chunkIndex,
        this.ctx.voiceId,
        this.ctx.modelConfig,
        chunk.textHash,
        audio.blob,
        audio.duration
      )
      return audio`,
`      await audioChunkRepository.save(
        this.ctx.bookId,
        chunk.sectionIndex,
        chunk.chunkIndex,
        this.ctx.voiceId,
        this.ctx.modelConfig,
        chunk.textHash,
        audio.blob,
        audio.duration
      )
      this.knownCached.add(key)
      return audio`,
  'remember newly cached chunks'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`    if (mode === 'chapter') {
      // Buffer current chapter
      await pushFrom(startSection, startChunk)
      
      // CROSS-CHAPTER LOOKAHEAD: Always buffer first few chunks of next section
      // to ensure smooth chapter transitions. This prevents lag when rolling
      // over to a new chapter.
      const LOOKAHEAD_CHUNKS = 5 // Buffer first 5 chunks of next chapter
      const nextSection = startSection + 1
      if (nextSection < allSections.length) {
        await pushFrom(nextSection, 0, LOOKAHEAD_CHUNKS)
      }
      
      return chunks
    }

    if (mode === 'book') {
      await pushFrom(startSection, startChunk)
      for (let s = startSection + 1; s < allSections.length; s++) {
        await pushFrom(s, 0)
      }
      return chunks
    }`,
`    if (mode === 'chapter') {
      // Desktop can honor full-chapter buffering. On iOS, cap the look-ahead so
      // Supertonic + cached WAV data cannot steadily push WebKit into a reload.
      const iosLimit = isIOSDevice() ? IOS_MAX_BUFFER_CHUNKS : undefined
      await pushFrom(startSection, startChunk, iosLimit)

      if (iosLimit !== undefined && chunks.length >= iosLimit) {
        return chunks
      }
      
      // CROSS-CHAPTER LOOKAHEAD: keep a few chunks ready for a seamless rollover.
      const remainingIOSSlots = iosLimit === undefined ? 5 : Math.max(0, iosLimit - chunks.length)
      const LOOKAHEAD_CHUNKS = iosLimit === undefined ? 5 : Math.min(3, remainingIOSSlots)
      const nextSection = startSection + 1
      if (LOOKAHEAD_CHUNKS > 0 && nextSection < allSections.length) {
        await pushFrom(nextSection, 0, LOOKAHEAD_CHUNKS)
      }
      
      return chunks
    }

    if (mode === 'book') {
      if (isIOSDevice()) {
        await pushFrom(startSection, startChunk, IOS_MAX_BUFFER_CHUNKS)
        return chunks
      }

      await pushFrom(startSection, startChunk)
      for (let s = startSection + 1; s < allSections.length; s++) {
        await pushFrom(s, 0)
      }
      return chunks
    }`,
  'cap chapter/book buffering on iOS'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`    const targetSeconds = Math.max(0, minutes) * 60
    let acc = 0`,
`    const targetSeconds = Math.max(0, minutes) * 60
    const maxIOSChunks = isIOSDevice() ? IOS_MAX_BUFFER_CHUNKS : Number.POSITIVE_INFINITY
    let acc = 0`,
  'minutes-mode iOS cap setup'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`        addChunk(c)
        if (acc >= targetSeconds) return chunks`,
`        addChunk(c)
        if (acc >= targetSeconds || chunks.length >= maxIOSChunks) return chunks`,
  'minutes-mode iOS cap enforcement'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`          // Find first missing chunk within target (efficient: per-section cache snapshot)
          let nextMissing: ChunkInfo | null = null
          let cachedCount = 0
          const cachedBySection = new Map<
            number,
            Promise<Map<number, { textHash: string; duration: number }>>
          >()

          const getCachedMap = async (sectionIndex: number) => {
            const existing = cachedBySection.get(sectionIndex)
            if (existing) return existing
            const p = audioChunkRepository
              .getForSection(this.ctx!.bookId, sectionIndex, this.ctx!.voiceId, this.ctx!.modelConfig)
              .then((chunks) => {
                const map = new Map<number, { textHash: string; duration: number }>()
                for (const c of chunks) {
                  map.set(c.chunkIndex, { textHash: c.textHash, duration: c.duration })
                }
                return map
              })
            cachedBySection.set(sectionIndex, p)
            return p
          }

          for (const c of target) {
            const m = await getCachedMap(c.sectionIndex)
            const hit = m.get(c.chunkIndex)
            if (hit && hit.textHash === c.textHash) {
              cachedCount++
              continue
            }
            nextMissing = c
            break
          }`,
`          // Find the first missing chunk without loading cached audio Blobs into
          // memory. The old section snapshot path could materialize hundreds of
          // MB of WAV data on every buffer pass and trigger iOS WebKit reloads.
          let nextMissing: ChunkInfo | null = null
          let cachedCount = 0

          for (const c of target) {
            const key = makeChunkKey(this.ctx, c)
            if (this.knownCached.has(key)) {
              cachedCount++
              continue
            }

            const exists = await audioChunkRepository.existsWithFallback(
              this.ctx.bookId,
              c.sectionIndex,
              c.chunkIndex,
              this.ctx.voiceId,
              this.ctx.modelConfig,
              c.textHash
            )

            if (exists) {
              this.knownCached.add(key)
              cachedCount++
              continue
            }

            nextMissing = c
            break
          }`,
  'blob-free background cache scan'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`          // Yield between chunks to keep UI responsive
          await this.waitForWakeOrTimeout(0)`,
`          // Give iOS a small breather between neural generations so WebKit has
          // time to release temporary inference/audio allocations.
          await this.waitForWakeOrTimeout(isIOSDevice() ? 40 : 0)`,
  'iOS generation yield'
)

replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`    const cached = await audioChunkRepository.getForSection(
      this.ctx.bookId,
      sectionIndex,
      this.ctx.voiceId,
      this.ctx.modelConfig
    )
    const cachedMap = new Map<number, string>()
    for (const c of cached) cachedMap.set(c.chunkIndex, c.textHash)

    let lastContiguous = startChunk - 1
    for (let i = startChunk; i < total; i++) {
      const chunk = chunkManager.getChunk({ sectionIndex, chunkIndex: i })
      if (!chunk) break
      const hitHash = cachedMap.get(i)
      if (hitHash && hitHash === chunk.textHash) {
        lastContiguous = i
      } else {
        break
      }
    }`,
`    let lastContiguous = startChunk - 1
    for (let i = startChunk; i < total; i++) {
      const chunk = chunkManager.getChunk({ sectionIndex, chunkIndex: i })
      if (!chunk) break

      const key = makeChunkKey(this.ctx, chunk)
      let exists = this.knownCached.has(key)
      if (!exists) {
        exists = await audioChunkRepository.existsWithFallback(
          this.ctx.bookId,
          sectionIndex,
          i,
          this.ctx.voiceId,
          this.ctx.modelConfig,
          chunk.textHash
        )
        if (exists) this.knownCached.add(key)
      }

      if (!exists) break
      lastContiguous = i
    }`,
  'blob-free buffer indicator scan'
)

// ---------------------------------------------------------------------------
// 3) Reduce high-frequency persisted Zustand writes. Lyrics highlighting polls
// the audio element directly, so this does not reduce highlight responsiveness.
// ---------------------------------------------------------------------------
replaceInFile(
  'src/features/player/audioBackends/AudioBlobBackend.ts',
`  private keepaliveStarted = false`,
`  private keepaliveStarted = false
  private lastTimingStoreUpdate = 0`,
  'timing update throttle state'
)

replaceInFile(
  'src/features/player/audioBackends/AudioBlobBackend.ts',
`    this.audio.addEventListener('timeupdate', () => {
      if (this.audio.duration) {
        // Mirror existing audio timing into the UI store. This is read-only
        // observation of playback and does not change the narration or audio.
        usePlayerStore.getState().setChunkTiming(this.audio.currentTime, this.audio.duration)
        this.events.onProgress?.(this.audio.currentTime, this.audio.duration)
      }
    })`,
`    this.audio.addEventListener('timeupdate', () => {
      if (this.audio.duration) {
        // The reader highlight reads the audio element directly, so the global
        // persisted store does not need a write on every native timeupdate.
        // Throttling this avoids several localStorage serializations per second.
        const now = performance.now()
        if (now - this.lastTimingStoreUpdate >= 500) {
          this.lastTimingStoreUpdate = now
          usePlayerStore.getState().setChunkTiming(this.audio.currentTime, this.audio.duration)
          this.events.onProgress?.(this.audio.currentTime, this.audio.duration)
        }
      }
    })`,
  'throttle persisted live timing updates'
)

replaceInFile(
  'src/features/player/audioBackends/AudioBlobBackend.ts',
`      // Reset UI timing at the start of each new generated-audio chunk.
      usePlayerStore.getState().setChunkTiming(options?.startTime ?? 0, 0)`,
`      // Reset UI timing at the start of each new generated-audio chunk.
      this.lastTimingStoreUpdate = 0
      usePlayerStore.getState().setChunkTiming(options?.startTime ?? 0, 0)`,
  'reset timing throttle on new chunk'
)

replaceInFile(
  'src/features/player/audioBackends/AudioBlobBackend.ts',
`    usePlayerStore.getState().setChunkTiming(0, 0)
    this._isPlaying = false`,
`    this.lastTimingStoreUpdate = 0
    usePlayerStore.getState().setChunkTiming(0, 0)
    this._isPlaying = false`,
  'reset timing throttle on stop'
)
