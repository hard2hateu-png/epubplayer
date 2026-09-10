import base64
import io
import os
import threading
from collections import OrderedDict
from pathlib import Path

import gradio as gr
import torchaudio as ta
from chatterbox.tts_turbo import ChatterboxTurboTTS

MODEL_NAME = os.getenv("CHATTERBOX_MODEL", "nano").strip().lower()
if MODEL_NAME not in {"nano", "turbo"}:
    raise RuntimeError("CHATTERBOX_MODEL must be 'nano' or 'turbo'")

DEVICE = os.getenv("CHATTERBOX_DEVICE", "cpu").strip().lower()
MAX_SESSIONS = 4
MAX_TEXT_CHARS = 1200

_model = None
_model_lock = threading.Lock()
_conditionals = OrderedDict()


def get_model():
    global _model
    if _model is None:
        _model = ChatterboxTurboTTS.from_pretrained(
            device=DEVICE,
            nano=(MODEL_NAME == "nano"),
        )
    return _model


def remember(session_id, conds):
    _conditionals.pop(session_id, None)
    _conditionals[session_id] = conds
    while len(_conditionals) > MAX_SESSIONS:
        _conditionals.popitem(last=False)


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
            elif session_id in _conditionals:
                model.conds = _conditionals[session_id]
                _conditionals.move_to_end(session_id)
            else:
                raise gr.Error("Leo reference required for this session.")

            wav = model.generate(text)
            buffer = io.BytesIO()
            ta.save(buffer, wav, model.sr, format="wav")
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            return {
                "audio_base64": encoded,
                "mime": "audio/wav",
                "sample_rate": model.sr,
                "model": MODEL_NAME,
            }
        finally:
            # Gradio uploads the prompt to a temporary file. Remove it as soon as
            # conditioning is prepared; no Leo recording is intentionally persisted.
            if reference_path:
                try:
                    reference_path.unlink(missing_ok=True)
                except OSError:
                    pass


with gr.Blocks(title="EPUB Chatterbox") as demo:
    gr.Markdown("# EPUB Chatterbox\nFree CPU backend for the EPUB reader. No voice asset is bundled with this Space.")
    text = gr.Textbox(label="Text", lines=4)
    reference = gr.Audio(label="Voice reference", type="filepath")
    session = gr.Textbox(label="Session id")
    output = gr.JSON(label="Audio payload")
    run = gr.Button("Generate")
    run.click(synthesize, [text, reference, session], output, api_name="synthesize")

demo.queue(default_concurrency_limit=1).launch()
