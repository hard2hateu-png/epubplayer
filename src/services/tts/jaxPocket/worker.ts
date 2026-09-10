import { defaultDevice, init, numpy as np, random, tree } from '@jax-js/jax'
import { cachedFetch, safetensors, tokenizers } from '@jax-js/loaders'
import {
  createFlowLMState,
  createMimiDecodeState,
  fromSafetensors,
  runFlowLMStep,
  runLinear,
  runMimiDecode,
  runMimiEncode,
  type PocketTTS,
} from './model'

type Backend = 'webgpu' | 'wasm'
type Mode = 'clone' | 'synthesis'
type VoiceEmbedding = { data: Float32Array; shape: number[] }
type WorkerRequest = {
  id: number
  type: 'init' | 'cloneVoice' | 'loadVoice' | 'generate' | 'cancel'
  payload?: Record<string, unknown>
}

const workerScope = self as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

const MODEL_URL =
  'https://huggingface.co/ekzhang/jax-js-models/resolve/main/kyutai-pocket-tts_b6369a24-fp16.safetensors'
const TOKENIZER_URL =
  'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/fbf8280/tokenizer.model'
const SAMPLE_RATE = 24_000
const FRAME_SAMPLES = 1_920

// Postmortem note: this experiment built successfully but crashed iPhone Safari
// while preparing the Leo clone. The clone path requires the full Pocket model
// plus Mimi encoder inside WebKit's memory budget. Do not merge this branch.

let model: PocketTTS | null = null
let backend: Backend | null = null
let tokenizer: Awaited<ReturnType<typeof tokenizers.loadSentencePiece>> | null = null
let voiceEmbedding: VoiceEmbedding | null = null
let cancelEpoch = 0

function postStatus(status: string, progress?: number): void {
  workerScope.postMessage({ type: 'status', status, progress })
}

function postResult(id: number, result: unknown, transfer: Transferable[] = []): void {
  workerScope.postMessage({ id, type: 'result', result }, transfer)
}

function postError(id: number, error: unknown): void {
  workerScope.postMessage({
    id,
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  })
}

function getModel(): PocketTTS {
  if (!model) throw new Error('JAX Pocket model is not loaded')
  return model
}

function weightDtype(): np.DType {
  return backend === 'wasm' ? np.float32 : np.float16
}

function dropCloneOnlyWeights(): void {
  const current = getModel()
  tree.dispose([
    current.mimi.encoder,
    current.mimi.encoderTransformer,
    current.mimi.downsample,
  ])
  current.mimi.encoder = {} as PocketTTS['mimi']['encoder']
  current.mimi.encoderTransformer = []
  current.mimi.downsample = {} as PocketTTS['mimi']['downsample']
}

async function initialize(mode: Mode): Promise<{ backend: Backend; sampleRate: number }> {
  if (model && backend && tokenizer) return { backend, sampleRate: SAMPLE_RATE }

  postStatus('Checking on-device Pocket acceleration…', 2)
  const devices = await init('webgpu', 'wasm')
  if (devices.includes('webgpu')) backend = 'webgpu'
  else if (devices.includes('wasm')) backend = 'wasm'
  else throw new Error('This browser does not provide WebGPU or JAX-JS Wasm support.')
  defaultDevice(backend)

  postStatus(
    backend === 'webgpu' ? 'Loading Pocket TTS with WebGPU…' : 'Loading Pocket TTS with Wasm…',
    5,
  )

  let lastProgress = -1
  let bytes: Uint8Array<ArrayBuffer> | null = await cachedFetch(
    MODEL_URL,
    undefined,
    ({ loadedBytes, totalBytes }) => {
      if (!totalBytes) return
      const pct = Math.max(5, Math.min(82, 5 + Math.floor((loadedBytes / totalBytes) * 77)))
      if (pct !== lastProgress) {
        lastProgress = pct
        postStatus('Downloading Pocket TTS once…', pct)
      }
    },
  )
  postStatus('Preparing Pocket TTS on this device…', 85)
  let parsed: safetensors.File | null = safetensors.parse(bytes)
  model = fromSafetensors(parsed, weightDtype())
  parsed = null
  bytes = null

  tokenizer = await tokenizers.loadSentencePiece(TOKENIZER_URL)
  if (mode === 'synthesis') dropCloneOnlyWeights()

  postStatus(`Pocket TTS ready on ${backend === 'webgpu' ? 'WebGPU' : 'Wasm'}`, 100)
  return { backend, sampleRate: SAMPLE_RATE }
}

