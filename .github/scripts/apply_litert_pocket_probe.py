from pathlib import Path

path = Path('src/features/settings/SettingsPage.tsx')
text = path.read_text()

old_desc = "{ id: 'pocket' as TTSEngine, name: t`Pocket TTS`, description: t`Custom on-device voice.` },"
new_desc = "{ id: 'pocket' as TTSEngine, name: t`Pocket TTS`, description: t`LiteRT mobile compatibility test. Does not change your current engine.` },"
if old_desc not in text and new_desc not in text:
    raise SystemExit('Pocket engine description anchor not found')
text = text.replace(old_desc, new_desc)

anchor = """        onChange={async (v) => {\n          const engine = v as TTSEngine\n          \n          // IMPORTANT: Set the voice for the new engine FIRST (without triggering reload)"""
replacement = """        onChange={async (v) => {\n          const engine = v as TTSEngine\n\n          // LiteRT is a compatibility probe only on this branch. Opening it must\n          // never activate Pocket, reload the app, or disturb the current reader.\n          if (engine === 'pocket') {\n            setActiveSheet('pocketLeo')\n            return\n          }\n          \n          // IMPORTANT: Set the voice for the new engine FIRST (without triggering reload)"""
if anchor in text:
    text = text.replace(anchor, replacement, 1)
elif "// LiteRT is a compatibility probe only on this branch." not in text:
    raise SystemExit('Pocket engine onChange anchor not found')

path.write_text(text)
print('Applied isolated Pocket LiteRT picker guard')
