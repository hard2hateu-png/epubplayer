const fs = require('fs')

function replaceOnce(path, oldText, newText, label) {
  let source = fs.readFileSync(path, 'utf8')
  if (!source.includes(oldText)) throw new Error(`${label} anchor not found in ${path}`)
  source = source.replace(oldText, newText)
  fs.writeFileSync(path, source)
}

// -----------------------------------------------------------------------------
// Page-map versioning: force a one-time re-check after the first implementation.
// The previous boolean could be true even when the initial detector found nothing.
// -----------------------------------------------------------------------------
replaceOnce(
  'src/services/storage/db.ts',
  `  /** True once the original EPUB has been checked for publisher-provided page markers. */\n  pageMapChecked?: boolean\n  addedAt: Date`,
  `  /** True once the original EPUB has been checked for publisher-provided page markers. */\n  pageMapChecked?: boolean\n  /** Detector version used for the last page-map scan. Optional/unindexed for easy upgrades. */\n  pageMapVersion?: number\n  addedAt: Date`,
  'Book page map version'
)

replaceOnce(
  'src/services/epub/parser.ts',
  `const log = createLogger('epub')`,
  `const log = createLogger('epub')\n\n// Bump when page-marker detection changes so existing imported EPUBs are rescanned once.\nexport const EPUB_PAGE_MAP_VERSION = 2`,
  'EPUB page map version constant'
)

replaceOnce(
  'src/services/epub/parser.ts',
  `    pageMapChecked: true,\n  }`,
  `    pageMapChecked: true,\n    pageMapVersion: EPUB_PAGE_MAP_VERSION,\n  }`,
  'new import page map version'
)

replaceOnce(
  'src/services/epub/parser.ts',
  `    element.getAttribute('aria-label'),\n    element.getAttribute('title'),\n    element.textContent,\n    element.getAttribute('id'),`,
  `    element.getAttribute('aria-label'),\n    element.getAttribute('title'),\n    element.getAttribute('data-page'),\n    element.getAttribute('data-page-number'),\n    element.getAttribute('value'),\n    element.textContent,\n    element.getAttribute('id'),`,
  'pagebreak label fallbacks'
)

replaceOnce(
  'src/features/player/PlaybackController.ts',
  `import { enrichSectionsWithPageMarkers } from '@/services/epub/parser'`,
  `import { enrichSectionsWithPageMarkers, EPUB_PAGE_MAP_VERSION } from '@/services/epub/parser'`,
  'PlaybackController page version import'
)

replaceOnce(
  'src/features/player/PlaybackController.ts',
  `      if (storedBook?.pageMapChecked !== true && storedBook?.epubBlob) {`,
  `      if (storedBook?.pageMapVersion !== EPUB_PAGE_MAP_VERSION && storedBook?.epubBlob) {`,
  'PlaybackController recheck condition'
)

replaceOnce(
  'src/features/player/PlaybackController.ts',
  `          await bookRepository.update(book.id, { pageMapChecked: true })`,
  `          await bookRepository.update(book.id, {\n            pageMapChecked: true,\n            pageMapVersion: EPUB_PAGE_MAP_VERSION,\n          })`,
  'PlaybackController version save'
)

// Also show the real EPUB page in the mini-player when one exists, so it is visible
// on the book details screen shown in the iPhone screenshot.
replaceOnce(
  'src/features/player/MiniPlayer.tsx',
  `  const chunkInfo = playbackController.getChunkInfo()\n  const sectionWeights`,
  `  const chunkInfo = playbackController.getChunkInfo()\n  const epubPage = playbackController.getCurrentEpubPage()\n  const sectionWeights`,
  'MiniPlayer current page'
)

replaceOnce(
  'src/features/player/MiniPlayer.tsx',
  `              {isBuffering\n                ? t\`Generating audio...\`\n                : t\`Chapter \${position.sectionIndex + 1} · \${currentBook.author}\`}\n`,
  `              {isBuffering\n                ? t\`Generating audio...\`\n                : epubPage\n                  ? \`Chapter \${position.sectionIndex + 1} · Page \${epubPage} · \${currentBook.author}\`\n                  : t\`Chapter \${position.sectionIndex + 1} · \${currentBook.author}\`}\n`,
  'MiniPlayer page label'
)

