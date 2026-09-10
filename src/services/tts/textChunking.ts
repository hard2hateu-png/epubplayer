/**
 * Text chunking utilities for TTS generation.
 *
 * Splits text into chunks that respect sentence boundaries by default. Engines
 * with stricter latency/memory limits can opt into safe long-sentence splitting.
 */

export interface ChunkingOptions {
  /**
   * When true, a single sentence that exceeds maxChars is split at a nearby
   * clause/word boundary instead of being allowed to grow without bound.
   */
  splitLongSentences?: boolean
}

/**
 * Split an oversized sentence without cutting through normal words.
 * Prefer punctuation/clause boundaries in the latter half of the window, then
 * fall back to whitespace. A pathological >limit token is hard-split only as a
 * final fallback so the caller still gets a real maximum.
 */
function splitOversizedSentence(sentence: string, limit: number): string[] {
  const pieces: string[] = []
  let remaining = sentence.trim()

  while (remaining.length > limit) {
    const minNaturalCut = Math.max(1, Math.floor(limit * 0.55))
    let cut = -1

    // Prefer a clause boundary close to the limit. Keep punctuation attached to
    // the phrase before the split so prosody remains as natural as possible.
    for (let i = Math.min(limit, remaining.length - 1); i >= minNaturalCut; i--) {
      if (/\s/.test(remaining[i]) && /[,;:—–-]/.test(remaining[i - 1] || '')) {
        cut = i
        break
      }
    }

    // Otherwise split at the latest normal whitespace before the hard limit.
    if (cut < 0) {
      for (let i = Math.min(limit, remaining.length - 1); i >= 1; i--) {
        if (/\s/.test(remaining[i])) {
          cut = i
          break
        }
      }
    }

    // Extremely long unbroken token/URL: enforce the limit rather than creating
    // an arbitrarily large TTS request.
    if (cut < 1) cut = limit

    const piece = remaining.slice(0, cut).trim()
    if (piece) pieces.push(piece)
    remaining = remaining.slice(cut).trim()
  }

  if (remaining) pieces.push(remaining)
  return pieces
}

/**
 * Split text into chunks at sentence boundaries.
 * - Combines sentences until hitting the character limit
 * - By default, preserves a sentence even if it exceeds the limit
 * - With splitLongSentences, oversized sentences are safely bounded
 */
export function splitTextIntoChunks(
  text: string,
  maxChars: number,
  options: ChunkingOptions = {},
): string[] {
  const limit = Number.isFinite(maxChars) ? Math.max(100, Math.floor(maxChars)) : 500

  // Normalize whitespace. Also repair the specific legacy EPUB-import artifact
  // where a paragraph boundary was flattened to "sentence.Next". Requiring a
  // lowercase/digit sentence end followed by Capitalized text avoids touching
  // normal abbreviations such as U.S.A.
  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/([a-z0-9][.!?…][”’"')\]]?)(?=[A-Z][a-z])/g, '$1 ')
    .trim()
  if (!normalized) return []

  // Split into sentences. Pocket and other constrained engines may additionally
  // break a rare oversized sentence at a natural clause/word boundary.
  const sentences = splitIntoSentences(normalized)
  if (sentences.length === 0) return []
  const units = options.splitLongSentences
    ? sentences.flatMap((sentence) =>
        sentence.length > limit ? splitOversizedSentence(sentence, limit) : [sentence]
      )
    : sentences

  // Combine sentences/units into chunks, respecting the limit.
  const chunks: string[] = []
  let current = ''

  for (const sentence of units) {
    if (!current) {
      current = sentence
    } else if (current.length + 1 + sentence.length <= limit) {
      current += ' ' + sentence
    } else {
      chunks.push(current)
      current = sentence
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks
}

/**
 * Split text into sentences.
 * Handles common punctuation: . ! ? …
 * Keeps punctuation attached to the sentence.
 */
function splitIntoSentences(text: string): string[] {
  const sentences: string[] = []
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    
    // Check for sentence-ending punctuation
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') {
      continue
    }

    // Consume consecutive punctuation (e.g., "..." or "?!")
    let end = i + 1
    while (end < text.length) {
      const next = text[end]
      if (next === '.' || next === '!' || next === '?' || next === '…') {
        end++
      } else {
        break
      }
    }

    // Only split if followed by whitespace or end of string
    if (end === text.length || /\s/.test(text[end])) {
      const sentence = text.slice(start, end).trim()
      if (sentence) {
        sentences.push(sentence)
      }

      // Skip whitespace after the sentence
      while (end < text.length && /\s/.test(text[end])) {
        end++
      }
      
      start = end
      i = end - 1
    }
  }

  // Handle any remaining text (no sentence-ending punctuation)
  const remaining = text.slice(start).trim()
  if (remaining) {
    sentences.push(remaining)
  }

  return sentences
}
