import base64
import copy
import hashlib
import io
import os
import tempfile
import time
import wave
from collections import OrderedDict
from threading import Lock

import gradio as gr
import numpy as np
import spaces
import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS

# This file is intended to replace app.py in a duplicate of
# ResembleAI/chatterbox-turbo-demo. That Space already carries the vendored
# Chatterbox source and a ZeroGPU-compatible dependency set.
MODEL = ChatterboxTurboTTS.from_pretrained("cuda")

MAX_REFERENCE_BYTES = 30 * 1024 * 1024
MAX_TEXT_CHARS = 300
VOICE_TTL_SECONDS = 60 * 60
MAX_VOICE_SESSIONS = 4

# Leo reference audio is NEVER persisted. We keep only CPU conditionals in RAM,
# keyed by a one-session opaque client ID. Space restarts clear this dictionary.
VOICE_CONDITIONALS = OrderedDict()
VOICE_LOCK = Lock()
MODEL_LOCK = Lock()


def _voice_key(client_id: str) -> str:
    client_id = (client_id or "").strip()
    if len(client_id) < 16 or len(client_id) > 200:
        raise ValueError("Invalid client session")
    return hashlib.sha256(client_id.encode("utf-8")).hexdigest()


def _cleanup_voice_sessions() -> None:
    cutoff = time.time() - VOICE_TTL_SECONDS
    with VOICE_LOCK:
        stale = [key for key, (_, touched_at) in VOICE_CONDITIONALS.items() if touched_at < cutoff]
        for key in stale:
            VOICE_CONDITIONALS.pop(key, None)
        while len(VOICE_CONDITIONALS) > MAX_VOICE_SESSIONS:
            VOICE_CONDITIONALS.popitem(last=False)


def _decode_reference(value: str):
    if not value:
        raise ValueError("Leo reference audio is missing")

    mime = "audio/wav"
    payload = value
    if value.startswith("data:"):
        header, payload = value.split(",", 1)
        mime = header[5:].split(";", 1)[0] or mime

    try:
        raw = base64.b64decode(payload, validate=True)
    except Exception as exc:
        raise ValueError("Leo reference audio is not valid base64") from exc

    if not raw:
        raise ValueError("Leo reference audio is empty")
    if len(raw) > MAX_REFERENCE_BYTES:
        raise ValueError("Leo reference audio is too large")

    suffix = ".wav"
    if "mpeg" in mime or "mp3" in mime:
        suffix = ".mp3"
    elif "mp4" in mime or "m4a" in mime:
        suffix = ".m4a"
    elif "ogg" in mime:
        suffix = ".ogg"

    return raw, suffix


def _wav_base64(wav_tensor: torch.Tensor, sample_rate: int):
    audio = wav_tensor.squeeze(0).detach().float().cpu().numpy()
    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
    audio = np.clip(audio, -1.0, 1.0)
    pcm = (audio * 32767.0).astype(np.int16)

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm.tobytes())

    return base64.b64encode(buffer.getvalue()).decode("ascii"), len(audio) / sample_rate


def health():
    _cleanup_voice_sessions()
    return {
        "ok": True,
        "engine": "chatterbox-turbo",
        "voice": "Leo",
        "reference_persisted": False,
        "max_text_chars": MAX_TEXT_CHARS,
    }


@spaces.GPU(duration=30)
def prepare_leo(client_id: str, reference_b64: str):
    """Prepare Leo once for this short-lived Space session.

    The raw reference is written only to an ephemeral temp file because the
    official Chatterbox API accepts audio_prompt_path. It is deleted in finally.
    Only CPU conditionals remain in RAM after this function returns.
    """
    key = _voice_key(client_id)
    raw, suffix = _decode_reference(reference_b64)
    _cleanup_voice_sessions()

    path = None
    try:
        with tempfile.NamedTemporaryFile(prefix="leo-ref-", suffix=suffix, delete=False) as handle:
            handle.write(raw)
            path = handle.name

        with MODEL_LOCK:
            MODEL.prepare_conditionals(path)
            if MODEL.conds is None:
                raise RuntimeError("Chatterbox did not create voice conditionals")
            cpu_conds = copy.deepcopy(MODEL.conds).to("cpu")
            MODEL.conds = None

        with VOICE_LOCK:
            VOICE_CONDITIONALS[key] = (cpu_conds, time.time())
            VOICE_CONDITIONALS.move_to_end(key)
            while len(VOICE_CONDITIONALS) > MAX_VOICE_SESSIONS:
                VOICE_CONDITIONALS.popitem(last=False)

        return {"status": "ready", "voice": "Leo"}
    except AssertionError as exc:
        return {"status": "error", "error": str(exc)}
    except Exception:
        return {"status": "error", "error": "Could not prepare Leo voice"}
    finally:
        MODEL.conds = None
        if path:
            try:
                os.remove(path)
            except OSError:
                pass
        del raw
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


@spaces.GPU(duration=45)
def generate(client_id: str, text: str):
    key = _voice_key(client_id)
    text = " ".join((text or "").split()).strip()
    if not text:
        return {"status": "error", "error": "Text is empty"}
    if len(text) > MAX_TEXT_CHARS:
        return {"status": "error", "error": f"Text exceeds {MAX_TEXT_CHARS} characters"}

    _cleanup_voice_sessions()
    with VOICE_LOCK:
        stored = VOICE_CONDITIONALS.get(key)
        if stored is None:
            return {"status": "needs_voice"}
        cpu_conds, _ = stored
        VOICE_CONDITIONALS[key] = (cpu_conds, time.time())
        VOICE_CONDITIONALS.move_to_end(key)
        conds = copy.deepcopy(cpu_conds)

    try:
        with MODEL_LOCK:
            MODEL.conds = conds.to("cuda")
            wav = MODEL.generate(text)
            audio_b64, duration = _wav_base64(wav, MODEL.sr)
            MODEL.conds = None

        return {
            "status": "ok",
            "audio_b64": audio_b64,
            "mime": "audio/wav",
            "sample_rate": MODEL.sr,
            "duration": duration,
        }
    except Exception:
        return {"status": "error", "error": "Chatterbox generation failed"}
    finally:
        MODEL.conds = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


with gr.Blocks(title="EPUB Player Chatterbox Turbo") as demo:
    gr.Markdown(
        "# EPUB Player · Chatterbox Turbo\n"
        "API backend for the EPUB reader. Leo reference audio is not stored."
    )

    client_id = gr.Textbox(visible=False)
    reference_b64 = gr.Textbox(visible=False)
    text = gr.Textbox(visible=False)
    output = gr.JSON(visible=False)

    prepare_button = gr.Button("Prepare voice", visible=False)
    generate_button = gr.Button("Generate", visible=False)
    health_button = gr.Button("Health", visible=False)

    health_button.click(health, inputs=[], outputs=output, api_name="health", concurrency_limit=4)
    prepare_button.click(
        prepare_leo,
        inputs=[client_id, reference_b64],
        outputs=output,
        api_name="prepare_leo",
        concurrency_limit=1,
        concurrency_id="chatterbox_gpu",
    )
    generate_button.click(
        generate,
        inputs=[client_id, text],
        outputs=output,
        api_name="generate",
        concurrency_limit=1,
        concurrency_id="chatterbox_gpu",
    )


if __name__ == "__main__":
    demo.queue(default_concurrency_limit=1).launch(ssr_mode=False, show_api=True)
