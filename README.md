# Pocket TTS for iPhone

A standalone iPhone web app based on the uploaded Pocket TTS 3 project. Paste text or choose a PDF, EPUB, or TXT file, select a voice, and generate speech. Record or upload a sample to create a cloned voice. Finished audio can be replayed or downloaded as M4A.

## Hosting

The Python speech engine runs on Railway. A private Sites gateway serves the app and forwards requests to the engine. The server requires the shared `APP_ACCESS_KEY`; the key is never included in browser code. The Sites runtime uses `POCKET_SERVER_URL` and the secret `POCKET_SERVER_KEY`.

`HF_TOKEN` can be supplied as a server secret to enable Kyutai's gated voice-cloning model, provided the associated account has accepted its terms. The Setup screen also supports a user-entered read token. Never put tokens into Git or an image. Built-in voices can use the ungated model.

The server is CPU-only, uses two inference threads, and runs one model worker. Model loading occurs after startup so the app can display progress. Railway health checks use `/health`. Generated files are temporary: the newest six completed files are retained, and a restart or redeploy may clear them. Download audio you want to keep. A server sleeping between uses needs time to wake and load the model again.

## iPhone

Open the private link in Safari and sign in with the owning ChatGPT account if requested. Choose Share → Add to Home Screen. Text extraction occurs in the browser; text to synthesize and voice samples are sent to the speech server. Cloned voice states and previews are stored in this browser's IndexedDB. Clearing site data removes them. Install the Home Screen app before creating voices if that is where you intend to use them.

Keep the app open while streaming. A screen wake lock is requested where supported. Once generation finishes, playback switches to a native audio element with seeking, speed controls, and Media Session integration. Background behavior during generation depends on iOS and is not guaranteed. Audio generation requires an internet connection.

Samples must contain at least three seconds of speech; 5–30 seconds is recommended. Longer samples use the first 30 seconds. Uploads are limited to 40 MB and narration to 500,000 characters per request.

## Local development

Requires Python 3.12 and a CPU with enough memory for PyTorch and the model.

```sh
sh bootstrap.sh
sh start.sh
```

Open `http://localhost:8321`. Microphone recording on another device requires HTTPS. Runtime data lives in `data/`, or the directory selected by `POCKET_DATA_DIR`.

## Layout

- `app/`: iPhone interface, streaming player, file parsers, manifest and asset-only service worker.
- `server/`: FastAPI speech engine, cloning, streaming, M4A encoding and temporary job storage.
- `site/`: private Cloudflare Worker gateway and its build script.
- `Dockerfile` and `railway.json`: CPU hosting configuration.

The original project's vendored PDF.js and JSZip files and app icons are retained. PDF scripting evaluation is disabled. Playback fixes include connecting audio sources, recovering from stream underruns, retaining a short rewind window, accurate media time, working cancellation, and native playback of the completed M4A.
