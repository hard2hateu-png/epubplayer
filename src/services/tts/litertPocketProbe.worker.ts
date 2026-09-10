import {
  Tensor,
  getWebGpuDevice,
  isWebGPUSupported,
  loadAndCompile,
  loadLiteRt,
  unloadLiteRt,
} from '@litertjs/core'
import { LiteRTPocketTokenizer } from './litertSentencePiece'

const HF = 'https://huggingface.co/mlboydaisuke/Pocket-TTS-LiteRT/resolve/main'
const FLOW_URL = `${HF}/pt_flowlm_fused_fp16.tflite`
const DEC_TX_URL = `${HF}/pt_mimi_dec_tx_fp16.tflite`
const DECONLY_URL = `${HF}/pt_mimi_deconly_fp16.tflite`
const EMBED_URL = `${HF}/pt_embed_f16.bin`
const INPUT_LINEAR_URL = `${HF}/pt_input_linear_f32.bin`
const BOS_URL = `${HF}/pt_bos_input_f32.bin`
const NEUTRAL_URL = `${HF}/pt_neutral_latent_f32.bin`
const ALBA_URL = `${HF}/voices/pt_voice_alba.bin`
const TOKENIZER_URL =
  'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/main/languages/english/tokenizer.model'
const LITERT_WASM = '/litert-wasm/'

const SAMPLE_RATE = 24_000
const SAMPLES_PER_FRAME = 1_920
const MAX_GENERATED_FRAMES = 160
const KV_GROUPS = 96
const KV_CAPACITY = 512
const KV_WIDTH = 64
const KV_STEP_VALUES = KV_GROUPS * KV_WIDTH
const MODEL_WIDTH = 1024
const LATENT_WIDTH = 32
const DECODER_BLOCK_FRAMES = 32
const DECODER_CONTEXT_FRAMES = 32
const DECODER_INPUT_FRAMES = 65
const DECODER_FEATURE_CHANNELS = 512
const DECODER_FEATURES_PER_BLOCK = 512
const DECONLY_FEATURE_LENGTH = 4096

const SAMPLE_TEXT =
  'The rain tapped softly against the window, and the old house seemed to breathe.'

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

async function fetchBuffer(url: string, label: string): Promise<ArrayBuffer> {
  status(label)
  const response = await fetch(url, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`${label} failed (${response.status})`)
  return response.arrayBuffer()
}

