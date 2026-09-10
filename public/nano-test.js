const VOICE_CACHES = ['epub-player-pocket-voices-v2', 'epub-player-pocket-voices-v1']
const VOICE_PATHS = ['/__epubplayer/pocket/voices/leo-reference-v2', '/__epubplayer/pocket/voices/leo']
const SAMPLE_RATE = 24000
const REFERENCE_SECONDS = 12
const TEST_TEXT = 'She folded the letter carefully, then looked toward the window as rain tapped softly against the glass.'
const STRESS_TEXTS = [
  'The hallway was quiet except for the soft ticking of the clock near the stairs.',
  'He turned the page slowly, trying not to lose the thought that had followed him home.',
  'Outside, the rain had softened to a mist and the streetlights blurred against the pavement.',
  'She smiled despite herself, then tucked the old photograph back inside the book.',
  'For a moment neither of them spoke, and the silence felt easier than an explanation.',
  'The train pulled away from the platform while the city disappeared behind a curtain of rain.',
  'He reached for his coat, paused at the doorway, and glanced back as though he had forgotten something.',
  'Morning arrived slowly, pale light gathering at the edges of the curtains before the room woke.',
  'She read the sentence twice, not because it was difficult, but because she wanted to hear it again.',
  'By the time they reached the corner, the clouds had broken and a thin strip of blue showed above them.',
]

const $ = (id) => document.getElementById(id)
const state = {
  worker: null,
  nextId: 1,
  pending: new Map(),
  referenceBlob: null,
  modelLoaded: false,
  voicePrepared: false,
  backend: null,
  loadResult: null,
  prepareResult: null,
  generationResult: null,
  stressResults: [],
  errors: [],
  startedAt: null,
  audioUrl: null,
}

function log(message, kind = 'info') {
  const row = document.createElement('div')
  row.className = `log-row ${kind}`
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  row.textContent = `${time}  ${message}`
  $('log').appendChild(row)
  $('log').scrollTop = $('log').scrollHeight
}

function setStatus(title, detail = '') {
  $('status-title').textContent = title
  $('status-detail').textContent = detail
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown'
  const gib = bytes / 1024 ** 3
  if (gib >= 1) return `${gib.toFixed(2)} GiB`
  return `${(bytes / 1024 ** 2).toFixed(0)} MiB`
}

async function storageEstimate() {
  try {
    const result = await navigator.storage?.estimate?.()
    if (!result) return null
    return { usage: result.usage || 0, quota: result.quota || 0 }
  } catch {
    return null
  }
}

async function collectDeviceInfo() {
  const storage = await storageEstimate()
  const memory = navigator.deviceMemory || null
  const cores = navigator.hardwareConcurrency || null
  const gpu = 'gpu' in navigator
  const info = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    cores,
    deviceMemoryGB: memory,
    webGPUExposed: gpu,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    storageUsage: storage?.usage || null,
    storageQuota: storage?.quota || null,
  }
  $('device-info').innerHTML = [
    `<span>iOS/Safari: <strong>${/iPhone|iPad|iPod/.test(navigator.userAgent) ? 'yes' : 'unknown/no'}</strong></span>`,
    `<span>CPU threads exposed: <strong>${cores ?? 'unknown'}</strong></span>`,
    `<span>WebGPU exposed: <strong>${gpu ? 'yes' : 'no'}</strong></span>`,
    `<span>Cross-origin isolated: <strong>${window.crossOriginIsolated ? 'yes' : 'no'}</strong></span>`,
    `<span>SharedArrayBuffer: <strong>${typeof SharedArrayBuffer !== 'undefined' ? 'yes' : 'no'}</strong></span>`,
    `<span>Storage: <strong>${storage ? `${formatBytes(storage.usage)} / ${formatBytes(storage.quota)}` : 'not exposed'}</strong></span>`,
  ].join('')
  return info
}

let deviceInfoPromise = collectDeviceInfo()

