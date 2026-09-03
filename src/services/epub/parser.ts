import ePub, { EpubCFI, type Book as EPubBook, type NavItem } from 'epubjs'
import { createLogger } from '@/services/logging'
import { hashText, sectionId } from '@/services/storage/db'
import type { Book, Section, PageMarker } from '@/services/storage/db'

const log = createLogger('epub')

// Bump when page-marker detection changes so existing imported EPUBs are rescanned once.
export const EPUB_PAGE_MAP_VERSION = 4

// ============================================================================
// Types
// ============================================================================

export interface ParsedEPUB {
  book: Omit<Book, 'addedAt' | 'lastPlayedAt'>
  sections: Section[]
}

export interface TOCItem {
  title: string
  href: string
  sectionIndex: number
  children?: TOCItem[]
}

// ============================================================================
// EPUB Parser
// ============================================================================

/**
 * Parse an EPUB file and extract metadata, cover, and sections
 */
export async function parseEPUB(file: File): Promise<ParsedEPUB> {
  log.info('Starting EPUB parse', { filename: file.name })

  const arrayBuffer = await file.arrayBuffer()
  const epub = ePub(arrayBuffer)

  // Wait for the book to be ready
  await epub.ready
  log.debug('EPUB book ready')

  // Extract metadata
  const metadata = await extractMetadata(epub)
  log.debug('Metadata extracted', { title: metadata.title, author: metadata.author })

  const coverBlob = await extractCover(epub)
  log.debug('Cover extracted', { hasCover: !!coverBlob })

  // Extract spine items (sections)
  const sections = await extractSections(epub, metadata.id)
  log.info('EPUB parsed', { title: metadata.title, sections: sections.length })

  const book: Omit<Book, 'addedAt' | 'lastPlayedAt'> = {
    id: metadata.id,
    title: metadata.title,
    author: metadata.author,
    coverBlob,
    language: metadata.language,
    publisher: metadata.publisher,
    description: metadata.description,
    totalSections: sections.length,
    pageMapChecked: true,
    pageMapVersion: EPUB_PAGE_MAP_VERSION,
  }

  // Clean up
  epub.destroy()

  return { book, sections }
}

/**
 * Extract metadata from EPUB
 */
async function extractMetadata(epub: EPubBook) {
  const meta = epub.packaging.metadata

  // Generate a unique ID based on identifiers or title+author
  const identifier = meta.identifier || `${meta.title}-${meta.creator}`
  const id = await hashText(identifier)

  return {
    id,
    title: meta.title || 'Untitled',
    author: meta.creator || 'Unknown Author',
    language: meta.language,
    publisher: meta.publisher,
    description: meta.description,
  }
}

/**
 * Extract cover image from EPUB
 */
async function extractCover(epub: EPubBook): Promise<Blob | undefined> {
  try {
    // Try to get the cover URL
    const coverUrl = await epub.coverUrl()
    if (!coverUrl) return undefined

    // Fetch the cover image
    const response = await fetch(coverUrl)
    if (!response.ok) return undefined

    return await response.blob()
  } catch (error) {
    log.warn('Failed to extract cover', error)
    return undefined
  }
}

/**
 * Extract sections (spine items) from EPUB
 */
