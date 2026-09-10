import {
  Tensor,
  loadAndCompile,
  loadLiteRt,
  unloadLiteRt,
} from '@litertjs/core'

const HF = 'https://huggingface.co/mlboydaisuke/Pocket-TTS-LiteRT/resolve/main'
const DEC_TX_URL = `${HF}/pt_mimi_dec_tx_fp16.tflite`
const DECONLY_URL = `${HF}/pt_mimi_deconly_fp16.tflite`
const NEUTRAL_URL = `${HF}/pt_neutral_latent_f32.bin`
const LITERT_WASM = '/litert-wasm/'

const SAMPLE_RATE = 24_000
const SAMPLES_PER_FRAME = 1_920
const LATENT_WIDTH = 32
const DECODER_BLOCK_FRAMES = 32
const DECODER_CONTEXT_FRAMES = 32
const DECODER_INPUT_FRAMES = 65
const DECODER_FEATURE_CHANNELS = 512
const DECODER_FEATURES_PER_BLOCK = 512
const DECONLY_FEATURE_LENGTH = 4096

const scope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

function status(stage: string, detail?: string): void {
  scope.postMessage({ type: 'status', stage, detail })
}

function configureLiteRtAssetLocator(): void {
  const base = new URL(LITERT_WASM, self.location.origin)
  ;(globalThis as unknown as { Module?: { locateFile: (filename: string) => string } }).Module = {
    locateFile: (filename: string) => new URL(filename, base).toString(),
  }
}

function shapeSize(shape: ArrayLike<number>): number {
  let size = 1
  for (const dim of Array.from(shape)) size *= dim
  return size
}

function makeHostTensor(data: Float32Array, shape: ArrayLike<number>): InstanceType<typeof Tensor> {
  return new Tensor(data, Array.from(shape))
}

function tensorDataToFloat32(data: ArrayLike<number>): Float32Array {
  if (data instanceof Float32Array) return data.slice()
  return Float32Array.from(data)
}

function flattenLatents(
  latents: Float32Array,
  latentFrames: number,
  block: number,
  neutral: Float32Array,
): Float32Array {
  const input = new Float32Array(DECODER_INPUT_FRAMES * LATENT_WIDTH)
  for (let i = 0; i < DECODER_INPUT_FRAMES; i++) {
    const sourceIndex = block * DECODER_BLOCK_FRAMES + i - DECODER_CONTEXT_FRAMES
    if (sourceIndex >= 0 && sourceIndex < latentFrames) {
      const start = sourceIndex * LATENT_WIDTH
      input.set(latents.subarray(start, start + LATENT_WIDTH), i * LATENT_WIDTH)
    } else {
      input.set(neutral, i * LATENT_WIDTH)
    }
  }
  return input
}

async function decode(
  latents: Float32Array,
  latentFrames: number,
): Promise<{ pcm: Float32Array; decodeMs: number }> {
  status('Starting a fresh Pocket decoder worker…')
  configureLiteRtAssetLocator()
  await loadLiteRt(LITERT_WASM)

  const neutralResponse = await fetch(NEUTRAL_URL, { cache: 'force-cache' })
  if (!neutralResponse.ok) throw new Error(`Pocket decoder seed download failed (${neutralResponse.status})`)
  const neutral = new Float32Array(await neutralResponse.arrayBuffer()).slice()
  if (neutral.length !== LATENT_WIDTH) throw new Error('Unexpected Pocket neutral latent size')

  status('Loading the lightweight Pocket audio decoder…')
  const decTx = await loadAndCompile(DEC_TX_URL, { accelerator: 'wasm' }) as any
  const deconly = await loadAndCompile(DECONLY_URL, { accelerator: 'webgpu' }) as any
  const started = performance.now()
  try {
    const txInputs = decTx.getInputDetails()
    if (txInputs.length !== 1 || shapeSize(txInputs[0].shape) !== DECODER_INPUT_FRAMES * LATENT_WIDTH) {
      throw new Error('Unexpected Pocket decoder-transformer input shape')
    }

    const blockCount = Math.ceil(latentFrames / DECODER_BLOCK_FRAMES)
    if (blockCount > 8) throw new Error('Pocket sample exceeded one SEANet decode window')
    const features = new Float32Array(DECODER_FEATURE_CHANNELS * DECONLY_FEATURE_LENGTH)

    status('Decoding Alba audio…', `${blockCount} decoder blocks`)
    for (let block = 0; block < blockCount; block++) {
      const input = makeHostTensor(flattenLatents(latents, latentFrames, block, neutral), txInputs[0].shape)
      let outputs: any[] = []
      try {
        outputs = await decTx.run([input]) as any[]
        if (outputs.length !== 1) throw new Error('Unexpected Pocket decoder-transformer output count')
        const raw = tensorDataToFloat32(await outputs[0].data())
        if (raw.length !== DECODER_FEATURE_CHANNELS * 1024) {
          throw new Error(`Unexpected Pocket decoder-transformer output size ${raw.length}`)
        }
        for (let channel = 0; channel < DECODER_FEATURE_CHANNELS; channel++) {
          const src = channel * 1024 + 512
          const dst = channel * DECONLY_FEATURE_LENGTH + block * DECODER_FEATURES_PER_BLOCK
          features.set(raw.subarray(src, src + DECODER_FEATURES_PER_BLOCK), dst)
        }
      } finally {
        input.delete()
        outputs.forEach((tensor) => tensor.delete())
      }
    }

    const deconlyInputs = deconly.getInputDetails()
    if (deconlyInputs.length !== 1 || shapeSize(deconlyInputs[0].shape) !== features.length) {
      throw new Error('Unexpected Pocket SEANet input shape')
    }
    const featureTensor = makeHostTensor(features, deconlyInputs[0].shape)
    let outputs: any[] = []
    try {
      outputs = await deconly.run([featureTensor]) as any[]
      if (outputs.length !== 1) throw new Error('Unexpected Pocket SEANet output count')
      const decoded = tensorDataToFloat32(await outputs[0].data())
      const wanted = Math.min(decoded.length, latentFrames * SAMPLES_PER_FRAME)
      if (wanted < SAMPLE_RATE) throw new Error('Pocket LiteRT decoded too little audio')
      return { pcm: decoded.slice(0, wanted), decodeMs: performance.now() - started }
    } finally {
      featureTensor.delete()
      outputs.forEach((tensor) => tensor.delete())
    }
  } finally {
    decTx.delete()
    deconly.delete()
  }
}

self.onmessage = (event: MessageEvent<{ type?: string; latents?: Float32Array; latentFrames?: number }>) => {
  if (event.data?.type !== 'decode' || !event.data.latents || !event.data.latentFrames) return
  const started = performance.now()
  void decode(event.data.latents, event.data.latentFrames)
    .then(({ pcm, decodeMs }) => {
      scope.postMessage({
        type: 'result',
        pcm,
        sampleRate: SAMPLE_RATE,
        duration: pcm.length / SAMPLE_RATE,
        decodeMs,
        workerMs: performance.now() - started,
      }, [pcm.buffer])
    })
    .catch((error) => {
      scope.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) })
    })
    .finally(() => {
      try {
        unloadLiteRt()
      } catch {
        // Worker termination on the main thread is the final cleanup boundary.
      }
    })
}
