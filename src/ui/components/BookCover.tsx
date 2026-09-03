import { useEffect, useState } from 'react'

const PREVIEW_PREFIX = 'epub-cover-preview-v2:'

function readPreview(bookId: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(`${PREVIEW_PREFIX}${bookId}`)
  } catch {
    return null
  }
}

function savePreview(bookId: string, image: HTMLImageElement): string | null {
  try {
    if (!image.naturalWidth || !image.naturalHeight) return null

    // Large enough to look clean while the real IndexedDB cover URL wakes up,
    // but still compact enough for synchronous localStorage.
    const maxWidth = 420
    const scale = Math.min(1, maxWidth / image.naturalWidth)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, width, height)

    const dataUrl = canvas.toDataURL('image/webp', 0.84)
    window.localStorage.setItem(`${PREVIEW_PREFIX}${bookId}`, dataUrl)
    return dataUrl
  } catch {
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
 * Cover art that paints instantly on Safari refresh without sacrificing quality.
 * The preview is only a bridge; the original full-resolution EPUB cover always wins
 * as soon as its current blob URL has actually loaded.
 */
export function BookCover({ bookId, title, coverUrl, className = '' }: BookCoverProps) {
  const [preview, setPreview] = useState<string | null>(() => readPreview(bookId))
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)

  useEffect(() => {
    setPreview(readPreview(bookId))
    setLoadedUrl(null)
  }, [bookId])

  const fullLoaded = Boolean(coverUrl && loadedUrl === coverUrl)

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
          key={coverUrl}
          src={coverUrl}
          alt={title}
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-75 ${
            fullLoaded ? 'opacity-100' : 'opacity-0'
          } ${className}`}
          onLoad={(event) => {
            // Track the exact blob URL that loaded. This avoids a Safari/React race
            // where an effect could reset a boolean after a very fast cached load.
            setLoadedUrl(coverUrl)
            const cached = savePreview(bookId, event.currentTarget)
            if (cached) setPreview(cached)
          }}
          onError={() => {
            if (loadedUrl === coverUrl) setLoadedUrl(null)
          }}
        />
      )}
    </div>
  )
}
