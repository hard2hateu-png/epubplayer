// Q4 decoder bootstrap for the isolated benchmark branch.
// It keeps the validated English Original Chatterbox pipeline intact and
// redirects only the conditional decoder fetch to the Q4 single-file export.

const ORIGINAL_DECODER_MODEL = 'https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/main/onnx/conditional_decoder.onnx'
const ORIGINAL_DECODER_DATA = 'https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/main/onnx/conditional_decoder.onnx_data'
const Q4_DECODER_MODEL = 'https://huggingface.co/BricksDisplay/chatterbox-multilingual-ONNX-q4/resolve/main/onnx/conditional_decoder.onnx'

const nativeFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input)

  if (url === ORIGINAL_DECODER_MODEL) {
    return nativeFetch(Q4_DECODER_MODEL, init)
  }

  // The Q4 decoder is a self-contained ONNX file. The staged worker still
  // supplies the legacy external-data mapping, so return an empty placeholder
  // instead of downloading the 534 MB FP32 payload. The Q4 graph does not
  // reference this external file.
  if (url === ORIGINAL_DECODER_DATA) {
    return new Response(new Uint8Array(0), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    })
  }

  return nativeFetch(input, init)
}

await import('/chatterbox-staged-worker.js?v=20260910-q4-decoder-v1-core')
