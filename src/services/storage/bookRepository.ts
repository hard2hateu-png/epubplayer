import { db, type Book, type Section, sectionId } from './db'

// ============================================================================
// Legacy source migration helpers
// ============================================================================

async function isPdfBlob(blob: Blob): Promise<boolean> {
  if (blob.type.toLowerCase() === 'application/pdf') return true

  // Some iOS file providers hand back an empty or generic MIME type. Check the
  // actual file signature so already-imported PDFs are still migrated safely.
  try {
    return (await blob.slice(0, 5).text()) === '%PDF-'
  } catch {
    return false
  }
}

async function migrateLegacyOriginalFile(book: Book): Promise<Book> {
  if (!book.epubBlob) return book

  const isLegacyPdf = book.sourceType === 'pdf' || (!book.sourceType && await isPdfBlob(book.epubBlob))
  if (!isLegacyPdf) return book

  const pdfBlob = book.epubBlob
  book.sourceType = 'pdf'
  book.originalBlob = book.originalBlob ?? pdfBlob
  book.epubBlob = undefined

  // Persist once so subsequent opens never route this PDF through EPUB parsing.
  await db.books.update(book.id, {
    sourceType: 'pdf',
    originalBlob: book.originalBlob,
    epubBlob: undefined,
  })

  return book
}

// ============================================================================
// Book Repository
// ============================================================================

export const bookRepository = {
  /**
   * Add a new book to the library
   */
  async add(book: Omit<Book, 'addedAt'>): Promise<string> {
    const fullBook: Book = {
      ...book,
      addedAt: new Date(),
    }
    await db.books.add(fullBook)
    return book.id
  },

  /**
   * Get a book by ID
   */
  async get(id: string): Promise<Book | undefined> {
    let book = await db.books.get(id)
    if (!book) return undefined

    book = await migrateLegacyOriginalFile(book)

    if (book.coverBlob) {
      // Generate object URL for cover
      book.coverUrl = URL.createObjectURL(book.coverBlob)
    }
    return book
  },

  /**
   * Get all books, sorted by last played (most recent first) then by added date
   */
  async getAll(): Promise<Book[]> {
    const books = await db.books.toArray()

    // Migrate legacy PDF storage and generate cover URLs.
    for (let i = 0; i < books.length; i++) {
      books[i] = await migrateLegacyOriginalFile(books[i])
      if (books[i].coverBlob) {
        books[i].coverUrl = URL.createObjectURL(books[i].coverBlob!)
      }
    }

    // Sort: recently played first, then recently added
    return books.sort((a, b) => {
      if (a.lastPlayedAt && b.lastPlayedAt) {
        return b.lastPlayedAt.getTime() - a.lastPlayedAt.getTime()
      }
      if (a.lastPlayedAt) return -1
      if (b.lastPlayedAt) return 1
      return b.addedAt.getTime() - a.addedAt.getTime()
    })
  },

  /**
   * Update a book's metadata
   */
  async update(id: string, updates: Partial<Book>): Promise<void> {
    await db.books.update(id, updates)
  },

  /**
   * Mark a book as recently played
   */
  async markPlayed(id: string): Promise<void> {
    await db.books.update(id, { lastPlayedAt: new Date() })
  },

  /**
   * Delete a book and all its associated data
   */
  async delete(id: string): Promise<void> {
    await db.transaction(
      'rw',
      [db.books, db.sections, db.playbackStates, db.audioChunks, db.bookmarks],
      async () => {
        await db.books.delete(id)
        await db.sections.where('bookId').equals(id).delete()
        await db.playbackStates.delete(id)
        await db.audioChunks.where('bookId').equals(id).delete()
        await db.bookmarks.where('bookId').equals(id).delete()
      }
    )
  },

  /**
   * Delete only the audio cache for a book (keeps the book and sections)
   */
  async deleteAudioCache(id: string): Promise<number> {
    return await db.audioChunks.where('bookId').equals(id).delete()
  },

  /**
   * Check if a book exists
   */
  async exists(id: string): Promise<boolean> {
    const count = await db.books.where('id').equals(id).count()
    return count > 0
  },

  /**
   * Check if a book exists by content hash (for deduplication)
   */
  async existsByContentHash(contentHash: string): Promise<boolean> {
    const count = await db.books.where('contentHash').equals(contentHash).count()
    return count > 0
  },

  /**
   * Get all content hashes in the library (for P2P transfer deduplication)
   */
  async getAllContentHashes(): Promise<string[]> {
    const books = await db.books.toArray()
    return books
      .map(book => book.contentHash)
      .filter((hash): hash is string => !!hash)
  },
}

// ============================================================================
// Section Repository
// ============================================================================

export const sectionRepository = {
  /**
   * Add sections for a book (bulk insert)
   */
  async addBulk(sections: Section[]): Promise<void> {
    await db.sections.bulkAdd(sections)
  },

  /**
   * Get all sections for a book, ordered by index
   */
  async getForBook(bookId: string): Promise<Section[]> {
    return await db.sections.where('bookId').equals(bookId).sortBy('index')
  },

  /**
   * Get a specific section
   */
  async get(bookId: string, index: number): Promise<Section | undefined> {
    return await db.sections.get(sectionId(bookId, index))
  },

  /**
   * Get section count for a book
   */
  async count(bookId: string): Promise<number> {
    return await db.sections.where('bookId').equals(bookId).count()
  },

  /**
   * Delete all sections for a book
   */
  async deleteForBook(bookId: string): Promise<number> {
    return await db.sections.where('bookId').equals(bookId).delete()
  },

  /**
   * Replace all sections for a book atomically (delete + re-insert)
   */
  async replaceForBook(bookId: string, sections: Section[]): Promise<void> {
    await db.transaction('rw', db.sections, async () => {
      await db.sections.where('bookId').equals(bookId).delete()
      await db.sections.bulkAdd(sections)
    })
  },
}
