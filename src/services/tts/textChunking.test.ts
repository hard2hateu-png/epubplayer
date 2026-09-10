import { describe, expect, it } from 'vitest'
import { splitTextIntoChunks } from './textChunking'

describe('splitTextIntoChunks', () => {
  it('preserves the existing sentence-first behavior by default', () => {
    const longSentence = `${'word '.repeat(45).trim()}.`
    const chunks = splitTextIntoChunks(longSentence, 150)
    expect(chunks).toEqual([longSentence])
  })

  it('bounds oversized sentences when requested', () => {
    const longSentence = `She looked over at him, ${'wondering what he meant '.repeat(12)}before answering.`
    const chunks = splitTextIntoChunks(longSentence, 150, { splitLongSentences: true })

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.length <= 150)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(
      longSentence.replace(/\s+/g, ' ').trim(),
    )
  })

  it('keeps normal sentences together up to the configured limit', () => {
    const text = 'One short sentence. Another short sentence. A third one.'
    const chunks = splitTextIntoChunks(text, 100, { splitLongSentences: true })
    expect(chunks).toEqual([text])
  })
})
