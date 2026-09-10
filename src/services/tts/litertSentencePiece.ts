const SPACE = '▁'
const UNK_PENALTY = 10.0
const BYTE_RE = /^<0x([0-9A-Fa-f]{2})>$/

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })
const utf8Encoder = new TextEncoder()

type Piece = { piece: Uint8Array | null; score: number }

type Segment = { id: number; start: number; end: number }

function readVarint(bytes: Uint8Array, pos: number): [number, number] {
  let shift = 0
  let result = 0
  let i = pos
  for (;;) {
    if (i >= bytes.length) throw new Error('Truncated SentencePiece model')
    const b = bytes[i++]
    result += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 56) throw new Error('Invalid SentencePiece varint')
  }
  return [result, i]
}

function parseModelProto(bytes: Uint8Array): Piece[] {
  const pieces: Piece[] = []
  let i = 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  while (i < bytes.length) {
    let tag: number
    ;[tag, i] = readVarint(bytes, i)
    const field = tag >>> 3
    const wire = tag & 7

    if (wire === 2) {
      let len: number
      ;[len, i] = readVarint(bytes, i)
      const end = i + len
      if (end > bytes.length) throw new Error('Truncated SentencePiece field')
      if (field === 1) {
        let j = i
        let piece: Uint8Array | null = null
        let score = 0
        while (j < end) {
          let ptag: number
          ;[ptag, j] = readVarint(bytes, j)
          const pf = ptag >>> 3
          const pw = ptag & 7
          if (pw === 2) {
            let plen: number
            ;[plen, j] = readVarint(bytes, j)
            if (pf === 1) piece = bytes.subarray(j, j + plen)
            j += plen
          } else if (pw === 5) {
            if (pf === 2) score = view.getFloat32(j, true)
            j += 4
          } else if (pw === 1) {
            j += 8
          } else if (pw === 0) {
            ;[, j] = readVarint(bytes, j)
          } else {
            throw new Error(`Unsupported SentencePiece wire type ${pw}`)
          }
        }
        pieces.push({ piece, score })
      }
      i = end
    } else if (wire === 0) {
      ;[, i] = readVarint(bytes, i)
    } else if (wire === 5) {
      i += 4
    } else if (wire === 1) {
      i += 8
    } else {
      throw new Error(`Unsupported SentencePiece wire type ${wire}`)
    }
  }
  return pieces
}

export class LiteRTPocketTokenizer {
  private readonly pieceToId = new Map<string, number>()
  private readonly scores: number[] = []
  private readonly byteTokenId = new Int32Array(256).fill(-1)
  private minScore = 0
  private maxPieceChars = 1

  static async fromUrl(url: string): Promise<LiteRTPocketTokenizer> {
    const response = await fetch(url, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`Tokenizer download failed (${response.status})`)
    const tokenizer = new LiteRTPocketTokenizer()
    tokenizer.load(new Uint8Array(await response.arrayBuffer()))
    return tokenizer
  }

  private load(modelBytes: Uint8Array): void {
    const pieces = parseModelProto(modelBytes)
    for (let id = 0; id < pieces.length; id++) {
      const { piece, score } = pieces[id]
      const text = piece ? utf8Decoder.decode(piece) : ''
      this.scores[id] = score
      this.pieceToId.set(text, id)
      if (score < this.minScore) this.minScore = score
      const byteMatch = BYTE_RE.exec(text)
      if (byteMatch) this.byteTokenId[Number.parseInt(byteMatch[1], 16)] = id
      this.maxPieceChars = Math.max(this.maxPieceChars, Array.from(text).length)
    }

    // Kyutai's SentencePiece vocabulary contains 4,000 tokens (IDs 0–3999).
    // The converted LiteRT embedding asset intentionally has 4,001 rows; the
    // additional row is model-side state and is not emitted by the tokenizer.
    if (pieces.length !== 4000) {
      throw new Error(`Unexpected Pocket tokenizer vocabulary (${pieces.length}, expected 4000)`)
    }
  }

  encode(text: string): number[] {
    if (!text) return []
    const chars = Array.from(SPACE + text.replace(/ /g, SPACE))
    const n = chars.length
    const unkScore = this.minScore - UNK_PENALTY
    const best = new Float64Array(n + 1).fill(-Infinity)
    const backId = new Int32Array(n + 1).fill(-1)
    const backStart = new Int32Array(n + 1).fill(-1)
    best[0] = 0

    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue
      const maxLen = Math.min(this.maxPieceChars, n - i)
      let acc = ''
      for (let len = 1; len <= maxLen; len++) {
        acc += chars[i + len - 1]
        const id = this.pieceToId.get(acc)
        if (id == null) continue
        const score = best[i] + this.scores[id]
        if (score > best[i + len]) {
          best[i + len] = score
          backId[i + len] = id
          backStart[i + len] = i
        }
      }
      const score = best[i] + unkScore
      if (score > best[i + 1]) {
        best[i + 1] = score
        backId[i + 1] = -1
        backStart[i + 1] = i
      }
    }

    const segments: Segment[] = []
    let pos = n
    while (pos > 0) {
      const start = backStart[pos]
      if (start < 0) throw new Error('Pocket tokenizer could not segment text')
      segments.push({ id: backId[pos], start, end: pos })
      pos = start
    }
    segments.reverse()

    const ids: number[] = []
    for (const segment of segments) {
      if (segment.id >= 0) {
        ids.push(segment.id)
        continue
      }
      const chunk = chars.slice(segment.start, segment.end).join('')
      for (const byte of utf8Encoder.encode(chunk)) {
        const id = this.byteTokenId[byte]
        if (id < 0) throw new Error(`Pocket tokenizer has no byte fallback for ${byte}`)
        ids.push(id)
      }
    }
    return ids
  }
}
