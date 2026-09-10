import { Client, handle_file } from '@gradio/client'

const refUrl = 'https://storage.googleapis.com/chatterbox-demo-samples/turbo/2.wav'
const refResponse = await fetch(refUrl)
if (!refResponse.ok) throw new Error(`Reference fetch failed: ${refResponse.status}`)
const reference = await refResponse.blob()

const app = await Client.connect('ResembleAI/chatterbox-turbo-demo')
const result = await app.predict('/generate', [
  'Hello. This is a short Chatterbox test.',
  handle_file(reference),
  0.8,
  42,
  0.0,
  0.95,
  1000,
  1.2,
  true,
])

const output = result?.data?.[0]
console.log('Output kind:', typeof output)
console.log('Output keys:', output && typeof output === 'object' ? Object.keys(output) : [])
const url = typeof output === 'string' ? output : output?.url
if (!url) throw new Error(`No audio URL in output: ${JSON.stringify(output).slice(0, 500)}`)

const audio = await fetch(url)
console.log('Audio fetch:', audio.status, audio.headers.get('content-type'), audio.headers.get('content-length'))
if (!audio.ok) throw new Error(`Generated audio fetch failed: ${audio.status}`)
const bytes = (await audio.arrayBuffer()).byteLength
if (bytes < 1000) throw new Error(`Generated audio unexpectedly small: ${bytes} bytes`)
console.log('Chatterbox smoke test passed:', bytes, 'bytes')
