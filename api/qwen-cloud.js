const REPLICATE_BASE = 'https://api.replicate.com/v1'
const WHISPER_VERSION = 'openai/whisper:8099696689d249cf8b122d833c36ac3f75505c666a395ca40ef26f68e7d3d16e'
const QWEN_MODEL_URL = `${REPLICATE_BASE}/models/qwen/qwen3-tts/predictions`

const MAX_REFERENCE_CHARS = 900_000
const MAX_TEXT_CHARS = 900
const MAX_WAIT_MS = 52_000

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function getToken(request) {
  const auth = request.headers.get('authorization') || ''
  if (!auth.toLowerCase().startsWith('bearer ')) return ''
  return auth.slice(7).trim()
}

async function replicateFetch(url, token, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  })
}

async function readReplicateError(response) {
  try {
    const data = await response.json()
    return data?.detail || data?.error || JSON.stringify(data)
  } catch {
    return `Replicate returned HTTP ${response.status}`
  }
}

async function createPrediction(url, token, body) {
  // Async creation keeps the Vercel request responsive; we poll the prediction
  // ourselves below and stay inside the function timeout.
  const response = await replicateFetch(url, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await readReplicateError(response))
  return response.json()
}

async function waitForPrediction(prediction, token) {
  const started = Date.now()
  let current = prediction
  while (current && !['succeeded', 'failed', 'canceled'].includes(current.status)) {
    if (Date.now() - started > MAX_WAIT_MS) {
      throw new Error('Qwen is still generating. Please try the chunk again.')
    }
    const getUrl = current?.urls?.get
    if (!getUrl) throw new Error('Replicate did not return a prediction status URL')
    await new Promise((resolve) => setTimeout(resolve, 650))
    const response = await replicateFetch(getUrl, token)
    if (!response.ok) throw new Error(await readReplicateError(response))
    current = await response.json()
  }
  if (!current) throw new Error('Replicate returned an empty prediction')
  if (current.status !== 'succeeded') {
    throw new Error(current.error || `Replicate prediction ${current.status}`)
  }
  return current
}

function validateReference(referenceAudio) {
  if (typeof referenceAudio !== 'string' || !referenceAudio.startsWith('data:audio/')) {
    throw new Error('Leo reference audio is missing')
  }
  if (referenceAudio.length > MAX_REFERENCE_CHARS) {
    throw new Error('Leo reference audio is too large for the cloud request')
  }
}

async function handleHealth(token) {
  const response = await replicateFetch(`${REPLICATE_BASE}/account`, token)
  if (!response.ok) throw new Error(await readReplicateError(response))
  const account = await response.json()
  return json({ ok: true, account: account?.username || account?.name || 'Replicate' })
}

async function handleTranscribe(token, body) {
  validateReference(body.referenceAudio)
  const prediction = await createPrediction(`${REPLICATE_BASE}/predictions`, token, {
    version: WHISPER_VERSION,
    input: {
      audio: body.referenceAudio,
      language: 'auto',
      translate: false,
      temperature: 0,
      transcription: 'plain text',
      suppress_tokens: '-1',
      condition_on_previous_text: true,
    },
  })
  const done = await waitForPrediction(prediction, token)
  const transcript = typeof done.output?.transcription === 'string'
    ? done.output.transcription.trim()
    : typeof done.output === 'string'
      ? done.output.trim()
      : ''
  return json({ ok: true, transcript })
}

async function handleSynthesize(token, body) {
  validateReference(body.referenceAudio)
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) throw new Error('No text was provided to Qwen')
  if (text.length > MAX_TEXT_CHARS) throw new Error(`Qwen text chunk is too long (${text.length} characters)`)

  const input = {
    mode: 'voice_clone',
    text,
    language: 'auto',
    reference_audio: body.referenceAudio,
    style_instruction: typeof body.styleInstruction === 'string' && body.styleInstruction.trim()
      ? body.styleInstruction.trim()
      : 'Natural audiobook narration. Preserve the reference speaker voice and accent. Speak clearly at a steady conversational pace with natural sentence-level pauses. Avoid whispering, exaggerated breaths, dramatic acting, or rushing.',
  }
  if (typeof body.referenceText === 'string' && body.referenceText.trim()) {
    input.reference_text = body.referenceText.trim()
  }

  const prediction = await createPrediction(QWEN_MODEL_URL, token, { input })
  const done = await waitForPrediction(prediction, token)
  const outputUrl = typeof done.output === 'string'
    ? done.output
    : typeof done.output?.url === 'string'
      ? done.output.url
      : null
  if (!outputUrl) throw new Error('Qwen completed without an audio URL')

  const audio = await fetch(outputUrl)
  if (!audio.ok) throw new Error(`Could not download generated audio (${audio.status})`)
  const bytes = await audio.arrayBuffer()
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': audio.headers.get('content-type') || 'audio/wav',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'no-store',
      'X-TTS-Engine': 'qwen3-tts',
    },
  })
}

async function route(request) {
  if (request.method === 'GET') return json({ ok: true, service: 'Qwen3-TTS cloud proxy' })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const token = getToken(request)
  if (!token) return json({ error: 'Replicate API token required' }, 401)

  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON request' }, 400)
  }

  try {
    switch (body?.action) {
      case 'health':
        return await handleHealth(token)
      case 'transcribe':
        return await handleTranscribe(token, body)
      case 'synthesize':
        return await handleSynthesize(token, body)
      default:
        return json({ error: 'Unknown Qwen cloud action' }, 400)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = /token|unauthorized|authentication/i.test(message) ? 401 : 502
    return json({ error: message }, status)
  }
}

// Vercel Functions support the Web Standard fetch export for framework-agnostic
// projects such as this Vite app.
export default {
  fetch(request) {
    return route(request)
  },
}
