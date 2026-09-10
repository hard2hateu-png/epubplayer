import { config } from 'hatchable'

const REQUEST_TIMEOUT_MS = 90_000

async function withTimeout(url, init = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

function parseSseResult(body) {
  const blocks = String(body || '').split(/\r?\n\r?\n/)
  let lastError = null

  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    const eventLine = lines.find((line) => line.startsWith('event:'))
    const dataLines = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
    if (!eventLine || dataLines.length === 0) continue

    const event = eventLine.slice(6).trim()
    const rawData = dataLines.join('\n')
    if (event === 'error') {
      lastError = rawData || 'Hugging Face Space returned an error'
      continue
    }
    if (event === 'complete') {
      const parsed = JSON.parse(rawData)
      return Array.isArray(parsed) ? parsed[0] : parsed
    }
  }

  throw new Error(lastError || 'Hugging Face Space did not return a complete result')
}

export async function callChatterboxSpace(apiName, data) {
  const rawBaseUrl = await config.get('CHATTERBOX_SPACE_URL')
  const hfToken = await config.get('HF_TOKEN')
  const baseUrl = String(rawBaseUrl || '').replace(/\/+$/, '')

  if (!baseUrl.startsWith('https://')) throw new Error('Chatterbox Space URL is not configured')
  if (!hfToken) throw new Error('Hugging Face token is not configured')

  const headers = {
    Authorization: `Bearer ${hfToken}`,
    'Content-Type': 'application/json',
  }

  const submit = await withTimeout(`${baseUrl}/gradio_api/call/${encodeURIComponent(apiName)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data }),
  })
  if (!submit.ok) {
    throw new Error(`Hugging Face Space submit failed (${submit.status})`)
  }

  const submitted = await submit.json()
  const eventId = submitted?.event_id
  if (!eventId || typeof eventId !== 'string') {
    throw new Error('Hugging Face Space did not return an event id')
  }

  const result = await withTimeout(
    `${baseUrl}/gradio_api/call/${encodeURIComponent(apiName)}/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${hfToken}` } },
  )
  if (!result.ok) {
    throw new Error(`Hugging Face Space result failed (${result.status})`)
  }

  return parseSseResult(await result.text())
}
