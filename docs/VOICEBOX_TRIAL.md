# Voicebox trial plan

Production stays on Pocket TTS while Voicebox is tested on the separate `experiment/voicebox-trial` branch.

## Goal

Use the same private Leo reference and the same narration passage to compare:

1. **Qwen3-TTS** — first choice for Leo similarity
2. **Chatterbox / Chatterbox Turbo** — second comparison
3. **TADA** — especially interesting for long-form consistency

Judge:

- similarity to the original Leo recording
- intelligibility / skipped words
- robotic or whispered drift
- pause and breath placement
- first-audio latency
- sustained long-form stability
- generation speed relative to playback

## Architecture

The iPhone should only request and play audio:

`EPUB Player on iPhone -> HTTPS Voicebox API -> native Qwen/Chatterbox/TADA backend -> audio -> EPUB Player`

Do **not** run these larger models inside iOS Safari.

Voicebox exposes:

- `GET /health`
- `POST /generate`
- `GET /audio/{generation_id}`

The experimental reader client is in `src/services/tts/voiceboxTrialClient.ts` and is deliberately not registered as a production TTS engine yet.

## Voicebox server requirements for the iPhone trial

### 1. Reachable HTTPS URL

The reader is served from `https://epubplayer-eta.vercel.app`, so Safari will block an `http://` Voicebox API as mixed content. The Voicebox backend therefore needs a trusted HTTPS URL reachable from the iPhone.

A secure tunnel/reverse proxy can keep Voicebox itself bound to localhost while exposing an HTTPS endpoint. Do not expose the backend directly to the public internet without access controls.

### 2. CORS

Voicebox defaults to local/Tauri origins. Add the reader origin when launching the server:

```text
VOICEBOX_CORS_ORIGINS=https://epubplayer-eta.vercel.app
```

If testing a Vercel preview URL, add that exact origin too.

### 3. Create a Leo profile inside Voicebox

Keep the Leo source audio in Voicebox/local storage. Do **not** commit the recording to this repository.

For the first test:

- profile name: `Leo`
- use the same clean ~40-second reference
- engine: `qwen`
- model: start with Qwen3-TTS 1.7B when hardware allows; otherwise 0.6B
- language: `en`

Voicebox caches the voice prompt for repeated generations, so the profile should be reused rather than re-uploading the reference for each EPUB chunk.

## Baseline API request

The first comparison should keep settings deterministic:

```json
{
  "profile_id": "<LEO_PROFILE_UUID>",
  "text": "<TEST PASSAGE>",
  "language": "en",
  "seed": 42,
  "model_size": "1.7B",
  "engine": "qwen",
  "max_chunk_chars": 800
}
```

Voicebox handles long text with sentence-boundary chunking and crossfades on the backend. Its generation queue is serialized, so our browser client also submits requests serially rather than competing for the backend.

## Trial order

1. Get Voicebox running and confirm `GET /health` returns `status: "healthy"`.
2. Create the Leo profile from the private reference recording.
3. Generate the same 2–3 paragraph passage in Qwen3-TTS 1.7B and 0.6B.
4. Compare Chatterbox using the exact same text and reference.
5. Test the best voice for at least 5–10 minutes of continuous book narration.
6. Only after that, wire Voicebox into the reader's visible TTS settings.

## App integration after the voice test passes

The final reader integration should:

- add `voicebox` to the TTS registry
- expose server URL + Leo profile selection in Settings
- show `Voice: Leo`
- run a health check before activation
- use the existing generated-audio cache
- keep only a small iOS look-ahead buffer
- keep Pocket TTS available as a fallback during the trial
- never store the private Leo recording in GitHub

## Security note

Voicebox is designed as a local single-user service and does not provide a production-grade public authentication boundary by default. For remote iPhone access, put it behind a private network/tunnel or authenticated reverse proxy rather than opening port 17493 directly to the internet.
