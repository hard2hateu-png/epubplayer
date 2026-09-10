from pathlib import Path

worker_path = Path('src/services/tts/litertPocketProbe.worker.ts')
text = worker_path.read_text()

if 'async function runProbe(generationOnly = false): Promise<void> {' not in text:
    text = text.replace(
        'async function runProbe(): Promise<void> {',
        'async function runProbe(generationOnly = false): Promise<void> {',
        1,
    )

old_cleanup = """  } finally {\n    destroyGpuState(gpuState)\n    flow.delete()\n  }\n\n  status('Pocket language model released; decoding audio…')\n"""
new_cleanup = """  } finally {\n    const device = gpuState?.device\n    destroyGpuState(gpuState)\n    flow.delete()\n    if (generationOnly) {\n      try {\n        device?.destroy?.()\n      } catch {\n        // The worker is terminated immediately after the latent handoff.\n      }\n    }\n  }\n\n  if (generationOnly) {\n    const flatLatents = new Float32Array(latents.length * LATENT_WIDTH)\n    for (let i = 0; i < latents.length; i++) {\n      flatLatents.set(latents[i], i * LATENT_WIDTH)\n    }\n    status('Pocket language model released; handing off decoder…')\n    scope.postMessage(\n      {\n        type: 'latent-result',\n        latents: flatLatents,\n        latentFrames: latents.length,\n        generationMs,\n        text: SAMPLE_TEXT,\n      },\n      [flatLatents.buffer],\n    )\n    return\n  }\n\n  status('Pocket language model released; decoding audio…')\n"""
if 'type: \'latent-result\'' not in text:
    if old_cleanup not in text:
        raise SystemExit('generation cleanup anchor not found')
    text = text.replace(old_cleanup, new_cleanup, 1)

old_handler = """self.onmessage = (event: MessageEvent<{ type?: string }>) => {\n  if (event.data?.type !== 'run') return\n  void runProbe()\n"""
new_handler = """self.onmessage = (event: MessageEvent<{ type?: string }>) => {\n  if (event.data?.type !== 'run' && event.data?.type !== 'generate-only') return\n  void runProbe(event.data.type === 'generate-only')\n"""
if "event.data.type === 'generate-only'" not in text:
    if old_handler not in text:
        raise SystemExit('worker message handler anchor not found')
    text = text.replace(old_handler, new_handler, 1)

worker_path.write_text(text)

controller_path = Path('src/services/tts/litertPocketProbe.ts')
controller = controller_path.read_text()
old_controller = """    generator = makeClassicWorker(\n      new URL('./litertPocketProbe.worker.ts', import.meta.url),\n      'pocket-litert-alba-generator',\n    )\n\n    generator.onerror = (event) => {\n"""
new_controller = """    const generationWorker = makeClassicWorker(\n      new URL('./litertPocketProbe.worker.ts', import.meta.url),\n      'pocket-litert-alba-generator',\n    )\n    generator = generationWorker\n\n    generationWorker.onerror = (event) => {\n"""
if 'const generationWorker = makeClassicWorker(' not in controller:
    if old_controller not in controller:
        raise SystemExit('controller worker anchor not found')
    controller = controller.replace(old_controller, new_controller, 1)
    controller = controller.replace(
        "    generator.onmessage = (event: MessageEvent<GeneratorMessage>) => {",
        "    generationWorker.onmessage = (event: MessageEvent<GeneratorMessage>) => {",
        1,
    )
    controller = controller.replace(
        "      generator.terminate()\n      generator = null",
        "      generationWorker.terminate()\n      generator = null",
        1,
    )
    controller = controller.replace(
        "    generator.postMessage({ type: 'generate-only' })",
        "    generationWorker.postMessage({ type: 'generate-only' })",
        1,
    )
controller_path.write_text(controller)

print('Patched LiteRT split workers and controller nullability')
