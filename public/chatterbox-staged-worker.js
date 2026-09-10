const MODEL_ID = 'onnx-community/chatterbox-ONNX'
const MODEL_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main`
const ORT_VERSION = '1.27.0'
const ORT_DIST = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0'
const SAMPLE_RATE = 24000
const START_SPEECH_TOKEN = 6561
const STOP_SPEECH_TOKEN = 6562
const SILENCE_TOKEN = 4299
const HIDDEN_SIZE = 1024
const CACHE_LAYERS = 30
const CACHE_HEADS = 16
const CACHE_HEAD_DIM = 64
const MAX_TEXT_CHARS = 200
const WASM_THREADS = 4

const COMPONENTS = {
  speech_encoder: { file: 'speech_encoder.onnx', data: 'speech_encoder.onnx_data', mib: 564 },
  embed_tokens: { file: 'embed_tokens.onnx', data: 'embed_tokens.onnx_data', mib: 59 },
  language_model: { file: 'language_model_q4.onnx', data: 'language_model_q4.onnx_data', mib: 338 },
  conditional_decoder: { file: 'conditional_decoder.onnx', data: 'conditional_decoder.onnx_data', mib: 510 },
}

let ort = null
let tokenizer = null
let conditioning = null
let busy = false
let cancelled = false
let activeThreads = 1

function progress(status, detail = '', extra = {}) {
  self.postMessage({ type: 'progress', status, detail, ...extra })
}
function toError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
function disposeTensor(tensor) {
  try { tensor?.dispose?.() } catch {}
}
function disposeTensorMap(map) {
  if (!map) return
  for (const value of Object.values(map)) disposeTensor(value)
}
async function releaseSession(session) {
  try { await session?.release?.() } catch {}
}
function findExternalDataPath(bytes, fallback) {
  try {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    const matches = text.match(/[A-Za-z0-9_.\/-]+\.onnx_data/g) || []
    return matches.find((item) => item.endsWith(fallback)) || matches[0] || fallback
  } catch {
    return fallback
  }
}

async function initRuntime() {
  if (ort && tokenizer) return {
    ready: true,
    alreadyLoaded: true,
    threads: activeThreads,
    crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  }
  if (busy) throw new Error('Warm-session Chatterbox worker is already busy')
  busy = true
  const started = performance.now()
  try {
    const isolated = self.crossOriginIsolated === true
    const hasSharedArrayBuffer = typeof SharedArrayBuffer !== 'undefined'
    if (!isolated || !hasSharedArrayBuffer) {
      throw new Error(`4-thread WASM unavailable: crossOriginIsolated=${isolated}, SharedArrayBuffer=${hasSharedArrayBuffer}`)
    }
    activeThreads = Math.max(1, Math.min(WASM_THREADS, Number(self.navigator?.hardwareConcurrency) || WASM_THREADS))
    progress('Loading ONNX Runtime', `WASM ${ORT_VERSION} · ${activeThreads} threads`)
    ort = await import(`${ORT_DIST}ort.wasm.bundle.min.mjs`)
    ort.env.wasm.wasmPaths = ORT_DIST
    ort.env.wasm.numThreads = activeThreads

    progress('Loading tokenizer', 'No model weights are resident yet')
    const transformers = await import(TRANSFORMERS_URL)
    if (transformers.env) {
      transformers.env.allowLocalModels = false
      transformers.env.allowRemoteModels = true
      transformers.env.useBrowserCache = true
    }
    tokenizer = await transformers.AutoTokenizer.from_pretrained(MODEL_ID)
    return {
      ready: true,
      initMs: performance.now() - started,
      threads: activeThreads,
      hardwareConcurrency: Number(self.navigator?.hardwareConcurrency) || null,
      crossOriginIsolated: isolated,
      sharedArrayBuffer: hasSharedArrayBuffer,
    }
  } finally {
    busy = false
  }
}

async function loadSession(name) {
  if (!ort) await initRuntime()
  const component = COMPONENTS[name]
  if (!component) throw new Error(`Unknown Chatterbox component: ${name}`)
  progress(`Loading ${name.replaceAll('_', ' ')}`, `~${component.mib} MiB · ${activeThreads}-thread WASM`, { component: name })
  const modelUrl = `${MODEL_BASE}/onnx/${component.file}`
  const externalUrl = `${MODEL_BASE}/onnx/${component.data}`
  const response = await fetch(modelUrl, { cache: 'force-cache', mode: 'cors' })
  if (!response.ok) throw new Error(`${component.file} returned HTTP ${response.status}`)
  const modelBytes = new Uint8Array(await response.arrayBuffer())
  const externalPath = findExternalDataPath(modelBytes, component.data)
  const started = performance.now()
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: ['wasm'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    enableMemPattern: false,
    externalData: [{ path: externalPath, data: externalUrl }],
  })
  progress(`Loaded ${name.replaceAll('_', ' ')}`, `${((performance.now() - started) / 1000).toFixed(1)}s`, { component: name })
  return session
}

function cloneTensor(tensor) {
  const data = new tensor.data.constructor(tensor.data)
  return new ort.Tensor(tensor.type, data, [...tensor.dims])
}
function int64Tensor(values, dims) {
  const data = new BigInt64Array(values.length)
  for (let i = 0; i < values.length; i++) data[i] = BigInt(values[i])
  return new ort.Tensor('int64', data, dims)
}
function float32Tensor(values, dims) {
  return new ort.Tensor('float32', Float32Array.from(values), dims)
}
function emptyKvCache(batchSize) {
  const cache = {}
  for (let layer = 0; layer < CACHE_LAYERS; layer++) {
    for (const kv of ['key', 'value']) {
      cache[`past_key_values.${layer}.${kv}`] = new ort.Tensor(
        'float32', new Float32Array(0), [batchSize, CACHE_HEADS, 0, CACHE_HEAD_DIM],
      )
    }
  }
  return cache
}
function concatFirstPass(audioFeatures, textEmbeddings, cfgWeight) {
  const audio = audioFeatures.data
  const text = textEmbeddings.data
  const audioSeq = audioFeatures.dims[1]
  const textSeq = textEmbeddings.dims[1]
  const hidden = textEmbeddings.dims[2] || HIDDEN_SIZE
  if (hidden !== HIDDEN_SIZE) throw new Error(`Unexpected Chatterbox embedding width ${hidden}`)
  const useCfg = cfgWeight > 0
  const batch = useCfg ? 2 : 1
  const seq = audioSeq + textSeq
  const out = new Float32Array(batch * seq * hidden)
  out.set(audio, 0)
  out.set(text, audio.length)
  if (useCfg) out.set(audio, seq * hidden)
  return new ort.Tensor('float32', out, [batch, seq, hidden])
}
function duplicateSpeechEmbedding(tensor, batchSize) {
  if (batchSize === 1) return cloneTensor(tensor)
  const source = tensor.data
  const out = new Float32Array(source.length * batchSize)
  for (let i = 0; i < batchSize; i++) out.set(source, i * source.length)
  return new ort.Tensor('float32', out, [batchSize, tensor.dims[1], tensor.dims[2]])
}
function lastBatchLogits(tensor) {
  const dims = tensor.dims
  const batch = dims[0]
  const vocab = dims[dims.length - 1]
  const seq = dims[dims.length - 2]
  const data = tensor.data
  const result = []
  for (let b = 0; b < batch; b++) {
    const start = (b * seq + (seq - 1)) * vocab
    result.push(Float32Array.from(data.subarray(start, start + vocab)))
  }
  return result
}
function applyCfg(batchLogits, cfgWeight) {
  const cond = batchLogits[0]
  if (cfgWeight <= 0 || batchLogits.length < 2) return cond
  const uncond = batchLogits[1]
  const out = new Float32Array(cond.length)
  for (let i = 0; i < cond.length; i++) out[i] = cond[i] + cfgWeight * (cond[i] - uncond[i])
  return out
}
function applyRepetitionPenalty(logits, generated, penalty) {
  const out = Float32Array.from(logits)
  if (penalty === 1) return out
  for (const id of new Set(generated)) {
    if (id < 0 || id >= out.length) continue
    out[id] = out[id] < 0 ? out[id] * penalty : out[id] / penalty
  }
  return out
}
function sampleToken(logits, { temperature = 0.9, minP = 0.05 } = {}) {
  if (!(temperature > 0)) {
    let best = 0
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i
    return best
  }
  let maxScaled = -Infinity
  const scaled = new Float64Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    scaled[i] = logits[i] / temperature
    if (scaled[i] > maxScaled) maxScaled = scaled[i]
  }
  const minLogit = maxScaled + Math.log(Math.max(1e-8, minP))
  let total = 0
  const weights = new Float64Array(logits.length)
  for (let i = 0; i < scaled.length; i++) {
    if (scaled[i] < minLogit) continue
    const w = Math.exp(scaled[i] - maxScaled)
    weights[i] = w
    total += w
  }
  if (!(total > 0)) {
    let best = 0
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i
    return best
  }
  let target = Math.random() * total
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i]
    if (target <= 0 && weights[i] > 0) return i
  }
  return weights.length - 1
}
function normalizeText(text) {
  let value = String(text || '').trim()
  if (!value) return ''
  if (/^[a-z]/.test(value)) value = value[0].toUpperCase() + value.slice(1)
  value = value
    .replace(/\s+/g, ' ')
    .replaceAll('...', ', ')
    .replaceAll('…', ', ')
    .replaceAll(':', ',')
    .replaceAll(' - ', ', ')
    .replaceAll(';', ', ')
    .replaceAll('—', '-')
    .replaceAll('–', '-')
    .replaceAll(' ,', ',')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
  if (!/[.!?\-,]$/.test(value)) value += '.'
  return value
}
async function tokenize(text) {
  const encoded = await tokenizer(text, { truncation: true, max_length: 512 })
  if (!encoded?.input_ids) throw new Error('Tokenizer returned no input_ids')
  const ids = Array.from(encoded.input_ids.data, Number)
  if (!ids.length) throw new Error('Tokenizer produced an empty prompt')
  return ids
}

async function prepareVoice(samples) {
  if (!(samples instanceof Float32Array) || samples.length < SAMPLE_RATE * 5) {
    throw new Error('Leo reference must contain at least 5 seconds of decoded audio')
  }
  if (busy) throw new Error('Warm-session Chatterbox worker is already busy')
  busy = true
  cancelled = false
  const started = performance.now()
  let session = null
  let input = null
  const encodeSegment = async (segment, label, keep) => {
    if (cancelled) throw new DOMException('Cancelled', 'AbortError')
    progress('Encoding Leo', `${label} · ${(segment.length / SAMPLE_RATE).toFixed(1)}s · ${activeThreads} threads`)
    input = new ort.Tensor('float32', segment, [1, segment.length])
    const outputs = await session.run({ audio_values: input })
    disposeTensor(input); input = null
    const ordered = session.outputNames.map((name) => outputs[name])
    if (ordered.length < 4) {
      disposeTensorMap(outputs)
      throw new Error(`Speech encoder returned ${ordered.length} outputs; expected 4`)
    }
    const picked = {}
    if (keep.audioFeatures) picked.audioFeatures = cloneTensor(ordered[0])
    if (keep.audioTokens) picked.audioTokens = cloneTensor(ordered[1])
    if (keep.speakerEmbeddings) picked.speakerEmbeddings = cloneTensor(ordered[2])
    if (keep.speakerFeatures) picked.speakerFeatures = cloneTensor(ordered[3])
    disposeTensorMap(outputs)
    return picked
  }
  try {
    await initRuntime()
    const sourceSeconds = samples.length / SAMPLE_RATE
    const lmSamples = samples.subarray(0, Math.min(samples.length, SAMPLE_RATE * 6))
    const decoderSamples = samples.subarray(0, Math.min(samples.length, SAMPLE_RATE * 10))
    progress('Stage 1/3 · Preparing Leo', `${sourceSeconds.toFixed(1)}s source · full identity, 10s decoder, 6s LM`)
    session = await loadSession('speech_encoder')
    const fullIdentity = await encodeSegment(samples, 'Speaker identity', { speakerEmbeddings: true })
    const decoderPrompt = await encodeSegment(decoderSamples, 'Decoder conditioning', { audioTokens: true, speakerFeatures: true })
    const lmPrompt = await encodeSegment(lmSamples, 'Autoregressive prompt', { audioFeatures: true })
    disposeTensorMap(conditioning)
    conditioning = {
      audioFeatures: lmPrompt.audioFeatures,
      audioTokens: decoderPrompt.audioTokens,
      speakerEmbeddings: fullIdentity.speakerEmbeddings,
      speakerFeatures: decoderPrompt.speakerFeatures,
    }
    await releaseSession(session); session = null
    return {
      referenceSeconds: sourceSeconds,
      identityReferenceSeconds: sourceSeconds,
      decoderPromptSeconds: decoderSamples.length / SAMPLE_RATE,
      lmPromptSeconds: lmSamples.length / SAMPLE_RATE,
      prepareMs: performance.now() - started,
      audioFeatureDims: conditioning.audioFeatures.dims,
      promptTokenCount: conditioning.audioTokens.data.length,
      threads: activeThreads,
    }
  } finally {
    disposeTensor(input)
    await releaseSession(session)
    busy = false
  }
}

async function generateTokensWithSessions(text, settings, embedSession, lmSession, runIndex) {
  const started = performance.now()
  let kv = null
  const generated = [START_SPEECH_TOKEN]
  let reachedEos = false
  const cfgWeight = settings.cfgWeight ?? 0
  const batchSize = cfgWeight > 0 ? 2 : 1
  const maxNewTokens = Math.max(32, Math.min(384, Number(settings.maxNewTokens) || 256))
  try {
    const ids = await tokenize(text)
    let nextInputIds = ids
    let attentionLength = 0
    for (let step = 0; step < maxNewTokens; step++) {
      if (cancelled) throw new DOMException('Cancelled', 'AbortError')
      const idsTensor = int64Tensor(nextInputIds, [1, nextInputIds.length])
      const positionValues = step === 0
        ? nextInputIds.map((id, i) => id >= START_SPEECH_TOKEN ? 0 : Math.max(0, i - 1))
        : [step]
      const positionTensor = int64Tensor(positionValues, [1, positionValues.length])
      const exaggerationTensor = float32Tensor([settings.exaggeration ?? 0.5], [1])
      const embedFeeds = { input_ids: idsTensor }
      if (embedSession.inputNames.includes('position_ids')) embedFeeds.position_ids = positionTensor
      if (embedSession.inputNames.includes('exaggeration')) embedFeeds.exaggeration = exaggerationTensor
      const embedOutputs = await embedSession.run(embedFeeds)
      disposeTensor(idsTensor); disposeTensor(positionTensor); disposeTensor(exaggerationTensor)
      const rawEmbedding = embedOutputs[embedSession.outputNames[0]]
      let lmEmbedding
      if (step === 0) {
        lmEmbedding = concatFirstPass(conditioning.audioFeatures, rawEmbedding, cfgWeight)
        attentionLength = lmEmbedding.dims[1]
        kv = emptyKvCache(batchSize)
      } else {
        lmEmbedding = duplicateSpeechEmbedding(rawEmbedding, batchSize)
        attentionLength += 1
      }
      disposeTensor(rawEmbedding)
      const attentionMask = int64Tensor(new Array(batchSize * attentionLength).fill(1), [batchSize, attentionLength])
      const lmOutputs = await lmSession.run({ inputs_embeds: lmEmbedding, attention_mask: attentionMask, ...kv })
      disposeTensor(lmEmbedding); disposeTensor(attentionMask)
      const oldKv = kv
      kv = {}
      const logitsTensor = lmOutputs[lmSession.outputNames[0]]
      const guided = applyCfg(lastBatchLogits(logitsTensor), cfgWeight)
      const penalized = applyRepetitionPenalty(guided, generated, settings.repetitionPenalty ?? 1.2)
      const token = sampleToken(penalized, { temperature: settings.temperature ?? 0.9, minP: settings.minP ?? 0.05 })
      generated.push(token)
      const cacheNames = Object.keys(oldKv)
      for (let i = 0; i < cacheNames.length; i++) {
        const output = lmOutputs[lmSession.outputNames[i + 1]]
        if (!output) throw new Error(`Language model KV output ${i + 1} was missing`)
        kv[cacheNames[i]] = output
      }
      disposeTensorMap(oldKv); disposeTensor(logitsTensor)
      if (step % 10 === 0 || token === STOP_SPEECH_TOKEN) {
        progress(`Token run ${runIndex}`, `${step + 1}/${maxNewTokens}`)
      }
      if (token === STOP_SPEECH_TOKEN) { reachedEos = true; break }
      nextInputIds = [token]
    }
    const audioTokens = reachedEos ? generated.slice(1, -1) : generated.slice(1)
    return { audioTokens, reachedEos, inferenceMs: performance.now() - started }
  } finally {
    disposeTensorMap(kv)
  }
}

async function decodeWithSession(generatedTokens, decoderSession, runIndex) {
  const started = performance.now()
  let speechTokens = null
  try {
    const prompt = Array.from(conditioning.audioTokens.data, Number)
    const all = [...prompt, ...generatedTokens, SILENCE_TOKEN, SILENCE_TOKEN, SILENCE_TOKEN]
    speechTokens = int64Tensor(all, [1, all.length])
    progress(`Decoder run ${runIndex}`, `${generatedTokens.length} new speech tokens`)
    const outputs = await decoderSession.run({
      speech_tokens: speechTokens,
      speaker_embeddings: conditioning.speakerEmbeddings,
      speaker_features: conditioning.speakerFeatures,
    })
    const waveformTensor = outputs[decoderSession.outputNames[0]]
    const waveform = Float32Array.from(waveformTensor.data, Number)
    disposeTensorMap(outputs)
    return { waveform, inferenceMs: performance.now() - started }
  } finally {
    disposeTensor(speechTokens)
  }
}

async function benchmarkWarm(texts, options = {}) {
  if (!conditioning) throw new Error('Prepare Leo first')
  if (busy) throw new Error('Warm-session Chatterbox worker is already busy')
  const cleaned = (Array.isArray(texts) ? texts : []).map(normalizeText)
  if (cleaned.length !== 2 || cleaned.some((text) => !text || text.length > MAX_TEXT_CHARS)) {
    throw new Error('Warm benchmark requires exactly two non-empty texts of 200 characters or fewer')
  }
  busy = true
  cancelled = false
  const started = performance.now()
  const settings = {
    temperature: 0.9,
    exaggeration: 0.5,
    cfgWeight: 0,
    repetitionPenalty: 1.2,
    minP: 0.05,
    maxNewTokens: 256,
    ...options,
  }
  let embedSession = null
  let lmSession = null
  let decoderSession = null
  try {
    progress('Stage 2/3 · Warm token batch', 'Loading embed + Q4 LM once for both chunks')
    const tokenLoadStart = performance.now()
    embedSession = await loadSession('embed_tokens')
    lmSession = await loadSession('language_model')
    const tokenSessionLoadMs = performance.now() - tokenLoadStart

    const tokenRuns = []
    for (let i = 0; i < cleaned.length; i++) {
      const result = await generateTokensWithSessions(cleaned[i], settings, embedSession, lmSession, i + 1)
      tokenRuns.push({
        audioTokens: result.audioTokens,
        reachedEos: result.reachedEos,
        inferenceMs: result.inferenceMs,
        generatedTokens: result.audioTokens.length,
        chars: cleaned[i].length,
      })
    }
    progress('Releasing warm token models', 'Both speech-token sequences are now small in-memory arrays')
    await releaseSession(lmSession); lmSession = null
    await releaseSession(embedSession); embedSession = null

    progress('Stage 3/3 · Warm decoder batch', 'Loading full decoder once for both chunks')
    const decoderLoadStart = performance.now()
    decoderSession = await loadSession('conditional_decoder')
    const decoderSessionLoadMs = performance.now() - decoderLoadStart

    const decoderRuns = []
    const outputs = []
    for (let i = 0; i < tokenRuns.length; i++) {
      const decoded = await decodeWithSession(tokenRuns[i].audioTokens, decoderSession, i + 1)
      decoderRuns.push({
        inferenceMs: decoded.inferenceMs,
        audioDuration: decoded.waveform.length / SAMPLE_RATE,
      })
      outputs.push({ waveform: decoded.waveform.buffer, sampleRate: SAMPLE_RATE })
    }
    await releaseSession(decoderSession); decoderSession = null

    return {
      totalMs: performance.now() - started,
      tokenSessionLoadMs,
      decoderSessionLoadMs,
      tokenRuns: tokenRuns.map(({ audioTokens, ...rest }) => rest),
      decoderRuns,
      outputs,
      threads: activeThreads,
      settings,
    }
  } finally {
    await releaseSession(lmSession)
    await releaseSession(embedSession)
    await releaseSession(decoderSession)
    busy = false
  }
}

async function reset() {
  cancelled = true
  disposeTensorMap(conditioning)
  conditioning = null
  return { ok: true }
}

self.onmessage = async (event) => {
  const { id, type, payload = {} } = event.data || {}
  if (type === 'cancel') { cancelled = true; return }
  try {
    let result
    if (type === 'init') result = await initRuntime()
    else if (type === 'prepare') result = await prepareVoice(payload.samples)
    else if (type === 'benchmark') {
      result = await benchmarkWarm(payload.texts, payload.options || {})
      const transfer = result.outputs.map((item) => item.waveform)
      self.postMessage({ type: 'result', id, result }, transfer)
      return
    } else if (type === 'reset') result = await reset()
    else throw new Error(`Unknown worker command: ${type}`)
    self.postMessage({ type: 'result', id, result })
  } catch (error) {
    self.postMessage({ type: 'error', id, error: toError(error) })
  }
}
