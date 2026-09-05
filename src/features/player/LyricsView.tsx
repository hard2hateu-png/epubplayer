/**
 * Lyrics View Component
 *
 * Presents the current TTS chunk as a calm, page-like reading view.
 * The text sent to TTS is never modified here — this component is display-only.
 *
 * Browser TTS can provide exact word-boundary events, so we keep word highlighting
 * there. Blob-based engines such as Supertonic/Kokoro do not expose word timings;
 * for those engines we estimate a short active phrase from audio time vs duration.
 */

import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
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

// Generated audio has no exact word timings. Keep the visual highlight small and
// stable by pre-splitting long sentences into fixed phrase spans. These ranges are
// display-only; they never alter the chunk sent to the TTS engine.
function splitIntoHighlightRanges(text: string): TextRange[] {
  const sentences = splitIntoSentenceRanges(text)
  const ranges: TextRange[] = []
  // Slightly longer phrases make the approximate generated-audio tracking feel
  // steadier at faster playback speeds without returning to huge sentence blocks.
  const maxWords = 10
  const minWordsBeforeNaturalBreak = 6

  for (const sentence of sentences) {
    const tokens: { text: string; start: number; end: number }[] = []
    const regex = /\S+/g
    let match: RegExpExecArray | null

    while ((match = regex.exec(sentence.text)) !== null) {
      tokens.push({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }

    if (tokens.length <= maxWords) {
      ranges.push(sentence)
      continue
    }

    let tokenIndex = 0
    while (tokenIndex < tokens.length) {
      let endToken = Math.min(tokenIndex + maxWords, tokens.length)

      // Prefer a nearby clause boundary so highlights read like natural phrases.
      if (endToken < tokens.length) {
        const earliestBreak = tokenIndex + minWordsBeforeNaturalBreak - 1
        for (let i = endToken - 1; i >= earliestBreak; i--) {
          const withoutClosingQuote = tokens[i].text.replace(/["'”’)]*$/, '')
          if (/[,;:—–-]$/.test(withoutClosingQuote)) {
            endToken = i + 1
            break
          }
        }
      }

      const localStart = tokens[tokenIndex].start
      const localEnd = tokens[endToken - 1].end
      const start = sentence.start + localStart
      const end = sentence.start + localEnd

      ranges.push({
        text: text.slice(start, end),
        start,
        end,
      })

      tokenIndex = endToken
    }
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
  const activeHighlightRef = useRef<HTMLSpanElement>(null)

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

  const highlightRanges = useMemo(() => splitIntoHighlightRanges(chunkText), [chunkText])

  // Exact word boundaries are available only for browser TTS. For generated
  // audio (Supertonic/Kokoro/Piper), poll playback time to estimate which fixed
  // phrase is currently being spoken. This never seeks or alters playback.
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
      const interval = window.setInterval(updateProgress, 200)
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

  const estimatedBlobChar = useMemo(() => {
    if (usesWordBoundaries || chunkText.length === 0) return 0
    return Math.min(
      Math.max(0, Math.floor(blobProgress * Math.max(0, chunkText.length - 1))),
      Math.max(0, chunkText.length - 1)
    )
  }, [blobProgress, chunkText.length, usesWordBoundaries])

  const activeHighlightIndex = useMemo(() => {
    if (usesWordBoundaries || highlightRanges.length === 0) return -1

    const exact = highlightRanges.findIndex(
      (range) => estimatedBlobChar >= range.start && estimatedBlobChar < range.end
    )
    if (exact >= 0) return exact

    // Whitespace between fixed phrases belongs visually to the phrase just read.
    const next = highlightRanges.findIndex((range) => estimatedBlobChar < range.start)
    if (next >= 0) return Math.max(0, next - 1)

    return highlightRanges.length - 1
  }, [estimatedBlobChar, highlightRanges, usesWordBoundaries])

  // Every TTS chunk is a fresh visual page. Reset the reader before paint so a
  // previous page's scroll position cannot flash or carry into the next one.
  useLayoutEffect(() => {
    setCharIndex(0)
    setCharLength(0)
    setBlobProgress(0)
    const container = containerRef.current
    if (container) container.scrollTop = 0
  }, [chunkText])

  // Scroll only when the active word/phrase would actually be clipped. Move the
  // minimum distance needed to reveal it — no continuous tracking and no forced
  // end-of-page nudge when the current highlight is already visible.
  useEffect(() => {
    const active = usesWordBoundaries ? activeWordRef.current : activeHighlightRef.current
    const container = containerRef.current
    if (!active || !container) return

    const frame = window.requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      const topGuard = containerRect.top + 36
      const bottomGuard = containerRect.bottom - 36
      let targetTop = container.scrollTop

      if (activeRect.top < topGuard) {
        targetTop -= topGuard - activeRect.top
      } else if (activeRect.bottom > bottomGuard) {
        targetTop += activeRect.bottom - bottomGuard
      } else {
        return
      }

      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
      targetTop = Math.max(0, Math.min(maxScroll, targetTop))
      if (Math.abs(targetTop - container.scrollTop) < 3) return

      container.scrollTo({
        top: targetTop,
        behavior: 'smooth',
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeWordIndex, activeHighlightIndex, usesWordBoundaries])

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
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pb-10 pt-2 lg:px-14 lg:pb-16 lg:pt-3"
      >
        <div className="flex min-h-full items-center justify-center py-2">
          <div className="w-full max-w-lg text-center lg:max-w-2xl">
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
                {highlightRanges.map((range, index) => {
                  const isPast = index < activeHighlightIndex
                  const isActive = index === activeHighlightIndex
                  const isFuture = index > activeHighlightIndex

                  return (
                    <span
                      key={`${range.start}-${range.end}`}
                      ref={isActive ? activeHighlightRef : undefined}
                      className={`transition-colors duration-150 ${
                        isActive
                          ? 'rounded-sm bg-accent/10 text-text-primary'
                          : isPast
                            ? 'text-text-secondary'
                            : isFuture
                              ? 'text-text-muted/60'
                              : 'text-text-secondary'
                      }`}
                    >
                      {range.text}
                      {index < highlightRanges.length - 1 ? ' ' : ''}
                    </span>
                  )
                })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