async function extractSections(epub: EPubBook, bookId: string): Promise<Section[]> {
  const sections: Section[] = []
  const spine = epub.spine

  // Get navigation (TOC) for section titles
  const navigation = epub.navigation
  const tocMap = buildTocMap(navigation?.toc || [])
  const pageTargets = getPageTargets(epub)

  // Access spine items
  const spineItems = (spine as unknown as { items: Array<{ href: string; index: number }> }).items
  if (!spineItems || spineItems.length === 0) {
    log.warn('No spine items found in EPUB')
    return sections
  }

  log.debug('Processing spine items', { count: spineItems.length })

  for (let i = 0; i < spineItems.length; i++) {
    const item = spineItems[i]

    try {
      // Get the section from spine
      const section = spine.get(item.href) || spine.get(i)
      if (!section) {
        log.warn('Could not get section', { index: i })
        continue
      }

      // Load the section - this populates section.document
      const sectionObj = section as unknown as {
        load: (loader: (url: string) => Promise<unknown>) => Promise<unknown>
        document?: Document
      }

      await sectionObj.load(epub.load.bind(epub))

      // Get text content from the loaded document
      const doc = sectionObj.document
      if (!doc) {
        log.warn('Section has no document after load', { index: i })
        continue
      }

      const textContent = extractTextFromDocument(doc)
      const pageMarkers = extractPageMarkers(doc, item.href, pageTargets, item.index ?? i)
      if (!textContent.trim()) {
        continue // Skip empty sections (like cover pages)
      }

      // Get title from TOC or generate one
      const hrefWithoutFragment = item.href.split('#')[0]
      const title = tocMap.get(hrefWithoutFragment) || tocMap.get(item.href) || `Section ${i + 1}`

      // Calculate text hash for caching
      const textHash = await hashText(textContent)

      // Estimate duration (rough: ~150 words per minute, ~5 chars per word)
      const estimatedDuration = Math.ceil((textContent.length / 5 / 150) * 60)

      sections.push({
        id: sectionId(bookId, sections.length),
        bookId,
        index: sections.length,
        title,
        href: item.href,
        textContent: normalizeText(textContent),
        textHash,
        charCount: textContent.length,
        estimatedDuration,
        pageMarkers: pageMarkers.length > 0 ? pageMarkers : undefined,
      })

      log.debug('Added section', { title, chars: textContent.length })
    } catch (error) {
      log.error('Error processing section', { index: i, error })
    }
  }

  return sections
}


interface PageTarget {
  path?: string
  fragment?: string
  cfi?: string
  spinePos?: number
  label: string
}

