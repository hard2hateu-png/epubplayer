# Chatterbox Turbo ZeroGPU backend

This directory contains the EPUB Player-specific API layer for a **free Hugging Face ZeroGPU Space**.

## Why this shape

- Uses **Chatterbox-Turbo** for English Leo narration.
- Keeps the stable iPhone reader responsible for chunking, playback, and its existing audio cache.
- Keeps Leo reference audio out of GitHub and out of the frontend bundle.
- Processes the reference once per live Space session with `prepare_conditionals()` and reuses only in-memory conditionals.
- Deletes the temporary reference file immediately after conditioning.
- If the Space sleeps/restarts and loses its conditionals, the reader can automatically resend the Leo reference stored on the iPhone.

## Free hosting path

Use Hugging Face ZeroGPU. A free personal account in good standing can host up to two ZeroGPU Spaces, subject to the account's daily GPU quota.

The safest setup is to **duplicate the official `ResembleAI/chatterbox-turbo-demo` Space**, which already runs successfully on ZeroGPU and contains a vendored `chatterbox/` source tree compatible with its current Torch stack.

Then replace only its `app.py` with this directory's `app.py`. Keep the duplicated Space's vendored `chatterbox/` directory. The dependency list in `requirements.txt` mirrors the current official Turbo demo's ZeroGPU-compatible runtime.

Do not add Leo audio, embeddings, transcripts, conditionals, or generated private voice assets to the Space repository.

## API contract

The Gradio Space exposes:

- `/health` — no GPU; reports backend availability.
- `/prepare_leo` — GPU; accepts an opaque `client_id` plus base64 reference audio. Returns `{status: "ready"}`.
- `/generate` — GPU; accepts the same `client_id` plus text (max 300 chars). Returns base64 WAV plus duration.

The Space stores at most a few voice-condition sessions in RAM and expires them after one hour. Nothing is written to persistent storage.

## Production request path

Recommended final path:

`iPhone EPUB Player -> Hatchable same-origin proxy -> private/public ZeroGPU Space -> WAV -> existing EPUB Player cache`

The Hatchable proxy can hold the user's Hugging Face read token as a server-side secret so it never ships in the public Vite bundle. The token is optional for a public Space, but authenticated ZeroGPU calls receive the user's normal free-account quota instead of the smaller unauthenticated pool.

No paid inference endpoint is required for this architecture.
