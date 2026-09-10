const SAMPLE_RATE = 24000
const MAX_REFERENCE_SECONDS = 45
const MAX_TEXT_CHARS = 200
const TEST_TEXT = 'He looked out the window for a moment, then smiled to himself. The rain had finally stopped, and the street below was beginning to shine.'

const $ = (id) => document.getElementById(id)
const state = {
  worker: null,
  referenceFile: null,
  referenceUrl: null,
  outputUrl: null,
  modelLoaded: false,
  voicePrepared: false,
  loadResult: null,
  prepareResult: null,
  generationResult: null,
  errors: [],
  startedAt: null,
}

function log(message, kind = 'info') {
  const row = document.createElement('div')
  row.className = `log-row ${kind}`
  const time = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  row.textContent = `${time}  ${message}`
  $('log').appendChild(row)
  $('log').scrollTop = $('log').scrollHeight
}

function setStatus(title, detail = '') {
  $('status-title').textContent = title
  $('status-detail').textContent = detail
}

function setBusy(value) {
  document.body.classList.toggle('busy', value)
  $('load-button').disabled = value || state.modelLoaded
  $('prepare-button').disabled = value || !state.modelLoaded || !state.referenceFile
  $('generate-button').disabled = value || !state.voicePrepared
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown'
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(2)} GiB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`
}

async function storageEstimate() {
  try {
    return await navigator.storage?.estimate?.()
  } catch {
    return null
  }
}

async function deviceInfo() {
  const storage = await storageEstimate()
  const values = [
    ['iPhone/iPad', /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'yes' : 'unknown/no'],
    ['CPU threads exposed', navigator.hardwareConcurrency || 'unknown'],
    ['WebGPU exposed', 'gpu' in navigator ? 'yes' : 'no'],
    ['Cross-origin isolated', window.crossOriginIsolated ? 'yes' : 'no'],
    [
      'Storage',
      storage
        ? `${formatBytes(storage.usage || 0)} / ${formatBytes(storage.quota || 0)}`
        : 'not exposed',
    ],
  ]
  $('device-info').innerHTML = values
    .map(([label, value]) => `<span><span>${label}</span><strong>${value}</strong></span>`)
    .join('')
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    webGPUExposed: 'gpu' in navigator,
    crossOriginIsolated: window.crossOriginIsolated,
    storageUsage: storage?.usage || null,
    storageQuota: storage?.quota || null,
  }
}

const deviceInfoPromise = deviceInfo()

function marker(value) {
  if (value) localStorage.setItem('fullChatterboxDiagnosticInProgress', JSON.stringify(value))
  else localStorage.removeItem('fullChatterboxDiagnosticInProgress')
}

function startTimer(phase) {
  const started = performance.now()
  state.startedAt = started
  const tick = () => {
    if (state.startedAt !== started) return
    $('elapsed').textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`
    requestAnimationFrame(tick)
  }
  tick()
  marker({ phase, startedAt: Date.now() })
  return started
}

function stopTimer() {
  state.startedAt = null
  marker(null)
}

function workerUrl() {
  const url = new URL('/chatterbox-full-test-worker.js', location.origin)
  url.searchParams.set('v', '20260910-full-a')
  const preview = new URLSearchParams(location.search).get('_preview')
  if (preview) url.searchParams.set('_preview', preview)
  return url.href
}

function ensureWorker() {
  if (state.worker) return state.worker
  const worker = new Worker(workerUrl(), {
    type: 'module',
    name: 'chatterbox-full-iphone-diagnostic',
  })
  worker.addEventListener('message', handleWorkerMessage)
  worker.addEventListener('error', (event) => {
    fail(new Error(event.message || 'Full Chatterbox worker crashed'))
  })
  state.worker = worker
  return worker
}

function handleWorkerMessage(event) {
  const { type, data = {} } = event.data || {}

  if (type === 'status') {
    setStatus(data.title || 'Working…', data.detail || '')
    log(`${data.title || 'Working'}${data.detail ? ` — ${data.detail}` : ''}`)
    return
  }

  if (type === 'load:progress') {
    const file = data.file || data.name || ''
    const pct = Number.isFinite(data.progress) ? Math.round(data.progress) : null
    setStatus(
      'Downloading full Chatterbox',
      `${file || data.status || 'model files'}${pct == null ? '' : ` · ${pct}%`}`,
    )
    return
  }

  if (type === 'load:complete') {
    state.modelLoaded = true
    state.loadResult = data
    $('model-result').textContent = `Loaded locally in ${(data.loadMs / 1000).toFixed(1)}s using ${String(data.device || 'wasm').toUpperCase()}.`
    $('model-result').className = 'result ok'
    setStatus('Full Chatterbox loaded', 'Now encode Leo.')
    log('Full Chatterbox model loaded.', 'ok')
    stopTimer()
    setBusy(false)
    return
  }

  if (type === 'prepare:complete') {
    state.voicePrepared = true
    state.prepareResult = data
    $('voice-result').textContent = `Leo encoded from ${data.referenceSeconds.toFixed(1)}s of local audio in ${(data.prepareMs / 1000).toFixed(1)}s.`
    $('voice-result').className = 'result ok'
    setStatus('Leo is ready', 'Generate the 200-character test.')
    log('Leo speaker conditioning completed.', 'ok')
    stopTimer()
    setBusy(false)
    return
  }

  if (type === 'generate:complete') {
    const samples = new Float32Array(data.waveform)
    if (state.outputUrl) URL.revokeObjectURL(state.outputUrl)
    state.outputUrl = URL.createObjectURL(wavBlob(samples, data.sampleRate || SAMPLE_RATE))
    $('output-audio').src = state.outputUrl
    $('output-wrap').hidden = false
    const rtf = data.audioDuration > 0
      ? (data.generationMs / 1000) / data.audioDuration
      : null
    state.generationResult = { ...data, waveform: undefined, rtf }
    $('generation-result').textContent =
      `${(data.generationMs / 1000).toFixed(1)}s generation → ${data.audioDuration.toFixed(1)}s audio` +
      `${rtf == null ? '' : ` · RTF ${rtf.toFixed(2)}×`}`
    $('generation-result').className = 'result ok'
    setStatus('Generation finished', 'Listen for Leo identity and end-of-clip drift.')
    log('Full Chatterbox generation finished.', 'ok')
    stopTimer()
    setBusy(false)
    return
  }

  if (type === 'error') {
    fail(new Error(data.message || 'Full Chatterbox failed'))
  }
}

