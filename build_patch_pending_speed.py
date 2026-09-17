from pathlib import Path

p = Path("app/app.js")
s = p.read_text()

old = '''    if (gen.active) return;\n    this.speed = 1;'''
new = '''    if (gen.active) {\n      // The live Web Audio stream cannot be sped up on iPhone without shifting pitch.\n      // Stop live playback and resume automatically from the pitch-correct finished file.\n      if (r !== 1) {\n        this.pause();\n        gen.wantsPlay = true;\n        $("#playerNote").textContent = `Preparing ${r}× pitch-correct playback…`;\n      } else {\n        $("#playerNote").textContent = "Playing as it generates…";\n        if (gen.wantsPlay && !this.playing) this.play();\n      }\n      return;\n    }\n    this.speed = 1;'''

if old not in s:
    raise SystemExit("pending-speed patch failed: live speed anchor not found")
s = s.replace(old, new, 1)

old2 = '''      $("#playerNote").textContent = "Audio ready · replay or save anytime";'''
new2 = '''      $("#playerNote").textContent = rate === 1\n        ? "Audio ready · replay or save anytime"\n        : `Audio ready · ${rate}× · pitch preserved`;'''
if old2 not in s:
    raise SystemExit("pending-speed patch failed: ready note anchor not found")
s = s.replace(old2, new2, 1)

p.write_text(s)

index = Path("app/index.html")
h = index.read_text()
h = h.replace('app.js?v=20260917-tempo1', 'app.js?v=20260917-tempo2')
index.write_text(h)

sw = Path("app/sw.js")
w = sw.read_text()
w = w.replace('pocket-ios-20260917-tempo1', 'pocket-ios-20260917-tempo2')
sw.write_text(w)

print("Applied explicit queued-speed playback behavior")
