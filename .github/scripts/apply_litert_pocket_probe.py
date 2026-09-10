from pathlib import Path

settings_path = Path('src/features/settings/SettingsPage.tsx')
text = settings_path.read_text()

old_desc = "{ id: 'pocket' as TTSEngine, name: t`Pocket TTS`, description: t`Custom on-device voice.` },"
new_desc = "{ id: 'pocket' as TTSEngine, name: t`Pocket TTS`, description: t`LiteRT mobile compatibility test. Does not change your current engine.` },"
if old_desc not in text and new_desc not in text:
    raise SystemExit('Pocket engine description anchor not found')
text = text.replace(old_desc, new_desc)

anchor = """        onChange={async (v) => {\n          const engine = v as TTSEngine\n          \n          // IMPORTANT: Set the voice for the new engine FIRST (without triggering reload)"""
replacement = """        onChange={async (v) => {\n          // LiteRT is a compatibility probe only on this branch. Opening it must\n          // never activate Pocket, reload the app, or disturb the current reader.\n          // String(v) deliberately avoids narrowing the TTSEngine variable below.\n          if (String(v) === 'pocket') {\n            setActiveSheet('pocketLeo')\n            return\n          }\n\n          const engine = v as TTSEngine\n          \n          // IMPORTANT: Set the voice for the new engine FIRST (without triggering reload)"""
if anchor in text:
    text = text.replace(anchor, replacement, 1)
elif "String(v) deliberately avoids narrowing" not in text:
    raise SystemExit('Pocket engine onChange anchor not found')

settings_path.write_text(text)

worker_path = Path('src/services/tts/litertPocketProbe.worker.ts')
worker = worker_path.read_text()
unused = """function readFloat16Array(buffer: ArrayBuffer): Float32Array {\n  if (buffer.byteLength % 2) throw new Error('Invalid fp16 binary length')\n  const view = new DataView(buffer)\n  const result = new Float32Array(buffer.byteLength / 2)\n  for (let i = 0; i < result.length; i++) result[i] = halfToFloat(view.getUint16(i * 2, true))\n  return result\n}\n\n"""
worker = worker.replace(unused, '')
worker = worker.replace(
    '  let current = bos.slice()\n',
    '  let current: Float32Array<ArrayBufferLike> = bos.slice()\n',
)
worker_path.write_text(worker)

print('Applied isolated Pocket LiteRT picker guard and build-safe typed arrays')
