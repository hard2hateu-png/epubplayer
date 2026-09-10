import { callChatterboxSpace } from 'lib/gradio-space.js'

export const access = 'member'
export const methods = ['GET']

export default async function handler(_req, res) {
  try {
    const result = await callChatterboxSpace('health', [])
    return res.json(result && typeof result === 'object' ? result : { ok: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chatterbox backend failed'
    return res.status(502).json({ ok: false, error: message })
  }
}
