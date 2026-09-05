const fs = require('fs')

function replaceInFile(file, oldText, newText, label) {
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes(oldText)) {
    throw new Error(`Could not find ${label} in ${file}`)
  }
  text = text.replace(oldText, newText)
  fs.writeFileSync(file, text)
  console.log(`Patched ${label}`)
}

// 1) Settings: new iPhone-only labels must not depend on an uncompiled Lingui
// catalog. Keep the existing localized desktop strings unchanged.
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  "      { id: 'minutes:3', label: t`Up to 3 min / 12 chunks`, description: t`Buffers about 3 minutes ahead, with a 12-chunk iPhone safety limit` },",
  "      { id: 'minutes:3', label: 'Up to 3 min / 12 chunks', description: 'Buffers about 3 minutes ahead, with a 12-chunk iPhone safety limit' },",
  'iPhone 3-minute buffer label'
)
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  "      { id: 'minutes:10', label: t`Up to 10 min / 12 chunks`, description: t`Buffers until 10 minutes ahead or the 12-chunk iPhone safety limit, whichever comes first` },",
  "      { id: 'minutes:10', label: 'Up to 10 min / 12 chunks', description: 'Buffers until 10 minutes ahead or the 12-chunk iPhone safety limit, whichever comes first' },",
  'iPhone 10-minute buffer label'
)
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  "      { id: 'minutes:30', label: t`Up to 30 min / 12 chunks`, description: t`Buffers until 30 minutes ahead or the 12-chunk iPhone safety limit, whichever comes first` },",
  "      { id: 'minutes:30', label: 'Up to 30 min / 12 chunks', description: 'Buffers until 30 minutes ahead or the 12-chunk iPhone safety limit, whichever comes first' },",
  'iPhone 30-minute buffer label'
)
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  "      { id: 'chapter', label: t`Chapter + transition`, description: t`Buffers up to 12 chunks from this chapter; if there is room, also readies up to 3 chunks from the next chapter` },",
  "      { id: 'chapter', label: 'Chapter + transition', description: 'Buffers up to 12 chunks from this chapter; if there is room, also readies up to 3 chunks from the next chapter' },",
  'iPhone chapter buffer label'
)
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  "      { id: 'book', label: t`Next 12 chunks`, description: t`Keeps the next 12 chunks ready and continues across chapter boundaries` },",
  "      { id: 'book', label: 'Next 12 chunks', description: 'Keeps up to 12 chunks ready in the current chapter' },",
  'iPhone book buffer label'
)
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  "      if (settings.bufferAheadMode === 'chapter') return t`Chapter + transition`\n      if (settings.bufferAheadMode === 'book') return t`Next 12 chunks`\n      return t`Up to ${settings.bufferAheadMinutes} min / 12 chunks`",
  "      if (settings.bufferAheadMode === 'chapter') return 'Chapter + transition'\n      if (settings.bufferAheadMode === 'book') return 'Next 12 chunks'\n      return 'Up to ' + settings.bufferAheadMinutes + ' min / 12 chunks'",
  'current iPhone buffer label'
)

// The browser quota estimate on iOS can under-report IndexedDB Blob storage.
// Make it explicit that the directly-counted audio cache is the useful number.
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  '<span className="text-text-primary"><Trans>Browser Storage (estimated)</Trans></span>',
  '<span className="text-text-primary">Safari storage estimate</span>',
  'storage estimate heading'
)
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  '<Trans>Includes your EPUB files, generated audio, TTS/app caches, and other storage used by this app. It will not necessarily match the audio cache below.</Trans>',
  'Safari may undercount IndexedDB audio here. The Generated Audio Cache below is measured directly and is the number to use when clearing narration.',
  'storage estimate explanation'
)
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  '<span className="text-sm text-text-primary"><Trans>Generated Audio Cache</Trans></span>',
  '<span className="text-sm text-text-primary">Generated Audio Cache</span>',
  'generated audio heading'
)
replaceInFile(
  'src/features/settings/SettingsPage.tsx',
  '<Trans>{stats.totalChunkCount} cached chunks • {stats.bookCount} books in library</Trans>',
  '{stats.totalChunkCount} cached chunks • {stats.bookCount} books in library',
  'generated audio detail'
)

// 2) Debug Logs: useSyncExternalStore requires getSnapshot() to return a stable
// reference between store changes. getSubsystems() builds a fresh array every
// call, which can cause a render loop/blank page. Derive it from the stable
// entries snapshot instead.
replaceInFile(
  'src/features/debug/DebugLogsPage.tsx',
  "function useSubsystems(): string[] {\n  return useSyncExternalStore(\n    (cb) => logStore.subscribe(cb),\n    () => logStore.getSubsystems(),\n    () => [],\n  )\n}\n\n",
  '',
  'unstable subsystem external-store hook'
)
replaceInFile(
  'src/features/debug/DebugLogsPage.tsx',
  '  const subsystems = useSubsystems()',
  "  const subsystems = useMemo(\n    () => Array.from(new Set(entries.map((entry) => entry.subsystem))).sort(),\n    [entries],\n  )",
  'stable subsystem derivation'
)

// 3) Buffering: undo only the cross-chapter expansion added in the last pass.
// Keep the existing iOS 12-chunk safety cap intact. This returns iPhone book
// mode to the immediately-previous behavior and avoids loading extra sections.
replaceInFile(
  'src/features/player/TTSBufferManager.ts',
  "    if (mode === 'book') {\n      if (isIOSDevice()) {\n        let remaining = IOS_MAX_BUFFER_CHUNKS\n        for (let s = startSection; s < allSections.length && remaining > 0; s++) {\n          const before = chunks.length\n          await pushFrom(s, s === startSection ? startChunk : 0, remaining)\n          remaining -= chunks.length - before\n        }\n        return chunks\n      }\n\n      await pushFrom(startSection, startChunk)\n      for (let s = startSection + 1; s < allSections.length; s++) {\n        await pushFrom(s, 0)\n      }\n      return chunks\n    }",
  "    if (mode === 'book') {\n      if (isIOSDevice()) {\n        await pushFrom(startSection, startChunk, IOS_MAX_BUFFER_CHUNKS)\n        return chunks\n      }\n\n      await pushFrom(startSection, startChunk)\n      for (let s = startSection + 1; s < allSections.length; s++) {\n        await pushFrom(s, 0)\n      }\n      return chunks\n    }",
  'restore pre-clarity iPhone book buffering'
)

console.log('Conservative recovery patch complete')