async function findSavedLeo() {
  if (!('caches' in window)) {
    $('reference-status').textContent = 'Cache Storage is unavailable here.'
    return null
  }
  for (const cacheName of VOICE_CACHES) {
    try {
      const cache = await caches.open(cacheName)
      for (const path of VOICE_PATHS) {
        const url = new URL(path, window.location.origin).toString()
        const response = await cache.match(url)
        if (response) {
          const blob = await response.blob()
          if (blob.size > 0) {
            state.referenceBlob = blob
            $('reference-status').textContent = `Saved Leo found locally (${formatBytes(blob.size)}).`
            $('reference-status').className = 'ok'
            $('prepare-button').disabled = !state.modelLoaded
            log(`Found saved Leo in ${cacheName}. The reference remains local.`)
            return blob
          }
        }
      }
    } catch (error) {
      log(`Could not inspect ${cacheName}: ${error.message || error}`, 'warn')
    }
  }
  $('reference-status').textContent = 'Saved Leo was not found on this origin. Choose the Leo audio file below.'
  $('reference-status').className = 'warn'
  return null
}

function resample(data, sourceRate, targetRate) {
  if (sourceRate === targetRate) return data.slice()
  const ratio = sourceRate / targetRate
  const out = new Float32Array(Math.max(1, Math.floor(data.length / ratio)))
  for (let i = 0; i < out.length; i++) {
    const position = i * ratio
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, data.length - 1)
    const fraction = position - lower
    out[i] = data[lower] * (1 - fraction) + data[upper] * fraction
  }
  return out
}

function normalizeReference(input) {
  const out = input.slice()
  if (!out.length) return out
  let mean = 0
  for (const value of out) mean += value
  mean /= out.length
  let peak = 0
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean
    peak = Math.max(peak, Math.abs(out[i]))
  }
  if (peak > 0.05) {
    const gain = Math.min(4, 0.7 / peak)
    for (let i = 0; i < out.length; i++) out[i] *= gain
  }
  return out
}

function selectRepresentativeWindow(input, sampleRate, seconds) {
  const windowSamples = Math.min(input.length, Math.max(1, Math.floor(sampleRate * seconds)))
  if (input.length <= windowSamples) return input.slice()
  const blockSamples = Math.max(1, Math.floor(sampleRate * 0.25))
  const blockCount = Math.ceil(input.length / blockSamples)
  const energies = new Float64Array(blockCount)
  for (let block = 0; block < blockCount; block++) {
    const start = block * blockSamples
    const end = Math.min(input.length, start + blockSamples)
    let sumSquares = 0
    for (let i = start; i < end; i++) sumSquares += input[i] * input[i]
    energies[block] = sumSquares / Math.max(1, end - start)
  }
  const windowBlocks = Math.max(1, Math.ceil(windowSamples / blockSamples))
  let running = 0
  for (let i = 0; i < windowBlocks; i++) running += energies[i] || 0
  let bestScore = running
  let bestBlock = 0
  for (let block = 1; block + windowBlocks <= blockCount; block++) {
    running += energies[block + windowBlocks - 1] - energies[block - 1]
    if (running > bestScore) {
      bestScore = running
      bestBlock = block
    }
  }
  const start = Math.min(bestBlock * blockSamples, input.length - windowSamples)
  return input.slice(start, start + windowSamples)
}

async function decodeReference(blob) {
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) throw new Error('Web Audio is unavailable on this device')
  const context = new Ctor()
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer())
    const mono = new Float32Array(buffer.length)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const source = buffer.getChannelData(channel)
      for (let i = 0; i < source.length; i++) mono[i] += source[i] / buffer.numberOfChannels
    }
    const normalized = normalizeReference(resample(mono, buffer.sampleRate, SAMPLE_RATE))
    const selected = selectRepresentativeWindow(normalized, SAMPLE_RATE, REFERENCE_SECONDS)
    if (selected.length < SAMPLE_RATE * 5) throw new Error('Reference is shorter than 5 seconds')
    return selected
  } finally {
    await context.close().catch(() => {})
  }
}

function workerCall(type, payload = {}, transfer = []) {
  if (!state.worker) return Promise.reject(new Error('Worker is not running'))
  const id = state.nextId++
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject })
    state.worker.postMessage({ id, type, payload }, transfer)
  })
}

function handleWorkerMessage(event) {
  const message = event.data || {}
  if (message.type === 'progress') {
    setStatus(message.status || 'Working…', message.detail || '')
    log(`${message.status || 'Progress'}${message.detail ? ` — ${message.detail}` : ''}`)
    return
  }
  const pending = state.pending.get(message.id)
  if (!pending) return
  state.pending.delete(message.id)
  if (message.type === 'error') pending.reject(new Error(message.error || 'Worker error'))
  else pending.resolve(message.result)
}

