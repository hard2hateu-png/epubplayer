const fs = require('fs')

function replaceOnce(path, oldText, newText, label) {
  let source = fs.readFileSync(path, 'utf8')
  if (!source.includes(oldText)) throw new Error(`${label} anchor not found in ${path}`)
  source = source.replace(oldText, newText)
  fs.writeFileSync(path, source)
}

function replaceAllChecked(path, oldText, newText, label) {
  let source = fs.readFileSync(path, 'utf8')
  const count = source.split(oldText).length - 1
  if (count < 1) throw new Error(`${label} anchor not found in ${path}`)
  source = source.split(oldText).join(newText)
  fs.writeFileSync(path, source)
  return count
}

// -----------------------------------------------------------------------------
// Storage types: optional unindexed fields, so no Dexie schema migration needed.
// -----------------------------------------------------------------------------
replaceOnce(
  'src/services/storage/db.ts',
  `  totalSections: number\n  addedAt: Date`,
  `  totalSections: number\n  /** True once the original EPUB has been checked for publisher-provided page markers. */\n  pageMapChecked?: boolean\n  addedAt: Date`,
  'Book pageMapChecked'
)

replaceOnce(
  'src/services/storage/db.ts',
  `export interface Section {`,
  `export interface PageMarker {\n  /** Publisher-provided page label, e.g. "87" or "xii". */\n  label: string\n  /** Character offset in the normalized TTS section text where this page begins. */\n  offset: number\n}\n\nexport interface Section {`,
  'PageMarker type'
)

replaceOnce(
  'src/services/storage/db.ts',
  `  estimatedDuration: number // Estimated TTS duration in seconds\n}`,
  `  estimatedDuration: number // Estimated TTS duration in seconds\n  /** Original EPUB/print page boundaries when the EPUB actually supplies them. */\n  pageMarkers?: PageMarker[]\n}`,
  'Section pageMarkers'
)

// -----------------------------------------------------------------------------
// EPUB parser: preserve only real page data supplied by the EPUB.
// Supports EPUB 3 page-list links and embedded epub:type="pagebreak" markers.
// -----------------------------------------------------------------------------
replaceOnce(
  'src/services/epub/parser.ts',
  `import type { Book, Section } from '@/services/storage/db'`,
  `import type { Book, Section, PageMarker } from '@/services/storage/db'`,
  'parser PageMarker import'
)

replaceOnce(
  'src/services/epub/parser.ts',
  `    totalSections: sections.length,\n  }`,
  `    totalSections: sections.length,\n    pageMapChecked: true,\n  }`,
  'parser pageMapChecked flag'
)

replaceOnce(
  'src/services/epub/parser.ts',
  `  const navigation = epub.navigation\n  const tocMap = buildTocMap(navigation?.toc || [])`,
  `  const navigation = epub.navigation\n  const tocMap = buildTocMap(navigation?.toc || [])\n  const pageTargets = getPageTargets(epub)`,
  'parser page targets'
)

replaceOnce(
  'src/services/epub/parser.ts',
  `      const textContent = extractTextFromDocument(doc)\n      if (!textContent.trim()) {`,
  `      const textContent = extractTextFromDocument(doc)\n      const pageMarkers = extractPageMarkers(doc, item.href, pageTargets)\n      if (!textContent.trim()) {`,
  'parser extract page markers'
)

replaceOnce(
  'src/services/epub/parser.ts',
  `        charCount: textContent.length,\n        estimatedDuration,\n      })`,
  `        charCount: textContent.length,\n        estimatedDuration,\n        pageMarkers: pageMarkers.length > 0 ? pageMarkers : undefined,\n      })`,
  'parser store page markers'
)

