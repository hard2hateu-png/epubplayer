const fs = require('fs')

const file = 'src/features/player/LyricsView.tsx'
let text = fs.readFileSync(file, 'utf8')

function replaceOnce(oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`Could not find ${label}`)
  text = text.replace(oldText, newText)
  console.log(`Patched ${label}`)
}

replaceOnce(
`  const activeSentenceRef = useRef<HTMLSpanElement>(null)
  // Invisible caret-like marker used only to keep generated-audio narration in view.
  // It follows the estimated character position *inside* a long highlighted sentence.
  const activePositionRef = useRef<HTMLSpanElement>(null)`,
`  const activeSentenceRef = useRef<HTMLSpanElement>(null)`,
  'moving inline marker ref'
)

replaceOnce(
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
`  // Keep the spoken position visible without changing/splitting the rendered text.
  // Browser TTS follows its exact word. Generated audio keeps the stable highlighted
  // sentence intact and estimates a vertical point inside that sentence's box.
  useEffect(() => {
    const active = usesWordBoundaries ? activeWordRef.current : activeSentenceRef.current
    const container = containerRef.current
    if (!active || !container) return

    const frame = window.requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)

      let trackedY = activeRect.top + activeRect.height / 2

      if (!usesWordBoundaries && activeSentenceIndex >= 0) {
        const sentence = sentences[activeSentenceIndex]
        const sentenceLength = Math.max(1, sentence.end - sentence.start)
        const progressWithinSentence = Math.max(
          0,
          Math.min(1, (estimatedBlobChar - sentence.start) / sentenceLength)
        )
        trackedY = activeRect.top + activeRect.height * progressWithinSentence
      }

      const topGuard = containerRect.top + 48
      const bottomGuard = containerRect.bottom - 72
      if (trackedY >= topGuard && trackedY <= bottomGuard) return

      const trackedYInScroll = container.scrollTop + (trackedY - containerRect.top)
      const targetTop = Math.max(
        0,
        Math.min(maxScroll, trackedYInScroll - container.clientHeight * 0.42)
      )

      container.scrollTo({
        top: targetTop,
        behavior: usesWordBoundaries ? 'smooth' : 'auto',
      })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [activeWordIndex, activeSentenceIndex, estimatedBlobChar, sentences, usesWordBoundaries])`,
  'stable sentence scrolling'
)

replaceOnce(
`                      {isActive && !usesWordBoundaries ? (
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
                      )}`,
`                      {sentence.text}`,
  'moving sentence split'
)

fs.writeFileSync(file, text)
console.log('Removed moving inline reader marker; sentence highlight remains stable')
// Trigger after workflow exists on main.
