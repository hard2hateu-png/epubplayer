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

type GeneratorMessage =
  | { type: 'status'; stage: string; detail?: string }
  | {
      type: 'latent-result'
      latents: Float32Array
      latentFrames: number
      generationMs: number
      text: string
    }
  | { type: 'error'; error: string }

type DecoderMessage =
  | { type: 'status'; stage: string; detail?: string }
  | {
      type: 'result'
      pcm: Float32Array
      sampleRate: number
      duration: number
      decodeMs: number
      workerMs: number
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
    const totalStarted = performance.now()
    let generator: Worker | null = null
    let decoder: Worker | null = null
    let releaseTimer: number | null = null
    let settled = false
    let generationMs = 0
    let sampleText = ''

    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      generator?.terminate()
      decoder?.terminate()
      if (releaseTimer != null) window.clearTimeout(releaseTimer)
      reject(new Error('Pocket LiteRT test timed out after 5 minutes.'))
    }, 5 * 60 * 1000)

    const finish = () => {
      window.clearTimeout(timeout)
      if (releaseTimer != null) window.clearTimeout(releaseTimer)
      generator?.terminate()
      decoder?.terminate()
      generator = null
      decoder = null
    }

    const fail = (message: string) => {
      if (settled) return
      settled = true
      finish()
      reject(new Error(message))
    }

    const startDecoder = (latents: Float32Array, latentFrames: number) => {
      onStatus?.('Pocket language model fully released.', 'Starting decoder in a fresh worker…')

      // Keep this constructor inline. Vite only recognizes and bundles worker
      // entrypoints when new Worker(new URL(..., import.meta.url)) is statically visible.
      decoder = new Worker(
        new URL('./litertPocketDecode.worker.ts', import.meta.url),
        { name: 'pocket-litert-alba-decoder' },
      )

      decoder.onerror = (event) => {
        fail(event.message || 'Pocket LiteRT decoder worker crashed.')
      }

      decoder.onmessage = (event: MessageEvent<DecoderMessage>) => {
        const message = event.data
        if (message.type === 'status') {
          onStatus?.(message.stage, message.detail)
          return
        }
        if (message.type === 'error') {
          fail(message.error)
          return
        }
        if (settled) return
        settled = true
        const totalMs = performance.now() - totalStarted
        const result = {
          blob: pcmToWav(message.pcm, message.sampleRate),
          text: sampleText,
          duration: message.duration,
          generationMs,
          decodeMs: message.decodeMs,
          totalMs,
          rtfx: message.duration / Math.max(0.001, generationMs / 1000),
        }
        finish()
        resolve(result)
      }

      decoder.postMessage(
        { type: 'decode', latents, latentFrames },
        [latents.buffer],
      )
    }

    // Keep this constructor inline for Vite's worker transform. Wrapping it in a
    // helper caused production to request a raw .ts file on Safari.
    const generationWorker = new Worker(
      new URL('./litertPocketProbe.worker.ts', import.meta.url),
      { name: 'pocket-litert-alba-generator' },
    )
    generator = generationWorker

    generationWorker.onerror = (event) => {
      fail(event.message || 'Pocket LiteRT generation worker crashed.')
    }

    generationWorker.onmessage = (event: MessageEvent<GeneratorMessage>) => {
      const message = event.data
      if (message.type === 'status') {
        onStatus?.(message.stage, message.detail)
        return
      }
      if (message.type === 'error') {
        fail(message.error)
        return
      }
      if (message.type !== 'latent-result' || settled) return

      generationMs = message.generationMs
      sampleText = message.text
      const latents = message.latents
      const latentFrames = message.latentFrames

      // Hard-stop the large flow-LM worker before creating any decoder runtime.
      generationWorker.terminate()
      generator = null
      onStatus?.('Releasing Pocket GPU memory…', 'The decoder will start separately in about 1.5 seconds.')

      releaseTimer = window.setTimeout(() => {
        releaseTimer = null
        if (!settled) startDecoder(latents, latentFrames)
      }, 1500)
    }

    generationWorker.postMessage({ type: 'generate-only' })
  })
}
