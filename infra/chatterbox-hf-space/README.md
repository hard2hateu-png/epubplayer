---
title: EPUB Chatterbox
emoji: 🔊
colorFrom: indigo
colorTo: gray
sdk: gradio
sdk_version: 6.8.0
app_file: app.py
pinned: false
---

# EPUB Chatterbox free backend

This backend uses **Chatterbox-Turbo** on Hugging Face **ZeroGPU**. It follows ResembleAI's official ZeroGPU demo pattern and loads the current Chatterbox source from `ResembleAI/chatterbox-turbo-demo`.

## Why ZeroGPU

Hugging Face currently requires a paid plan to create ordinary Gradio/Docker compute Spaces. The free-plan exception is ZeroGPU: eligible personal accounts can host up to two ZeroGPU Spaces. That makes ZeroGPU the realistic no-billing Chatterbox-Turbo host.

Free usage is limited by Hugging Face's daily ZeroGPU quota, so this is suitable for testing/light listening rather than unlimited audiobook generation.

## Privacy

No Leo recording, transcript, embedding, conditionals file, or generated WAV is included in this repository.

The reader keeps Leo's reference on the iPhone. The Space receives a short reference only when its current in-memory session needs conditioning, stores only CPU conditionals in memory, deletes the uploaded temporary reference immediately after conditioning, and returns generated WAV bytes as base64 rather than creating a persistent output file. If the Space restarts and loses its session, the reader automatically sends the local reference again.

## Deployment

Create or duplicate a **Gradio ZeroGPU Space** and use the files in this folder. Then build the reader with `VITE_CHATTERBOX_ENDPOINT` set to the Space URL or `owner/space-name`.

Chatterbox stays hidden from the reader's engine picker when `VITE_CHATTERBOX_ENDPOINT` is absent, so an unavailable backend cannot affect the stable local engines.

The endpoint API is `/synthesize` with three inputs: text, optional reference audio, and a reader session id.
