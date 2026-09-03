const fs = require('fs')

function replaceOnce(path, oldText, newText, label) {
  let source = fs.readFileSync(path, 'utf8')
  if (!source.includes(oldText)) {
    throw new Error(`${label} anchor not found in ${path}`)
  }
  source = source.replace(oldText, newText)
  fs.writeFileSync(path, source)
}

function replaceAllChecked(path, oldText, newText, label) {
  let source = fs.readFileSync(path, 'utf8')
  const count = source.split(oldText).length - 1
  if (count < 1) {
    throw new Error(`${label} anchor not found in ${path}`)
  }
  source = source.split(oldText).join(newText)
  fs.writeFileSync(path, source)
  return count
}

const coverComponent = `import { useEffect, useState } from 'react'

const PREVIEW_PREFIX = 'epub-cover-preview:'

function readPreview(bookId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(\`${'${PREVIEW_PREFIX}${bookId}'}\`)
  } catch {
    return null
  }
}

function savePreview(bookId: string, image: HTMLImageElement): string | null {
  try {
    if (!image.naturalWidth || !image.naturalHeight) return null

    const maxWidth = 180
    const scale = Math.min(1, maxWidth / image.naturalWidth)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, width, height)

    const dataUrl = canvas.toDataURL('image/webp', 0.72)
    window.localStorage.setItem(\`${'${PREVIEW_PREFIX}${bookId}'}\`, dataUrl)
    return dataUrl
  } catch {
    // A cover should never fail just because the tiny synchronous preview
    // cannot be written (storage full, unsupported encoding, etc.).
    return null
  }
}

interface BookCoverProps {
  bookId: string
  title: string
  coverUrl?: string
  className?: string
}

/**
 * Cover art that avoids blob-URL flashes across Safari refreshes.
 *
 * The full cover remains stored in IndexedDB. Once it successfully loads, we
 * keep a tiny compressed preview in localStorage, which is synchronous and can
 * paint immediately on the next refresh while IndexedDB recreates the session
 * blob URL. This is display-only and does not touch EPUB or TTS data.
 */
export function BookCover({ bookId, title, coverUrl, className = '' }: BookCoverProps) {
  const [preview, setPreview] = useState<string | null>(() => readPreview(bookId))
  const [fullLoaded, setFullLoaded] = useState(false)

  useEffect(() => {
    setPreview(readPreview(bookId))
    setFullLoaded(false)
  }, [bookId, coverUrl])

  return (
    <div className="relative h-full w-full overflow-hidden bg-surface-3">
      {preview && (
        <img
          src={preview}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}

      {coverUrl && (
        <img
          src={coverUrl}
          alt={title}
          className={\`absolute inset-0 h-full w-full object-cover transition-opacity duration-75 \${
            fullLoaded ? 'opacity-100' : 'opacity-0'
          } \${className}\`}
          onLoad={(event) => {
            setFullLoaded(true)
            if (!preview) {
              const cached = savePreview(bookId, event.currentTarget)
              if (cached) setPreview(cached)
            }
          }}
          onError={() => setFullLoaded(false)}
        />
      )}
    </div>
  )
}
`

fs.mkdirSync('src/ui/components', { recursive: true })
fs.writeFileSync('src/ui/components/BookCover.tsx', coverComponent)

// Book detail: replace the giant emoji/fade placeholder with shared cached cover art.
replaceOnce(
  'src/features/library/BookDetailPage.tsx',
  `import { ChevronLeftIcon, PlayIcon, TrashIcon, ListIcon, LoaderIcon, EraserIcon, DownloadIcon, EditIcon } from '@/ui/icons'`,
  `import { ChevronLeftIcon, PlayIcon, TrashIcon, ListIcon, LoaderIcon, EraserIcon, DownloadIcon, EditIcon } from '@/ui/icons'\nimport { BookCover } from '@/ui/components/BookCover'`,
  'BookDetail import'
)

