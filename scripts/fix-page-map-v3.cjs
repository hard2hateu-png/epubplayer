const fs = require('fs')

const file = 'src/services/epub/parser.ts'
let src = fs.readFileSync(file, 'utf8')

function replaceOnce(oldText, newText, label) {
  if (!src.includes(oldText)) throw new Error(`Missing patch target: ${label}`)
  src = src.replace(oldText, newText)
}

replaceOnce(
  "import ePub, { type Book as EPubBook, type NavItem } from 'epubjs'",
  "import ePub, { EpubCFI, type Book as EPubBook, type NavItem } from 'epubjs'",
  'epubjs import'
)

replaceOnce(
  'export const EPUB_PAGE_MAP_VERSION = 2',
  'export const EPUB_PAGE_MAP_VERSION = 3',
  'page map version'
)

replaceOnce(
`interface PageTarget {
  path: string
  fragment: string
  label: string
}`,
`interface PageTarget {
  path?: string
  fragment?: string
  cfi?: string
  spinePos?: number
  label: string
}`,
  'PageTarget interface'
)

replaceOnce(
`function resolvePageHref(navPath: string, href: string): { path: string; fragment: string } | null {
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
}`,
`function pathsReferToSameResource(a: string, b: string): boolean {
  const left = normalizeBookPath(a).replace(/^\\.\\//, '')
  const right = normalizeBookPath(b).replace(/^\\.\\//, '')
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
}`,
  'page href resolver'
)

replaceOnce(
`  const rawBook = epub as unknown as {
    pageList?: { pageList?: Array<{ href?: string; page?: string | number }> }
    packaging?: { navPath?: string; ncxPath?: string }
  }`,
`  const rawBook = epub as unknown as {
    pageList?: { pageList?: Array<{ href?: string; page?: string | number; cfi?: string }> }
    packaging?: { navPath?: string; ncxPath?: string }
  }`,
  'page list typing'
)

replaceOnce(
`  for (const item of items) {
    const label = item.page == null ? '' : String(item.page).trim()
    if (!item.href || !label || label === 'NaN') continue
    const resolved = resolvePageHref(navPath, item.href)
    if (!resolved) continue
    targets.push({ ...resolved, label })
  }`,
`  for (const item of items) {
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
          : \`epubcfi(\${cfiCandidate})\`
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
  }`,
  'page target parsing'
)

replaceOnce(
`function normalizedOffsetBefore(doc: Document, node: Element): number {
  try {
    const root = doc.body || doc.documentElement
    const range = doc.createRange()
    range.selectNodeContents(root)
    range.setEndBefore(node)
    return normalizeText(range.toString()).length
  } catch {
    return 0
  }
}`,
`function normalizedOffsetBefore(doc: Document, node: Element): number {
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
}`,
  'offset and named anchor helpers'
)

replaceOnce(
`function extractPageMarkers(doc: Document, sectionHref: string, pageTargets: PageTarget[]): PageMarker[] {
  const markers: PageMarker[] = []
  const sectionPath = normalizeBookPath(sectionHref.split('#')[0])

  // Explicit EPUB navigation page-list: map its anchor to an offset in the exact
  // normalized section text that is later handed to the TTS chunker.
  for (const target of pageTargets) {
    if (target.path !== sectionPath) continue
    const node = doc.getElementById(target.fragment)
    if (!node) continue
    markers.push({ label: target.label, offset: normalizedOffsetBefore(doc, node) })
  }`,
`function extractPageMarkers(
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
  }`,
  'page marker extraction'
)

replaceOnce(
  'const pageMarkers = extractPageMarkers(doc, item.href, pageTargets)',
  'const pageMarkers = extractPageMarkers(doc, item.href, pageTargets, item.index ?? i)',
  'initial import page marker call'
)

replaceOnce(
  "const spineItems = (epub.spine as unknown as { items: Array<{ href: string }> }).items || []",
  "const spineItems = (epub.spine as unknown as { items: Array<{ href: string; index?: number }> }).items || []",
  'backfill spine typing'
)

replaceOnce(
  'const markers = extractPageMarkers(sectionObj.document, item.href, pageTargets)',
  'const markers = extractPageMarkers(sectionObj.document, item.href, pageTargets, item.index ?? i)',
  'backfill page marker call'
)

fs.writeFileSync(file, src)
console.log('Applied EPUB page map v3 compatibility fixes')
