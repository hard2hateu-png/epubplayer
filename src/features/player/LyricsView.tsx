/**
 * Lyrics View Component
 *
 * Presents the current TTS chunk as a calm, page-like reading view.
 * The text sent to TTS is never modified here — this component is display-only.
 *
 * Browser TTS can provide exact word-boundary events, so we keep word highlighting
 * there. Blob-based engines such as Supertonic/Kokoro do not expose word timings;
 * for those engines we estimate the active sentence from audio time vs duration.
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { playbackController } from './PlaybackController'
import { BrowserTTSBackend, AudioBlobBackend } from './audioBackends'
import { usePlayerStore } from './playerStore'

interface LyricsViewProps {
  chunkText: string
}

interface TextRange {
  text: string
  start: number
  end: number
}

function splitIntoSentenceRanges(text: string): TextRange[] {
  const ranges: TextRange[] = []
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char !== '.' && char !== '!' && char !== '?' && char !== '…') continue

    let end = i + 1

    // Keep repeated punctuation and closing quotes/brackets with the sentence.
    while (end < text.length && /[.!?…]/.test(text[end])) end++
    while (end < text.length && /["'”’)]/.test(text[end])) end++

    if (end === text.length || /\s/.test(text[end])) {
      const sentence = text.slice(start, end)
      if (sentence.trim()) {
        ranges.push({ text: sentence, start, end })
      }

      while (end < text.length && /\s/.test(text[end])) end++
      start = end
      i = end - 1
    }
  }

  if (start < text.length) {
    const sentence = text.slice(start)
    if (sentence.trim()) {
      ranges.push({ text: sentence, start, end: text.length })
    }
  }

  if (ranges.length === 0 && text.trim()) {
    ranges.push({ text, start: 0, end: text.length })
  }

  return ranges
}

export function LyricsView({ chunkText }: LyricsViewProps) {
  const [charIndex, setCharIndex] = useState(0)
  const [charLength, setCharLength] = useState(0)
  const [blobProgress, setBlobProgress] = useState(0)
  const [usesWordBoundaries, setUsesWordBoundaries] = useState(false)
  const currentSectionTitle = usePlayerStore((s) => s.currentSectionTitle)
  const containerRef = useRef<HTMLDivElement>(null)
  const activeWordRef = useRef<HTMLSpanElement>(null)
  const activeSentenceRef = useRef<HTMLSpanElement>(null)

  // Split text into words while preserving whitespace. This is display-only and
  // does not change the chunk passed to the TTS engine.
  const words = useMemo(() => {
    const result: { text: string; start: number; end: number; isWord: boolean }[] = []
    let currentIndex = 0
    const regex = /(\S+|\s+)/g
    let match

    while ((match = regex.exec(chunkText)) !== null) {
      const text = match[0]
      const isWord = /\S/.test(text)
      result.push({
        text,
        start: currentIndex,
        end: currentIndex + text.length,
        isWord,
      })
      currentIndex += text.length
    }

    return result
  }, [chunkText])

  const sentences = useMemo(() => splitIntoSentenceRanges(chunkText), [chunkText])

  // Exact word boundaries are available only for browser TTS. For generated
  // audio (Supertonic/Kokoro/Piper), poll playback time to estimate which
  // sentence is currently being spoken. This never seeks or alters playback.
  useEffect(() => {
    const backend = playbackController.getAudioBackend()

    if (backend instanceof BrowserTTSBackend) {
      setUsesWordBoundaries(true)
      backend.setBoundaryCallback((index, length) => {
        setCharIndex(index)
        setCharLength(length)
      })

      return () => {
        backend.setBoundaryCallback(undefined)
      }
    }

    setUsesWordBoundaries(false)

    if (backend instanceof AudioBlobBackend) {
      const updateProgress = () => {
        const duration = backend.getDuration()
        const currentTime = backend.getCurrentTime()
        const progress = duration > 0 ? currentTime / duration : 0
        setBlobProgress(Math.max(0, Math.min(1, progress)))
      }

      updateProgress()
      const interval = window.setInterval(updateProgress, 150)
      return () => window.clearInterval(interval)
    }
  }, [])

  // Find which exact word is currently being spoken when Browser TTS supplies
  // boundary events.
  const activeWordIndex = useMemo(() => {
    if (!usesWordBoundaries) return -1

    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (word.isWord && charIndex >= word.start && charIndex < word.end) {
        return i
      }
    }

    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (word.isWord && word.start >= charIndex) {
        return i
      }
    }

    return -1
  }, [words, charIndex, usesWordBoundaries])

  // Blob-based engines do not expose word timings. Estimate the active sentence
  // from the fraction of the generated audio that has played.
  const activeSentenceIndex = useMemo(() => {
    if (usesWordBoundaries || sentences.length === 0) return -1

    const estimatedChar = Math.min(
      Math.max(0, Math.floor(blobProgress * Math.max(0, chunkText.length - 1))),
      Math.max(0, chunkText.length - 1)
    )

    const exact = sentences.findIndex(
      (sentence) => estimatedChar >= sentence.start && estimatedChar < sentence.end
    )

    if (exact >= 0) return exact
    return Math.min(sentences.length - 1, Math.floor(blobProgress * sentences.length))
  }, [blobProgress, chunkText.length, sentences, usesWordBoundaries])

  // Keep the active item visible inside this single pseudo-page if a particularly
  // long chunk needs a small amount of internal scrolling.
  useEffect(() => {
    const active = usesWordBoundaries ? activeWordRef.current : activeSentenceRef.current
    const container = containerRef.current
    if (!active || !container) return

    const containerRect = container.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    const isAbove = activeRect.top < containerRect.top + 72
    const isBelow = activeRect.bottom > containerRect.bottom - 72

    if (isAbove || isBelow) {
      active.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [charIndex, activeSentenceIndex, usesWordBoundaries])

  const textSizeClass =
    chunkText.length > 720
      ? 'text-lg leading-8'
      : chunkText.length > 520
        ? 'text-xl leading-9'
        : 'text-[1.35rem] leading-9'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-1/30">
      {/* Reserved page header: text below scrolls independently and can never
          pass behind the section title or the reader-view toggle. */}
      <div className="pointer-events-none flex h-16 flex-shrink-0 items-center px-6 pr-20 text-left text-sm text-text-muted lg:h-20 lg:px-10 lg:pr-24">
        {currentSectionTitle || 'Now Playing'}
      </div>

      {/* One TTS chunk = one visual page. There is no continuous chapter scroll. */}
      <div
        ref={containerRef}
        className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto overscroll-contain px-7 pb-8 pt-2 lg:px-14 lg:pb-16 lg:pt-3"
      >
        <div className="my-auto w-full max-w-lg text-center lg:max-w-2xl">
          {usesWordBoundaries ? (
            <p className={`font-serif font-normal tracking-normal text-text-primary ${textSizeClass}`}>
              {words.map((word, index) => {
                const isPast = word.end <= charIndex
                const isActive = index === activeWordIndex
                const isFuture = word.start > charIndex + charLength

                return (
                  <span
                    key={`${index}-${word.start}`}
                    ref={isActive ? activeWordRef : undefined}
                    className={`transition-colors duration-150 ${
                      isActive
                        ? 'text-accent'
                        : isPast
                          ? 'text-text-primary'
                          : isFuture
                            ? 'text-text-muted/60'
                            : 'text-text-secondary'
                    }`}
                  >
                    {word.text}
                  </span>
                )
              })}
            </p>
          ) : (
            <p className={`font-serif font-normal tracking-normal ${textSizeClass}`}>
              {sentences.map((sentence, index) => {
                const isPast = index < activeSentenceIndex
                const isActive = index === activeSentenceIndex
                const isFuture = index > activeSentenceIndex

                return (
                  <span
                    key={`${sentence.start}-${sentence.end}`}
                    ref={isActive ? activeSentenceRef : undefined}
                    className={`transition-colors duration-200 ${
                      isActive
                        ? 'rounded-sm bg-accent/10 text-text-primary'
                        : isPast
                          ? 'text-text-secondary'
                          : isFuture
                            ? 'text-text-muted/60'
                            : 'text-text-secondary'
                    }`}
                  >
                    {sentence.text}
                    {index < sentences.length - 1 ? ' ' : ''}
                  </span>
                )
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