function halfToFloat(value: number): number {
  const sign = (value & 0x8000) ? -1 : 1
  const exponent = (value >>> 10) & 0x1f
  const fraction = value & 0x03ff
  if (exponent === 0) {
    if (fraction === 0) return sign === 1 ? 0 : -0
    return sign * 2 ** -14 * (fraction / 1024)
  }
  if (exponent === 31) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

function readFloat32Array(buffer: ArrayBuffer): Float32Array {
  if (buffer.byteLength % 4) throw new Error('Invalid fp32 binary length')
  const source = new Float32Array(buffer)
  return source.slice()
}

function tensorDataToFloat32(data: ArrayLike<number>): Float32Array {
  if (data instanceof Float32Array) return data.slice()
  return Float32Array.from(data)
}

function makeHostTensor(data: Float32Array, shape: ArrayLike<number>): InstanceType<typeof Tensor> {
  return new Tensor(data, Array.from(shape))
}

function gaussianVector(count: number): Float32Array {
  const output = new Float32Array(count)
  const scale = Math.sqrt(0.3)
  for (let i = 0; i < count; i += 2) {
    const u1 = Math.max(Number.MIN_VALUE, Math.random())
    const u2 = Math.random()
    const radius = Math.sqrt(-2 * Math.log(u1)) * scale
    const angle = 2 * Math.PI * u2
    output[i] = radius * Math.cos(angle)
    if (i + 1 < count) output[i + 1] = radius * Math.sin(angle)
  }
  return output
}

function tokenEmbedding(token: number, embeddingsFp16: DataView): Float32Array {
  if (token < 0 || token >= 4001) throw new Error(`Pocket token ${token} is out of range`)
  const output = new Float32Array(MODEL_WIDTH)
  const base = token * MODEL_WIDTH * 2
  for (let i = 0; i < MODEL_WIDTH; i++) {
    output[i] = halfToFloat(embeddingsFp16.getUint16(base + i * 2, true))
  }
  return output
}

function latentToEmbedding(latent: Float32Array, inputLinear: Float32Array): Float32Array {
  const output = new Float32Array(MODEL_WIDTH)
  for (let row = 0; row < MODEL_WIDTH; row++) {
    const base = row * LATENT_WIDTH
    let sum = 0
    for (let col = 0; col < LATENT_WIDTH; col++) sum += inputLinear[base + col] * latent[col]
    output[row] = sum
  }
  return output
}

type GpuState = {
  device: any
  pkBuffer: any
  pvBuffer: any
  maskBuffer: any
  kvStepBuffer: any
  paramsBuffer: any
  pkTensor: any
  pvTensor: any
  maskTensor: any
  scatterPipeline: any
  scatterBindGroup: any
  pos: number
}

function parseVoiceState(buffer: ArrayBuffer): { promptFrames: number; pk: Float32Array; pv: Float32Array } {
  if (buffer.byteLength < 8) throw new Error('Alba voice state is incomplete')
  const view = new DataView(buffer)
  const promptFrames = view.getInt32(0, true)
  if (promptFrames < 1 || promptFrames >= KV_CAPACITY) {
    throw new Error(`Unexpected Alba prompt length ${promptFrames}`)
  }
  const expectedHalfValues = 2 * KV_GROUPS * promptFrames * KV_WIDTH
  if (buffer.byteLength !== 4 + expectedHalfValues * 2) {
    throw new Error('Alba voice state has an unexpected size')
  }

  const pk = new Float32Array(KV_GROUPS * KV_CAPACITY * KV_WIDTH)
  const pv = new Float32Array(KV_GROUPS * KV_CAPACITY * KV_WIDTH)
  for (let plane = 0; plane < 2; plane++) {
    const target = plane === 0 ? pk : pv
    for (let group = 0; group < KV_GROUPS; group++) {
      for (let frame = 0; frame < promptFrames; frame++) {
        const sourceBase = ((plane * KV_GROUPS + group) * promptFrames + frame) * KV_WIDTH
        const targetBase = (group * KV_CAPACITY + frame) * KV_WIDTH
        for (let d = 0; d < KV_WIDTH; d++) {
          const halfIndex = sourceBase + d
          target[targetBase + d] = halfToFloat(view.getUint16(4 + halfIndex * 2, true))
        }
      }
    }
  }
  return { promptFrames, pk, pv }
}

function createGpuState(flow: any, voiceBuffer: ArrayBuffer): GpuState {
  const device = getWebGpuDevice() as any
  if (!device) throw new Error('LiteRT did not provide a WebGPU device')
  const details = flow.getInputDetails()
  if (details.length !== 7) throw new Error(`Unexpected fused Pocket input count ${details.length}`)

  const voice = parseVoiceState(voiceBuffer)
  const mask = new Float32Array(16 * 513).fill(-1e4)
  for (let head = 0; head < 16; head++) {
    const base = head * 513
    for (let p = 0; p < voice.promptFrames; p++) mask[base + p] = 0
    mask[base + 512] = 0
  }

  const usage = (globalThis as any).GPUBufferUsage
  if (!usage) throw new Error('WebGPU buffer constants are unavailable')
  const makeBuffer = (data: Float32Array, extraUsage = 0) => {
    const buffer = device.createBuffer({
      size: Math.ceil(data.byteLength / 4) * 4,
      usage: usage.STORAGE | usage.COPY_DST | usage.COPY_SRC | extraUsage,
    })
    device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }

  const pkBuffer = makeBuffer(voice.pk)
  const pvBuffer = makeBuffer(voice.pv)
  const maskBuffer = makeBuffer(mask)
  const kvStepBuffer = device.createBuffer({
    size: KV_STEP_VALUES * 2 * 4,
    usage: usage.STORAGE | usage.COPY_DST,
  })
  const paramsBuffer = device.createBuffer({
    size: 16,
    usage: usage.UNIFORM | usage.COPY_DST,
  })

  const shader = device.createShaderModule({
    code: `
      struct Params { pos: u32, pad0: u32, pad1: u32, pad2: u32 }
      @group(0) @binding(0) var<storage, read> stepKV: array<f32>;
      @group(0) @binding(1) var<storage, read_write> pk: array<f32>;
      @group(0) @binding(2) var<storage, read_write> pv: array<f32>;
      @group(0) @binding(3) var<storage, read_write> mask: array<f32>;
      @group(0) @binding(4) var<uniform> params: Params;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i = gid.x;
        if (i < ${KV_STEP_VALUES}u) {
          let group = i / ${KV_WIDTH}u;
          let dim = i % ${KV_WIDTH}u;
          let dst = group * ${KV_CAPACITY * KV_WIDTH}u + params.pos * ${KV_WIDTH}u + dim;
          pk[dst] = stepKV[i];
          pv[dst] = stepKV[${KV_STEP_VALUES}u + i];
        }
        if (i < 16u) {
          mask[i * 513u + params.pos] = 0.0;
        }
      }
    `,
  })
  const scatterPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: shader, entryPoint: 'main' },
  })
  const scatterBindGroup = device.createBindGroup({
    layout: scatterPipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: kvStepBuffer } },
      { binding: 1, resource: { buffer: pkBuffer } },
      { binding: 2, resource: { buffer: pvBuffer } },
      { binding: 3, resource: { buffer: maskBuffer } },
      { binding: 4, resource: { buffer: paramsBuffer } },
    ],
  })

  const TensorCtor = Tensor as any
  const pkTensor = new TensorCtor(pkBuffer, Array.from(details[4].shape), details[4].dtype)
  const pvTensor = new TensorCtor(pvBuffer, Array.from(details[5].shape), details[5].dtype)
  const maskTensor = new TensorCtor(maskBuffer, Array.from(details[3].shape), details[3].dtype)

  return {
    device,
    pkBuffer,
    pvBuffer,
    maskBuffer,
    kvStepBuffer,
    paramsBuffer,
    pkTensor,
    pvTensor,
    maskTensor,
    scatterPipeline,
    scatterBindGroup,
    pos: voice.promptFrames,
  }
}

