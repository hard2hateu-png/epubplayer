const fs = require('fs')

function replaceOnce(path, oldText, newText, label) {
  let source = fs.readFileSync(path, 'utf8')
  if (!source.includes(oldText)) throw new Error(`${label} anchor not found in ${path}`)
  source = source.replace(oldText, newText)
  fs.writeFileSync(path, source)
}

replaceOnce(
  'src/features/player/PlaybackController.ts',
  `import { enrichSectionsWithPageMarkers } from '@/services/epub'`,
  `import { enrichSectionsWithPageMarkers } from '@/services/epub/parser'`,
  'direct parser import'
)

replaceOnce(
  'src/services/epub/parser.ts',
  `  const updated = sections.map((section) => ({ ...section, pageMarkers: undefined }))`,
  `  const updated: Section[] = sections.map((section) => ({ ...section, pageMarkers: undefined }))`,
  'Section array annotation'
)

console.log('Applied EPUB page-number TypeScript fixes')
