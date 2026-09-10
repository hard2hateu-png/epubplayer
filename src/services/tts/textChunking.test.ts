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

  it('does not append the start of an oversized sentence to the previous page', () => {
    const intro = 'He watched her from across the room.'
    const longSentence = `She leaned closer, studying his expression, because ${'she had wanted to ask him this for years, '.repeat(4)}but had never found the nerve.`
    const chunks = splitTextIntoChunks(`${intro} ${longSentence}`, 150, {
      splitLongSentences: true,
    })

    expect(chunks[0]).toBe(intro)
    expect(chunks.every((chunk) => chunk.length <= 150)).toBe(true)
  })

  it('keeps a quoted question with its dialogue tag when a better pause exists', () => {
    const text = 'She leaned closer, studying his expression, because she had wanted to ask him this for years, but never found the nerve. "Is it true you dated a newsreader?" she asked, delighted at her own daring.'
    const chunks = splitTextIntoChunks(text, 150, { splitLongSentences: true })

    expect(chunks.every((chunk) => chunk.length <= 150)).toBe(true)
    expect(chunks.some((chunk) => /newsreader\?["”’]?\s*$/.test(chunk))).toBe(false)
    expect(chunks.some((chunk) => /^she asked\b/i.test(chunk))).toBe(false)
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text)
  })

  it('avoids a tiny final orphan when an earlier breath boundary is available', () => {
    const text = 'She kept talking about the summer they had planned together, the apartment near the water, the family dinners, the long drives after class, because none of it had ever felt temporary to her.'
    const chunks = splitTextIntoChunks(text, 150, { splitLongSentences: true })
    const lastChunkWords = chunks.at(-1)?.match(/\S+/g)?.length ?? 0

    expect(chunks.every((chunk) => chunk.length <= 150)).toBe(true)
    expect(lastChunkWords).toBeGreaterThan(4)
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text)
  })
})
