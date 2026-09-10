# Leo clarity conditioning experiment

Baseline: stable-pocket-tts-2026-09-10 / 4922b78

This branch changes only which continuous 12-second portion of the existing private Leo reference is encoded for Pocket TTS voice conditioning.

- Stable selector result on the supplied 44.7-second reference: approximately 18.5-30.5 seconds (loudness-only RMS winner)
- Experiment window: 21.25-33.25 seconds
- Reason: the experiment window measured a higher speech spectral centroid/rolloff and less low-mid concentration than the stable window, which should be a better candidate for clarity without changing speaker identity
- No EQ, denoising, resynthesis, splicing, playback post-processing, sampling changes, chunk-size changes, buffer changes, or speed changes
- Conditioning remains one continuous 12-second mono PCM window, preserving the iPhone memory-safe contract
- Embedding cache is versioned to v5 so the experiment actually rebuilds Leo once

Do not merge based on build success alone. Audition on the target iPhone and compare voice identity, consonant clarity, muffling, stability, generation speed, and playback continuity against the stable reset point.
