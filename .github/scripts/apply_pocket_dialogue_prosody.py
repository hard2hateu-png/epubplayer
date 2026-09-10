from pathlib import Path

chunk_path = Path('src/services/tts/textChunking.ts')
pocket_path = Path('src/services/tts/pocketService.ts')
test_path = Path('src/services/tts/textChunking.test.ts')

chunk = chunk_path.read_text()
pocket = pocket_path.read_text()
tests = test_path.read_text()

if 'dialogueAwareSentenceSplits?: boolean' not in chunk:
    chunk = chunk.replace(
        '  splitLongSentences?: boolean\n}',
        '''  splitLongSentences?: boolean\n  /**\n   * Pocket-only narration mode: treat sentence punctuation followed by closing\n   * quotes/brackets as a real boundary, except when a dialogue attribution such\n   * as “she asked” immediately follows. Defaults off so other engines are unchanged.\n   */\n  dialogueAwareSentenceSplits?: boolean\n}''',
    )

chunk = chunk.replace(
    '  const sentences = splitIntoSentences(normalized)',
    '  const sentences = splitIntoSentences(normalized, options.dialogueAwareSentenceSplits === true)',
)

chunk = chunk.replace(
    'function splitIntoSentences(text: string): string[] {',
    'function splitIntoSentences(text: string, dialogueAware = false): string[] {',
)

old_boundary = '''    // Only split if followed by whitespace or end of string. A closing quote\n    // followed by a dialogue tag intentionally remains part of the same sentence.\n    if (end === text.length || /\\s/.test(text[end])) {\n      const sentence = text.slice(start, end).trim()\n      if (sentence) {\n        sentences.push(sentence)\n      }\n\n      // Skip whitespace after the sentence\n      while (end < text.length && /\\s/.test(text[end])) {\n        end++\n      }\n\n      start = end\n      i = end - 1\n    }'''

new_boundary = '''    // Pocket narration can treat punctuation plus closing quotes/brackets as a\n    // complete sentence boundary. Keep a true dialogue attribution attached:\n    // “Are you coming?” she asked. should remain one spoken thought, while\n    // “Are you coming?” He turned away. should split after the closing quote.\n    let boundaryEnd = end\n    if (dialogueAware) {\n      while (boundaryEnd < text.length && /["'”’\\)\\]]/.test(text[boundaryEnd])) {\n        boundaryEnd++\n      }\n    }\n\n    if (boundaryEnd === text.length || /\\s/.test(text[boundaryEnd])) {\n      let nextStart = boundaryEnd\n      while (nextStart < text.length && /\\s/.test(text[nextStart])) {\n        nextStart++\n      }\n\n      const hasCloser = boundaryEnd > end\n      if (dialogueAware && hasCloser && DIALOGUE_TAG.test(text.slice(nextStart))) {\n        i = end - 1\n        continue\n      }\n\n      const sentence = text.slice(start, boundaryEnd).trim()\n      if (sentence) {\n        sentences.push(sentence)\n      }\n\n      start = nextStart\n      i = nextStart - 1\n    }'''

if old_boundary not in chunk:
    raise SystemExit('Could not find sentence-boundary block to patch safely')
chunk = chunk.replace(old_boundary, new_boundary)

old_pocket = '''  splitIntoChunks(text: string): string[] {\n    return splitTextIntoChunks(text, Math.min(this.config?.maxChunkChars || MAX_CHUNK_CHARS, MAX_CHUNK_CHARS))\n  }'''
new_pocket = '''  splitIntoChunks(text: string): string[] {\n    return splitTextIntoChunks(\n      text,\n      Math.min(this.config?.maxChunkChars || MAX_CHUNK_CHARS, MAX_CHUNK_CHARS),\n      { dialogueAwareSentenceSplits: true },\n    )\n  }'''
if old_pocket not in pocket:
    raise SystemExit('Could not find stable Pocket splitIntoChunks block')
pocket = pocket.replace(old_pocket, new_pocket)

marker = "it('handles closing quotes as Pocket narration boundaries without detaching dialogue tags'"
if marker not in tests:
    insert = r'''

  it('handles closing quotes as Pocket narration boundaries without detaching dialogue tags', () => {
    const action = `He turned toward the hallway, ${'wondering whether she really meant it, '.repeat(3)}then looked back at her.`
    const text = `"Are you coming?" ${action}`
    const chunks = splitTextIntoChunks(text, 150, { dialogueAwareSentenceSplits: true })

    expect(chunks[0]).toBe('"Are you coming?"')
    expect(chunks.slice(1).join(' ')).toBe(action)
  })

  it('keeps a closing-quote question attached to its dialogue attribution in Pocket mode', () => {
    const tail = `Then he looked toward the hallway, ${'trying to decide what to say next, '.repeat(3)}before answering.`
    const dialogue = '"Are you coming?" she asked.'
    const chunks = splitTextIntoChunks(`${dialogue} ${tail}`, 150, {
      dialogueAwareSentenceSplits: true,
    })

    expect(chunks[0]).toBe(dialogue)
    expect(chunks.some((chunk) => /^she asked\b/i.test(chunk))).toBe(false)
  })

  it('leaves default sentence behavior unchanged for non-Pocket callers', () => {
    const action = `He turned toward the hallway, ${'wondering whether she really meant it, '.repeat(3)}then looked back at her.`
    const text = `"Are you coming?" ${action}`
    const defaultChunks = splitTextIntoChunks(text, 150)
    const pocketChunks = splitTextIntoChunks(text, 150, { dialogueAwareSentenceSplits: true })

    expect(defaultChunks).not.toEqual(pocketChunks)
    expect(pocketChunks[0]).toBe('"Are you coming?"')
  })
'''
    pos = tests.rfind('\n})')
    if pos < 0:
        raise SystemExit('Could not find end of textChunking tests')
    tests = tests[:pos] + insert + tests[pos:]

chunk_path.write_text(chunk)
pocket_path.write_text(pocket)
test_path.write_text(tests)