const pageHelpers = `
interface PageTarget {
  path: string
  fragment: string
  label: string
}

function normalizeBookPath(path: string): string {
  try {
    return decodeURIComponent(path.split('?')[0])
      .replace(/^\\/+/, '')
      .replace(/^\\.\\//, '')
  } catch {
    return path.split('?')[0].replace(/^\\/+/, '').replace(/^\\.\\//, '')
  }
}

function resolvePageHref(navPath: string, href: string): { path: string; fragment: string } | null {
  if (!href || href.includes('epubcfi(')) return null

  const hashIndex = href.indexOf('#')
  const rawPath = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  const rawFragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : ''
  if (!rawFragment) return null

  try {
    const base = new URL(navPath || 'nav.xhtml', 'https://epub.local/')
    const resolved = new URL(rawPath || base.pathname, base)
    return {
      path: normalizeBookPath(resolved.pathname),
      fragment: decodeURIComponent(rawFragment),
    }
  } catch {
    return {
      path: normalizeBookPath(rawPath),
      fragment: rawFragment,
    }
  }
}

function getPageTargets(epub: EPubBook): PageTarget[] {
  const rawBook = epub as unknown as {
    pageList?: { pageList?: Array<{ href?: string; page?: string | number }> }
    packaging?: { navPath?: string; ncxPath?: string }
  }
  const items = rawBook.pageList?.pageList || []
  const navPath = rawBook.packaging?.navPath || rawBook.packaging?.ncxPath || 'nav.xhtml'
  const targets: PageTarget[] = []

  for (const item of items) {
    const label = item.page == null ? '' : String(item.page).trim()
    if (!item.href || !label || label === 'NaN') continue
    const resolved = resolvePageHref(navPath, item.href)
    if (!resolved) continue
    targets.push({ ...resolved, label })
  }

  return targets
}

function normalizedOffsetBefore(doc: Document, node: Element): number {
  try {
    const root = doc.body || doc.documentElement
    const range = doc.createRange()
    range.selectNodeContents(root)
    range.setEndBefore(node)
    return normalizeText(range.toString()).length
  } catch {
    return 0
  }
}

function pageBreakLabel(element: Element): string | null {
  const candidates = [
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.textContent,
    element.getAttribute('id'),
  ]

  for (const raw of candidates) {
    const value = raw?.trim()
    if (!value) continue
    const match = value.match(/(?:page[\\s_-]*)?([0-9]+|[ivxlcdm]+)/i)
    if (match?.[1]) return match[1]
  }

  return null
}

function extractPageMarkers(doc: Document, sectionHref: string, pageTargets: PageTarget[]): PageMarker[] {
  const markers: PageMarker[] = []
  const sectionPath = normalizeBookPath(sectionHref.split('#')[0])

  // Explicit EPUB navigation page-list: map its anchor to an offset in the exact
  // normalized section text that is later handed to the TTS chunker.
  for (const target of pageTargets) {
    if (target.path !== sectionPath) continue
    const node = doc.getElementById(target.fragment)
    if (!node) continue
    markers.push({ label: target.label, offset: normalizedOffsetBefore(doc, node) })
  }

  // Some EPUBs omit a nav page-list but embed semantic pagebreak markers in the
  // content documents. Those are also publisher-provided page data, not guessed pages.
  for (const element of Array.from(doc.getElementsByTagName('*'))) {
    const epubType =
      element.getAttribute('epub:type') ||
      element.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ||
      ''
    const role = element.getAttribute('role') || ''
    const isPageBreak = epubType.split(/\\s+/).includes('pagebreak') || role === 'doc-pagebreak'
    if (!isPageBreak) continue

    const label = pageBreakLabel(element)
    if (!label) continue
    markers.push({ label, offset: normalizedOffsetBefore(doc, element) })
  }

  const deduped = new Map<string, PageMarker>()
  for (const marker of markers) {
    deduped.set(\`${'${marker.offset}:${marker.label}'}\`, marker)
  }

  return Array.from(deduped.values()).sort((a, b) => a.offset - b.offset)
}

/**
 * One-time page-map backfill for books imported before page tracking existed.
 * Uses the original stored EPUB and never changes TTS text or chunking.
 */
export async function enrichSectionsWithPageMarkers(
  epubBlob: Blob,
  sections: Section[]
): Promise<Section[]> {
  const epub = ePub(await epubBlob.arrayBuffer())
  await epub.ready
  const pageTargets = getPageTargets(epub)
  const updated = sections.map((section) => ({ ...section, pageMarkers: undefined }))
  const byHref = new Map(updated.map((section, index) => [normalizeBookPath(section.href.split('#')[0]), index]))

  const spineItems = (epub.spine as unknown as { items: Array<{ href: string }> }).items || []

  try {
    for (let i = 0; i < spineItems.length; i++) {
      const item = spineItems[i]
      const sectionIndex = byHref.get(normalizeBookPath(item.href.split('#')[0]))
      if (sectionIndex == null) continue

      const spineSection = epub.spine.get(item.href) || epub.spine.get(i)
      if (!spineSection) continue
      const sectionObj = spineSection as unknown as {
        load: (loader: (url: string) => Promise<unknown>) => Promise<unknown>
        document?: Document
      }
      await sectionObj.load(epub.load.bind(epub))
      if (!sectionObj.document) continue

      const markers = extractPageMarkers(sectionObj.document, item.href, pageTargets)
      updated[sectionIndex] = {
        ...updated[sectionIndex],
        pageMarkers: markers.length > 0 ? markers : undefined,
      }
    }
  } finally {
    epub.destroy()
  }

  return updated
}
`

