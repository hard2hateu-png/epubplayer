/**
 * Text chunking utilities for TTS generation.
 *
 * Splits text into chunks that respect sentence boundaries by default. Engines
 * with stricter latency/memory limits can opt into safe long-sentence splitting.
 */

export interface ChunkingOptions {
  /**
   * When true, a single sentence that exceeds maxChars is split at a nearby
   * natural speaking boundary instead of being allowed to grow without bound.
   */
  splitLongSentences?: boolean
}

const CONJUNCTION_BREAKS = new Set([
  'and', 'but', 'or', 'so', 'because', 'although', 'though', 'while',
  'when', 'which', 'who', 'that', 'yet',
])

const DIALOGUE_TAG = /^(?:he|she|they|i|we|you|[A-Z][A-Za-z’'-]+)\s+(?:said|asked|replied|answered|whispered|murmured|muttered|shouted|called|added|continued|cried|sighed|laughed|told|began)\b/i

function countWords(text: string): number {
  return text.match(/\S+/g)?.length ?? 0
}

/**
 * Score a legal whitespace split. Higher scores sound more like places where a
 * narrator would naturally pause. The hard character limit is still absolute.
 */
function scoreSplitBoundary(text: string, cut: number, limit: number): number {
  const left = text.slice(0, cut).trimEnd()
  const right = text.slice(cut).trimStart()
  if (!left || !right) return Number.NEGATIVE_INFINITY

  // Closing quotes/brackets belong to the punctuation before them when judging
  // whether this is a natural pause: question?" is still a question boundary.
  const leftWithoutClosers = left.replace(/["'”’\)\]]+$/, '')
  const last = leftWithoutClosers.at(-1) ?? ''
  let score = 35

  if (/[.!?…]/.test(last)) score = 120
  else if (/[;:—–]/.test(last)) score = 105
  else if (last === ',') score = 95
  else if (last === '-') score = 80
  else {
    const nextWord = right.match(/^[A-Za-z’'-]+/)?.[0]?.toLowerCase() ?? ''
    if (CONJUNCTION_BREAKS.has(nextWord)) score = 68
  }

  // Never favor a boundary that strands a closing quote on the next page.
  if (/^[”’"](?:\s|$)/.test(right)) score -= 160

  // A quoted line and its attribution are one spoken thought. Prefer splitting
  // earlier in the sentence rather than producing: “…newsreader?” | she asked…
  if (/[.!?…]["”’]\s*$/.test(left) && DIALOGUE_TAG.test(right)) score -= 145

  // If the whole remainder is only a little larger than one request, strongly
  // discourage leaving a tiny one-to-four-word final page.
  if (
    text.length <= Math.floor(limit * 1.45) &&
    (countWords(right) <= 4 || right.length < 28)
  ) {
    score -= 115
  }

  // Among equally natural pauses, prefer one closer to the limit so requests do
  // useful work without letting raw character count override prosody.
  score -= ((limit - cut) / limit) * 24
  return score
}

/**
 * Split an oversized sentence without cutting through normal words.
 * Prefer breath/pause punctuation, then conjunctions, then ordinary whitespace.
 * A pathological >limit token is hard-split only as a final fallback.
 */
function splitOversizedSentence(sentence: string, limit: number): string[] {
  const pieces: string[] = []
  let remaining = sentence.trim()

  while (remaining.length > limit) {
    const minNaturalCut = Math.max(1, Math.floor(limit * 0.45))
    const maxCut = Math.min(limit, remaining.length - 1)
    let cut = -1
    let bestScore = Number.NEGATIVE_INFINITY

    // Evaluate every legal whitespace boundary in the useful part of the window
    // instead of blindly taking the final comma/space before the hard ceiling.
    for (let i = minNaturalCut; i <= maxCut; i++) {
      if (!/\s/.test(remaining[i])) continue
      const score = scoreSplitBoundary(remaining, i, limit)
      if (score > bestScore) {
        bestScore = score
        cut = i
      }
    }

    // If there is no candidate in the preferred window, use the latest ordinary
    // whitespace before the hard limit.
    if (cut < 0) {
      for (let i = maxCut; i >= 1; i--) {
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
 * - Combines complete sentences until hitting the character limit
 * - By default, preserves a sentence even if it exceeds the limit
 * - With splitLongSentences, oversized sentences are safely bounded
 * - Oversized sentence pieces stay together as their own sequence so a page does
 *   not end halfway into a sentence merely because the previous sentence had room
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

  const sentences = splitIntoSentences(normalized)
  if (sentences.length === 0) return []

  const chunks: string[] = []
  let current = ''

  const flushCurrent = () => {
    if (!current) return
    chunks.push(current)
    current = ''
  }

  const addCompleteSentence = (sentence: string) => {
    if (!current) {
      current = sentence
    } else if (current.length + 1 + sentence.length <= limit) {
      current += ' ' + sentence
    } else {
      flushCurrent()
      current = sentence
    }
  }

  for (const sentence of sentences) {
    if (!options.splitLongSentences || sentence.length <= limit) {
      addCompleteSentence(sentence)
      continue
    }

    // Keep the beginning of a long sentence off the tail of the previous page.
    // This costs an occasional extra Pocket request but produces much cleaner
    // screen/audio transitions and remains fully bounded by the same hard limit.
    flushCurrent()
    chunks.push(...splitOversizedSentence(sentence, limit))
  }

  flushCurrent()
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

    // Only split if followed by whitespace or end of string. A closing quote
    // followed by a dialogue tag intentionally remains part of the same sentence.
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
