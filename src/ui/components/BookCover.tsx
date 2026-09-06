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
 * Safari can occasionally restore/reuse a valid blob image without delivering the
 * React load event in the order we expect. Never make the real cover depend on that
 * event for visibility: paint it immediately and keep a small local preview behind it
 * as a fallback if the runtime blob URL fails.
 */
export function BookCover({ bookId, title, coverUrl, className = '' }: BookCoverProps) {
  const [preview, setPreview] = useState<string | null>(() => readPreview(bookId))
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  useEffect(() => {
    setPreview(readPreview(bookId))
  }, [bookId])

  useEffect(() => {
    // A refreshed object URL gets a fresh chance to load.
    setFailedUrl(null)
  }, [coverUrl])

  const fullFailed = Boolean(coverUrl && failedUrl === coverUrl)

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

      {coverUrl && !fullFailed && (
        <img
          key={coverUrl}
          src={coverUrl}
          alt={title}
          className={`absolute inset-0 h-full w-full object-cover ${className}`}
          onLoad={(event) => {
            const cached = savePreview(bookId, event.currentTarget)
            if (cached) setPreview(cached)
          }}
          onError={() => setFailedUrl(coverUrl)}
        />
      )}
    </div>
  )
}
