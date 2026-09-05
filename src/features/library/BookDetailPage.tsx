import { useParams, useNavigate } from 'react-router-dom'
import { Trans } from '@lingui/react/macro'
import { t } from '@lingui/core/macro'
import { useBook } from './useBook'
import { playbackController } from '@/features/player/PlaybackController'
import { usePlayerStore } from '@/features/player/playerStore'
import { ChevronLeftIcon, PlayIcon, TrashIcon, ListIcon, LoaderIcon, EraserIcon, DownloadIcon, EditIcon } from '@/ui/icons'
import { BookCover } from '@/ui/components/BookCover'

export function BookDetailPage() {
  const { bookId } = useParams<{ bookId: string }>()
  const navigate = useNavigate()
  const { book, isLoading, deleteBook, deleteAudioCache } = useBook(bookId)
  const activeBook = usePlayerStore((state) => state.currentBook)
  const livePosition = usePlayerStore((state) => state.position)

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderIcon className="h-8 w-8 text-accent" />
      </div>
    )
  }

  if (!book) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8">
        <p className="mb-4 text-text-secondary"><Trans>Book not found</Trans></p>
        <button
          onClick={() => navigate('/app')}
          className="pressable rounded-full bg-surface-2 px-6 py-2 text-text-primary"
        >
          <Trans>Go to Library</Trans>
        </button>
      </div>
    )
  }

  const handlePlay = async () => {
    // Load the book into the playback manager
    await playbackController.loadBook({
      id: book.id,
      title: book.title,
      author: book.author,
      coverUrl: book.coverUrl,
    })

    // Open Now Playing immediately in the reading/highlight view. Do not wait
    // for the generated-audio play promise, which can remain pending for the
    // duration of the current chunk.
    navigate('/app/playing', { state: { reader: true } })

    // Start playback after navigation has been requested. Playback continues
    // independently while the Now Playing screen renders.
    void playbackController.play()
  }

  const handleDelete = async () => {
    if (confirm(t`Are you sure you want to remove this book and all its audio?`)) {
      await deleteBook()
      navigate('/app')
    }
  }

  const handleClearAudio = async () => {
    if (
      confirm(t`Delete all generated audio for this book? The book will remain in your library.`)
    ) {
      await deleteAudioCache()
    }
  }

  const handleDownloadEpub = () => {
    if (!book?.epubBlob) return
    
    // Create a download link
    const url = URL.createObjectURL(book.epubBlob)
    const a = document.createElement('a')
    a.href = url
    // Sanitize filename
    const filename = `${book.title.replace(/[^a-z0-9]/gi, '_')}.epub`
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Use the same text-weighted whole-book calculation as Now Playing when this
  // is the active book. For inactive books, fall back to the saved section
  // boundary, still weighted by text length rather than treating chapters equally.
  let progressFraction = 0
  if (activeBook?.id === book.id) {
    const sections = playbackController.getSections()
    const chunkInfo = playbackController.getChunkInfo()
    const sectionWeights = sections.map((section) => Math.max(1, section.charCount || 0))
    const totalBookWeight = sectionWeights.reduce((sum, weight) => sum + weight, 0)
    const weightBeforeCurrentSection = sectionWeights
      .slice(0, livePosition.sectionIndex)
      .reduce((sum, weight) => sum + weight, 0)
    const currentSectionWeight = sectionWeights[livePosition.sectionIndex] ?? 0
    const currentSectionProgress = Math.max(0, Math.min(1, chunkInfo.progress / 100))
    progressFraction = totalBookWeight > 0
      ? (weightBeforeCurrentSection + currentSectionWeight * currentSectionProgress) / totalBookWeight
      : 0
  } else if (book.playbackState) {
    const totalBookWeight = book.sections.reduce(
      (sum, section) => sum + Math.max(1, section.charCount || 0),
      0
    )
    const completedBookWeight = book.sections
      .slice(0, book.playbackState.sectionIndex)
      .reduce((sum, section) => sum + Math.max(1, section.charCount || 0), 0)
    progressFraction = totalBookWeight > 0 ? completedBookWeight / totalBookWeight : 0
  }

  const progress = Math.max(0, Math.min(100, progressFraction * 100))
  const progressLabel = progress.toFixed(1)

  // Calculate total duration
  const totalDuration = book.sections.reduce((sum, s) => sum + s.estimatedDuration, 0)
  const totalHours = Math.floor(totalDuration / 3600)
  const totalMinutes = Math.round((totalDuration % 3600) / 60)
  const durationText = totalHours > 0 ? `${totalHours}h ${totalMinutes}m` : `${totalMinutes} min`

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 px-2 py-4">
        <button
          onClick={() => navigate(-1)}
          className="pressable flex h-10 w-10 items-center justify-center rounded-full text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          aria-label={t`Go back`}
        >
          <ChevronLeftIcon className="h-6 w-6" />
        </button>
        <span className="flex-1" />
        {book.epubBlob && (
          <button
            onClick={handleDownloadEpub}
            className="pressable flex h-10 w-10 items-center justify-center rounded-full text-text-secondary hover:bg-surface-2 hover:text-accent"
            aria-label={t`Download EPUB`}
            title={t`Download original EPUB`}
          >
            <DownloadIcon className="h-5 w-5" />
          </button>
        )}
        <button
          onClick={() => navigate(`/app/book/${book.id}/edit`)}
          className="pressable flex h-10 w-10 items-center justify-center rounded-full text-text-secondary hover:bg-surface-2 hover:text-accent"
          aria-label={t`Edit sections`}
          title={t`Edit sections`}
        >
          <EditIcon className="h-5 w-5" />
        </button>
        <button
          onClick={handleClearAudio}
          className="pressable flex h-10 w-10 items-center justify-center rounded-full text-text-secondary hover:bg-surface-2 hover:text-warning"
          aria-label={t`Clear audio cache`}
          title={t`Clear audio cache`}
        >
          <EraserIcon className="h-5 w-5" />
        </button>
        <button
          onClick={handleDelete}
          className="pressable flex h-10 w-10 items-center justify-center rounded-full text-text-secondary hover:bg-surface-2 hover:text-error"
          aria-label={t`Delete book`}
        >
          <TrashIcon className="h-5 w-5" />
        </button>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6">
        {/* Cover and info - horizontal on desktop */}
        <div className="mb-8 flex flex-col items-center text-center md:flex-row md:items-start md:gap-8 md:text-left">
          {/* Cover */}
          <div className="relative mb-6 aspect-[2/3] w-48 flex-shrink-0 overflow-hidden rounded-2xl bg-surface-3 shadow-2xl md:mb-0 md:w-56">
            <BookCover bookId={book.id} title={book.title} coverUrl={book.coverUrl} />
          </div>

          {/* Info */}
          <div className="flex flex-col items-center md:flex-1 md:items-start">
            <h1 className="mb-2 text-2xl font-bold text-text-primary md:text-3xl">{book.title}</h1>
            <p className="mb-2 text-text-secondary md:text-lg">{book.author}</p>
            <p className="mb-4 text-sm text-text-muted">
              {book.sections.length} sections · ~{durationText}
            </p>

            {/* Storage info */}
            {book.storageStats && book.storageStats.audioSizeMB > 0 && (
              <p className="mb-4 text-xs text-text-muted">
                {book.storageStats.audioSizeMB} MB cached audio
              </p>
            )}

            {/* Progress */}
            {progress > 0 && (
              <div className="mb-4 w-full max-w-xs md:max-w-sm">
                <div className="mb-1 flex justify-between text-xs text-text-muted">
                  <span>{progressLabel}% complete</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Play button */}
            <button
              onClick={handlePlay}
              className="pressable flex items-center gap-3 rounded-full bg-accent px-8 py-4 text-lg font-semibold text-white shadow-lg shadow-accent/25"
            >
              <PlayIcon className="h-6 w-6" />
              {progress > 0 ? <Trans>Continue Listening</Trans> : <Trans>Start Listening</Trans>}
            </button>
          </div>
        </div>

        {/* Chapters / Table of Contents */}
        <div className="pb-8">
          <div className="mb-4 flex items-center gap-2">
            <ListIcon className="h-5 w-5 text-text-secondary" />
            <h2 className="text-lg font-semibold text-text-primary"><Trans>Chapters</Trans></h2>
          </div>
          <div className="rounded-xl bg-surface-1 p-2">
            <div className="flex flex-col gap-1">
              {book.sections.map((section, index) => {
                const isActive = book.playbackState?.sectionIndex === index
                const isPlayed = book.playbackState && book.playbackState.sectionIndex > index

                const minutes = Math.round(section.estimatedDuration / 60)
                const durationStr = minutes > 0 ? `${minutes} min` : '<1 min'

                return (
                  <button
                    key={section.id}
                    onClick={async () => {
                      // Load book if not already loaded
                      await playbackController.loadBook({
                        id: book.id,
                        title: book.title,
                        author: book.author,
                        coverUrl: book.coverUrl,
                      })
                      // Jump to this section
                      await playbackController.goToSection(index)
                      // Navigate to player
                      navigate('/app/playing')
                    }}
                    className={`pressable flex w-full items-center justify-between rounded-lg px-4 py-3 text-left transition-colors ${
                      isActive
                        ? 'bg-accent/10 text-accent'
                        : isPlayed
                          ? 'text-text-muted'
                          : 'text-text-primary hover:bg-surface-2'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate pr-4 font-medium">{section.title}</span>
                    <span className="flex-shrink-0 text-sm text-text-muted">{durationStr}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