function normalizeBookPath(path: string): string {
  try {
    return decodeURIComponent(path.split('?')[0])
      .replace(/^\/+/, '')
      .replace(/^\.\//, '')
  } catch {
    return path.split('?')[0].replace(/^\/+/, '').replace(/^\.\//, '')
  }
}

function pathsReferToSameResource(a: string, b: string): boolean {
  const left = normalizeBookPath(a).replace(/^\.\//, '')
  const right = normalizeBookPath(b).replace(/^\.\//, '')
  if (left === right) return true

  // EPUB nav hrefs are resolved relative to the nav document, while epub.js
  // exposes spine hrefs relative to the package root. That can produce pairs
  // such as "OEBPS/Text/ch03.xhtml" and "Text/ch03.xhtml" for the same file.
  return left.endsWith('/' + right) || right.endsWith('/' + left)
}

function resolvePageHref(navPath: string, href: string): { path: string; fragment?: string } | null {
  if (!href || href.includes('epubcfi(')) return null

  const hashIndex = href.indexOf('#')
  const rawPath = hashIndex >= 0 ? href.slice(0, hashIndex) : href
  const rawFragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : ''
  if (!rawPath && !rawFragment) return null

  try {
    const base = new URL(navPath || 'nav.xhtml', 'https://epub.local/')
    const resolved = new URL(rawPath || base.pathname, base)
    return {
      path: normalizeBookPath(resolved.pathname),
      fragment: rawFragment ? decodeURIComponent(rawFragment) : undefined,
    }
  } catch {
    return {
      path: normalizeBookPath(rawPath),
      fragment: rawFragment || undefined,
    }
  }
}

function getPageTargets(epub: EPubBook): PageTarget[] {
  const rawBook = epub as unknown as {
    pageList?: { pageList?: Array<{ href?: string; page?: string | number; cfi?: string }> }
    packaging?: { navPath?: string; ncxPath?: string }
  }
  const items = rawBook.pageList?.pageList || []
  const navPath = rawBook.packaging?.navPath || rawBook.packaging?.ncxPath || 'nav.xhtml'
  const targets: PageTarget[] = []

  for (const item of items) {
    const label = item.page == null ? '' : String(item.page).trim()
    if (!label || label === 'NaN') continue

    // EPUB 3 page-lists usually point to an element id. Some publishers use
    // EPUB CFI targets instead; epub.js exposes those as item.cfi / href.
    let cfiCandidate = item.cfi || ''
    if (!cfiCandidate && item.href?.includes('epubcfi(')) {
      cfiCandidate = item.href.slice(item.href.indexOf('epubcfi('))
    }
    if (cfiCandidate) {
      try {
        cfiCandidate = decodeURIComponent(cfiCandidate)
        const cfi = cfiCandidate.startsWith('epubcfi(')
          ? cfiCandidate
          : `epubcfi(${cfiCandidate})`
        const parsed = new EpubCFI(cfi)
        targets.push({ cfi, spinePos: parsed.spinePos, label })
        continue
      } catch {
        // Fall through to a normal href target when available.
      }
    }

    if (!item.href) continue
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

function normalizedOffsetAtRangeStart(doc: Document, target: Range): number {
  try {
    const root = doc.body || doc.documentElement
    const range = doc.createRange()
    range.selectNodeContents(root)
    range.setEnd(target.startContainer, target.startOffset)
    return normalizeText(range.toString()).length
  } catch {
    return 0
  }
}

function findFragmentNode(doc: Document, fragment: string): Element | null {
  const decoded = (() => {
    try { return decodeURIComponent(fragment) } catch { return fragment }
  })()
  const byId = doc.getElementById(decoded)
  if (byId) return byId

  // Older EPUB 2 files sometimes use <a name="..."> instead of an id.
  return Array.from(doc.querySelectorAll('[name]')).find(
    (element) => element.getAttribute('name') === decoded
  ) || null
}

function pageBreakLabel(element: Element): string | null {
  const candidates = [
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.getAttribute('data-page'),
    element.getAttribute('data-page-number'),
    element.getAttribute('value'),
    element.textContent,
    element.getAttribute('id'),
  ]

  for (const raw of candidates) {
    const value = raw?.trim()
    if (!value) continue
    const match = value.match(/(?:page[\s_-]*)?([0-9]+|[ivxlcdm]+)/i)
    if (match?.[1]) return match[1]
  }

  return null
}

function extractPageMarkers(
  doc: Document,
  sectionHref: string,
  pageTargets: PageTarget[],
  spineIndex: number
): PageMarker[] {
  const markers: PageMarker[] = []
  const sectionPath = normalizeBookPath(sectionHref.split('#')[0])

  // Explicit EPUB navigation page-list: map its anchor to an offset in the exact
  // normalized section text that is later handed to the TTS chunker.
  for (const target of pageTargets) {
    if (target.cfi) {
      if (target.spinePos !== spineIndex) continue
      try {
        const range = new EpubCFI(target.cfi).toRange(doc)
        markers.push({ label: target.label, offset: normalizedOffsetAtRangeStart(doc, range) })
      } catch {
        // Malformed/unresolvable CFI: keep checking other publisher markers.
      }
      continue
    }

    if (!target.path || !pathsReferToSameResource(target.path, sectionPath)) continue
    if (!target.fragment) {
      markers.push({ label: target.label, offset: 0 })
      continue
    }

    const node = findFragmentNode(doc, target.fragment)
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
    const isPageBreak = epubType.split(/\s+/).includes('pagebreak') || role === 'doc-pagebreak'
    if (!isPageBreak) continue

    const label = pageBreakLabel(element)
    if (!label) continue
    markers.push({ label, offset: normalizedOffsetBefore(doc, element) })
  }

  const deduped = new Map<string, PageMarker>()
  for (const marker of markers) {
    deduped.set(`${marker.offset}:${marker.label}`, marker)
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
  const updated: Section[] = sections.map((section) => ({ ...section, pageMarkers: undefined }))

  // The shared import pipeline historically rebuilt EPUB sections with href: ''.
  // That meant older imported books could not be matched back to their original
  // spine items during page-map backfill, even though the original EPUB was saved.
  const byHref = new Map(
    updated
      .map((section, index) => [normalizeBookPath(section.href.split('#')[0]), index] as const)
      .filter(([href]) => href.length > 0)
  )
  const matchedSectionIndices = new Set<number>()

  const spineItems = (epub.spine as unknown as { items: Array<{ href: string; index?: number }> }).items || []

  try {
    for (let i = 0; i < spineItems.length; i++) {
      const item = spineItems[i]
      let sectionIndex = byHref.get(normalizeBookPath(item.href.split('#')[0]))

      const spineSection = epub.spine.get(item.href) || epub.spine.get(i)
      if (!spineSection) continue
      const sectionObj = spineSection as unknown as {
        load: (loader: (url: string) => Promise<unknown>) => Promise<unknown>
        document?: Document
      }
      await sectionObj.load(epub.load.bind(epub))
      if (!sectionObj.document) continue

      const markers = extractPageMarkers(sectionObj.document, item.href, pageTargets, item.index ?? i)

      // Fallback for EPUBs imported through the shared content pipeline, which
      // discarded the original href. Match the exact normalized text that was
      // saved for TTS; this does not modify that text or its chunking.
      if (sectionIndex == null) {
        const spineText = normalizeText(extractTextFromDocument(sectionObj.document))
        const textMatch = updated.findIndex(
          (section, index) => !matchedSectionIndices.has(index) && section.textContent === spineText
        )
        if (textMatch >= 0) sectionIndex = textMatch
      }

      if (sectionIndex == null) continue
      matchedSectionIndices.add(sectionIndex)
      updated[sectionIndex] = {
        ...updated[sectionIndex],
        href: item.href,
        pageMarkers: markers.length > 0 ? markers : undefined,
      }
    }
  } finally {
    epub.destroy()
  }

  return updated
}

/**
 * Build a map of href -> title from TOC
 */
function buildTocMap(toc: NavItem[]): Map<string, string> {
  const map = new Map<string, string>()

  function processItem(item: NavItem) {
    if (item.href) {
      // Remove fragment identifier if present
      const href = item.href.split('#')[0]
      map.set(href, item.label.trim())
      // Also add with the full href in case it's needed
      map.set(item.href, item.label.trim())
    }
    if (item.subitems) {
      item.subitems.forEach(processItem)
    }
  }

  toc.forEach(processItem)
  return map
}

/**
 * Extract plain text from an HTML document
 */
function extractTextFromDocument(doc: Document): string {
  // Remove script and style elements
  const scripts = doc.querySelectorAll('script, style, noscript')
  scripts.forEach((el) => el.remove())

  // Get body text
  const body = doc.body || doc.documentElement
  return body?.textContent || ''
}

/**
 * Normalize text for TTS
 */
function normalizeText(text: string): string {
  return (
    text
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      // Remove excessive line breaks
      .replace(/\n{3,}/g, '\n\n')
      // Trim
      .trim()
  )
}

/**
 * Extract TOC structure from EPUB
 */
export async function extractTOC(file: File): Promise<TOCItem[]> {
  const arrayBuffer = await file.arrayBuffer()
  const epub = ePub(arrayBuffer)
  await epub.ready

  const navigation = epub.navigation
  const toc = navigation?.toc || []

  // Get spine items for index mapping
  const spineItems = (epub.spine as unknown as { items: Array<{ href: string }> }).items || []
  const hrefToIndex = new Map(spineItems.map((item, i) => [item.href?.split('#')[0], i]))

  function processTocItem(item: NavItem): TOCItem {
    const href = item.href?.split('#')[0] || ''
    return {
      title: item.label.trim(),
      href: item.href || '',
      sectionIndex: hrefToIndex.get(href) ?? -1,
      children: item.subitems?.map(processTocItem),
    }
  }

  const result = toc.map(processTocItem)
  epub.destroy()

  return result
}
