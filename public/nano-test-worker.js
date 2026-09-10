const MODEL_ID = 'owensong/chatterbox-nano-ONNX'
const MODEL_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`
const ORT_VERSION = '1.27.0'
const ORT_DIST = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0'
const SAMPLE_RATE = 24000
const START_SPEECH_TOKEN = 6561
const STOP_SPEECH_TOKEN = 6562
const SILENCE_TOKEN = 4299
const HIDDEN_SIZE = 768
const CACHE_LAYERS = 12
const CACHE_HEADS = 12
const CACHE_HEAD_DIM = 64

const COMPONENTS = [
  { name: 'embed_tokens', file: 'embed_tokens_fp16.onnx', data: 'embed_tokens_fp16.onnx_data', mib: 83.3 },
  { name: 'speech_encoder', file: 'speech_encoder_q4f16.onnx', data: 'speech_encoder_q4f16.onnx_data', mib: 169.3 },
  { name: 'language_model', file: 'language_model_q4f16.onnx', data: 'language_model_q4f16.onnx_data', mib: 53.8 },
  { name: 'conditional_decoder', file: 'conditional_decoder_q4.onnx', data: 'conditional_decoder_q4.onnx_data', mib: 237.0 },
]

let ort = null
let tokenizer = null
let sessions = null
let conditioning = null
let activeBackend = null
let busy = false
let cancelled = false

function progress(status, detail = '', extra = {}) {
  self.postMessage({ type: 'progress', status, detail, ...extra })
}

function toError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function disposeTensor(tensor) {
  try {
    if (tensor && typeof tensor.dispose === 'function') tensor.dispose()
  } catch {}
}

function disposeTensorMap(map) {
  if (!map) return
  for (const value of Object.values(map)) disposeTensor(value)
}

async function importRuntime(backend) {
  if (ort) return
  progress('Loading JavaScript runtime', `ONNX Runtime Web ${ORT_VERSION}`)
  let ortUrl = `${ORT_DIST}ort.wasm.bundle.min.mjs`
  if (backend === 'webgpu') ortUrl = `${ORT_DIST}ort.webgpu.bundle.min.mjs`
  else if (backend === 'webgl') ortUrl = `${ORT_DIST}ort.webgl.min.mjs`
  ort = await import(ortUrl)

  if (ort.env?.wasm) {
    ort.env.wasm.wasmPaths = ORT_DIST
    // External-data session creation has had hangs with multi-threaded ORT Web.
    // Stability is more important than speed for the first iPhone diagnostic.
    ort.env.wasm.numThreads = 1
  }

  progress('Loading tokenizer runtime', 'Transformers.js 4.2.0')
  const transformers = await import(TRANSFORMERS_URL)
  if (transformers.env) {
    transformers.env.allowLocalModels = false
    transformers.env.allowRemoteModels = true
    transformers.env.useBrowserCache = true
  }
  progress('Loading Nano tokenizer', MODEL_ID)
  tokenizer = await transformers.AutoTokenizer.from_pretrained(MODEL_ID, {
    progress_callback: (event) => {
      if (!event || typeof event !== 'object') return
      const status = event.status || 'tokenizer'
      const file = event.file || ''
      const pct = Number.isFinite(event.progress) ? Math.round(event.progress) : null
      progress('Tokenizer', `${status}${file ? `: ${file}` : ''}${pct == null ? '' : ` (${pct}%)`}`)
    },
  })
}

function executionProviders(backend) {
  if (backend === 'webgpu') return ['webgpu']
  if (backend === 'webgl') return ['webgl']
  return ['wasm']
}

function findExternalDataPath(bytes, fallback) {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const matches = text.match(/[A-Za-z0-9_.\/-]+\.onnx_data/g) || []
    const exact = matches.find((item) => item.endsWith(fallback))
    return exact || matches[0] || fallback
  } catch {
    return fallback
  }
}

async function loadSession(component, backend, index) {
  const modelUrl = `${MODEL_BASE}/onnx/${component.file}`
  const externalUrl = `${MODEL_BASE}/onnx/${component.data}`
  progress(
    `Loading Nano model ${index + 1}/${COMPONENTS.length}`,
    `${component.name} · ~${component.mib.toFixed(0)} MiB weights`,
    { component: component.name }
  )

  const response = await fetch(modelUrl, { cache: 'force-cache', mode: 'cors' })
  if (!response.ok) throw new Error(`${component.file} returned HTTP ${response.status}`)
  const modelBytes = new Uint8Array(await response.arrayBuffer())
  const externalPath = findExternalDataPath(modelBytes, component.data)

  const options = {
    executionProviders: executionProviders(backend),
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    externalData: [{ path: externalPath, data: externalUrl }],
  }

  const started = performance.now()
  const session = await ort.InferenceSession.create(modelBytes, options)
  progress(
    `Loaded Nano model ${index + 1}/${COMPONENTS.length}`,
    `${component.name} in ${((performance.now() - started) / 1000).toFixed(1)}s`,
    { component: component.name }
  )
  return session
}

async function loadModel(backend) {
  if (sessions) return { backend: activeBackend, alreadyLoaded: true }
  if (busy) throw new Error('Nano worker is already busy')
  busy = true
  cancelled = false
  const started = performance.now()
  try {
    await importRuntime(backend)
    if (cancelled) throw new DOMException('Cancelled', 'AbortError')

    const loaded = {}
    for (let i = 0; i < COMPONENTS.length; i++) {
      if (cancelled) throw new DOMException('Cancelled', 'AbortError')
      loaded[COMPONENTS[i].name] = await loadSession(COMPONENTS[i], backend, i)
    }
    sessions = loaded
    activeBackend = backend
    return {
      backend,
      loadMs: performance.now() - started,
      modelMiB: COMPONENTS.reduce((sum, item) => sum + item.mib, 0),
    }
  } catch (error) {
    if (sessions) {
      for (const session of Object.values(sessions)) {
        try { session.release?.() } catch {}
      }
    }
    sessions = null
    activeBackend = null
    throw error
  } finally {
    busy = false
  }
}

function halfToFloat(value) {
  const sign = value & 0x8000 ? -1 : 1
  const exponent = (value >> 10) & 0x1f
  const fraction = value & 0x03ff
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024)
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024)
}

function asFloat32(tensor) {
  if (!tensor) throw new Error('Expected tensor output was missing')
  if (tensor.data instanceof Float32Array) return tensor.data
  if (tensor.type === 'float16' && tensor.data instanceof Uint16Array) {
    const output = new Float32Array(tensor.data.length)
    for (let i = 0; i < tensor.data.length; i++) output[i] = halfToFloat(tensor.data[i])
    return output
  }
  return Float32Array.from(tensor.data, Number)
}

function asNumbers(tensor) {
  if (!tensor) throw new Error('Expected tensor output was missing')
  return Array.from(tensor.data, Number)
}

async function prepareVoice(samples) {
  if (!sessions) throw new Error('Load the Nano model first')
  if (!(samples instanceof Float32Array) || samples.length < SAMPLE_RATE * 5) {
    throw new Error('Leo reference must contain at least 5 seconds of decoded audio')
  }
  if (busy) throw new Error('Nano worker is already busy')
  busy = true
  const started = performance.now()
  try {
    progress('Preparing Leo', `${(samples.length / SAMPLE_RATE).toFixed(1)}s local reference; audio never leaves this browser`)
    const input = new ort.Tensor('float32', samples, [1, samples.length])
    const outputs = await sessions.speech_encoder.run({ audio_values: input })
    disposeTensor(input)

    const ordered = sessions.speech_encoder.outputNames.map((name) => outputs[name])
    if (ordered.length < 4) throw new Error(`Speech encoder returned ${ordered.length} outputs; expected 4`)

    if (conditioning) {
      disposeTensor(conditioning.audioFeatures)
      disposeTensor(conditioning.audioTokens)
      disposeTensor(conditioning.speakerEmbeddings)
      disposeTensor(conditioning.speakerFeatures)
    }

    conditioning = {
      audioFeatures: ordered[0],
      audioTokens: ordered[1],
      speakerEmbeddings: ordered[2],
      speakerFeatures: ordered[3],
    }

    return {
      referenceSeconds: samples.length / SAMPLE_RATE,
      prepareMs: performance.now() - started,
      audioFeatureDims: conditioning.audioFeatures.dims,
      promptTokenCount: conditioning.audioTokens.data.length,
    }
  } finally {
    busy = false
  }
}

function int64Tensor(values, dims) {
  const data = new BigInt64Array(values.length)
  for (let i = 0; i < values.length; i++) data[i] = BigInt(values[i])
  return new ort.Tensor('int64', data, dims)
}

function float16Empty(dims) {
  return new ort.Tensor('float16', new Uint16Array(0), dims)
}

function emptyKvCache() {
  const names = sessions.language_model.inputNames.filter((name) => name.startsWith('past_key_values.'))
  if (names.length !== CACHE_LAYERS * 2) {
    throw new Error(`Expected ${CACHE_LAYERS * 2} Nano KV-cache inputs, found ${names.length}`)
  }
  const cache = {}
  for (const name of names) cache[name] = float16Empty([1, CACHE_HEADS, 0, CACHE_HEAD_DIM])
  return { names, cache }
}

function concatEmbeddings(audioFeatures, textEmbeddings) {
  const audio = asFloat32(audioFeatures)
  const text = asFloat32(textEmbeddings)
  const audioSeq = audioFeatures.dims[1]
  const textSeq = textEmbeddings.dims[1]
  const hidden = textEmbeddings.dims[2] || HIDDEN_SIZE
  if (hidden !== HIDDEN_SIZE) throw new Error(`Unexpected embedding width ${hidden}`)
  const data = new Float32Array(audio.length + text.length)
  data.set(audio, 0)
  data.set(text, audio.length)
  return new ort.Tensor('float32', data, [1, audioSeq + textSeq, hidden])
}

function applyRepetitionPenalty(logits, generated, penalty) {
  if (penalty === 1) return Float32Array.from(logits)
  const out = Float32Array.from(logits)
  const seen = new Set(generated)
  for (const id of seen) {
    if (id < 0 || id >= out.length) continue
    out[id] = out[id] < 0 ? out[id] * penalty : out[id] / penalty
  }
  return out
}

function sampleToken(logits, { temperature = 0.8, topK = 1000, topP = 0.95, greedy = false } = {}) {
  if (greedy || temperature <= 0) {
    let best = 0
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i
    return best
  }

  const ids = Array.from({ length: logits.length }, (_, i) => i)
  ids.sort((a, b) => logits[b] - logits[a])
  const keep = ids.slice(0, Math.max(1, Math.min(topK, ids.length)))

  let max = -Infinity
  for (const id of keep) max = Math.max(max, logits[id] / temperature)
  const weights = new Float64Array(keep.length)
  let total = 0
  for (let i = 0; i < keep.length; i++) {
    const value = Math.exp(logits[keep[i]] / temperature - max)
    weights[i] = value
    total += value
  }

  let cumulative = 0
  let cutoff = keep.length
  for (let i = 0; i < keep.length; i++) {
    cumulative += weights[i] / total
    if (cumulative >= topP) {
      cutoff = i + 1
      break
    }
  }

  let truncatedTotal = 0
  for (let i = 0; i < cutoff; i++) truncatedTotal += weights[i]
  let target = Math.random() * truncatedTotal
  for (let i = 0; i < cutoff; i++) {
    target -= weights[i]
    if (target <= 0) return keep[i]
  }
  return keep[Math.max(0, cutoff - 1)]
}

function lastLogits(tensor) {
  const dims = tensor.dims
  const vocab = dims[dims.length - 1]
  const data = asFloat32(tensor)
  return data.subarray(data.length - vocab)
}

function concatSpeechTokens(promptTensor, generated) {
  const prompt = asNumbers(promptTensor)
  const all = [...prompt, ...generated, SILENCE_TOKEN, SILENCE_TOKEN, SILENCE_TOKEN]
  return int64Tensor(all, [1, all.length])
}

async function tokenize(text) {
  const encoded = await tokenizer(text, { truncation: true, max_length: 512 })
  if (!encoded?.input_ids) throw new Error('Tokenizer returned no input_ids')
  const ids = Array.from(encoded.input_ids.data, Number)
  if (!ids.length) throw new Error('Tokenizer produced an empty prompt')
  return ids
}

async function generate(text, options = {}) {
  if (!sessions) throw new Error('Load the Nano model first')
  if (!conditioning) throw new Error('Prepare Leo first')
  if (busy) throw new Error('Nano worker is already busy')
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim()
  if (!cleaned) throw new Error('Enter some text to synthesize')
  if (cleaned.length > 180) throw new Error('Keep the diagnostic prompt at 180 characters or fewer')

  busy = true
  cancelled = false
  const started = performance.now()
  const maxNewTokens = Math.max(32, Math.min(384, Number(options.maxNewTokens) || 256))
  const generated = [START_SPEECH_TOKEN]
  let reachedEos = false
  let kv = null

  try {
    const textIds = await tokenize(cleaned)
    let nextInputIds = textIds
    let attentionLength = 0
    let nextPosition = 0

    for (let step = 0; step < maxNewTokens; step++) {
      if (cancelled) throw new DOMException('Cancelled', 'AbortError')

      const inputIdsTensor = int64Tensor(nextInputIds, [1, nextInputIds.length])
      const embedResult = await sessions.embed_tokens.run({ input_ids: inputIdsTensor })
      disposeTensor(inputIdsTensor)
      const rawEmbeddings = embedResult[sessions.embed_tokens.outputNames[0]]
      let lmEmbeddings = rawEmbeddings

      if (step === 0) {
        lmEmbeddings = concatEmbeddings(conditioning.audioFeatures, rawEmbeddings)
        attentionLength = lmEmbeddings.dims[1]
        nextPosition = attentionLength - 1
        kv = emptyKvCache()
      } else {
        attentionLength += 1
        nextPosition += 1
      }

      const maskValues = new Array(attentionLength).fill(1)
      const positionValues = step === 0
        ? Array.from({ length: attentionLength }, (_, i) => i)
        : [nextPosition]
      const attentionMask = int64Tensor(maskValues, [1, attentionLength])
      const positionIds = int64Tensor(positionValues, [1, positionValues.length])

      const feeds = {
        inputs_embeds: lmEmbeddings,
        attention_mask: attentionMask,
        position_ids: positionIds,
        ...kv.cache,
      }
      const oldCache = kv.cache
      const lmOutputs = await sessions.language_model.run(feeds)

      disposeTensor(attentionMask)
      disposeTensor(positionIds)
      if (lmEmbeddings !== rawEmbeddings) disposeTensor(lmEmbeddings)
      disposeTensor(rawEmbeddings)

      const logitsTensor = lmOutputs[sessions.language_model.outputNames[0]]
      const penalized = applyRepetitionPenalty(lastLogits(logitsTensor), generated, 1.2)
      const token = sampleToken(penalized, {
        temperature: 0.8,
        topK: 1000,
        topP: 0.95,
        greedy: Boolean(options.greedy),
      })
      generated.push(token)

      const newCache = {}
      for (let i = 0; i < kv.names.length; i++) {
        const tensor = lmOutputs[sessions.language_model.outputNames[i + 1]]
        if (!tensor) throw new Error(`Language model KV output ${i + 1} was missing`)
        newCache[kv.names[i]] = tensor
      }
      kv.cache = newCache
      disposeTensorMap(oldCache)
      disposeTensor(logitsTensor)

      if (step % 10 === 0 || token === STOP_SPEECH_TOKEN) {
        progress('Generating speech tokens', `${step + 1}/${maxNewTokens}`, { tokenStep: step + 1 })
      }

      if (token === STOP_SPEECH_TOKEN) {
        reachedEos = true
        break
      }
      nextInputIds = [token]
    }

    const generatedAudio = reachedEos ? generated.slice(1, -1) : generated.slice(1)
    progress('Synthesizing waveform', `${generatedAudio.length} generated speech tokens`)
    const speechTokens = concatSpeechTokens(conditioning.audioTokens, generatedAudio)
    const decoderOutputs = await sessions.conditional_decoder.run({
      speech_tokens: speechTokens,
      speaker_embeddings: conditioning.speakerEmbeddings,
      speaker_features: conditioning.speakerFeatures,
    })
    disposeTensor(speechTokens)
    const waveformTensor = decoderOutputs[sessions.conditional_decoder.outputNames[0]]
    const waveform = Float32Array.from(asFloat32(waveformTensor))
    disposeTensor(waveformTensor)

    const elapsed = performance.now() - started
    const duration = waveform.length / SAMPLE_RATE
    return {
      waveform,
      sampleRate: SAMPLE_RATE,
      generationMs: elapsed,
      audioDuration: duration,
      generatedTokens: generatedAudio.length,
      reachedEos,
      chars: cleaned.length,
    }
  } finally {
    if (kv?.cache) disposeTensorMap(kv.cache)
    busy = false
  }
}

async function reset() {
  cancelled = true
  if (conditioning) {
    disposeTensor(conditioning.audioFeatures)
    disposeTensor(conditioning.audioTokens)
    disposeTensor(conditioning.speakerEmbeddings)
    disposeTensor(conditioning.speakerFeatures)
  }
  conditioning = null
  if (sessions) {
    for (const session of Object.values(sessions)) {
      try { await session.release?.() } catch {}
    }
  }
  sessions = null
  activeBackend = null
  return { ok: true }
}

self.onmessage = async (event) => {
  const { id, type, payload = {} } = event.data || {}
  if (type === 'cancel') {
    cancelled = true
    return
  }

  try {
    let result
    if (type === 'load') result = await loadModel(payload.backend || 'wasm')
    else if (type === 'prepare') result = await prepareVoice(payload.samples)
    else if (type === 'generate') {
      const generated = await generate(payload.text, payload.options || {})
      if (payload.keepAudio) {
        result = generated
        self.postMessage({ type: 'result', id, result }, [generated.waveform.buffer])
        return
      }
      const { waveform: _waveform, ...metrics } = generated
      result = metrics
    } else if (type === 'reset') result = await reset()
    else throw new Error(`Unknown worker command: ${type}`)

    self.postMessage({ type: 'result', id, result })
  } catch (error) {
    self.postMessage({ type: 'error', id, error: toError(error) })
  }
}