replaceOnce(
  'src/features/library/BookDetailPage.tsx',
  `          <div className="relative mb-6 aspect-[2/3] w-48 flex-shrink-0 overflow-hidden rounded-2xl bg-surface-3 shadow-2xl md:mb-0 md:w-56">\n            {/* Keep a neutral placeholder underneath until the refreshed blob URL\n                has actually loaded. This prevents Safari from flashing its broken-image icon. */}\n            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-surface-3 to-surface-4">\n              <span className="text-6xl opacity-50">📖</span>\n            </div>\n            {book.coverUrl && (\n              <img\n                src={book.coverUrl}\n                alt={book.title}\n                className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-150"\n                onLoad={(event) => {\n                  event.currentTarget.classList.remove('opacity-0')\n                  event.currentTarget.classList.add('opacity-100')\n                }}\n                onError={(event) => {\n                  event.currentTarget.classList.add('opacity-0')\n                  event.currentTarget.classList.remove('opacity-100')\n                }}\n              />\n            )}\n          </div>`,
  `          <div className="relative mb-6 aspect-[2/3] w-48 flex-shrink-0 overflow-hidden rounded-2xl bg-surface-3 shadow-2xl md:mb-0 md:w-56">\n            <BookCover bookId={book.id} title={book.title} coverUrl={book.coverUrl} />\n          </div>`,
  'BookDetail cover'
)

// Mini player: cached preview is available immediately after refresh, before
// the player store receives its fresh IndexedDB blob URL.
replaceOnce(
  'src/features/player/MiniPlayer.tsx',
  `import { PlayIcon, PauseIcon } from '@/ui/icons'`,
  `import { PlayIcon, PauseIcon } from '@/ui/icons'\nimport { BookCover } from '@/ui/components/BookCover'`,
  'MiniPlayer import'
)

replaceOnce(
  'src/features/player/MiniPlayer.tsx',
  `            {currentBook.coverUrl ? (\n              <img\n                src={currentBook.coverUrl}\n                alt={currentBook.title}\n                className="h-full w-full object-cover"\n              />\n            ) : (\n              <div className="flex h-full w-full items-center justify-center text-text-muted">\n                <span className="text-xl">📖</span>\n              </div>\n            )}`,
  `            <BookCover\n              bookId={currentBook.id}\n              title={currentBook.title}\n              coverUrl={currentBook.coverUrl}\n            />`,
  'MiniPlayer cover'
)

// Now Playing (including the cover screen you toggle to/from the reading page).
replaceOnce(
  'src/features/player/NowPlayingPage.tsx',
  `import { LyricsView } from './LyricsView'`,
  `import { LyricsView } from './LyricsView'\nimport { BookCover } from '@/ui/components/BookCover'`,
  'NowPlaying import'
)

replaceOnce(
  'src/features/player/NowPlayingPage.tsx',
  `  const [dragProgress, setDragProgress] = useState(0)\n  const [coverLoaded, setCoverLoaded] = useState(false)\n  const progressBarRef = useRef<HTMLDivElement>(null)\n\n  // A cover blob URL can briefly be unavailable while the app refreshes it\n  // from IndexedDB after a reload. Keep the neutral placeholder visible until\n  // the refreshed image has actually loaded instead of flashing a broken icon.\n  useEffect(() => {\n    setCoverLoaded(false)\n  }, [currentBook?.coverUrl])`,
  `  const [dragProgress, setDragProgress] = useState(0)\n  const progressBarRef = useRef<HTMLDivElement>(null)`,
  'NowPlaying cover state'
)

const miniCoverOld = `                        {currentBook.coverUrl ? (\n                          <img src={currentBook.coverUrl} alt={currentBook.title} className="h-full w-full object-cover" />\n                        ) : (\n                          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-accent/20 to-purple-900/30">\n                            <span className="text-2xl opacity-50">📖</span>\n                          </div>\n                        )}`
const miniCoverNew = `                        <BookCover\n                          bookId={currentBook.id}\n                          title={currentBook.title}\n                          coverUrl={currentBook.coverUrl}\n                        />`
replaceAllChecked('src/features/player/NowPlayingPage.tsx', miniCoverOld, miniCoverNew, 'NowPlaying mini cover')

replaceOnce(
  'src/features/player/NowPlayingPage.tsx',
  `                    <div\n                      className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-accent/20 to-purple-900/30"\n                      aria-hidden="true"\n                    >\n                      <span className="text-6xl opacity-50 lg:text-8xl">📖</span>\n                    </div>\n                    {currentBook.coverUrl && (\n                      <img\n                        src={currentBook.coverUrl}\n                        alt={currentBook.title}\n                        onLoad={() => setCoverLoaded(true)}\n                        onError={() => setCoverLoaded(false)}\n                        className={\`relative h-full w-full object-cover transition-opacity duration-150 \${coverLoaded ? 'opacity-100' : 'opacity-0'}\`}\n                      />\n                    )}`,
  `                    <BookCover\n                      bookId={currentBook.id}\n                      title={currentBook.title}\n                      coverUrl={currentBook.coverUrl}\n                    />`,
  'NowPlaying main cover'
)

console.log('Applied instant cached cover previews')
