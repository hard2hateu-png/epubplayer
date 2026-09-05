const fs = require('fs')

function replaceInFile(file, oldText, newText, label) {
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes(oldText)) throw new Error(`Could not find ${label} in ${file}`)
  text = text.replace(oldText, newText)
  fs.writeFileSync(file, text)
  console.log(`Patched ${label}`)
}

// ---------------------------------------------------------------------------
// Settings UI: describe storage measurements accurately and make iOS buffer
// choices match the actual safety-capped behavior.
// ---------------------------------------------------------------------------
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
`// Skip interval options
const SKIP_INTERVALS = [5, 10, 15, 30, 45, 60]

function getBufferAheadChoices() {
  return [
    { id: 'minutes:3', label: t\`3 minutes\`, description: t\`Good balance (less storage)\` },
    { id: 'minutes:10', label: t\`10 minutes\`, description: t\`Smoother playback\` },
    { id: 'minutes:30', label: t\`30 minutes\`, description: t\`Very smooth, uses more storage\` },
    { id: 'chapter', label: t\`Entire chapter\`, description: t\`Keep generating until the chapter is fully cached\` },
    { id: 'book', label: t\`Entire book (∞)\`, description: t\`Maximum caching; may use lots of storage\` },
  ]
}`,
`// Skip interval options
const SKIP_INTERVALS = [5, 10, 15, 30, 45, 60]

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

function getBufferAheadChoices() {
  if (isIOSDevice()) {
    return [
      { id: 'minutes:3', label: t\`Up to 3 min / 12 chunks\`, description: t\`Buffers about 3 minutes ahead, with a 12-chunk iPhone safety limit\` },
      { id: 'minutes:10', label: t\`Up to 10 min / 12 chunks\`, description: t\`Buffers until 10 minutes ahead or the 12-chunk iPhone safety limit, whichever comes first\` },
      { id: 'minutes:30', label: t\`Up to 30 min / 12 chunks\`, description: t\`Buffers until 30 minutes ahead or the 12-chunk iPhone safety limit, whichever comes first\` },
      { id: 'chapter', label: t\`Chapter + transition\`, description: t\`Buffers up to 12 chunks from this chapter; if there is room, also readies up to 3 chunks from the next chapter\` },
      { id: 'book', label: t\`Next 12 chunks\`, description: t\`Keeps the next 12 chunks ready and continues across chapter boundaries\` },
    ]
  }

  return [
    { id: 'minutes:3', label: t\`3 minutes\`, description: t\`Good balance (less storage)\` },
    { id: 'minutes:10', label: t\`10 minutes\`, description: t\`Smoother playback\` },
    { id: 'minutes:30', label: t\`30 minutes\`, description: t\`Very smooth, uses more storage\` },
    { id: 'chapter', label: t\`Entire chapter\`, description: t\`Keep generating until the chapter is fully cached\` },
    { id: 'book', label: t\`Entire book (∞)\`, description: t\`Maximum caching; may use lots of storage\` },
  ]
}`,
  'device-aware buffer labels'
)

replaceInFile(
  'src/features/settings/SettingsPage.tsx',
`  const getBufferAheadLabel = () => {
    if (settings.bufferAheadMode === 'chapter') return t\`Entire chapter\`
    if (settings.bufferAheadMode === 'book') return t\`Entire book (∞)\`
    return t\`${settings.bufferAheadMinutes} min\`
  }`,
`  const getBufferAheadLabel = () => {
    if (isIOSDevice()) {
      if (settings.bufferAheadMode === 'chapter') return t\`Chapter + transition\`
      if (settings.bufferAheadMode === 'book') return t\`Next 12 chunks\`
      return t\`Up to ${settings.bufferAheadMinutes} min / 12 chunks\`
    }
    if (settings.bufferAheadMode === 'chapter') return t\`Entire chapter\`
    if (settings.bufferAheadMode === 'book') return t\`Entire book (∞)\`
    return t\`${settings.bufferAheadMinutes} min\`
  }`,
  'current buffer setting label'
)

replaceInFile(
  'src/features/settings/SettingsPage.tsx',
`                  <span className="text-text-primary"><Trans>Storage Used</Trans></span>
                  <span className="text-text-secondary">
                    {stats.quotaUsedMB} MB / {stats.quotaTotalMB} MB
                  </span>`,
`                  <span className="text-text-primary"><Trans>Browser Storage (estimated)</Trans></span>
                  <span className="text-text-secondary">
                    {stats.quotaUsedMB} MB / {stats.quotaTotalMB} MB
                  </span>`,
  'browser storage heading'
)

replaceInFile(
  'src/features/settings/SettingsPage.tsx',
`                <div className="mt-2 text-xs text-text-muted">
                  <Trans>{stats.totalAudioSizeMB} MB audio • {stats.totalChunkCount} chunks • {stats.bookCount} books</Trans>
                </div>`,
`                <div className="mt-2 text-xs leading-relaxed text-text-muted">
                  <Trans>Includes your EPUB files, generated audio, TTS/app caches, and other storage used by this app. It will not necessarily match the audio cache below.</Trans>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-sm text-text-primary"><Trans>Generated Audio Cache</Trans></span>
                  <span className="text-sm text-text-secondary">{stats.totalAudioSizeMB} MB</span>
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  <Trans>{stats.totalChunkCount} cached chunks • {stats.bookCount} books in library</Trans>
                </div>`,
  'storage measurement explanation'
)

// ---------------------------------------------------------------------------
// Storage stats: the settings page only needs book IDs/titles. Avoid calling
// bookRepository.getAll(), which creates cover object URLs that are unnecessary
// here and can accumulate across repeated storage refreshes.
// ---------------------------------------------------------------------------
replaceInFile(
  'src/features/settings/useStorageStats.ts',
`import { storageStats, bookRepository } from '@/services/storage'`,
`import { storageStats, bookRepository, db } from '@/services/storage'`,
  'storage hook db import'
)

replaceInFile(
  'src/features/settings/useStorageStats.ts',
`      const allBooks = await bookRepository.getAll()`,
`      const allBooks = await db.books.toArray()`,
  'metadata-only book loading'
)

// ---------------------------------------------------------------------------
// iOS book-mode buffering: the UI now says "Next 12 chunks", so make the
// safety-capped mode actually continue across chapter boundaries until 12 total
// chunks have been collected.
// ---------------------------------------------------------------------------
replaceInFile(
  'src/features/player/TTSBufferManager.ts',
`    if (mode === 'book') {
      if (isIOSDevice()) {
        await pushFrom(startSection, startChunk, IOS_MAX_BUFFER_CHUNKS)
        return chunks
      }

      await pushFrom(startSection, startChunk)
      for (let s = startSection + 1; s < allSections.length; s++) {
        await pushFrom(s, 0)
      }
      return chunks
    }`,
`    if (mode === 'book') {
      if (isIOSDevice()) {
        let remaining = IOS_MAX_BUFFER_CHUNKS
        for (let s = startSection; s < allSections.length && remaining > 0; s++) {
          const before = chunks.length
          await pushFrom(s, s === startSection ? startChunk : 0, remaining)
          remaining -= chunks.length - before
        }
        return chunks
      }

      await pushFrom(startSection, startChunk)
      for (let s = startSection + 1; s < allSections.length; s++) {
        await pushFrom(s, 0)
      }
      return chunks
    }`,
  'cross-chapter 12-chunk book mode'
)

console.log('Settings clarity pass complete')
