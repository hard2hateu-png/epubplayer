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

This backend uses ResembleAI's official `ChatterboxTurboTTS` class. It defaults to **Chatterbox-Nano on CPU** because the reader is constrained to free hosting. Nano is 110M parameters and shares Turbo's architecture/voice-cloning API.

## Privacy

No Leo recording, transcript, embedding, conditionals file, or generated WAV is included in this repository. The reader keeps the reference on the iPhone. The Space receives a short reference only when its in-memory session needs conditioning, deletes the uploaded temporary file after conditioning, and returns generated WAV bytes as base64 rather than creating a persistent output file.

## Free deployment

Create a Hugging Face **Gradio Space** using free CPU hardware and copy this folder's three files into it. Leave the default environment variables:

- `CHATTERBOX_MODEL=nano`
- `CHATTERBOX_DEVICE=cpu`

Then build the reader with `VITE_CHATTERBOX_ENDPOINT` set to the Space URL or `owner/space-name`. Chatterbox stays hidden from Settings when that value is absent.

Turbo can be selected later with `CHATTERBOX_MODEL=turbo`, but free CPU is not the recommended Turbo runtime.
