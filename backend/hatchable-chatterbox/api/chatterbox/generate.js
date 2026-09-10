import { callChatterboxSpace } from 'lib/gradio-space.js'

export const access = 'member'
export const methods = ['POST']

export default async function handler(req, res) {
  const clientId = typeof req.body?.clientId === 'string' ? req.body.clientId.trim() : ''
  const text = typeof req.body?.text === 'string' ? req.body.text.replace(/\s+/g, ' ').trim() : ''

  if (clientId.length < 16 || clientId.length > 200) {
    return res.status(400).json({ error: 'Invalid Chatterbox client session' })
  }
  if (!text || text.length > 300) {
    return res.status(400).json({ error: 'Chatterbox text must be 1–300 characters' })
  }

  try {
    const result = await callChatterboxSpace('generate', [clientId, text])
    if (!result || typeof result !== 'object') {
      return res.status(502).json({ error: 'Invalid Chatterbox response' })
    }
    return res.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chatterbox backend failed'
    return res.status(502).json({ error: message })
  }
}