function destroyGpuState(state: GpuState | null): void {
  if (!state) return
  state.pkTensor.delete()
  state.pvTensor.delete()
  state.maskTensor.delete()
  state.pkBuffer.destroy()
  state.pvBuffer.destroy()
  state.maskBuffer.destroy()
  state.kvStepBuffer.destroy()
  state.paramsBuffer.destroy()
}

async function fusedStep(
  flow: any,
  state: GpuState,
  embedding: Float32Array,
  noise: Float32Array,
): Promise<{ eos: number; latent: Float32Array }> {
  if (state.pos >= KV_CAPACITY) throw new Error('Pocket KV cache capacity was exceeded')
  const details = flow.getInputDetails()
  const angleCos = new Float32Array(64)
  const angleSin = new Float32Array(64)
  for (let j = 0; j < 32; j++) {
    const frequency = 10000 ** (-j / 32)
    const angle = state.pos * frequency
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    angleCos[j] = c
    angleCos[j + 32] = c
    angleSin[j] = s
    angleSin[j + 32] = s
  }

  const hostInputs = [
    makeHostTensor(embedding, details[0].shape),
    makeHostTensor(angleCos, details[1].shape),
    makeHostTensor(angleSin, details[2].shape),
    makeHostTensor(noise, details[6].shape),
  ]
  let outputs: any[] = []
  try {
    outputs = await flow.run([
      hostInputs[0],
      hostInputs[1],
      hostInputs[2],
      state.maskTensor,
      state.pkTensor,
      state.pvTensor,
      hostInputs[3],
    ]) as any[]
    if (outputs.length !== 1) throw new Error(`Unexpected fused Pocket output count ${outputs.length}`)
    const raw = tensorDataToFloat32(await outputs[0].data())
    if (raw.length !== 1 + LATENT_WIDTH + KV_STEP_VALUES * 2) {
      throw new Error(`Unexpected fused Pocket output size ${raw.length}`)
    }

    const kv = raw.subarray(1 + LATENT_WIDTH)
    state.device.queue.writeBuffer(state.kvStepBuffer, 0, kv)
    state.device.queue.writeBuffer(
      state.paramsBuffer,
      0,
      new Uint32Array([state.pos, 0, 0, 0]),
    )
    const encoder = state.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(state.scatterPipeline)
    pass.setBindGroup(0, state.scatterBindGroup)
    pass.dispatchWorkgroups(Math.ceil(KV_STEP_VALUES / 64))
    pass.end()
    state.device.queue.submit([encoder.finish()])

    state.pos++
    return { eos: raw[0], latent: raw.slice(1, 1 + LATENT_WIDTH) }
  } finally {
    hostInputs.forEach((tensor) => tensor.delete())
    outputs.forEach((tensor) => tensor.delete())
  }
}