function ensureWorker() {
  if (state.worker) return state.worker
  const worker = new Worker(`/nano-test-worker.js?v=20260910b`, { type: 'module', name: 'chatterbox-nano-diagnostic' })
  worker.onmessage = handleWorkerMessage
  worker.onerror = (event) => {
    const error = new Error(event.message || 'Nano worker crashed')
    state.errors.push(error.message)
    log(error.message, 'error')
    for (const { reject } of state.pending.values()) reject(error)
    state.pending.clear()
  }
  state.worker = worker
  return worker
}

function setBusy(isBusy) {
  document.body.classList.toggle('busy', isBusy)
  $('backend').disabled = isBusy || state.modelLoaded
  $('load-button').disabled = isBusy || state.modelLoaded
  $('prepare-button').disabled = isBusy || !state.modelLoaded || !state.referenceBlob
  $('generate-button').disabled = isBusy || !state.voicePrepared
  $('stress-button').disabled = isBusy || !state.voicePrepared
  $('reset-button').disabled = isBusy && !state.worker
}

function updateElapsed(started) {
  state.startedAt = started
  const tick = () => {
    if (state.startedAt !== started) return
    $('elapsed').textContent = `${((performance.now() - started) / 1000).toFixed(1)}s`
    requestAnimationFrame(tick)
  }
  tick()
}

function stopElapsed() {
  state.startedAt = null
}

