# Native Pocket TTS server (experimental)

This service runs the official Kyutai `pocket-tts` model outside iPhone Safari while preserving EPUB Player's existing generated-audio cache and playback pipeline.

## Why this exists

The stable browser Pocket implementation uses a community ONNX/WebWorker port and a 12-second conditioning workaround for iOS WebKit memory limits. This experiment instead keeps one official Pocket model resident on a server and exports Leo once to a reusable `.safetensors` voice state. The uploaded reference is not needed for normal narration after the voice state is prepared.

## Environment

- `HF_TOKEN`: Hugging Face token with access to `kyutai/pocket-tts` if the model requires authenticated/gated access.
- `LEO_STATE_PATH`: persistent path for Leo's exported state. Default `/data/voices/leo.safetensors`.
- `POCKET_LANGUAGE`: defaults to `english` (Kyutai's current English model).
- `POCKET_QUANTIZE`: defaults to `0` for the first quality comparison.
- `POCKET_ACCESS_TOKEN`: optional Bearer token for the API.
- `CORS_ORIGINS`: comma-separated allowed EPUB Player origins. Defaults to `*` for local testing.
- `MAX_REFERENCE_BYTES`: default 30 MiB.
- `MAX_TEXT_CHARS`: default 1200.

## Endpoints

- `GET /health`: model and Leo readiness.
- `GET /voice/status`: whether the persisted Leo state exists.
- `POST /voice/install`: multipart field `reference`; runs Kyutai's official voice conditioning with `truncate=True` (up to 30 seconds), exports `.safetensors`, then reloads that exact state.
- `DELETE /voice`: removes the persisted Leo state.
- `POST /tts`: JSON `{ "text": "..." }`; returns 24 kHz mono PCM WAV.

Generation is serialized because the official Pocket model instance is not thread-safe. The client also preserves the stable Pocket generation queue, so player and server ordering agree.

## Client build variables

Set these when building the experimental EPUB Player frontend:

- `VITE_POCKET_NATIVE_URL=https://<native-pocket-host>`
- `VITE_POCKET_API_KEY=<same POCKET_ACCESS_TOKEN>` if authentication is enabled.

The access token in a browser build should be treated as a single-user prototype convenience, not strong secret storage. Before a public multi-user deployment, put authentication behind a server-side session/proxy rather than shipping a reusable secret to the browser.