// -----------------------------------------------------------------------------
// Cover preview: fix Safari race that could leave the tiny preview visible forever.
// Use a new, sharper preview key so old 180px previews are naturally replaced.
// -----------------------------------------------------------------------------
fs.writeFileSync(
  'src/ui/components/BookCover.tsx',
`import { useEffect, useState } from 'react'\n\nconst PREVIEW_PREFIX = 'epub-cover-preview-v2:'\n\nfunction readPreview(bookId: string): string | null {\n  if (typeof window === 'undefined') return null\n  try {\n    return window.localStorage.getItem(\`\${PREVIEW_PREFIX}\${bookId}\`)\n  } catch {\n    return null\n  }\n}\n\nfunction savePreview(bookId: string, image: HTMLImageElement): string | null {\n  try {\n    if (!image.naturalWidth || !image.naturalHeight) return null\n\n    // Large enough to look clean while the real IndexedDB cover URL wakes up,\n    // but still compact enough for synchronous localStorage.\n    const maxWidth = 420\n    const scale = Math.min(1, maxWidth / image.naturalWidth)\n    const width = Math.max(1, Math.round(image.naturalWidth * scale))\n    const height = Math.max(1, Math.round(image.naturalHeight * scale))\n    const canvas = document.createElement('canvas')\n    canvas.width = width\n    canvas.height = height\n\n    const context = canvas.getContext('2d')\n    if (!context) return null\n    context.drawImage(image, 0, 0, width, height)\n\n    const dataUrl = canvas.toDataURL('image/webp', 0.84)\n    window.localStorage.setItem(\`\${PREVIEW_PREFIX}\${bookId}\`, dataUrl)\n    return dataUrl\n  } catch {\n    return null\n  }\n}\n\ninterface BookCoverProps {\n  bookId: string\n  title: string\n  coverUrl?: string\n  className?: string\n}\n\n/**\n * Cover art that paints instantly on Safari refresh without sacrificing quality.\n * The preview is only a bridge; the original full-resolution EPUB cover always wins\n * as soon as its current blob URL has actually loaded.\n */\nexport function BookCover({ bookId, title, coverUrl, className = '' }: BookCoverProps) {\n  const [preview, setPreview] = useState<string | null>(() => readPreview(bookId))\n  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)\n\n  useEffect(() => {\n    setPreview(readPreview(bookId))\n    setLoadedUrl(null)\n  }, [bookId])\n\n  const fullLoaded = Boolean(coverUrl && loadedUrl === coverUrl)\n\n  return (\n    <div className=\"relative h-full w-full overflow-hidden bg-surface-3\">\n      {preview && (\n        <img\n          src={preview}\n          alt=\"\"\n          aria-hidden=\"true\"\n          className=\"absolute inset-0 h-full w-full object-cover\"\n        />\n      )}\n\n      {coverUrl && (\n        <img\n          key={coverUrl}\n          src={coverUrl}\n          alt={title}\n          className={\`absolute inset-0 h-full w-full object-cover transition-opacity duration-75 \${\n            fullLoaded ? 'opacity-100' : 'opacity-0'\n          } \${className}\`}\n          onLoad={(event) => {\n            // Track the exact blob URL that loaded. This avoids a Safari/React race\n            // where an effect could reset a boolean after a very fast cached load.\n            setLoadedUrl(coverUrl)\n            const cached = savePreview(bookId, event.currentTarget)\n            if (cached) setPreview(cached)\n          }}\n          onError={() => {\n            if (loadedUrl === coverUrl) setLoadedUrl(null)\n          }}\n        />\n      )}\n    </div>\n  )\n}\n`
)

// -----------------------------------------------------------------------------
// New app icon filenames avoid Safari's very sticky home-screen icon cache.
// -----------------------------------------------------------------------------
replaceOnce(
  'index.html',
  `    <link rel="icon" type="image/png" sizes="32x32" href="/pwa-192x192.png" />\n    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
  `    <link rel="icon" type="image/png" sizes="32x32" href="/app-icon-192.png" />\n    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-v2.png" />`,
  'HTML icon filenames'
)

replaceOnce(
  'vite.config.ts',
  `      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'og-image.png'],`,
  `      includeAssets: ['favicon.svg', 'apple-touch-icon-v2.png', 'app-icon-192.png', 'app-icon-512.png', 'og-image.png'],`,
  'PWA included icons'
)

replaceOnce(
  'vite.config.ts',
  `            src: 'pwa-192x192.png',`,
  `            src: 'app-icon-192.png',`,
  'PWA 192 icon'
)

// There are two 512 references (regular + maskable) and one shortcut 192 reference.
let vite = fs.readFileSync('vite.config.ts', 'utf8')
vite = vite.replaceAll("src: 'pwa-512x512.png'", "src: 'app-icon-512.png'")
vite = vite.replace("icons: [{ src: 'pwa-192x192.png', sizes: '192x192' }]", "icons: [{ src: 'app-icon-192.png', sizes: '192x192' }]")
fs.writeFileSync('vite.config.ts', vite)

console.log('Applied page-number retry, cover quality fix, and app icon references')
