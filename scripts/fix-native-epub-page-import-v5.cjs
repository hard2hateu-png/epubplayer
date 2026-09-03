const fs = require('fs')

function replaceOnce(file, oldText, newText, label) {
  let src = fs.readFileSync(file, 'utf8')
  if (!src.includes(oldText)) throw new Error(`Missing patch target: ${label}`)
  src = src.replace(oldText, newText)
  fs.writeFileSync(file, src)
}

replaceOnce(
  'src/services/contentParsers/types.ts',
`export interface ParsedContent {
  metadata: ContentMetadata
  coverBlob?: Blob
  sections: DetectedSection[]
  originalBlob?: Blob
  contentHash: string
}`,
`export interface ParsedContent {
  metadata: ContentMetadata
  coverBlob?: Blob
  sections: DetectedSection[]
  originalBlob?: Blob
  contentHash: string
  /** Page-map detector version when the source parser already scanned publisher page data. */
  pageMapVersion?: number
}`,
  'ParsedContent page map version'
)

replaceOnce(
  'src/services/contentParsers/types.ts',
`export interface DetectedSection {
  title: string
  textContent: string
  confidence: SectionConfidence
}`,
`export interface DetectedSection {
  title: string
  textContent: string
  confidence: SectionConfidence
  /** Original EPUB spine href when the source format supplies one. */
  href?: string
  /** Publisher-provided page boundaries already mapped to normalized section text. */
  pageMarkers?: Array<{ label: string; offset: number }>
}`,
  'DetectedSection EPUB metadata'
)

replaceOnce(
  'src/services/contentParsers/epubAdapter.ts',
`    sections: sections.map((s) => ({
      title: s.title,
      textContent: s.textContent,
      confidence: 'high' as const,
    })),
    originalBlob: file,
    contentHash,`,
`    sections: sections.map((s) => ({
      title: s.title,
      textContent: s.textContent,
      confidence: 'high' as const,
      href: s.href,
      pageMarkers: s.pageMarkers,
    })),
    originalBlob: file,
    contentHash,
    pageMapVersion: book.pageMapVersion,`,
  'EPUB adapter preserves href and page markers'
)

replaceOnce(
  'src/features/import/saveImport.ts',
`export async function buildSectionRecords(
  bookId: string,
  sections: { title: string; textContent: string }[],
): Promise<Section[]> {`,
`export async function buildSectionRecords(
  bookId: string,
  sections: {
    title: string
    textContent: string
    href?: string
    pageMarkers?: Array<{ label: string; offset: number }>
  }[],
): Promise<Section[]> {`,
  'section builder input metadata'
)

replaceOnce(
  'src/features/import/saveImport.ts',
`        title: s.title || \`Section \${index + 1}\`,
        href: '',
        textContent,
        textHash,
        charCount,
        estimatedDuration,`,
`        title: s.title || \`Section \${index + 1}\`,
        href: s.href || '',
        textContent,
        textHash,
        charCount,
        estimatedDuration,
        pageMarkers: s.pageMarkers?.length ? s.pageMarkers : undefined,`,
  'persist href and page markers'
)

replaceOnce(
  'src/features/import/saveImport.ts',
`    totalSections: finalSections.length,
    epubBlob: originalBlob,
    contentHash,`,
`    totalSections: finalSections.length,
    epubBlob: originalBlob,
    contentHash,
    // EPUB parsing already did the publisher-page scan during import. Persist that
    // fact so first playback does not reopen/rescan the EPUB just to recover data
    // we already have. Other source types leave these fields unset.
    pageMapChecked: metadata.sourceType === 'epub' ? true : undefined,
    pageMapVersion: metadata.sourceType === 'epub' ? content.pageMapVersion : undefined,`,
  'mark EPUB page map complete at import'
)

console.log('Applied native EPUB page import v5')
