import { describe, expect, it } from 'vitest'
import { parseWavDuration } from './pocketService'

function makePcm16Wav(seconds: number, sampleRate = 24_000): ArrayBuffer {
  const frames = Math.floor(seconds * sampleRate)
  const dataBytes = frames * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return buffer
}

describe('native Pocket WAV metadata', () => {
  it('reads duration from the server PCM WAV', () => {
    expect(parseWavDuration(makePcm16Wav(3.25))).toBeCloseTo(3.25, 4)
  })

  it('rejects non-WAV data', () => {
    expect(parseWavDuration(new ArrayBuffer(64))).toBeNull()
  })
})
