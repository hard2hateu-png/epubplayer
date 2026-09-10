import { describe, expect, it } from 'vitest'
import { ensurePocketTailPause, getPocketTailPauseMs } from './pocketProsody'

describe('Pocket prosody tail pauses', () => {
  it('uses stronger breathing room after sentence punctuation', () => {
    expect(getPocketTailPauseMs('She looked back.')).toBe(280)
    expect(getPocketTailPauseMs('"Are you sure?"')).toBe(280)
    expect(getPocketTailPauseMs('He hesitated;')).toBe(170)
    expect(getPocketTailPauseMs('She turned,')).toBe(100)
    expect(getPocketTailPauseMs('because he knew')).toBe(70)
  })

  it('adds only the missing quiet tail and preserves generated speech samples', () => {
    const speech = new Float32Array([0.2, -0.1, 0.05, 0])
    const result = ensurePocketTailPause([speech], 1000, 'Done.')

    expect(result.length).toBe(2)
    expect(Array.from(result[0])).toEqual(Array.from(speech))
    expect(result[1].length).toBe(279)
    expect(result[1].every((sample) => sample === 0)).toBe(true)
  })

  it('does not add silence when Pocket already supplied enough tail quiet', () => {
    const speech = new Float32Array([0.2, -0.1])
    const existingTail = new Float32Array(300)
    const chunks = [speech, existingTail]
    const result = ensurePocketTailPause(chunks, 1000, 'Done.')

    expect(result).toBe(chunks)
  })
})
