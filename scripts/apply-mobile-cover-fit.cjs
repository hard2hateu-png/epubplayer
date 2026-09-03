const fs = require('fs')

const path = 'src/features/player/NowPlayingPage.tsx'
let source = fs.readFileSync(path, 'utf8')

const replacements = [
  [
    'className="relative flex min-h-0 flex-1 items-center justify-center px-6 lg:w-2/5 lg:flex-none lg:px-0"',
    'className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 pt-2 lg:w-2/5 lg:flex-none lg:overflow-visible lg:px-0 lg:pt-0"'
  ],
  [
    'className="flex min-h-0 w-full max-w-xs flex-shrink items-center justify-center pb-4 lg:max-w-md lg:pb-0"',
    'className="flex min-h-0 h-full w-full max-w-xs flex-shrink items-center justify-center pb-3 lg:h-auto lg:max-w-md lg:pb-0"'
  ],
  [
    'className="aspect-square w-full max-h-full overflow-hidden rounded-2xl bg-surface-3 shadow-2xl shadow-black/50 lg:rounded-3xl"',
    'className="aspect-square h-[min(32vh,16rem)] w-auto max-h-full max-w-full overflow-hidden rounded-2xl bg-surface-3 shadow-2xl shadow-black/50 lg:h-auto lg:w-full lg:rounded-3xl"'
  ]
]

for (const [from, to] of replacements) {
  if (!source.includes(from)) {
    throw new Error(`Expected source fragment not found: ${from}`)
  }
  source = source.replace(from, to)
}

fs.writeFileSync(path, source)
console.log('Applied mobile cover fit patch')
