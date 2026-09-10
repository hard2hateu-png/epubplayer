from __future__ import annotations

import asyncio
import io
import json
import os
import secrets
import tempfile
import time
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from pocket_tts import TTSModel, export_model_state

LANGUAGE = os.getenv("POCKET_LANGUAGE", "english")
QUANTIZE = os.getenv("POCKET_QUANTIZE", "0").lower() in {"1", "true", "yes"}
ACCESS_TOKEN = os.getenv("POCKET_ACCESS_TOKEN", "").strip()
VOICE_PATH = Path(os.getenv("LEO_STATE_PATH", "/data/voices/leo.safetensors"))
VOICE_META_PATH = VOICE_PATH.with_suffix(".json")
MAX_REFERENCE_BYTES = int(os.getenv("MAX_REFERENCE_BYTES", str(30 * 1024 * 1024)))
MAX_TEXT_CHARS = int(os.getenv("MAX_TEXT_CHARS", "1200"))

MODEL: TTSModel | None = None
VOICE_STATE: Any | None = None
MODEL_LOCK = asyncio.Lock()


def _cors_origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [part.strip().rstrip("/") for part in raw.split(",") if part.strip()]


def _require_model() -> TTSModel:
    if MODEL is None:
        raise HTTPException(status_code=503, detail="Pocket TTS model is still loading")
    return MODEL


def _require_voice() -> Any:
    if VOICE_STATE is None:
        raise HTTPException(status_code=409, detail="Leo voice has not been prepared yet")
    return VOICE_STATE


def _check_auth(authorization: str | None = Header(default=None)) -> None:
    if not ACCESS_TOKEN:
        return
    expected = f"Bearer {ACCESS_TOKEN}"
    if authorization is None or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Invalid Pocket access token")


def _wav_bytes(audio: Any, sample_rate: int) -> bytes:
    data = audio.detach().cpu().float().numpy()
    data = np.asarray(data, dtype=np.float32).reshape(-1)
    data = np.clip(data, -1.0, 1.0)
    pcm = np.where(data < 0, data * 32768.0, data * 32767.0).astype("<i2")
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return out.getvalue()


def _load_saved_voice(model: TTSModel) -> Any | None:
    if not VOICE_PATH.exists():
        return None
    return model.get_state_for_audio_prompt(VOICE_PATH)


def _read_metadata() -> dict[str, Any]:
    if not VOICE_META_PATH.exists():
        return {}
    try:
        return json.loads(VOICE_META_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    global MODEL, VOICE_STATE
    VOICE_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Keep one official Kyutai Pocket model resident, like a desktop/local server.
    # Start full precision for the quality audition; quantization can be enabled
    # later only if profiling shows that the host needs it.
    MODEL = await asyncio.to_thread(
        TTSModel.load_model,
        language=LANGUAGE,
        quantize=QUANTIZE,
    )
    VOICE_STATE = await asyncio.to_thread(_load_saved_voice, MODEL)
    yield
    VOICE_STATE = None
    MODEL = None


app = FastAPI(title="EPUB Player Native Pocket TTS", version="1.0.0", lifespan=lifespan)
_origins = _cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["X-Audio-Duration", "X-Pocket-Generation-Ms", "X-Pocket-Sample-Rate"],
)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)


@app.get("/health")
async def health() -> dict[str, Any]:
    model = MODEL
    return {
        "ok": model is not None,
        "modelReady": model is not None,
        "voiceInstalled": VOICE_STATE is not None,
        "language": LANGUAGE,
        "quantized": QUANTIZE,
        "sampleRate": int(model.sample_rate) if model is not None else 24000,
    }


@app.get("/voice/status", dependencies=[Depends(_check_auth)])
async def voice_status() -> dict[str, Any]:
    metadata = _read_metadata()
    return {
        "installed": VOICE_STATE is not None and VOICE_PATH.exists(),
        "name": "Leo",
        **metadata,
    }


@app.post("/voice/install", dependencies=[Depends(_check_auth)])
async def install_voice(reference: UploadFile = File(...)) -> dict[str, Any]:
    global VOICE_STATE
    model = _require_model()
    content = await reference.read(MAX_REFERENCE_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail="Leo reference is empty")
    if len(content) > MAX_REFERENCE_BYTES:
        raise HTTPException(status_code=413, detail="Leo reference is too large")

    suffix = Path(reference.filename or "leo.wav").suffix.lower()
    if suffix not in {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"}:
        suffix = ".wav"

    temp_path: Path | None = None
    async with MODEL_LOCK:
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
                temp.write(content)
                temp.flush()
                temp_path = Path(temp.name)

            # Kyutai's official voice-cloning path. truncate=True uses up to the
            # supported 30 seconds instead of the 12-second WebKit workaround.
            state = await asyncio.to_thread(
                model.get_state_for_audio_prompt,
                temp_path,
                truncate=True,
            )
            await asyncio.to_thread(export_model_state, state, VOICE_PATH)
            # Reload the persisted state so narration uses exactly what survives a restart.
            VOICE_STATE = await asyncio.to_thread(model.get_state_for_audio_prompt, VOICE_PATH)
            metadata = {
                "preparedAt": int(time.time()),
                "referenceBytes": len(content),
                "conditioning": "official-truncate-30s",
            }
            VOICE_META_PATH.write_text(json.dumps(metadata), encoding="utf-8")
        except HTTPException:
            raise
        except Exception as exc:
            VOICE_STATE = None
            VOICE_PATH.unlink(missing_ok=True)
            VOICE_META_PATH.unlink(missing_ok=True)
            raise HTTPException(status_code=500, detail=f"Could not prepare Leo: {exc}") from exc
        finally:
            if temp_path is not None:
                temp_path.unlink(missing_ok=True)

    return {"installed": True, "name": "Leo", **_read_metadata()}


@app.delete("/voice", dependencies=[Depends(_check_auth)])
async def remove_voice() -> dict[str, bool]:
    global VOICE_STATE
    async with MODEL_LOCK:
        VOICE_STATE = None
        VOICE_PATH.unlink(missing_ok=True)
        VOICE_META_PATH.unlink(missing_ok=True)
    return {"removed": True}


@app.post("/tts", dependencies=[Depends(_check_auth)])
async def synthesize(request: TTSRequest) -> Response:
    model = _require_model()
    state = _require_voice()
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty")

    started = time.perf_counter()
    async with MODEL_LOCK:
        try:
            audio = await asyncio.to_thread(
                model.generate_audio,
                state,
                text,
                copy_state=True,
            )
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Pocket generation failed: {exc}") from exc

    sample_rate = int(model.sample_rate)
    wav = await asyncio.to_thread(_wav_bytes, audio, sample_rate)
    duration = max(0.0, (len(wav) - 44) / (sample_rate * 2))
    generation_ms = int((time.perf_counter() - started) * 1000)
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-store",
            "X-Audio-Duration": f"{duration:.6f}",
            "X-Pocket-Generation-Ms": str(generation_ms),
            "X-Pocket-Sample-Rate": str(sample_rate),
        },
    )