function padAudio(audio: Float32Array): Float32Array {
  const paddedLength = Math.max(FRAME_SAMPLES, Math.ceil(audio.length / FRAME_SAMPLES) * FRAME_SAMPLES)
  if (paddedLength === audio.length) return audio.slice()
  const padded = new Float32Array(paddedLength)
  padded.set(audio)
  return padded
}

async function cloneVoice(audio: Float32Array): Promise<VoiceEmbedding> {
  const current = getModel()
  if (!audio.length) throw new Error('Leo conditioning audio is empty')

  postStatus('Encoding Leo locally with JAX-JS…', 92)
  const padded = padAudio(audio)
  let waveform = np.array(Array.from(padded), {
    shape: [1, padded.length],
    dtype: np.float32,
  })
  if (weightDtype() !== np.float32) waveform = waveform.astype(weightDtype())

  const encoded = runMimiEncode(tree.ref(current.mimi), waveform)
  const voiceFrames = encoded.transpose([1, 0])
  const projected = runLinear(
    { weight: current.flowLM.speakerProjWeight.ref },
    voiceFrames,
  )
  const shape = [...projected.shape]
  const fp32 = projected.astype(np.float32)
  const raw = (await fp32.data()) as Float32Array
  fp32.dispose()

  voiceEmbedding = { data: new Float32Array(raw), shape }
  const copy = voiceEmbedding.data.slice()
  postStatus('Leo voice embedding ready', 100)
  return { data: copy, shape: [...shape] }
}

function loadVoice(data: Float32Array, shape: number[]): void {
  if (!data.length || shape.length !== 2 || shape[1] !== 1024) {
    throw new Error('Saved Leo JAX voice embedding is invalid')
  }
  const expected = shape.reduce((product, value) => product * value, 1)
  if (expected !== data.length) throw new Error('Saved Leo JAX voice length is invalid')
  voiceEmbedding = { data: data.slice(), shape: shape.map(Number) }
}

function prepareTextPrompt(input: string): { text: string; framesAfterEos: number } {
  let text = input.trim().replace(/\s+/g, ' ')
  if (!text) throw new Error('Pocket text is empty')

  const wordCount = text.split(' ').length
  const framesAfterEos = wordCount <= 4 ? 5 : 3
  text = text.replace(/^(\p{Ll})/u, (char) => char.toLocaleUpperCase())
  if (/[\p{L}\p{N}]$/u.test(text)) text += '.'
  if (wordCount < 5) text = ' '.repeat(8) + text
  return { text, framesAfterEos }
}

function makeConditioning(text: string): { embeds: np.Array; framesAfterEos: number } {
  const current = getModel()
  if (!tokenizer) throw new Error('Pocket tokenizer is not loaded')
  if (!voiceEmbedding) throw new Error('Leo voice is not prepared')

  const prepared = prepareTextPrompt(text)
  const tokens = tokenizer.encode(prepared.text)
  const tokenArray = np.array(tokens, { dtype: np.uint32 })
  const textEmbeds = current.flowLM.conditionerEmbed.ref.slice(tokenArray)
  let voiceEmbeds = np.array(Array.from(voiceEmbedding.data), {
    shape: voiceEmbedding.shape,
    dtype: np.float32,
  })
  if (weightDtype() !== np.float32) voiceEmbeds = voiceEmbeds.astype(weightDtype())

  return {
    embeds: np.concatenate([voiceEmbeds, textEmbeds]),
    framesAfterEos: prepared.framesAfterEos,
  }
}

