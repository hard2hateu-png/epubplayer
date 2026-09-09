# Voicebox trial plan

This file is a placeholder for the upcoming Voicebox trial. The production reader remains on Pocket TTS until the Voicebox path is tested separately.

## Goal

Compare the same private Leo reference and the same narration passage across:

1. Qwen3-TTS (first choice)
2. Chatterbox / Chatterbox Turbo
3. TADA if available on the test machine

Judge voice similarity, intelligibility, long-form stability, pause quality, first-audio latency, and sustained realtime factor.

## Intended architecture

The iPhone reader should remain a lightweight playback client:

`EPUB Player on iPhone -> HTTPS Voicebox API -> native TTS backend -> audio -> EPUB Player`

Do not run these large Voicebox engines inside iOS Safari.

## App-side trial requirements

- Configurable Voicebox server URL; never hard-code a personal LAN address or token.
- Health/connectivity check before enabling Voicebox.
- Voice/profile selector with Leo displayed by profile name.
- Keep Pocket TTS available as a fallback during the trial.
- Submit narration chunks serially and prefetch only a small number on iOS.
- Store generated audio through the reader's existing audio cache.
- Do not upload the Leo reference to this GitHub repository.

## Test passage

Use the same 2–3 paragraphs for each engine and keep generation settings fixed for the first comparison.

## Before app integration

We still need a reachable Voicebox backend URL and a Leo voice profile created there. Once those exist, wire the experimental engine on a separate branch before merging anything into production.