replaceOnce(
  'src/services/epub/parser.ts',
  `/**\n * Build a map of href -> title from TOC\n */`,
  `${pageHelpers}\n/**\n * Build a map of href -> title from TOC\n */`,
  'parser page helper insertion'
)

// -----------------------------------------------------------------------------
// Chunk manager: retain display-only text offsets. Chunk text/hash are unchanged.
// -----------------------------------------------------------------------------
replaceOnce(
  'src/features/player/ChunkManager.ts',
  `  text: string\n  textHash: string\n}`,
  `  text: string\n  textHash: string\n  /** Start offset of this unchanged chunk inside the normalized section text. */\n  startOffset: number\n}`,
  'ChunkInfo startOffset'
)

replaceOnce(
  'src/features/player/ChunkManager.ts',
  `    // Create chunk info objects\n    const newChunks: ChunkInfo[] = await Promise.all(\n      textChunks.map(async (chunkText, index) => ({\n        sectionIndex,\n        chunkIndex: index,\n        text: chunkText,\n        textHash: await hashText(chunkText),\n      }))\n    )`,
  `    // Record where each unchanged chunk begins in the normalized section text.\n    // This is UI metadata only; the text passed to TTS is byte-for-byte the same.\n    let searchFrom = 0\n    const chunkStarts = textChunks.map((chunkText) => {\n      const found = text.indexOf(chunkText, searchFrom)\n      const startOffset = found >= 0 ? found : searchFrom\n      searchFrom = startOffset + chunkText.length\n      return startOffset\n    })\n\n    // Create chunk info objects\n    const newChunks: ChunkInfo[] = await Promise.all(\n      textChunks.map(async (chunkText, index) => ({\n        sectionIndex,\n        chunkIndex: index,\n        text: chunkText,\n        textHash: await hashText(chunkText),\n        startOffset: chunkStarts[index] ?? 0,\n      }))\n    )`,
  'ChunkManager chunk starts'
)

// -----------------------------------------------------------------------------
// Playback controller: backfill old imports once and expose the real EPUB page.
// -----------------------------------------------------------------------------
replaceOnce(
  'src/features/player/PlaybackController.ts',
  `import { settingsRepository } from '@/services/storage/settingsRepository'`,
  `import { settingsRepository } from '@/services/storage/settingsRepository'\nimport { enrichSectionsWithPageMarkers } from '@/services/epub'`,
  'PlaybackController page helper import'
)

replaceOnce(
  'src/features/player/PlaybackController.ts',
  `      // Load sections from DB\n      this.sections = await sectionRepository.getForBook(book.id)\n\n      // Load saved playback state`,
  `      // Load sections from DB\n      this.sections = await sectionRepository.getForBook(book.id)\n\n      // Books imported before page tracking existed can be checked once using the\n      // original stored EPUB. If the EPUB contains no page map/pagebreaks, nothing\n      // is displayed and we remember that we already checked.\n      const storedBook = await bookRepository.get(book.id)\n      if (storedBook?.pageMapChecked !== true && storedBook?.epubBlob) {\n        try {\n          this.sections = await enrichSectionsWithPageMarkers(storedBook.epubBlob, this.sections)\n          await sectionRepository.replaceForBook(book.id, this.sections)\n          await bookRepository.update(book.id, { pageMapChecked: true })\n        } catch (error) {\n          log.warn('Could not read EPUB page map', error)\n        } finally {\n          if (storedBook.coverUrl) URL.revokeObjectURL(storedBook.coverUrl)\n        }\n      }\n\n      // Load saved playback state`,
  'PlaybackController page-map backfill'
)