async function generateLatents(
  flow: any,
  state: GpuState,
  tokenizer: LiteRTPocketTokenizer,
  embeddingBuffer: ArrayBuffer,
  inputLinear: Float32Array,
  bos: Float32Array,
): Promise<{ latents: Float32Array[]; generationMs: number }> {
  const tokens = tokenizer.encode(SAMPLE_TEXT)
  if (!tokens.length || tokens.length > 50) {
    throw new Error(`LiteRT test text encoded to ${tokens.length} tokens (expected 1–50)`)
  }
  if (state.pos + tokens.length + MAX_GENERATED_FRAMES >= KV_CAPACITY) {
    throw new Error('Alba prompt leaves insufficient Pocket KV capacity')
  }
  const embeddingsFp16 = new DataView(embeddingBuffer)
  if (embeddingBuffer.byteLength !== 4001 * MODEL_WIDTH * 2) {
    throw new Error('Pocket embedding table has an unexpected size')
  }

  status('Priming Alba with the sample text…', `${tokens.length} text tokens`)
  const zeroNoise = new Float32Array(LATENT_WIDTH)
  for (const token of tokens) {
    await fusedStep(flow, state, tokenEmbedding(token, embeddingsFp16), zeroNoise)
  }

  status('Generating Alba speech on your iPhone…')
  const started = performance.now()
  const latents: Float32Array[] = []
  let current: Float32Array<ArrayBufferLike> = bos.slice()
  let eosAt: number | null = null

  for (let frame = 0; frame < MAX_GENERATED_FRAMES; frame++) {
    const step = await fusedStep(flow, state, current, gaussianVector(LATENT_WIDTH))
    if (step.eos > -4 && eosAt == null) eosAt = frame
    if (eosAt != null && frame >= eosAt + 3) break
    latents.push(step.latent)
    current = latentToEmbedding(step.latent, inputLinear)
    if (frame > 0 && frame % 25 === 0) {
      status('Generating Alba speech on your iPhone…', `${(frame / 12.5).toFixed(1)} s generated`)
    }
  }

  if (!latents.length) throw new Error('Pocket LiteRT generated no latent audio frames')
  if (eosAt == null) throw new Error('Pocket LiteRT did not reach end-of-speech before the safety cap')
  return { latents, generationMs: performance.now() - started }
}

function flattenLatents(
  latents: Float32Array[],
  block: number,
  neutral: Float32Array,
): Float32Array {
  const input = new Float32Array(DECODER_INPUT_FRAMES * LATENT_WIDTH)
  for (let i = 0; i < DECODER_INPUT_FRAMES; i++) {
    const sourceIndex = block * DECODER_BLOCK_FRAMES + i - DECODER_CONTEXT_FRAMES
    const source = sourceIndex >= 0 && sourceIndex < latents.length ? latents[sourceIndex] : neutral
    input.set(source, i * LATENT_WIDTH)
  }
  return input
}

