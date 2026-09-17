from pathlib import Path

app = Path("app/app.js")
s = app.read_text()

old_setspeed = '''  setSpeed(r) {\n    if (this.native) { this.speed = r; this.native.playbackRate = r; return; }\n    const wasPlaying = this.playing;\n    this.pause(); this.speed = r;\n    if (wasPlaying) this.play();\n  }'''
new_setspeed = '''  setSpeed(r) {\n    this.requestedSpeed = r;\n    if (this.native) {\n      this._loadFinishedRate(r);\n      return;\n    }\n    // Never change AudioBufferSourceNode playbackRate. On iPhone that resamples\n    // the live PCM and raises the voice pitch. Keep live generation at 1x.\n    if (gen.active) return;\n    this.speed = 1;\n  }\n  _loadFinishedRate(r) {\n    const audio = this.native;\n    if (!audio || !gen.jobId) return;\n    const wasPlaying = !audio.paused;\n    const oldRate = this.finishedRate || 1;\n    const basePos = (audio.currentTime || 0) * oldRate;\n    const target = basePos / r;\n    this.finishedRate = r;\n    audio.pause();\n    audio.onloadedmetadata = () => {\n      this.total = Number.isFinite(audio.duration) ? audio.duration : this.total;\n      audio.currentTime = Math.min(target, audio.duration || target);\n      audio.playbackRate = 1;\n      this.speed = 1;\n      this._paintNow();\n      if (wasPlaying) audio.play().catch(() => toast("Tap Play to continue."));\n    };\n    audio.src = "/api/download/" + gen.jobId + "?speed=" + encodeURIComponent(r);\n    audio.load();\n  }'''

old_pos = '''      const pos = this._pos(), resume = this.playing;'''
new_pos = '''      const pos = this._pos(), resume = this.playing;\n      const rate = this.requestedSpeed || 1;'''

old_native = '''      audio.currentTime = Math.min(pos, audio.duration || pos);\n      audio.playbackRate = this.speed;\n      audio.preservesPitch = true;'''
new_native = '''      this.finishedRate = rate;\n      this.speed = 1;\n      audio.currentTime = Math.min(pos / rate, audio.duration || (pos / rate));\n      // The server already time-stretched this file without changing pitch.\n      audio.playbackRate = 1;'''

old_src = '''    audio.src = url;\n    audio.load();'''
new_src = '''    audio.src = url + "?speed=" + encodeURIComponent(this.requestedSpeed || 1);\n    audio.load();'''

old_start = '''  player.stop();\n  $("#playerCard").hidden = false;'''
new_start = '''  player.stop();\n  player.requestedSpeed = SPEEDS[speedIdx];\n  player.finishedRate = 1;\n  player.speed = 1;\n  $("#playerCard").hidden = false;'''

for old, new, label in [
    (old_setspeed, new_setspeed, "setSpeed"),
    (old_pos, new_pos, "finished position"),
    (old_native, new_native, "finished native playback"),
    (old_src, new_src, "finished source"),
    (old_start, new_start, "generation start"),
]:
    if old not in s:
        raise SystemExit(f"tempo patch failed: {label} pattern not found")
    s = s.replace(old, new, 1)

app.write_text(s)

index = Path("app/index.html")
h = index.read_text()
old_script = '<script src="app.js"></script>'
new_script = '<script src="app.js?v=20260917-tempo1"></script>'
if old_script not in h:
    raise SystemExit("tempo patch failed: app.js script tag not found")
index.write_text(h.replace(old_script, new_script, 1))

sw = Path("app/sw.js")
w = sw.read_text()
old_cache = 'const CACHE = "pocket-ios-20260916-1";'
new_cache = 'const CACHE = "pocket-ios-20260917-tempo1";'
if old_cache not in w:
    raise SystemExit("tempo patch failed: service-worker cache version not found")
sw.write_text(w.replace(old_cache, new_cache, 1))

server = Path("server/server.py")
p = server.read_text()

old_import = '''import struct\nimport threading'''
new_import = '''import struct\nimport subprocess\nimport threading'''
if old_import not in p:
    raise SystemExit("tempo patch failed: server import anchor not found")
p = p.replace(old_import, new_import, 1)

old_download = '''@app.get("/api/download/{job_id}")\ndef download(job_id: str):\n    if not re.fullmatch(r"[a-f0-9]{12}", job_id):\n        raise HTTPException(404, "Job not found")\n    p = OUT_DIR / job_id / "audio.m4a"\n    if not p.exists() or not (p.parent / "DONE").exists():\n        raise HTTPException(404, "Not found (the file may have been pruned).")\n    meta = next((j for j in _jobs() if j["id"] == job_id), None)\n    title = re.sub(r"[^A-Za-z0-9 _\\-]", "", (meta or {}).get("title", "narration")).strip() or "narration"\n    return FileResponse(p, media_type="audio/mp4", filename=f"{title[:60]}.m4a")'''

new_download = '''@app.get("/api/download/{job_id}")\ndef download(job_id: str, speed: float = 1.0):\n    if not re.fullmatch(r"[a-f0-9]{12}", job_id):\n        raise HTTPException(404, "Job not found")\n    base = OUT_DIR / job_id / "audio.m4a"\n    if not base.exists() or not (base.parent / "DONE").exists():\n        raise HTTPException(404, "Not found (the file may have been pruned).")\n\n    allowed = (1.0, 1.25, 1.5, 1.75, 2.0)\n    rate = next((x for x in allowed if abs(float(speed) - x) < 0.001), None)\n    if rate is None:\n        raise HTTPException(400, "Unsupported playback speed")\n\n    out = base\n    if rate != 1.0:\n        tag = str(rate).replace(".", "_")\n        out = base.parent / f"audio-{tag}x.m4a"\n        if not out.exists():\n            tmp = base.parent / f"audio-{tag}x-{uuid.uuid4().hex[:8]}.tmp.m4a"\n            try:\n                proc = subprocess.run(\n                    [\n                        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",\n                        "-i", str(base),\n                        "-filter:a", f"atempo={rate}",\n                        "-c:a", "aac", "-b:a", "64k",\n                        str(tmp),\n                    ],\n                    capture_output=True, text=True, timeout=300, check=False,\n                )\n                if proc.returncode != 0 or not tmp.exists():\n                    raise RuntimeError((proc.stderr or "tempo conversion failed").strip())\n                tmp.replace(out)\n            except Exception as e:  # noqa: BLE001\n                tmp.unlink(missing_ok=True)\n                raise HTTPException(500, f"Could not prepare {rate}x audio: {e}") from e\n\n    meta = next((j for j in _jobs() if j["id"] == job_id), None)\n    title = re.sub(r"[^A-Za-z0-9 _\\-]", "", (meta or {}).get("title", "narration")).strip() or "narration"\n    suffix = "" if rate == 1.0 else f" {rate}x"\n    return FileResponse(out, media_type="audio/mp4", filename=f"{title[:52]}{suffix}.m4a")'''

if old_download not in p:
    raise SystemExit("tempo patch failed: download endpoint pattern not found")
p = p.replace(old_download, new_download, 1)
server.write_text(p)

print("Applied server-side pitch-preserving tempo playback patch")
