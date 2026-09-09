from pathlib import Path

p = Path('src/services/tts/pocketService.ts')
s = p.read_text()

# Force a new saved voice fingerprint. The old v2 fingerprint was created by
# averaging several time-aligned Mimi embedding sequences, which destroys the
# temporal conditioning structure and can change speaker identity.
s = s.replace("const EMBEDDING_PATH = '/__epubplayer/pocket/voices/leo-embedding-v2-full'", "const EMBEDDING_PATH = '/__epubplayer/pocket/voices/leo-embedding-v3-single-30s'")
s = s.replace("const EMBEDDING_MAGIC = 'LEOEMB02'", "const EMBEDDING_MAGIC = 'LEOEMB03'")
s = s.replace("const REFERENCE_SECONDS = 42.65\n", "const REFERENCE_SECONDS = 42.65\nconst CONDITIONING_SECONDS = 30\n")

# Remove the invalid element-wise averaging helper entirely.
start = s.find('function averageEmbeddings(')
if start != -1:
    end = s.find('\nfunction localUrl(', start)
    assert end != -1
    s = s[:start] + s[end+1:]

old = '''        let embedding: VoiceEmbedding
        if (isIOSDevice() && pcm.length > rate * 12) {
          // WebKit is much more stable when the voice encoder sees ~10-second pieces
          // instead of one 42-second tensor. Every part of the stored reference still
          // contributes to Leo: encode each piece, then average the fixed-size embeddings.
          const segmentCount = Math.max(2, Math.ceil(pcm.length / (rate * 11)))
          const segmentLength = Math.ceil(pcm.length / segmentCount)
          const embeddings: VoiceEmbedding[] = []
          for (let index = 0; index < segmentCount; index++) {
            const start = index * segmentLength
            const end = Math.min(pcm.length, start + segmentLength)
            if (end - start < rate * 2) continue
            this.onProgressCallback?.(`Preparing Leo voice ${index + 1}/${segmentCount}...`, 99)
            embeddings.push(await candidate.cloneVoice(pcm.slice(start, end)))
            await new Promise<void>((resolve) => setTimeout(resolve, 25))
          }
          embedding = averageEmbeddings(embeddings)
        } else {
          this.onProgressCallback?.('Preparing the full Leo reference...', 99)
          embedding = await candidate.cloneVoice(pcm)
        }

        await this.saveEmbedding(embedding)
        log.info('Prepared the full Leo reference', { seconds: pcm.length / rate })
'''
new = '''        // Pocket's voice embedding is a temporal sequence. Never average embeddings
        // from different portions of speech. Use one continuous conditioning clip.
        // Pocket's official export/server path truncates uploaded references to 30s;
        // keeping the same limit also avoids the 42s WebKit memory spike.
        const conditioningSamples = Math.min(pcm.length, Math.floor(rate * CONDITIONING_SECONDS))
        const conditioningPcm = pcm.slice(0, conditioningSamples)
        if (conditioningPcm.length < rate) throw new Error('Leo conditioning clip is too short')
        this.onProgressCallback?.('Preparing Leo from the original continuous reference...', 99)
        const embedding = await candidate.cloneVoice(conditioningPcm)

        await this.saveEmbedding(embedding)
        log.info('Prepared Leo from one continuous reference', {
          storedSeconds: pcm.length / rate,
          conditioningSeconds: conditioningPcm.length / rate,
        })
'''
assert old in s, 'old segmented embedding block not found'
s = s.replace(old, new, 1)
p.write_text(s)

# Force fresh narration audio as well, so cached output made with the bad v2
# fingerprint cannot be replayed after Leo is rebuilt.
p = Path('src/features/player/TTSBufferManager.ts')
s = p.read_text()
s = s.replace("const POCKET_AUDIO_CACHE_VERSION = 'pocket-serial-v2'", "const POCKET_AUDIO_CACHE_VERSION = 'pocket-leo-v3'")
p.write_text(s)
