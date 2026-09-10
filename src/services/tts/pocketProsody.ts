/** Pocket-only pause shaping for generated audio. */

const QUIET_THRESHOLD = 0.0025

export function getPocketTailPauseMs(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0

  // Ignore closing quotes/brackets when deciding what kind of spoken boundary
  // just ended. This preserves dialogue punctuation such as: "Are you sure?"
  const withoutClosers = trimmed.replace(/["'”’\)\]]+$/, '')
  const last = withoutClosers.at(-1) ?? ''

  if (/[.!?…]/.test(last)) return 280
  if (/[;:]/.test(last)) return 170
  if (/[,—–-]/.test(last)) return 100
  return 70
}

function countTrailingQuietSamples(chunks: Float32Array[]): number {
  let quiet = 0

  for (let chunkIndex = chunks.length - 1; chunkIndex >= 0; chunkIndex--) {
    const chunk = chunks[chunkIndex]
    for (let i = chunk.length - 1; i >= 0; i--) {
      if (Math.abs(chunk[i]) > QUIET_THRESHOLD) return quiet
      quiet++
    }
  }

  return quiet
}

/**
 * Ensure a small minimum tail pause after a Pocket chunk without touching any
 * generated speech samples. If Pocket already produced at least that much quiet
 * tail, return the original chunk array unchanged.
 */
export function ensurePocketTailPause(
  chunks: Float32Array[],
  sampleRate: number,
  text: string,
): Float32Array[] {
  if (!chunks.length || sampleRate <= 0) return chunks

  const targetSamples = Math.max(0, Math.round(sampleRate * getPocketTailPauseMs(text) / 1000))
  const existingQuietSamples = countTrailingQuietSamples(chunks)
  const missingSamples = targetSamples - existingQuietSamples

  if (missingSamples <= 0) return chunks
  return [...chunks, new Float32Array(missingSamples)]
}
