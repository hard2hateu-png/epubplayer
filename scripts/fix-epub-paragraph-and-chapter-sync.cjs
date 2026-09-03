const fs = require('fs')

function replaceOnce(file, oldText, newText, label) {
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes(oldText)) {
    throw new Error(`Could not find ${label} in ${file}`)
  }
  text = text.replace(oldText, newText)
  fs.writeFileSync(file, text)
  console.log(`Patched ${label}`)
}

function replaceAllRequired(file, oldText, newText, label) {
  let text = fs.readFileSync(file, 'utf8')
  const count = text.split(oldText).length - 1
  if (count < 1) throw new Error(`Could not find ${label} in ${file}`)
  text = text.split(oldText).join(newText)
  fs.writeFileSync(file, text)
  console.log(`Patched ${label} (${count} occurrence${count === 1 ? '' : 's'})`)
}

// 1) Preserve semantic block boundaries when EPUB HTML is converted to plain text.
// textContent by itself turns </p><p> into no separator at all, e.g. "about.Until".
replaceOnce(
  'src/services/epub/parser.ts',
`function extractTextFromDocument(doc: Document): string {
  // Remove script and style elements
  const scripts = doc.querySelectorAll('script, style, noscript')
  scripts.forEach((el) => el.remove())

  // Get body text
  const body = doc.body || doc.documentElement
  return body?.textContent || ''
}`,
`function extractTextFromDocument(doc: Document): string {
  // Remove non-reading content first.
  const scripts = doc.querySelectorAll('script, style, noscript')
  scripts.forEach((el) => el.remove())

  const body = doc.body || doc.documentElement
  if (!body) return ''

  // textContent does not preserve HTML block boundaries. In EPUBs from AO3,
  // Calibre, and other generators, adjacent paragraphs can therefore become
  // "sentence.Next" and TTS may literally pronounce the dot. Add harmless
  // whitespace nodes around common block elements before extracting text.
  // normalizeText() collapses these to a single space afterward.
  const blockSelector = [
    'p', 'div', 'section', 'article', 'header', 'footer', 'blockquote',
    'li', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre',
    'tr', 'td', 'th', 'figure', 'figcaption'
  ].join(',')

  body.querySelectorAll(blockSelector).forEach((el) => {
    el.before(doc.createTextNode(' '))
    el.after(doc.createTextNode(' '))
  })
  body.querySelectorAll('br').forEach((el) => el.replaceWith(doc.createTextNode(' ')))

  return body.textContent || ''
}`,
  'block-aware EPUB text extraction'
)

replaceOnce(
  'src/services/epub/parser.ts',
`      const textContent = extractTextFromDocument(doc)
      const pageMarkers = extractPageMarkers(doc, item.href, pageTargets, item.index ?? i)
      if (!textContent.trim()) {`,
`      const textContent = normalizeText(extractTextFromDocument(doc))
      const pageMarkers = extractPageMarkers(doc, item.href, pageTargets, item.index ?? i)
      if (!textContent.trim()) {`,
  'normalized EPUB section text'
)

replaceOnce(
  'src/services/epub/parser.ts',
`        textContent: normalizeText(textContent),`,
`        textContent,`,
  'stored normalized EPUB text'
)

// 2) Safety net for already-imported books whose old stored text contains a
// sentence boundary with the missing paragraph space. This changes the chunk text,
// so affected stale audio hashes are naturally bypassed and corrected audio is made.
replaceOnce(
  'src/services/tts/textChunking.ts',
`  // Normalize whitespace
  const normalized = text.replace(/\\s+/g, ' ').trim()`,
`  // Normalize whitespace. Also repair the specific legacy EPUB-import artifact
  // where a paragraph boundary was flattened to "sentence.Next". Requiring a
  // lowercase/digit sentence end followed by Capitalized text avoids touching
  // normal abbreviations such as U.S.A.
  const normalized = text
    .replace(/\\s+/g, ' ')
    .replace(/([a-z0-9][.!?…][”’"')\\]]?)(?=[A-Z][a-z])/g, '$1 ')
    .trim()`,
  'legacy missing paragraph-space safety net'
)

// 3) Loading/preloading chunks must not change the visible chapter title.
replaceOnce(
  'src/features/player/PlaybackController.ts',
`    // Load section text and create chunks
    await chunkManager.loadSection(sectionIndex, section.textContent)

    // Update section title in store and Media Session
    usePlayerStore.getState().setCurrentSectionTitle(section.title)
    mediaSessionManager.setChapterTitle(section.title)`,
`    // Load section text and create chunks. This method is also used for background
    // preloading, so it must not change the visible/current chapter title.
    await chunkManager.loadSection(sectionIndex, section.textContent)`,
  'preloader chapter-title side effect'
)

replaceOnce(
  'src/features/player/PlaybackController.ts',
`    // Auto-save on position changes
    if (
      state.sectionIndex !== prevState.sectionIndex ||
      state.chunkIndex !== prevState.chunkIndex
    ) {
      this.debouncedSave()
    }`,
`    // Keep the displayed chapter tied to the ACTUAL playback position. Background
    // chunk preloading does not change state.sectionIndex, so it can no longer make
    // the header jump ahead to a different chapter.
    if (state.sectionIndex !== prevState.sectionIndex) {
      const section = this.sections[state.sectionIndex]
      if (section) {
        usePlayerStore.getState().setCurrentSectionTitle(section.title)
        mediaSessionManager.setChapterTitle(section.title)
      }
    }

    // Auto-save on position changes
    if (
      state.sectionIndex !== prevState.sectionIndex ||
      state.chunkIndex !== prevState.chunkIndex
    ) {
      this.debouncedSave()
    }`,
  'chapter title sync to playback position'
)

// 4) A spine section is not necessarily a numbered chapter (preface, AO3 metadata,
// afterword, etc.). Show the EPUB section title instead of "Chapter N of total".
replaceAllRequired(
  'src/features/player/NowPlayingPage.tsx',
`<span>{chapterCount > 0 ? \`Chapter \${chapterNumber} of \${chapterCount}\` : t\`Loading...\`}</span>`,
`<span className="truncate pr-2">{currentSectionTitle || (chapterCount > 0 ? \`Section \${chapterNumber} of \${chapterCount}\` : t\`Loading...\`)}</span>`,
  'Now Playing progress section label'
)

// Book detail is reporting stored spine sections, not necessarily literal chapters.
replaceOnce(
  'src/features/library/BookDetailPage.tsx',
`              <Trans>{book.sections.length} chapters · ~{durationText}</Trans>`,
`              <Trans>{book.sections.length} sections · ~{durationText}</Trans>`,
  'book detail section count label'
)

console.log('All EPUB paragraph/chapter fixes applied')
