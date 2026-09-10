import base64
import copy
import io
import sys
import threading
from collections import OrderedDict
from pathlib import Path

import gradio as gr
import spaces
import torch
import torchaudio as ta
from huggingface_hub import snapshot_download

# Free personal HF accounts can host ZeroGPU Gradio Spaces, but ordinary compute
# Spaces now require a paid plan. Reuse ResembleAI's current ZeroGPU-compatible
# Chatterbox source rather than installing the PyPI package's older torch pin.
SOURCE_ROOT = snapshot_download(
    repo_id="ResembleAI/chatterbox-turbo-demo",
    repo_type="space",
    allow_patterns=["chatterbox/**"],
)
if SOURCE_ROOT not in sys.path:
    sys.path.insert(0, SOURCE_ROOT)

from chatterbox.tts_turbo import ChatterboxTurboTTS  # noqa: E402

MAX_SESSIONS = 4
MAX_TEXT_CHARS = 300

_model = None
_model_lock = threading.Lock()
_conditionals = OrderedDict()


def get_model():
    global _model
    if _model is None:
        _model = ChatterboxTurboTTS.from_pretrained(device="cuda")
    return _model


def remember(session_id, conds):
    # Keep session conditionals in CPU memory between ZeroGPU calls. The private
    # Leo recording itself is never intentionally stored by this app.
    _conditionals.pop(session_id, None)
    _conditionals[session_id] = copy.deepcopy(conds).to("cpu")
    while len(_conditionals) > MAX_SESSIONS:
        _conditionals.popitem(last=False)


def use_saved_conditionals(model, session_id):
    conds = _conditionals.get(session_id)
    if conds is None:
        raise gr.Error("Leo reference required for this session.")
    _conditionals.move_to_end(session_id)
    model.conds = copy.deepcopy(conds).to("cuda")


@spaces.GPU
def synthesize(text, reference_audio, session_id):
    text = (text or "").strip()
    session_id = (session_id or "").strip()
    if not text:
        raise gr.Error("Text is required.")
    if len(text) > MAX_TEXT_CHARS:
        raise gr.Error(f"Text is limited to {MAX_TEXT_CHARS} characters per request.")
    if not session_id:
        raise gr.Error("Session id is required.")

    reference_path = Path(reference_audio) if reference_audio else None
    with _model_lock:
        model = get_model()
        try:
            if reference_path:
                model.prepare_conditionals(str(reference_path))
                remember(session_id, model.conds)
            else:
                use_saved_conditionals(model, session_id)

            # Fixed seed improves continuity from chunk to chunk for narration.
            torch.manual_seed(42)
            torch.cuda.manual_seed_all(42)
            wav = model.generate(text)

            # Return WAV bytes directly. This avoids creating a persistent
            # generated-audio file on the Space; the iPhone's existing cache owns it.
            buffer = io.BytesIO()
            ta.save(buffer, wav, model.sr, format="wav")
            return {
                "audio_base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
                "mime": "audio/wav",
                "sample_rate": model.sr,
                "model": "chatterbox-turbo",
            }
        finally:
            # Gradio uploads the prompt to a temporary file. Delete it immediately
            # after conditioning rather than keeping Leo's recording on the Space.
            if reference_path:
                try:
                    reference_path.unlink(missing_ok=True)
                except OSError:
                    pass


with gr.Blocks(title="EPUB Chatterbox") as demo:
    gr.Markdown(
        "# EPUB Chatterbox\n"
        "ZeroGPU Chatterbox-Turbo backend for the EPUB reader. "
        "No Leo voice asset is bundled with this Space."
    )
    text = gr.Textbox(label="Text", lines=4, max_lines=5)
    reference = gr.Audio(label="Voice reference", type="filepath")
    session = gr.Textbox(label="Session id")
    output = gr.JSON(label="Audio payload")
    run = gr.Button("Generate")
    run.click(synthesize, [text, reference, session], output, api_name="synthesize")

demo.queue(max_size=20, default_concurrency_limit=1).launch()
