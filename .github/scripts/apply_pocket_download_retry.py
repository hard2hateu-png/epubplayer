from pathlib import Path

# One-shot branch patch. This file is deleted after the tested change lands.
path = Path('src/services/tts/pocketService.ts')
text = path.read_text()

old = """  if (!result.includes(dispatchOriginal)) throw new Error('Pocket worker dispatch patch no longer matches')
  return result.replace(dispatchOriginal, dispatchPatched)
}"""

new = """  if (!result.includes(dispatchOriginal)) throw new Error('Pocket worker dispatch patch no longer matches')
  result = result.replace(dispatchOriginal, dispatchPatched)

  // Hugging Face can transiently return 429 on a fresh origin while Pocket's
  // model bundle is being populated. The vendored worker currently fails on
  // the first non-2xx response, so add bounded 429-only retry/backoff without
  // changing model URLs, model weights, synthesis, or playback behavior.
  const fetchOriginal = '    const res = await fetch(url);\\n    if (!res.ok) throw new Error(`Failed to fetch ${label}: ${res.status}`);'
  const fetchPatched = `    let res = null;\n    for (let attempt = 0; attempt < 5; attempt++) {\n        res = await fetch(url);\n        if (res.ok) break;\n        if (res.status !== 429 || attempt === 4) {\n            throw new Error(\\`Failed to fetch \\${label}: \\${res.status}\\`);\n        }\n        const retryAfter = Number(res.headers.get("retry-after"));\n        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0\n            ? Math.min(retryAfter * 1000, 60000)\n            : 1500 * Math.pow(2, attempt);\n        try { await res.body?.cancel(); } catch { /* best effort */ }\n        post({ type: "status", status: \\`Rate limited downloading \\${label}; retrying…\\` });\n        await new Promise((resolve) => setTimeout(resolve, delayMs));\n    }`
  if (!result.includes(fetchOriginal)) throw new Error('Pocket worker fetch patch no longer matches')
  return result.replace(fetchOriginal, fetchPatched)
}"""

if old not in text:
    raise SystemExit('patchWorker tail no longer matches expected code')

path.write_text(text.replace(old, new, 1))
