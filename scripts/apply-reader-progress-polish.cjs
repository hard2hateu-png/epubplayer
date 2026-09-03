const fs = require('fs')

// 1) Keep the reader heading/toggle in their own reserved top area so scrolled
// text can never slide underneath them.
{
  const path = 'src/features/player/LyricsView.tsx'
  let source = fs.readFileSync(path, 'utf8')

  const oldLayout = `  return (\n    <div className="relative h-full overflow-hidden bg-surface-1/30">\n      {/* Page-like section heading */}\n      <div className="pointer-events-none absolute left-6 right-6 top-5 z-10 text-left text-sm text-text-muted lg:left-10 lg:top-8">\n        {currentSectionTitle || 'Now Playing'}\n      </div>\n\n      {/* One TTS chunk = one visual page. There is no continuous chapter scroll. */}\n      <div\n        ref={containerRef}\n        className="flex h-full items-center justify-center overflow-y-auto overscroll-contain px-7 pb-12 pt-16 lg:px-14 lg:pb-16 lg:pt-20"\n      >`

  const newLayout = `  return (\n    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface-1/30">\n      {/* Reserved page header: text below scrolls independently and can never\n          pass behind the section title or the reader-view toggle. */}\n      <div className="pointer-events-none flex h-16 flex-shrink-0 items-center px-6 pr-20 text-left text-sm text-text-muted lg:h-20 lg:px-10 lg:pr-24">\n        {currentSectionTitle || 'Now Playing'}\n      </div>\n\n      {/* One TTS chunk = one visual page. There is no continuous chapter scroll. */}\n      <div\n        ref={containerRef}\n        className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto overscroll-contain px-7 pb-12 pt-2 lg:px-14 lg:pb-16 lg:pt-3"\n      >`

  if (!source.includes(oldLayout)) throw new Error('LyricsView layout anchor not found')
  source = source.replace(oldLayout, newLayout)
  fs.writeFileSync(path, source)
}

// 2) Display one decimal place on the visible Now Playing book percentage.
// This is display-only; the underlying progress value and seek behavior stay intact.
{
  const path = 'src/features/player/NowPlayingPage.tsx'
  let source = fs.readFileSync(path, 'utf8')
  const oldText = '${Math.round(bookProgress)}%'
  const newText = '${bookProgress.toFixed(1)}%'
  const matches = source.split(oldText).length - 1
  if (matches < 3) throw new Error(`Expected at least 3 progress labels, found ${matches}`)
  source = source.split(oldText).join(newText)
  fs.writeFileSync(path, source)
}

// 3) Avoid feeding a newly-added dynamic progress string through Lingui before
// it has a compiled catalog entry; render the already-formatted percentage literally.
{
  const path = 'src/features/library/BookDetailPage.tsx'
  let source = fs.readFileSync(path, 'utf8')
  const oldLabel = '<span><Trans>{progressLabel}% complete</Trans></span>'
  const newLabel = '<span>{progressLabel}% complete</span>'
  if (!source.includes(oldLabel)) throw new Error('Book detail progress label anchor not found')
  source = source.replace(oldLabel, newLabel)
  fs.writeFileSync(path, source)
}

console.log('Applied reader overlap + progress display polish')
// Trigger workflow after installation.
