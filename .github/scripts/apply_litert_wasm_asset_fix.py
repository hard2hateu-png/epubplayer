from pathlib import Path

worker_path = Path('src/services/tts/litertPocketProbe.worker.ts')
worker = worker_path.read_text()
old_wasm = "const LITERT_WASM = 'https://cdn.jsdelivr.net/npm/@litertjs/core@2.5.3/wasm/'"
new_wasm = "const LITERT_WASM = '/litert-wasm/'"
if old_wasm not in worker and new_wasm not in worker:
    raise SystemExit('LiteRT WASM constant anchor not found')
worker = worker.replace(old_wasm, new_wasm)

locator_anchor = """function status(stage: string, detail?: string): void {\n  scope.postMessage({ type: 'status', stage, detail })\n}\n\n"""
locator_code = """function status(stage: string, detail?: string): void {\n  scope.postMessage({ type: 'status', stage, detail })\n}\n\nfunction configureLiteRtAssetLocator(): void {\n  const base = new URL(LITERT_WASM, self.location.origin)\n  ;(globalThis as unknown as { Module?: { locateFile: (filename: string) => string } }).Module = {\n    locateFile: (filename: string) => new URL(filename, base).toString(),\n  }\n}\n\n"""
if 'function configureLiteRtAssetLocator()' not in worker:
    if locator_anchor not in worker:
        raise SystemExit('status() anchor not found')
    worker = worker.replace(locator_anchor, locator_code, 1)

load_anchor = """  const totalStarted = performance.now()\n  status('Starting Google LiteRT…')\n  await loadLiteRt(LITERT_WASM)\n"""
load_replacement = """  const totalStarted = performance.now()\n  status('Starting Google LiteRT…')\n  configureLiteRtAssetLocator()\n  await loadLiteRt(LITERT_WASM)\n"""
if load_replacement not in worker:
    if load_anchor not in worker:
        raise SystemExit('loadLiteRt anchor not found')
    worker = worker.replace(load_anchor, load_replacement, 1)
worker_path.write_text(worker)

vite_path = Path('vite.config.ts')
vite = vite_path.read_text()
if "from 'node:fs'" not in vite:
    vite = vite.replace(
        "import { lingui } from '@lingui/vite-plugin'\n",
        "import { lingui } from '@lingui/vite-plugin'\nimport { copyFileSync, mkdirSync } from 'node:fs'\nimport { resolve } from 'node:path'\n",
        1,
    )

plugin = """\nconst LITERT_RUNTIME_FILES = [\n  'litert_wasm_internal.js',\n  'litert_wasm_internal.wasm',\n  'litert_wasm_compat_internal.js',\n  'litert_wasm_compat_internal.wasm',\n]\n\nfunction copyLiteRtRuntime() {\n  return {\n    name: 'copy-litert-runtime',\n    closeBundle() {\n      const sourceDir = resolve(process.cwd(), 'node_modules/@litertjs/core/wasm')\n      const outputDir = resolve(process.cwd(), 'dist/litert-wasm')\n      mkdirSync(outputDir, { recursive: true })\n      for (const file of LITERT_RUNTIME_FILES) {\n        copyFileSync(resolve(sourceDir, file), resolve(outputDir, file))\n      }\n    },\n  }\n}\n\n"""
if 'function copyLiteRtRuntime()' not in vite:
    vite = vite.replace('// https://vite.dev/config/\n', plugin + '// https://vite.dev/config/\n', 1)

plugins_anchor = """    lingui(),\n    tailwindcss(),\n"""
plugins_replacement = """    lingui(),\n    tailwindcss(),\n    copyLiteRtRuntime(),\n"""
if '    copyLiteRtRuntime(),\n' not in vite:
    if plugins_anchor not in vite:
        raise SystemExit('Vite plugins anchor not found')
    vite = vite.replace(plugins_anchor, plugins_replacement, 1)

vite_path.write_text(vite)
print('Applied self-hosted LiteRT WASM runtime and explicit worker asset locator')
