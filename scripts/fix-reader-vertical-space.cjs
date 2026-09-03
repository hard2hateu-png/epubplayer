const fs = require('fs')

function replaceOnce(file, oldText, newText, label) {
  let src = fs.readFileSync(file, 'utf8')
  if (!src.includes(oldText)) throw new Error(`Missing patch target: ${label}`)
  src = src.replace(oldText, newText)
  fs.writeFileSync(file, src)
}

replaceOnce(
  'src/features/player/NowPlayingPage.tsx',
  '              <div className="flex-shrink-0 pb-6" />',
  '              <div className="flex-shrink-0" />',
  'remove unused mobile lyrics bottom spacer'
)

replaceOnce(
  'src/features/player/LyricsView.tsx',
  'className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto overscroll-contain px-7 pb-12 pt-2 lg:px-14 lg:pb-16 lg:pt-3"',
  'className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto overscroll-contain px-7 pb-8 pt-2 lg:px-14 lg:pb-16 lg:pt-3"',
  'reduce mobile reader bottom padding'
)

console.log('Applied mobile reader vertical-space tweak')
