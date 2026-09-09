const ALLOWED_PATHS = [
  /^\/health$/,
  /^\/profiles$/,
  /^\/profiles\/[A-Za-z0-9_-]+\/samples$/,
  /^\/transcribe$/,
  /^\/generate$/,
  /^\/history\/[A-Za-z0-9_-]+$/,
  /^\/audio\/[A-Za-z0-9_-]+$/,
  /^\/generate\/[A-Za-z0-9_-]+\/cancel$/,
]

const ALLOWED_METHODS = new Set(['GET', 'POST'])
const MAX_REQUEST_BYTES = 8 * 1024 * 1024

function isAllowedPath(path) {
  return ALLOWED_PATHS.some((pattern) => pattern.test(path))
}

function validateUpstream(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Missing Voicebox upstream URL')
  }
  const url = new URL(value.trim())
  if (url.protocol !== 'https:') throw new Error('Voicebox upstream must use HTTPS')
  if (!url.hostname.endsWith('.trycloudflare.com')) {
    throw new Error('Voicebox upstream must be a Cloudflare Quick Tunnel')
  }
  if (url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Invalid Voicebox upstream URL')
  }
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

async function readBody(req) {
  if (req.method === 'GET') return undefined
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_REQUEST_BYTES) throw new Error('Voicebox relay request is too large')
    chunks.push(buffer)
  }
  return total ? Buffer.concat(chunks) : undefined
}

export const config = {
  maxDuration: 60,
}

export default async function handler(req, res) {
  try {
    if (!ALLOWED_METHODS.has(req.method || '')) {
      res.setHeader('Allow', 'GET, POST')
      return res.status(405).json({ error: 'Method not allowed' })
    }

    const rawPath = Array.isArray(req.query?.path) ? req.query.path[0] : req.query?.path
    const path = typeof rawPath === 'string' ? rawPath : ''
    if (!isAllowedPath(path)) return res.status(400).json({ error: 'Unsupported Voicebox path' })

    const upstream = validateUpstream(req.headers['x-voicebox-upstream'])
    const token = req.headers['x-voicebox-token']
    if (typeof token !== 'string' || !token.trim()) {
      return res.status(401).json({ error: 'Missing Voicebox access token' })
    }

    const body = await readBody(req)
    const headers = new Headers()
    headers.set('X-Voicebox-Token', token.trim())
    if (typeof req.headers['content-type'] === 'string') headers.set('Content-Type', req.headers['content-type'])
    if (typeof req.headers.accept === 'string') headers.set('Accept', req.headers.accept)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 55_000)
    let response
    try {
      response = await fetch(`${upstream}${path}`, {
        method: req.method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    const payload = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type')
    const contentDisposition = response.headers.get('content-disposition')
    if (contentType) res.setHeader('Content-Type', contentType)
    if (contentDisposition) res.setHeader('Content-Disposition', contentDisposition)
    res.setHeader('Cache-Control', 'no-store')
    return res.status(response.status).send(payload)
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Voicebox relay timed out waiting for the Colab session'
      : error instanceof Error ? error.message : String(error)
    return res.status(502).json({ error: message })
  }
}