function recordError(error) {
  const text = error?.message || String(error)
  state.errors.push(text)
  setStatus('Stopped with an error', text)
  log(text, 'error')
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
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const sample = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

async function loadModel() {
  setBusy(true)
  const backend = $('backend').value
  ensureWorker()
  const started = performance.now()
  updateElapsed(started)
  localStorage.setItem('nanoDiagnosticInProgress', JSON.stringify({ phase: 'model-load', backend, startedAt: Date.now() }))
  try {
    setStatus('Starting Nano', `${backend.toUpperCase()} backend`)
    const before = await storageEstimate()
    const result = await workerCall('load', { backend })
    const after = await storageEstimate()
    state.modelLoaded = true
    state.backend = result.backend
    state.loadResult = { ...result, storageBefore: before, storageAfter: after }
    $('model-result').textContent = `Loaded in ${(result.loadMs / 1000).toFixed(1)}s · ${result.backend.toUpperCase()} · published weights ~${result.modelMiB.toFixed(0)} MiB`
    $('model-result').className = 'result ok'
    setStatus('Nano model loaded', 'Now prepare Leo.')
    log(`Nano loaded successfully in ${(result.loadMs / 1000).toFixed(1)}s.`, 'ok')
    localStorage.removeItem('nanoDiagnosticInProgress')
  } catch (error) {
    recordError(error)
  } finally {
    stopElapsed()
    setBusy(false)
  }
}

async function prepareLeo() {
  if (!state.referenceBlob) return
  setBusy(true)
  const started = performance.now()
  updateElapsed(started)
  localStorage.setItem('nanoDiagnosticInProgress', JSON.stringify({ phase: 'prepare-leo', startedAt: Date.now() }))
  try {
    setStatus('Decoding Leo locally', 'Selecting a speech-dense 12-second window.')
    const samples = await decodeReference(state.referenceBlob)
    log(`Prepared ${(samples.length / SAMPLE_RATE).toFixed(1)}s PCM reference locally.`)
    const result = await workerCall('prepare', { samples }, [samples.buffer])
    state.voicePrepared = true
    state.prepareResult = result
    $('voice-result').textContent = `Leo prepared in ${(result.prepareMs / 1000).toFixed(1)}s · ${result.promptTokenCount} prompt speech tokens`
    $('voice-result').className = 'result ok'
    setStatus('Leo is ready', 'Generate one sentence before trying the stress test.')
    log(`Leo conditioning completed in ${(result.prepareMs / 1000).toFixed(1)}s.`, 'ok')
    localStorage.removeItem('nanoDiagnosticInProgress')
  } catch (error) {
    recordError(error)
  } finally {
    stopElapsed()
    setBusy(false)
  }
}

async function generateOne() {
  setBusy(true)
  const text = $('test-text').value.trim()
  const started = performance.now()
  updateElapsed(started)
  localStorage.setItem('nanoDiagnosticInProgress', JSON.stringify({ phase: 'single-generation', startedAt: Date.now() }))
  try {
    setStatus('Generating one sentence', `${text.length} characters`)
    const result = await workerCall('generate', { text, keepAudio: true })
    const samples = result.waveform
    if (!(samples instanceof Float32Array)) throw new Error('Worker returned no playable waveform')
    if (state.audioUrl) URL.revokeObjectURL(state.audioUrl)
    state.audioUrl = URL.createObjectURL(wavBlob(samples, result.sampleRate))
    $('audio').src = state.audioUrl
    $('audio-wrap').hidden = false
    const rtf = result.audioDuration > 0 ? (result.generationMs / 1000) / result.audioDuration : null
    state.generationResult = { ...result, waveform: undefined, rtf }
    $('generation-result').textContent = `${(result.generationMs / 1000).toFixed(1)}s generation → ${result.audioDuration.toFixed(1)}s audio · RTF ${rtf?.toFixed(2) ?? '?'}× · ${result.generatedTokens} tokens${result.reachedEos ? '' : ' · token limit reached'}`
    $('generation-result').className = `result ${result.reachedEos ? 'ok' : 'warn'}`
    setStatus('Generation finished', 'Play the sample and judge Leo before stressing the phone.')
    log(`Generated ${result.audioDuration.toFixed(1)}s of audio in ${(result.generationMs / 1000).toFixed(1)}s (RTF ${rtf?.toFixed(2)}×).`, 'ok')
    localStorage.removeItem('nanoDiagnosticInProgress')
  } catch (error) {
    recordError(error)
  } finally {
    stopElapsed()
    setBusy(false)
  }
}

function summarizeStress(results) {
  if (!results.length) return null
  const rtfs = results.map((row) => row.rtf).filter(Number.isFinite)
  const times = results.map((row) => row.generationMs)
  const averageRtf = rtfs.reduce((a, b) => a + b, 0) / rtfs.length
  const averageSeconds = times.reduce((a, b) => a + b, 0) / times.length / 1000
  const sorted = [...rtfs].sort((a, b) => a - b)
  const medianRtf = sorted[Math.floor(sorted.length / 2)]
  return { averageRtf, medianRtf, averageSeconds }
}

async function runStress() {
  setBusy(true)
  state.stressResults = []
  const started = performance.now()
  updateElapsed(started)
  try {
    for (let i = 0; i < STRESS_TEXTS.length; i++) {
      const marker = { phase: 'stress', step: i + 1, total: STRESS_TEXTS.length, startedAt: Date.now() }
      localStorage.setItem('nanoDiagnosticInProgress', JSON.stringify(marker))
      setStatus(`Stress test ${i + 1}/${STRESS_TEXTS.length}`, `${STRESS_TEXTS[i].length} characters`)
      const result = await workerCall('generate', { text: STRESS_TEXTS[i], keepAudio: false })
      const rtf = result.audioDuration > 0 ? (result.generationMs / 1000) / result.audioDuration : null
      state.stressResults.push({ index: i + 1, ...result, rtf })
      $('stress-progress').textContent = `${i + 1}/${STRESS_TEXTS.length} · last RTF ${rtf?.toFixed(2) ?? '?'}×`
      log(`Stress ${i + 1}/10: ${(result.generationMs / 1000).toFixed(1)}s → ${result.audioDuration.toFixed(1)}s (RTF ${rtf?.toFixed(2)}×).`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const summary = summarizeStress(state.stressResults)
    const storage = await storageEstimate()
    $('stress-result').textContent = `Completed all 10 · average RTF ${summary.averageRtf.toFixed(2)}× · median ${summary.medianRtf.toFixed(2)}× · average generation ${summary.averageSeconds.toFixed(1)}s`
    $('stress-result').className = 'result ok'
    state.stressSummary = { ...summary, storageAfter: storage }
    setStatus('Stress test passed', 'The page survived 10 consecutive Nano generations.')
    log('All 10 stress generations completed without a page reload.', 'ok')
    localStorage.removeItem('nanoDiagnosticInProgress')
  } catch (error) {
    recordError(error)
  } finally {
    stopElapsed()
    setBusy(false)
  }
}

async function buildReport() {
  const info = await deviceInfoPromise
  const previous = $('previous-run').dataset.previous || null
  const report = {
    test: 'EPUB Player Chatterbox Nano iPhone diagnostic',
    timestamp: new Date().toISOString(),
    page: location.href,
    device: info,
    previousInterruptedRun: previous ? JSON.parse(previous) : null,
    backend: state.backend || $('backend').value,
    model: state.loadResult ? {
      loadSeconds: Number((state.loadResult.loadMs / 1000).toFixed(2)), modelMiB: state.loadResult.modelMiB,
      storageBefore: state.loadResult.storageBefore, storageAfter: state.loadResult.storageAfter,
    } : null,
    leo: state.prepareResult ? {
      referenceSeconds: state.prepareResult.referenceSeconds,
      prepareSeconds: Number((state.prepareResult.prepareMs / 1000).toFixed(2)), promptTokenCount: state.prepareResult.promptTokenCount,
    } : null,
    singleGeneration: state.generationResult ? {
      seconds: Number((state.generationResult.generationMs / 1000).toFixed(2)),
      audioSeconds: Number(state.generationResult.audioDuration.toFixed(2)), rtf: Number(state.generationResult.rtf.toFixed(3)),
      generatedTokens: state.generationResult.generatedTokens, reachedEos: state.generationResult.reachedEos,
    } : null,
    stress: state.stressResults.map((row) => ({
      index: row.index, seconds: Number((row.generationMs / 1000).toFixed(2)), audioSeconds: Number(row.audioDuration.toFixed(2)),
      rtf: Number(row.rtf.toFixed(3)), tokens: row.generatedTokens, reachedEos: row.reachedEos,
    })),
    errors: state.errors,
  }
  return JSON.stringify(report, null, 2)
}

async function copyReport() {
  try {
    const report = await buildReport()
    await navigator.clipboard.writeText(report)
    $('copy-button').textContent = 'Copied — paste it into ChatGPT'
    setTimeout(() => { $('copy-button').textContent = 'Copy diagnostic report' }, 2500)
  } catch (error) {
    recordError(error)
  }
}

function resetTest() {
  if (state.worker) {
    try { state.worker.postMessage({ type: 'cancel' }) } catch {}
    state.worker.terminate()
  }
  for (const { reject } of state.pending.values()) reject(new Error('Diagnostic reset'))
  state.pending.clear()
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl)
  localStorage.removeItem('nanoDiagnosticInProgress')
  location.reload()
}

$('file-input').addEventListener('change', () => {
  const file = $('file-input').files?.[0]
  if (!file) return
  state.referenceBlob = file
  $('reference-status').textContent = `Using ${file.name} (${formatBytes(file.size)}). It will stay on this device.`
  $('reference-status').className = 'ok'
  $('prepare-button').disabled = !state.modelLoaded
  log(`Selected local reference file: ${file.name}`)
})

$('load-button').addEventListener('click', loadModel)
$('prepare-button').addEventListener('click', prepareLeo)
$('generate-button').addEventListener('click', generateOne)
$('stress-button').addEventListener('click', runStress)
$('copy-button').addEventListener('click', copyReport)
$('reset-button').addEventListener('click', resetTest)
$('test-text').value = TEST_TEXT

const previousMarker = localStorage.getItem('nanoDiagnosticInProgress')
if (previousMarker) {
  try {
    const parsed = JSON.parse(previousMarker)
    $('previous-run').hidden = false
    $('previous-run').dataset.previous = JSON.stringify(parsed)
    $('previous-run').textContent = `A previous ${parsed.phase || 'Nano'} test stopped before it cleared its marker${parsed.step ? ` at stress chunk ${parsed.step}/${parsed.total}` : ''}. If you did not close or reload the page yourself, Safari may have killed/reloaded it.`
    log('Detected an interrupted previous diagnostic run.', 'warn')
  } catch {}
  localStorage.removeItem('nanoDiagnosticInProgress')
}

findSavedLeo()
setBusy(false)
