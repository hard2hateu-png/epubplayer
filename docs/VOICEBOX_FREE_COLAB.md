# Voicebox + Leo without a paid TTS API

This EPUB Player integration uses the actual open-source `jamiepine/voicebox` backend.

## No-computer architecture

1. The iPhone opens `tools/Voicebox_Free_Colab.ipynb` in Google Colab.
2. A free Colab GPU session runs Voicebox and Qwen3-TTS 1.7B.
3. A temporary Cloudflare Quick Tunnel exposes a token-protected HTTPS proxy.
4. The notebook's pairing button passes the temporary URL/token to EPUB Player in the URL fragment (the secret is not sent to Vercel).
5. EPUB Player recovers the Leo recording already stored privately in browser Cache Storage.
6. The first Voicebox session transcribes Leo once. The transcript is retained locally on the iPhone.
7. Each new ephemeral Voicebox server automatically recreates the Leo profile and uploads the original full reference using that cached transcript.
8. Generated book chunks are cached locally in EPUB Player.

## Cost / limits

There is no per-character TTS API or Replicate dependency. Voicebox is MIT-licensed/open source and the model runs in the Colab session. Google controls free Colab GPU availability, idle disconnects, and session limits, so this is appropriate for a free trial and intermittent listening, not a guaranteed 24/7 server.

## Security

Voicebox itself currently has no built-in remote API authentication. The Colab notebook therefore does **not** expose port 17493 directly. It places a small proxy in front of Voicebox that requires a random 256-bit `X-Voicebox-Token`, then tunnels only that proxy over HTTPS. Do not share the pairing URL or access token.
