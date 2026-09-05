const fs = require('fs')

const file = 'src/features/player/LyricsView.tsx'
let text = fs.readFileSync(file, 'utf8')

function replaceOnce(oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`Could not find ${label}`)
  text = text.replace(oldText, newText)
  console.log(`Patched ${label}`)
}

replaceOnce(
`  const activeWordRef = useRef<HTMLSpanElement>(null)
  const activeSentenceRef = useRef<HTMLSpanElement>(null)`,
`  const activeWordRef = useRef<HTMLSpanElement>(null)
  const activeSentenceRef = useRef<HTMLSpanElement>(null)
  // Invisible caret-like marker used only to keep generated-audio narration in view.
  // It follows the estimated character position *inside* a long highlighted sentence.
  const activePositionRef = useRef<HTMLSpanElement>(null)`,
  'generated-audio position ref'
)

replaceOnce(
`  // Blob-based engines do not expose word timings. Estimate the active sentence
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
  }, [blobProgress, chunkText.length, sentences, usesWordBoundaries])`,
`  // Blob-based engines do not expose word timings. Estimate the current character
  // from generated-audio time. We still highlight the whole sentence, but this
  // finer position lets the viewport follow the narration *within* long sentences.
  const estimatedBlobChar = useMemo(() => {
    if (usesWordBoundaries || chunkText.length === 0) return 0
    return Math.min(
      Math.max(0, Math.floor(blobProgress * Math.max(0, chunkText.length - 1))),
      Math.max(0, chunkText.length - 1)
    )
  }, [blobProgress, chunkText.length, usesWordBoundaries])

  const activeSentenceIndex = useMemo(() => {
    if (usesWordBoundaries || sentences.length === 0) return -1

    const exact = sentences.findIndex(
      (sentence) => estimatedBlobChar >= sentence.start && estimatedBlobChar < sentence.end
    )

    if (exact >= 0) return exact
    return Math.min(sentences.length - 1, Math.floor(blobProgress * sentences.length))
  }, [blobProgress, estimatedBlobChar, sentences, usesWordBoundaries])

  // A visual page is a TTS chunk. Always start a newly mounted/changed page at
  // the top before audio-time tracking begins; this prevents scroll carry-over.
  useEffect(() => {
    setCharIndex(0)
    setCharLength(0)
    setBlobProgress(0)
    const container = containerRef.current
    if (container) container.scrollTop = 0
  }, [chunkText])`,
  'intra-sentence generated-audio position'
)

replaceOnce(
`  // Keep the active item visible INSIDE the reader's own scroll container.
  // Using Element.scrollIntoView() could also move ancestor/viewport scrollers on
  // iOS and a smooth animation could still be running when the next chunk mounted.
  useEffect(() => {
    const active = usesWordBoundaries ? activeWordRef.current : activeSentenceRef.current
    const container = containerRef.current
    if (!active || !container) return

    const frame = window.requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      const topGuard = 48
      const bottomGuard = 64
      const isAbove = activeRect.top < containerRect.top + topGuard
      const isBelow = activeRect.bottom > containerRect.bottom - bottomGuard

      if (!isAbove && !isBelow) return

      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
      const activeCenterInScroll =
        container.scrollTop + (activeRect.top - containerRect.top) + activeRect.height / 2
      let targetTop = activeCenterInScroll - container.clientHeight / 2

      // Make the final sentence fully visible immediately. This avoids the old
      // case where a smooth scroll was still finishing when the next visual page
      // replaced the current chunk.
      const isFinalSentence =
        !usesWordBoundaries &&
        activeSentenceIndex >= 0 &&
        activeSentenceIndex === sentences.length - 1

      if (isFinalSentence) targetTop = maxScroll
      targetTop = Math.max(0, Math.min(maxScroll, targetTop))

      container.scrollTo({
        top: targetTop,
        behavior: isFinalSentence ? 'auto' : 'smooth',
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeWordIndex, activeSentenceIndex, sentences.length, usesWordBoundaries])`,
`  // Keep the actual spoken position visible INSIDE the reader's own scroller.
  // For browser TTS this is the exact active word. For generated audio it is an
  // invisible marker inserted at the estimated character position within the
  // highlighted sentence. This fixes long sentences whose top/bottom can span
  // beyond one viewport while the sentence remains active.
  useEffect(() => {
    const active = usesWordBoundaries ? activeWordRef.current : activePositionRef.current
    const container = containerRef.current
    if (!active || !container) return

    const frame = window.requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      const topGuard = 48
      const bottomGuard = 72
      const isAbove = activeRect.top < containerRect.top + topGuard
      const isBelow = activeRect.bottom > containerRect.bottom - bottomGuard

      if (!isAbove && !isBelow) return

      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
      const activeCenterInScroll =
        container.scrollTop + (activeRect.top - containerRect.top) + activeRect.height / 2

      // Keep the spoken line a little above center so the reader can see what is
      // coming next. Generated audio uses immediate small jumps rather than queued
      // smooth animations, which is more reliable on iOS at 1.5x+ playback.
      const targetTop = Math.max(
        0,
        Math.min(maxScroll, activeCenterInScroll - container.clientHeight * 0.42)
      )

      container.scrollTo({
        top: targetTop,
        behavior: usesWordBoundaries ? 'smooth' : 'auto',
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeWordIndex, activeSentenceIndex, estimatedBlobChar, usesWordBoundaries])`,
  'line-following reader auto-scroll'
)

replaceOnce(
`                  >
                    {sentence.text}
                    {index < sentences.length - 1 ? ' ' : ''}
                  </span>`,
`                  >
                    {isActive && !usesWordBoundaries ? (
                      <>
                        {sentence.text.slice(
                          0,
                          Math.max(0, Math.min(sentence.text.length, estimatedBlobChar - sentence.start))
                        )}
                        <span
                          ref={activePositionRef}
                          aria-hidden="true"
                          className="pointer-events-none inline-block h-[1em] w-px align-baseline opacity-0"
                        />
                        {sentence.text.slice(
                          Math.max(0, Math.min(sentence.text.length, estimatedBlobChar - sentence.start))
                        )}
                      </>
                    ) : (
                      sentence.text
                    )}
                    {index < sentences.length - 1 ? ' ' : ''}
                  </span>`,
  'generated-audio position marker rendering'
)

fs.writeFileSync(file, text)
console.log('Reader follow fix applied')