replaceOnce(
  'src/features/player/PlaybackController.ts',
  `  getChunkInfo(): { current: number; total: number; progress: number } {\n    const state = playbackStateMachine.getState()\n    return chunkManager.getStats({\n      sectionIndex: state.sectionIndex,\n      chunkIndex: state.chunkIndex,\n    })\n  }`,
  `  getChunkInfo(): { current: number; total: number; progress: number } {\n    const state = playbackStateMachine.getState()\n    return chunkManager.getStats({\n      sectionIndex: state.sectionIndex,\n      chunkIndex: state.chunkIndex,\n    })\n  }\n\n  /**\n   * Return the publisher-provided EPUB/print page at the current audio position.\n   * Returns null when the original EPUB does not contain page information.\n   */\n  getCurrentEpubPage(): string | null {\n    const state = playbackStateMachine.getState()\n    const chunk = chunkManager.getChunk({\n      sectionIndex: state.sectionIndex,\n      chunkIndex: state.chunkIndex,\n    })\n    if (!chunk) return null\n\n    const store = usePlayerStore.getState()\n    const liveFraction = store.chunkDuration > 0\n      ? Math.max(0, Math.min(1, store.position.timeInChunk / store.chunkDuration))\n      : 0\n    const textOffset = chunk.startOffset + Math.floor(chunk.text.length * liveFraction)\n\n    const currentMarkers = this.sections[state.sectionIndex]?.pageMarkers || []\n    let currentLabel: string | null = null\n    for (const marker of currentMarkers) {\n      if (marker.offset <= textOffset) currentLabel = marker.label\n      else break\n    }\n    if (currentLabel) return currentLabel\n\n    // At the very beginning of a section, the physical page may have started in\n    // the previous section. Carry the most recent real marker forward.\n    for (let sectionIndex = state.sectionIndex - 1; sectionIndex >= 0; sectionIndex--) {\n      const markers = this.sections[sectionIndex]?.pageMarkers || []\n      if (markers.length > 0) return markers[markers.length - 1].label\n    }\n\n    return null\n  }`,
  'PlaybackController getCurrentEpubPage'
)

// -----------------------------------------------------------------------------
// Now Playing: show Page N only when real page data exists.
// -----------------------------------------------------------------------------
replaceOnce(
  'src/features/player/NowPlayingPage.tsx',
  `  const chunkInfo = playbackController.getChunkInfo()\n  const chunkText = playbackController.getCurrentChunkText()`,
  `  const chunkInfo = playbackController.getChunkInfo()\n  const chunkText = playbackController.getCurrentChunkText()\n  const epubPage = playbackController.getCurrentEpubPage()`,
  'NowPlaying epubPage value'
)

replaceOnce(
  'src/features/player/NowPlayingPage.tsx',
  `                  <div className="flex justify-between text-xs text-text-muted" aria-hidden="true">\n                    <span>{chapterCount > 0 ? \`Chapter \${chapterNumber} of \${chapterCount}\` : t\`Loading...\`}</span>\n                    <span>{\`\${bookProgress.toFixed(1)}%\`}</span>\n                  </div>`,
  `                  <div className="grid grid-cols-3 items-center text-xs text-text-muted" aria-hidden="true">\n                    <span>{chapterCount > 0 ? \`Chapter \${chapterNumber} of \${chapterCount}\` : t\`Loading...\`}</span>\n                    {epubPage ? <span className="text-center">Page {epubPage}</span> : <span />}\n                    <span className="text-right">{\`\${bookProgress.toFixed(1)}%\`}</span>\n                  </div>`,
  'NowPlaying reader progress page'
)

replaceOnce(
  'src/features/player/NowPlayingPage.tsx',
  `                  <div className="flex justify-between text-xs text-text-muted lg:text-sm">\n                    <span>\n                      {chapterCount > 0 \n                        ? \`Chapter \${chapterNumber} of \${chapterCount}\`\n                        : t\`Loading...\`}\n                    </span>\n                    <span>{\`\${bookProgress.toFixed(1)}%\`}</span>\n                  </div>`,
  `                  <div className="grid grid-cols-3 items-center text-xs text-text-muted lg:text-sm">\n                    <span>\n                      {chapterCount > 0 \n                        ? \`Chapter \${chapterNumber} of \${chapterCount}\`\n                        : t\`Loading...\`}\n                    </span>\n                    {epubPage ? <span className="text-center">Page {epubPage}</span> : <span />}\n                    <span className="text-right">{\`\${bookProgress.toFixed(1)}%\`}</span>\n                  </div>`,
  'NowPlaying normal progress page'
)

console.log('Applied publisher EPUB page tracking')
