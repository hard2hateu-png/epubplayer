from pathlib import Path

p = Path('src/features/settings/SettingsPage.tsx')
s = p.read_text()
old = """          } else if (engine === 'pocket') {
            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.
            await settingsRepository.set('voiceId', 'pocket:leo')
            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))
          }
"""
new = """          } else if (engine === 'pocket') {
            // On a fresh origin, do not activate/reload Pocket until Leo exists.
            // Keep the current working engine alive while the user installs Leo.
            const hasLeoReference = await pocketService.hasLeoVoiceSample()
            if (!hasLeoReference) {
              setActiveSheet('pocketLeo')
              return
            }
            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.
            await settingsRepository.set('voiceId', 'pocket:leo')
            setSettings((prev) => ({ ...prev, voiceId: 'pocket:leo' }))
          }
"""
if old not in s:
    raise SystemExit('Pocket engine selection block no longer matches expected code')
p.write_text(s.replace(old, new, 1))
