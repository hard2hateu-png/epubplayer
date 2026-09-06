// Re-export all storage modules for convenient imports
export { db, hashText, hashBlob, sectionId, audioChunkId } from './db'
export type { Book, Section, PlaybackState, AudioChunk, Bookmark, Settings } from './db'

export { bookRepository, sectionRepository } from './bookRepository'
export { playbackRepository } from './playbackRepository'
export { audioChunkRepository } from './audioChunkRepository'
export { bookmarkRepository } from './bookmarkRepository'
export { settingsRepository, DEFAULT_SETTINGS } from './settingsRepository'
export type { SettingKey, SettingValue } from './settingsRepository'

// ============================================================================
// Storage Statistics
// ============================================================================

import { db } from './db'
import { audioChunkRepository } from './audioChunkRepository'

export const storageStats = {
  /**
   * Get storage usage statistics
   */
  async getStats() {
    // Safari/iOS can substantially under-report IndexedDB Blob usage through
    // navigator.storage.estimate(). Measure the large payloads we control directly
    // so the displayed "used" total can never be smaller than its own audio cache.
    const storedBookPayloadPromise = (async () => {
      let total = 0
      await db.books.each((book) => {
        total += book.epubBlob?.size ?? 0
        total += book.coverBlob?.size ?? 0
      })
      return total
    })()

    const [bookCount, audioSize, chunkCount, storedBookPayloadSize] = await Promise.all([
      db.books.count(),
      audioChunkRepository.getTotalSize(),
      db.audioChunks.count(),
      storedBookPayloadPromise,
    ])

    // Get Safari/browser quota information when available. Its total quota is useful,
    // but its usage number is only a lower-confidence estimate on iOS.
    let browserReportedUsage = 0
    let quotaTotal = 0
    if ('storage' in navigator && 'estimate' in navigator.storage) {
      const estimate = await navigator.storage.estimate()
      browserReportedUsage = estimate.usage ?? 0
      quotaTotal = estimate.quota ?? 0
    }

    // Directly known payload = generated audio + original EPUB files + cover images.
    // Use the larger of this and Safari's own reported usage. This avoids double
    // counting if Safari does include IndexedDB correctly, while also fixing the
    // impossible case where "total used" was smaller than generated audio alone.
    const measuredPayloadUsage = audioSize + storedBookPayloadSize
    const quotaUsed = Math.max(browserReportedUsage, measuredPayloadUsage)

    return {
      bookCount,
      audioSize,
      audioSizeMB: Math.round((audioSize / 1024 / 1024) * 10) / 10,
      chunkCount,
      quotaUsed,
      quotaUsedMB: Math.round(quotaUsed / 1024 / 1024),
      quotaTotal,
      quotaTotalMB: Math.round(quotaTotal / 1024 / 1024),
      quotaPercentUsed: quotaTotal > 0 ? (quotaUsed / quotaTotal) * 100 : 0,
    }
  },

  /**
   * Get per-book storage breakdown
   */
  async getBookStats(bookId: string) {
    const [audioSize, chunkCount, bookmarkCount] = await Promise.all([
      audioChunkRepository.getSizeForBook(bookId),
      audioChunkRepository.countForBook(bookId),
      db.bookmarks.where('bookId').equals(bookId).count(),
    ])

    return {
      audioSize,
      audioSizeMB: Math.round((audioSize / 1024 / 1024) * 10) / 10,
      chunkCount,
      bookmarkCount,
    }
  },

  /**
   * Clear all cached audio (keeps books and sections)
   */
  async clearAllAudio(): Promise<void> {
    await db.audioChunks.clear()
  },

  /**
   * Clear all data (full reset)
   */
  async clearAll(): Promise<void> {
    await db.transaction('rw', db.tables, async () => {
      for (const table of db.tables) {
        await table.clear()
      }
    })
  },
}
