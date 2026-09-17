from pathlib import Path

p = Path("app/app.js")
s = p.read_text()

old_setspeed = '''  setSpeed(r) {\n    if (this.native) { this.speed = r; this.native.playbackRate = r; return; }\n    const wasPlaying = this.playing;\n    this.pause(); this.speed = r;\n    if (wasPlaying) this.play();\n  }'''
new_setspeed = '''  setSpeed(r) {\n    this.requestedSpeed = r;\n    if (this.native) {\n      this.speed = r;\n      this.native.preservesPitch = true;\n      this.native.webkitPreservesPitch = true;\n      this.native.playbackRate = r;\n      return;\n    }\n    if (gen.active) {\n      // Live PCM uses AudioBufferSourceNode; changing playbackRate raises pitch.\n      // Remember the requested speed and apply it when the finished media file takes over.\n      return;\n    }\n    const wasPlaying = this.playing;\n    this.pause(); this.speed = r;\n    if (wasPlaying) this.play();\n  }'''

old_finished = '''      audio.playbackRate = this.speed;\n      audio.preservesPitch = true;'''
new_finished = '''      this.speed = this.requestedSpeed || this.speed;\n      audio.preservesPitch = true;\n      audio.webkitPreservesPitch = true;\n      audio.playbackRate = this.speed;'''

old_start = '''  player.stop();\n  $("#playerCard").hidden = false;'''
new_start = '''  player.stop();\n  // Always stream live PCM at natural pitch. Preserve the user's chosen speed for finished playback.\n  player.requestedSpeed = SPEEDS[speedIdx];\n  player.speed = 1;\n  $("#playerCard").hidden = false;'''

for old, new, label in [
    (old_setspeed, new_setspeed, "setSpeed"),
    (old_finished, new_finished, "finished playback"),
    (old_start, new_start, "generation start"),
]:
    if old not in s:
        raise SystemExit(f"speed patch failed: {label} pattern not found")
    s = s.replace(old, new, 1)

p.write_text(s)
print("Applied minimal pitch-safe speed patch")
