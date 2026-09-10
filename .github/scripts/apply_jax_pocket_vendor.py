from __future__ import annotations

from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM_COMMIT = "ef32174b3b64e44422f148078ac0cacdf50384aa"
UPSTREAM_URL = (
    "https://raw.githubusercontent.com/ekzhang/jax-js/"
    f"{UPSTREAM_COMMIT}/website/src/routes/tts/pocket-tts.ts"
)

model_path = ROOT / "src/services/tts/jaxPocket/model.ts"
model_path.parent.mkdir(parents=True, exist_ok=True)
with urlopen(UPSTREAM_URL, timeout=30) as response:
    source = response.read().decode("utf-8")
model_path.write_text(
    "// Vendored from ekzhang/jax-js Pocket TTS demo, MIT license.\n"
    f"// Upstream commit: {UPSTREAM_COMMIT}\n"
    + source,
    encoding="utf-8",
)

settings_path = ROOT / "src/features/settings/SettingsPage.tsx"
settings = settings_path.read_text(encoding="utf-8")
needle = """          } else if (engine === 'pocket') {\n            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.\n"""
replacement = """          } else if (engine === 'pocket') {\n            // Do not activate/reload Pocket until Leo actually exists. On a fresh\n            // origin this opens setup while the current working engine stays active.\n            const hasLeo = await pocketService.hasLeoVoiceSample()\n            if (!hasLeo) {\n              setActiveSheet('pocketLeo')\n              return\n            }\n            // Unique cache identity for Leo. Pocket itself always uses the local Leo clone.\n"""
if needle not in settings:
    raise SystemExit("Pocket Settings guard target no longer matches stable source")
settings_path.write_text(settings.replace(needle, replacement, 1), encoding="utf-8")

pocket_service = (ROOT / "src/services/tts/pocketService.ts").read_text(encoding="utf-8")
for forbidden in ("railway.app", "pocket-native", "/voice/install", "/tts"):
    if forbidden in pocket_service:
        raise SystemExit(f"Server-backed Pocket reference found in local experiment: {forbidden}")

print("Vendored pinned JAX-JS Pocket model and applied local-only Settings guard")
