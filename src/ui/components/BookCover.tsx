import { useEffect, useState } from 'react'

const PREVIEW_PREFIX = 'epub-cover-preview:'

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
    window.localStorage.setItem(`${PREVIEW_PREFIX}${bookId}`, dataUrl)
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
          className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-75 ${
            fullLoaded ? 'opacity-100' : 'opacity-0'
          } ${className}`}
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