async function decodeLatents(
  latents: Float32Array[],
  neutral: Float32Array,
): Promise<{ pcm: Float32Array; decodeMs: number }> {
  status('Loading the lightweight Pocket audio decoder…')
  const decTx = await loadAndCompile(DEC_TX_URL, { accelerator: 'wasm' }) as any
  const deconly = await loadAndCompile(DECONLY_URL, { accelerator: 'webgpu' }) as any
  const started = performance.now()
  try {
    const txInputs = decTx.getInputDetails()
    if (txInputs.length !== 1 || shapeSize(txInputs[0].shape) !== DECODER_INPUT_FRAMES * LATENT_WIDTH) {
      throw new Error('Unexpected Pocket decoder-transformer input shape')
    }
    const blockCount = Math.ceil(latents.length / DECODER_BLOCK_FRAMES)
    if (blockCount > 8) throw new Error('Pocket sample exceeded one SEANet decode window')
    const features = new Float32Array(DECODER_FEATURE_CHANNELS * DECONLY_FEATURE_LENGTH)

    status('Decoding Alba audio…', `${blockCount} decoder blocks`)
    for (let block = 0; block < blockCount; block++) {
      const input = makeHostTensor(flattenLatents(latents, block, neutral), txInputs[0].shape)
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
      const wanted = Math.min(decoded.length, latents.length * SAMPLES_PER_FRAME)
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

async function runProbe(generationOnly = false): Promise<void> {
  if (!isWebGPUSupported()) {
    throw new Error('WebGPU is not available in this Safari session. The LiteRT safety test will not fall back to the large CPU model.')
  }

  const totalStarted = performance.now()
  status('Starting Google LiteRT…')
  configureLiteRtAssetLocator()
  await loadLiteRt(LITERT_WASM)

  const [embeddingBuffer, inputLinearBuffer, bosBuffer, neutralBuffer, voiceBuffer, tokenizer] =
    await Promise.all([
      fetchBuffer(EMBED_URL, 'Loading Pocket token embeddings…'),
      fetchBuffer(INPUT_LINEAR_URL, 'Loading Pocket input projection…'),
      fetchBuffer(BOS_URL, 'Loading Pocket generation seed…'),
      fetchBuffer(NEUTRAL_URL, 'Loading Pocket decoder seed…'),
      fetchBuffer(ALBA_URL, 'Loading the Alba voice state…'),
      LiteRTPocketTokenizer.fromUrl(TOKENIZER_URL),
    ])

  const inputLinear = readFloat32Array(inputLinearBuffer)
  const bos = readFloat32Array(bosBuffer)
  const neutral = readFloat32Array(neutralBuffer)
  if (inputLinear.length !== MODEL_WIDTH * LATENT_WIDTH) throw new Error('Unexpected Pocket input projection size')
  if (bos.length !== MODEL_WIDTH) throw new Error('Unexpected Pocket BOS size')
  if (neutral.length !== LATENT_WIDTH) throw new Error('Unexpected Pocket neutral latent size')

  status('Loading Pocket LiteRT language model…', 'About 169 MB on first run')
  const flow = await loadAndCompile(FLOW_URL, { accelerator: 'webgpu' }) as any
  let gpuState: GpuState | null = null
  let generationMs = 0
  let latents: Float32Array[] = []
  try {
    if (flow.options?.accelerator !== 'webgpu' || !flow.isFullyAccelerated) {
      throw new Error('Pocket LiteRT could not stay fully on WebGPU on this iPhone; CPU fallback was intentionally blocked for safety.')
    }
    gpuState = createGpuState(flow, voiceBuffer)
    const generated = await generateLatents(flow, gpuState, tokenizer, embeddingBuffer, inputLinear, bos)
    latents = generated.latents
    generationMs = generated.generationMs
    await gpuState.device.queue.onSubmittedWorkDone()
  } finally {
    const device = gpuState?.device
    destroyGpuState(gpuState)
    flow.delete()
    if (generationOnly) {
      try {
        device?.destroy?.()
      } catch {
        // The worker is terminated immediately after the latent handoff.
      }
    }
  }

  if (generationOnly) {
    const flatLatents = new Float32Array(latents.length * LATENT_WIDTH)
    for (let i = 0; i < latents.length; i++) {
      flatLatents.set(latents[i], i * LATENT_WIDTH)
    }
    status('Pocket language model released; handing off decoder…')
    scope.postMessage(
      {
        type: 'latent-result',
        latents: flatLatents,
        latentFrames: latents.length,
        generationMs,
        text: SAMPLE_TEXT,
      },
      [flatLatents.buffer],
    )
    return
  }

  status('Pocket language model released; decoding audio…')
  const decoded = await decodeLatents(latents, neutral)
  const duration = decoded.pcm.length / SAMPLE_RATE
  const totalMs = performance.now() - totalStarted
  const pcm = decoded.pcm

  status('Alba LiteRT test ready.')
  scope.postMessage(
    {
      type: 'result',
      pcm,
      sampleRate: SAMPLE_RATE,
      text: SAMPLE_TEXT,
      duration,
      generationMs,
      decodeMs: decoded.decodeMs,
      totalMs,
      rtfx: duration / Math.max(0.001, generationMs / 1000),
    },
    [pcm.buffer],
  )
}

self.onmessage = (event: MessageEvent<{ type?: string }>) => {
  if (event.data?.type !== 'run' && event.data?.type !== 'generate-only') return
  void runProbe(event.data.type === 'generate-only')
    .catch((error) => {
      scope.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      try {
        unloadLiteRt()
      } catch {
        // Best-effort cleanup; worker termination on the main thread is the hard stop.
      }
    })
}
