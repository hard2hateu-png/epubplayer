from pathlib import Path

path = Path('src/services/tts/litertPocketProbe.worker.ts')
text = path.read_text()

text = text.replace(
    'async function runProbe(): Promise<void> {',
    'async function runProbe(generationOnly = false): Promise<void> {',
    1,
)

old_cleanup = """  } finally {\n    destroyGpuState(gpuState)\n    flow.delete()\n  }\n\n  status('Pocket language model released; decoding audio…')\n"""
new_cleanup = """  } finally {\n    const device = gpuState?.device\n    destroyGpuState(gpuState)\n    flow.delete()\n    if (generationOnly) {\n      try {\n        device?.destroy?.()\n      } catch {\n        // The worker is terminated immediately after the latent handoff.\n      }\n    }\n  }\n\n  if (generationOnly) {\n    const flatLatents = new Float32Array(latents.length * LATENT_WIDTH)\n    for (let i = 0; i < latents.length; i++) {\n      flatLatents.set(latents[i], i * LATENT_WIDTH)\n    }\n    status('Pocket language model released; handing off decoder…')\n    scope.postMessage(\n      {\n        type: 'latent-result',\n        latents: flatLatents,\n        latentFrames: latents.length,\n        generationMs,\n        text: SAMPLE_TEXT,\n      },\n      [flatLatents.buffer],\n    )\n    return\n  }\n\n  status('Pocket language model released; decoding audio…')\n"""
if old_cleanup not in text:
    raise SystemExit('generation cleanup anchor not found')
text = text.replace(old_cleanup, new_cleanup, 1)

old_handler = """self.onmessage = (event: MessageEvent<{ type?: string }>) => {\n  if (event.data?.type !== 'run') return\n  void runProbe()\n"""
new_handler = """self.onmessage = (event: MessageEvent<{ type?: string }>) => {\n  if (event.data?.type !== 'run' && event.data?.type !== 'generate-only') return\n  void runProbe(event.data.type === 'generate-only')\n"""
if old_handler not in text:
    raise SystemExit('worker message handler anchor not found')
text = text.replace(old_handler, new_handler, 1)

path.write_text(text)
print('Patched LiteRT generator worker for hard two-worker handoff')