async function generatePcm(
  text: string,
  requestEpoch: number,
): Promise<{ pcm: Float32Array; sampleRate: number; rtfx: number }> {
  const current = getModel()
  const { embeds, framesAfterEos } = makeConditioning(text)
  const modelRef = tree.ref(current)
  let lastLatent = modelRef.flowLM.bosEmb.ref.reshape([1, -1])
  let flowState = createFlowLMState(modelRef.flowLM)
  let mimiState = createMimiDecodeState(modelRef.mimi)
  const frames: Float32Array[] = []
  let eosStep: number | null = null
  let key = random.key(Math.floor(Math.random() * 0xffffffff))
  const started = performance.now()

  try {
    for (let step = 0; step < 1000; step++) {
      if (requestEpoch !== cancelEpoch) throw new DOMException('Pocket generation cancelled', 'AbortError')

      let stepKey: np.Array
      ;[key, stepKey] = random.split(key)
      const generated = runFlowLMStep(
        tree.ref(modelRef.flowLM),
        flowState,
        stepKey,
        lastLatent.ref,
        step === 0 ? embeds.ref : null,
        flowState.kvCacheLen,
        1,
        0.7,
        null,
      )
      flowState = generated.state

      const eosData = await generated.isEos.data()
      generated.isEos.dispose()
      if (eosData[0] && eosStep === null) eosStep = step
      if (eosStep !== null && step >= eosStep + framesAfterEos) {
        generated.latent.dispose()
        break
      }

      const previous = lastLatent
      lastLatent = generated.latent
      previous.dispose()

      const mimiInput = generated.latent.ref
        .mul(modelRef.flowLM.embStd.ref)
        .add(modelRef.flowLM.embMean.ref)
      let audio: np.Array
      ;[audio, mimiState] = runMimiDecode(tree.ref(modelRef.mimi), mimiState, mimiInput)
      const pcmArray = np.clip(audio, -1, 1).astype(np.float32)
      const frame = (await pcmArray.data()) as Float32Array
      pcmArray.dispose()
      frames.push(new Float32Array(frame))
    }
  } finally {
    lastLatent.dispose()
    tree.dispose(flowState)
    tree.dispose(mimiState)
    tree.dispose([modelRef, embeds])
  }

  if (!frames.length) throw new Error('JAX Pocket returned no audio')
  const totalSamples = frames.reduce((sum, frame) => sum + frame.length, 0)
  const pcm = new Float32Array(totalSamples)
  let offset = 0
  for (const frame of frames) {
    pcm.set(frame, offset)
    offset += frame.length
  }
  const audioSeconds = totalSamples / SAMPLE_RATE
  const elapsedSeconds = Math.max(0.001, (performance.now() - started) / 1000)
  return { pcm, sampleRate: SAMPLE_RATE, rtfx: audioSeconds / elapsedSeconds }
}

workerScope.onmessage = (event) => {
  const message = event.data
  const id = Number(message.id)

  void (async () => {
    try {
      switch (message.type) {
        case 'init': {
          const mode = message.payload?.mode === 'clone' ? 'clone' : 'synthesis'
          postResult(id, await initialize(mode))
          break
        }
        case 'cloneVoice': {
          const audio = message.payload?.audio
          if (!(audio instanceof Float32Array)) throw new Error('Leo PCM was not transferred to JAX Pocket')
          const embedding = await cloneVoice(audio)
          postResult(id, embedding, [embedding.data.buffer])
          break
        }
        case 'loadVoice': {
          const data = message.payload?.data
          const shape = message.payload?.shape
          if (!(data instanceof Float32Array) || !Array.isArray(shape)) {
            throw new Error('Saved Leo JAX voice data is missing')
          }
          loadVoice(data, shape.map(Number))
          postResult(id, { loaded: true })
          break
        }
        case 'generate': {
          const text = typeof message.payload?.text === 'string' ? message.payload.text : ''
          const epoch = cancelEpoch
          const result = await generatePcm(text, epoch)
          postResult(id, result, [result.pcm.buffer])
          break
        }
        case 'cancel': {
          cancelEpoch++
          postResult(id, { cancelled: true })
          break
        }
        default:
          throw new Error(`Unknown JAX Pocket worker request: ${String(message.type)}`)
      }
    } catch (error) {
      postError(id, error)
    }
  })()
}
