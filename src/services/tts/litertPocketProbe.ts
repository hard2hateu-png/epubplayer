export interface LiteRTPocketProbeResult {
  blob: Blob
  text: string
  duration: number
  generationMs: number
  decodeMs: number
  totalMs: number
  rtfx: number
}

export type LiteRTPocketProbeStatus = (stage: string, detail?: string) => void

type WorkerMessage =
  | { type: 'status'; stage: string; detail?: string }
  | {
      type: 'result'
      pcm: Float32Array
      sampleRate: number
      text: string
      duration: number
      generationMs: number
      decodeMs: number
      totalMs: number
      rtfx: number
    }
  | { type: 'error'; error: string }

function pcmToWav(pcm: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2)
  const view = new DataView(buffer)
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, pcm.length * 2, true)

  let offset = 44
  for (const value of pcm) {
    const sample = Math.max(-1, Math.min(1, value))
    view.setInt16(offset, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export function runLiteRTPocketProbe(
  onStatus?: LiteRTPocketProbeStatus,
): Promise<LiteRTPocketProbeResult> {
  return new Promise((resolve, reject) => {
    // LiteRT's WASM bootstrap calls importScripts() when it runs inside a worker.
    // importScripts() is illegal in module workers, so this probe must stay a
    // classic worker. Vite bundles the worker as an IIFE via vite.config.ts.
    const worker = new Worker(
      new URL('./litertPocketProbe.worker.ts', import.meta.url),
      { name: 'pocket-litert-alba-probe' },
    )
    let settled = false
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      worker.terminate()
      reject(new Error('Pocket LiteRT test timed out after 5 minutes.'))
    }, 5 * 60 * 1000)

    const finish = () => {
      window.clearTimeout(timeout)
      worker.terminate()
    }

    worker.onerror = (event) => {
      if (settled) return
      settled = true
      finish()
      reject(new Error(event.message || 'Pocket LiteRT worker crashed.'))
    }

    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data
      if (message.type === 'status') {
        onStatus?.(message.stage, message.detail)
        return
      }
      if (settled) return
      if (message.type === 'error') {
        settled = true
        finish()
        reject(new Error(message.error))
        return
      }
      if (message.type === 'result') {
        settled = true
        finish()
        resolve({
          blob: pcmToWav(message.pcm, message.sampleRate),
          text: message.text,
          duration: message.duration,
          generationMs: message.generationMs,
          decodeMs: message.decodeMs,
          totalMs: message.totalMs,
          rtfx: message.rtfx,
        })
      }
    }

    worker.postMessage({ type: 'run' })
  })
}
