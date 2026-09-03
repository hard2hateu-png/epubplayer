const fs = require('fs')

const file = 'src/services/epub/parser.ts'
let src = fs.readFileSync(file, 'utf8')

function replaceOnce(oldText, newText, label) {
  if (!src.includes(oldText)) throw new Error(`Missing patch target: ${label}`)
  src = src.replace(oldText, newText)
}

replaceOnce(
  'export const EPUB_PAGE_MAP_VERSION = 3',
  'export const EPUB_PAGE_MAP_VERSION = 4',
  'page map version'
)

replaceOnce(
`  const updated: Section[] = sections.map((section) => ({ ...section, pageMarkers: undefined }))
  const byHref = new Map(updated.map((section, index) => [normalizeBookPath(section.href.split('#')[0]), index]))

  const spineItems = (epub.spine as unknown as { items: Array<{ href: string; index?: number }> }).items || []

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

      const markers = extractPageMarkers(sectionObj.document, item.href, pageTargets, item.index ?? i)
      updated[sectionIndex] = {
        ...updated[sectionIndex],
        pageMarkers: markers.length > 0 ? markers : undefined,
      }
    }
  } finally {`,
`  const updated: Section[] = sections.map((section) => ({ ...section, pageMarkers: undefined }))

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
  } finally {`,
  'page map backfill matching'
)

fs.writeFileSync(file, src)
console.log('Applied EPUB page backfill v4 fix')