function fail(error) {
  const message = error?.message || String(error)
  state.errors.push(message)
  setStatus('Stopped with an error', message)
  log(message, 'error')
  state.startedAt = null
  setBusy(false)
}

async function decodeReference(file) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) throw new Error('Web Audio is unavailable')
  const ctx = new AudioContextCtor()
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
    const duration = Math.min(decoded.duration, MAX_REFERENCE_SECONDS)
    const numSamples = Math.max(1, Math.round(duration * SAMPLE_RATE))
    const offline = new OfflineAudioContext(1, numSamples, SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start(0, 0, duration)
    const rendered = await offline.startRendering()
    const mono = rendered.getChannelData(0)
    const copy = new Float32Array(mono.length)
    copy.set(mono)
    return copy
  } finally {
    await ctx.close().catch(() => {})
  }
}

function wavBlob(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let offset = 44
  for (const raw of samples) {
    const sample = Math.max(-1, Math.min(1, raw))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

async function loadModel() {
  setBusy(true)
  startTimer('full-model-load')
  setStatus('Starting full Chatterbox', 'WASM baseline on iPhone.')
  ensureWorker().postMessage({ type: 'load', data: { device: 'wasm' } })
}

async function prepareLeo() {
  if (!state.referenceFile) return
  setBusy(true)
  startTimer('full-prepare-leo')
  try {
    setStatus('Decoding Leo', `Using up to ${MAX_REFERENCE_SECONDS}s of the selected recording.`)
    const samples = await decodeReference(state.referenceFile)
    log(`Decoded ${(samples.length / SAMPLE_RATE).toFixed(1)}s of Leo at 24 kHz.`)
    ensureWorker().postMessage(
      { type: 'prepare', data: { audioData: samples.buffer } },
      [samples.buffer],
    )
  } catch (error) {
    fail(error)
  }
}

function generate() {
  const text = $('test-text').value.replace(/\s+/g, ' ').trim()
  if (!text) return
  if (text.length > MAX_TEXT_CHARS) {
    fail(new Error(`Keep this test at ${MAX_TEXT_CHARS} characters or fewer`))
    return
  }
  setBusy(true)
  startTimer('full-generate')
  ensureWorker().postMessage({ type: 'generate', data: { text } })
}

async function copyReport() {
  const report = {
    test: 'Full Chatterbox browser iPhone diagnostic',
    timestamp: new Date().toISOString(),
    device: await deviceInfoPromise,
    settings: {
      maxTextChars: MAX_TEXT_CHARS,
      temperature: 0.9,
      exaggeration: 0.5,
      cfgWeight: 'not exposed by Transformers.js 4.2.0 browser implementation',
      repetitionPenalty: 1.2,
      topP: 1.0,
      maxReferenceSeconds: MAX_REFERENCE_SECONDS,
    },
    model: state.loadResult,
    leo: state.prepareResult,
    generation: state.generationResult,
    errors: state.errors,
  }
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
  $('copy-button').textContent = 'Copied — paste into ChatGPT'
  setTimeout(() => {
    $('copy-button').textContent = 'Copy diagnostic report'
  }, 2500)
}

function reset() {
  try {
    state.worker?.terminate()
  } catch {}
  if (state.referenceUrl) URL.revokeObjectURL(state.referenceUrl)
  if (state.outputUrl) URL.revokeObjectURL(state.outputUrl)
  marker(null)
  location.reload()
}

$('file-input').addEventListener('change', () => {
  const file = $('file-input').files?.[0]
  if (!file) return
  state.referenceFile = file
  if (state.referenceUrl) URL.revokeObjectURL(state.referenceUrl)
  state.referenceUrl = URL.createObjectURL(file)
  $('reference-audio').src = state.referenceUrl
  $('reference-wrap').hidden = false
  $('reference-status').textContent = `Using ${file.name} (${formatBytes(file.size)}). Audio stays on this device.`
  $('reference-status').className = 'ok'
  $('prepare-button').disabled = !state.modelLoaded
})

$('test-text').value = TEST_TEXT
$('char-count').textContent = `${TEST_TEXT.length}/${MAX_TEXT_CHARS}`
$('test-text').addEventListener('input', () => {
  $('char-count').textContent = `${$('test-text').value.length}/${MAX_TEXT_CHARS}`
})
$('load-button').addEventListener('click', loadModel)
$('prepare-button').addEventListener('click', prepareLeo)
$('generate-button').addEventListener('click', generate)
$('copy-button').addEventListener('click', copyReport)
$('reset-button').addEventListener('click', reset)

const previousMarker = localStorage.getItem('fullChatterboxDiagnosticInProgress')
if (previousMarker) {
  try {
    const previous = JSON.parse(previousMarker)
    $('previous-run').hidden = false
    $('previous-run').textContent =
      `A previous ${previous.phase || 'full Chatterbox'} test stopped before completion. ` +
      'If you did not close or reload the page, Safari may have terminated it.'
    log('Detected an interrupted previous full-model test.', 'warn')
  } catch {}
  marker(null)
}

setBusy(false)
