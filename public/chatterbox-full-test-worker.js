import {
  AutoProcessor,
  ChatterboxModel,
  Tensor,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0'

const MODEL_ID = 'onnx-community/chatterbox-ONNX'
const SAMPLE_RATE = 24000
const MAX_TEXT_CHARS = 200

let model = null
let processor = null
let speaker = null
let busy = false

function post(type, data = {}, transfer = []) {
  self.postMessage({ type, data }, transfer)
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function dispose(value) {
  try {
    value?.dispose?.()
  } catch {}
}

function disposeMap(value) {
  if (!value || typeof value !== 'object') return
  for (const item of Object.values(value)) dispose(item)
}

async function checkWebGPU() {
  if (!self.navigator?.gpu) return { available: false, reason: 'WebGPU is not exposed by this browser' }
  try {
    const adapter = await self.navigator.gpu.requestAdapter()
    return adapter ? { available: true } : { available: false, reason: 'No WebGPU adapter was returned' }
  } catch (error) {
    return { available: false, reason: errorText(error) }
  }
}

async function loadModel({ device = 'wasm' } = {}) {
  if (model && processor) {
    post('load:complete', { device, alreadyLoaded: true })
    return
  }
  if (busy) throw new Error('Chatterbox worker is already busy')
  busy = true
  const started = performance.now()
  try {
    if (env.backends?.onnx?.wasm) {
      // First iPhone pass is intentionally single-threaded. This avoids
      // SharedArrayBuffer / worker-pool edge cases while we prove viability.
      env.backends.onnx.wasm.numThreads = 1
    }

    const dtype = device === 'webgpu'
      ? {
          embed_tokens: 'fp32',
          speech_encoder: 'fp32',
          language_model: 'q4f16',
          conditional_decoder: 'fp32',
        }
      : {
          embed_tokens: 'fp32',
          speech_encoder: 'fp32',
          language_model: 'q4',
          conditional_decoder: 'fp32',
        }

    post('status', {
      title: 'Loading processor',
      detail: MODEL_ID,
    })
    processor = await AutoProcessor.from_pretrained(MODEL_ID)

    post('status', {
      title: 'Loading full Chatterbox',
      detail: `${device.toUpperCase()} · about 1.5 GB of model files`,
    })
    model = await ChatterboxModel.from_pretrained(MODEL_ID, {
      device,
      dtype,
      progress_callback: (progress) => post('load:progress', progress || {}),
    })

    post('load:complete', {
      device,
      loadMs: performance.now() - started,
      dtype,
      webgpu: await checkWebGPU(),
    })
  } finally {
    busy = false
  }
}

async function prepareLeo({ audioData }) {
  if (!model) throw new Error('Load full Chatterbox first')
  if (busy) throw new Error('Chatterbox worker is already busy')

  const samples = new Float32Array(audioData)
  if (samples.length < SAMPLE_RATE * 5) {
    throw new Error('Leo reference must be at least 5 seconds')
  }

  busy = true
  const started = performance.now()
  try {
    post('status', {
      title: 'Encoding Leo locally',
      detail: `${(samples.length / SAMPLE_RATE).toFixed(1)}s reference · never uploaded`,
    })
    const audioTensor = new Tensor('float32', samples, [1, samples.length])
    try {
      const nextSpeaker = await model.encode_speech(audioTensor)
      disposeMap(speaker)
      speaker = nextSpeaker
    } finally {
      dispose(audioTensor)
    }

    post('prepare:complete', {
      prepareMs: performance.now() - started,
      referenceSeconds: samples.length / SAMPLE_RATE,
    })
  } finally {
    busy = false
  }
}

async function generate({ text }) {
  if (!model || !processor) throw new Error('Load full Chatterbox first')
  if (!speaker) throw new Error('Prepare Leo first')
  if (busy) throw new Error('Chatterbox worker is already busy')

  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) throw new Error('Text is empty')
  if (normalized.length > MAX_TEXT_CHARS) {
    throw new Error(`Text exceeds the ${MAX_TEXT_CHARS}-character Leo test limit`)
  }

  busy = true
  const started = performance.now()
  let inputs = null
  let waveform = null
  try {
    post('status', {
      title: 'Generating with Leo',
      detail: `${normalized.length}/${MAX_TEXT_CHARS} characters · temperature 0.9 · exaggeration 0.5`,
    })

    inputs = await processor._call(normalized)
    waveform = await model.generate({
      ...inputs,
      ...speaker,
      exaggeration: 0.5,
      temperature: 0.9,
      do_sample: true,
      repetition_penalty: 1.2,
      top_p: 1.0,
      max_new_tokens: 512,
    })

    const source = waveform.data
    const copy = new Float32Array(source.length)
    copy.set(source)
    post(
      'generate:complete',
      {
        waveform: copy.buffer,
        sampleRate: SAMPLE_RATE,
        generationMs: performance.now() - started,
        audioDuration: copy.length / SAMPLE_RATE,
        chars: normalized.length,
      },
      [copy.buffer],
    )
  } finally {
    dispose(waveform)
    disposeMap(inputs)
    busy = false
  }
}

self.addEventListener('message', async (event) => {
  const { type, data = {} } = event.data || {}
  try {
    if (type === 'load') await loadModel(data)
    else if (type === 'prepare') await prepareLeo(data)
    else if (type === 'generate') await generate(data)
    else if (type === 'check_webgpu') post('check_webgpu:complete', await checkWebGPU())
    else throw new Error(`Unknown worker message: ${type}`)
  } catch (error) {
    post('error', { message: errorText(error), phase: type })
  }
})
