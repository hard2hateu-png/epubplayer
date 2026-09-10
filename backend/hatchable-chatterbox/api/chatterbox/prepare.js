import { callChatterboxSpace } from 'lib/gradio-space.js'

export const access = 'member'
export const methods = ['POST']

export default async function handler(req, res) {
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : ''
  const referenceBase64 = typeof req.body?.referenceBase64 === 'string' ? req.body.referenceBase64 : ''

  if (clientId.length < 16 || clientId.length > 200) {
    return res.status(400).json({ error: 'Invalid Chatterbox client session' })
  }
  if (!referenceBase64 || referenceBase64.length > 45_000_000) {
    return res.status(400).json({ error: 'Invalid Leo reference audio' })
  }

  try {
    const result = await callChatterboxSpace('prepare_leo', [clientId, referenceBase64])
    if (!result || typeof result !== 'object') {
      return res.status(502).json({ error: 'Invalid Chatterbox response' })
    }
    return res.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chatterbox backend failed'
    return res.status(502).json({ error: message })
  }
}
