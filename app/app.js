/* Pocket TTS 3 (English) — iPhone-first web app */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const mm = String(m).padStart(2, "0"), sss = String(ss).padStart(2, "0");
  return h ? `${h}:${mm}:${sss}` : `${m}:${sss}`;
}
function wordsOf(text) {
  return (text.trim().match(/\S+/g) || []).length;
}

/* ---------------- audio context (iOS unlock) ---------------- */
let actx = null;
function ensureAudio(unlock = false) {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    actx.onstatechange = () => player._paintNow();
  }
  if (unlock && actx.state !== "running") actx.resume().catch(() => {});
  return actx;
}

/* ---------------- IndexedDB (cloned voices live in the browser) ---------------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pocket-tts3", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("voices", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbAll(store) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readonly");
    const q = tx.objectStore(store).getAll();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbPut(store, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(val);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbDel(store, key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

/* ---------------- streaming player (Web Audio queue) ---------------- */
class StreamPlayer {
  constructor() {
    this.q = [];
    this.sources = new Map();
    this.total = 0;
    this.offset = 0;
    this.anchor = 0;
    this.speed = 1;
    this.playing = false;
    this.native = null;
    this._raf = null;
  }
  get src() { return this.playing ? (this.native || this.sources.values().next().value || null) : null; }
  ctx() { return ensureAudio(); }
  _pos() {
    if (this.native) return this.native.currentTime || 0;
    return this.playing && actx
      ? Math.min(this.total, this.offset + Math.max(0, actx.currentTime - this.anchor) * this.speed)
      : this.offset;
  }
  queueReal() { return Math.max(0, (this.total - this._pos()) / this.speed); }
  enqueue(buffer) {
    const starved = this.playing && !this.sources.size && this._pos() >= this.total;
    if (starved) { this.offset = this.total; this.anchor = this.ctx().currentTime + 0.04; }
    this.q.push({buffer, start: this.total});
    this.total += buffer.duration;
    if (this.playing) this._schedule();
    this._paint();
  }
  _schedule() {
    if (!this.playing || this.native) return;
    const c = this.ctx(), pos = this._pos();
    for (const rec of this.q) {
      if (this.sources.has(rec) || rec.start + rec.buffer.duration <= pos) continue;
      const skip = Math.max(0, pos - rec.start);
      const when = Math.max(c.currentTime, this.anchor + (rec.start + skip - this.offset) / this.speed);
      const src = c.createBufferSource();
      src.buffer = rec.buffer;
      src.playbackRate.value = this.speed;
      src.connect(c.destination);
      src.onended = () => {
        this.sources.delete(rec);
        src.disconnect();
        const cutoff = this._pos() - 30;
        this.q = this.q.filter(r => r.start + r.buffer.duration >= cutoff);
        if (gen.done && !this.sources.size && this._pos() >= this.total) {
          this.offset = this.total; this.playing = false;
        }
        this._paintNow();
      };
      this.sources.set(rec, src);
      src.start(when, skip);
    }
  }
  _clearSources() {
    for (const src of this.sources.values()) {
      src.onended = null;
      try { src.stop(); src.disconnect(); } catch (_) {}
    }
    this.sources.clear();
  }
  play() {
    ensureAudio(true);
    if (this.native) {
      this.native.play().catch(() => toast("Tap Play to start the audio."));
      return;
    }
    if (this.playing) return;
    if (this.offset >= this.total && gen.done) this.offset = this.q[0]?.start || 0;
    this.anchor = this.ctx().currentTime + 0.04;
    this.playing = true;
    this._schedule();
    this._paint();
  }
  pause() {
    if (this.native) { this.native.pause(); return; }
    this.offset = this._pos();
    this.playing = false;
    this._clearSources();
    this._paintNow();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() {
    this.pause();
    if (this.native) {
      this.native.pause();
      this.native.removeAttribute("src");
      this.native.load();
    }
    this.native = null;
    this.q = []; this.total = 0; this.offset = 0;
    cancelAnimationFrame(this._raf);
    this._raf = null;
    this._paintNow();
  }
  seek(t) {
    if (this.native) {
      this.native.currentTime = Math.max(0, Math.min(t, this.native.duration || 0));
    } else {
      const wasPlaying = this.playing;
      this.pause();
      const first = this.q[0]?.start || 0;
      this.offset = Math.max(first, Math.min(t, this.total));
      if (t < first) toast("Earlier audio is available when generation finishes.");
      if (wasPlaying) this.play();
    }
    this._paintNow();
  }
  setSpeed(r) {
    if (this.native) { this.speed = r; this.native.playbackRate = r; return; }
    const wasPlaying = this.playing;
    this.pause(); this.speed = r;
    if (wasPlaying) this.play();
  }
  useFinished(url) {
    const audio = $("#finishedAudio");
    audio.onloadedmetadata = () => {
      if (!gen.done || !$("#playerCard") || $("#playerCard").hidden) return;
      const pos = this._pos(), resume = this.playing;
      this.pause(); this._clearSources(); this.q = [];
      this.native = audio;
      this.total = Number.isFinite(audio.duration) ? audio.duration : this.total;
      audio.currentTime = Math.min(pos, audio.duration || pos);
      audio.playbackRate = this.speed;
      audio.preservesPitch = true;
      audio.onplay = () => { this.playing = true; this._paint(); };
      audio.onpause = () => { this.playing = false; this._paintNow(); };
      audio.onended = () => { this.playing = false; this._paintNow(); };
      audio.ontimeupdate = () => this._paintNow();
      $("#playerNote").textContent = "Audio ready · replay or save anytime";
      if (resume) audio.play().catch(() => { this.playing = false; this._paintNow(); toast("Audio ready. Tap Play to continue."); });
      this._paintNow();
    };
    audio.src = url;
    audio.load();
  }
  _paint() {
    cancelAnimationFrame(this._raf);
    this._paintNow();
    if (this.playing) this._raf = requestAnimationFrame(() => this._paint());
  }
  _paintNow() {
    const pos = this._pos();
    $("#tCur").textContent = fmtTime(pos);
    $("#tTot").textContent = gen.done ? fmtTime(this.total) : `${fmtTime(this.total)} buffered`;
    $("#playBar").style.width = this.total ? Math.min(100, pos / this.total * 100) + "%" : "0%";
    $("#playBtn").textContent = this.playing ? "❚❚" : "▶︎";
    $("#playBtn").setAttribute("aria-label", this.playing ? "Pause" : "Play");
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = this.playing ? "playing" : "paused";
  }
}
const player = new StreamPlayer();

/* ---------------- generation ---------------- */
const gen = {
  active: false, done: false, wantsPlay: false,
  ctrl: null, jobId: null, reader: null,
  frameBuf: new Uint8Array(0), pool: new Uint8Array(0),
  estBytes: 1, recv: 0, title: "", voiceLabel: "",
};
function concatBytes(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a); c.set(b, a.length);
  return c;
}
function wavFromPcm(pcm) {
  const h = new ArrayBuffer(44);
  const dv = new DataView(h);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); dv.setUint32(4, 36 + pcm.length, true); ws(8, "WAVE"); ws(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, "data"); dv.setUint32(40, pcm.length, true);
  return new Blob([h, pcm], { type: "audio/wav" });
}
let decodeChain = Promise.resolve();
function decodePool() {
  const session = gen.session;
  const pcm = gen.pool;
  gen.pool = new Uint8Array(0);
  if (pcm.length < 44) return;
  // serialize decodes so buffers enqueue in order
  decodeChain = decodeChain.then(async () => {
    try {
      if (session !== gen.session) return;
      const buf = ensureAudio().createBuffer(1, pcm.length / 2, 24000);
      const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      const channel = buf.getChannelData(0);
      for (let i = 0; i < channel.length; i++) channel[i] = samples.getInt16(i * 2, true) / 32768;
      player.enqueue(buf);
      if (gen.wantsPlay && !player.src && !gen.playerStarted) {
        gen.playerStarted = true;
        player.toggle();
      }
    } catch (e) {
      console.error("decode failed", e);
    }
  });
}
function feed(chunk) {
  gen.frameBuf = concatBytes(gen.frameBuf, chunk);
  let off = 0;
  while (gen.frameBuf.length - off >= 4) {
    const len = new DataView(gen.frameBuf.buffer, gen.frameBuf.byteOffset + off, 4).getUint32(0, true);
    if (len > 4_800_000 || len % 2) throw new Error("Invalid audio received from the server.");
    if (gen.frameBuf.length - off - 4 < len) break;
    gen.pool = concatBytes(gen.pool, gen.frameBuf.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  if (off > 0) gen.frameBuf = gen.frameBuf.subarray(off);
  gen.recv += chunk.length;
  if (gen.pool.length >= 48000) decodePool();
  // progress
  const pct = Math.min(99, Math.round((gen.recv / gen.estBytes) * 100));
  $("#genPct").textContent = pct + "%";
  $("#genBar").style.width = pct + "%";
  $("#genEta").textContent = gen.done
    ? "done"
    : `${fmtTime(gen.recv / 48000)} generated of ~${fmtTime(gen.estBytes / 48000)}`;
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* ---------------- voice selection ---------------- */
let selVoice = null;      // {kind:'builtin', id} | {kind:'clone', id, name}
let myVoices = [];
let statusInfo = null;

function voiceLabel() {
  if (!selVoice) return "no voice";
  if (selVoice.kind === "builtin") return selVoice.name;
  return selVoice.name + " (cloned)";
}
function voicePayload() {
  if (!selVoice) return null;
  if (selVoice.kind === "builtin") return { voice_builtin: selVoice.id, voice_label: selVoice.name };
  const v = myVoices.find((x) => x.id === selVoice.id);
  if (!v) return null;
  return { voice_state_b64: v.state_b64, voice_label: v.name + " (cloned)" };
}
function renderChips() {
  const wrap = $("#voiceChips");
  wrap.innerHTML = "";
  // pick a default voice before rendering so the active chip is correct
  if (!selVoice || !chipsContain(selVoice)) {
    selVoice = null;
    if (myVoices.length) selVoice = { kind: "clone", id: myVoices[0].id, name: myVoices[0].name };
    else if (statusInfo && statusInfo.voices.length)
      selVoice = { kind: "builtin", id: statusInfo.voices[0].id.split(":")[1], name: statusInfo.voices[0].name };
  }
  const mk = (item, active, extra = "") => {
    const b = document.createElement("button");
    b.className = "chip" + (active ? " active" : "") + extra;
    b.innerHTML = `<span class="n"></span><span class="d"></span>`;
    b.querySelector(".n").textContent = item.name;
    b.querySelector(".d").textContent = item.desc || "";
    b.onclick = () => { selVoice = item; renderChips(); };
    wrap.appendChild(b);
  };
  for (const v of myVoices)
    mk({ kind: "clone", id: v.id, name: v.name, desc: fmtTime(v.duration_s || 0) + " sample · " + (v.size_mb || "?") + " MB" },
       selVoice && selVoice.kind === "clone" && selVoice.id === v.id, " mine");
  if (statusInfo)
    for (const v of statusInfo.voices)
      mk({ kind: "builtin", id: v.id.split(":")[1], name: v.name, desc: v.desc },
         selVoice && selVoice.kind === "builtin" && selVoice.id === v.id.split(":")[1]);
}
function chipsContain(v) {
  if (v.kind === "clone") return myVoices.some((x) => x.id === v.id);
  return !!(statusInfo && statusInfo.voices.some((x) => x.id === "builtin:" + v.id));
}

/* ---------------- text sources ---------------- */
let mode = "text";
let docText = "";
let docTitle = "";

$("#modeText").onclick = () => setMode("text");
$("#modeFile").onclick = () => setMode("file");
function setMode(m) {
  mode = m;
  $("#modeText").classList.toggle("active", m === "text");
  $("#modeFile").classList.toggle("active", m === "file");
  $("#textInput").hidden = m !== "text";
  $("#fileRow").hidden = m !== "file";
}
$("#filePick").onclick = () => $("#fileInput").click();
$("#docClear").onclick = () => {
  docText = ""; docTitle = "";
  $("#docCard").hidden = true;
  $("#filePickLabel").textContent = "Choose a PDF, EPUB or TXT file";
};
$("#fileInput").onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  e.target.value = "";
  $("#filePickLabel").textContent = "Reading " + f.name + "…";
  try {
    const { title, text } = await parseFile(f);
    const w = wordsOf(text);
    if (w < 10) throw new Error("Could not find readable text in this file.");
    docText = text; docTitle = title;
    $("#docTitle").textContent = title;
    $("#docMeta").textContent = `${(w / 1000).toFixed(1)}k words · ~${fmtTime(w / 2.5)} of audio`;
    $("#docCard").hidden = false;
    toast(`Extracted ${w.toLocaleString()} words`);
  } catch (err) {
    $("#filePickLabel").textContent = "Choose a PDF, EPUB or TXT file";
    toast("Couldn't read that file: " + err.message, 4000);
  }
};

async function parseFile(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "txt") {
    let t = await file.text();
    t = t.replace(/^\uFEFF/, "");
    return { title: file.name, text: t };
  }
  if (ext === "epub") return parseEpub(file);
  if (ext === "pdf") return parsePdf(file);
  throw new Error("Unsupported file type (use PDF, EPUB or TXT).");
}
async function parseEpub(file) {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const cxml = await zip.file("META-INF/container.xml").async("string");
  const m = cxml.match(/full-path="([^"]+)"/);
  if (!m) throw new Error("Not a valid EPUB (no OPF).");
  const opf = await zip.file(m[1]).async("string");
  const dom = new DOMParser().parseFromString(opf, "application/xml");
  const base = m[1].replace(/[^/]*$/, "");
  const manifest = {};
  for (const item of dom.getElementsByTagName("item"))
    manifest[item.getAttribute("id")] = item.getAttribute("href");
  const texts = [];
  for (const ref of dom.getElementsByTagName("itemref")) {
    const href = manifest[ref.getAttribute("idref")];
    if (!href) continue;
    const path = decodeURIComponent(new URL(href, "https://epub.local/" + base).pathname.slice(1));
    const f = zip.file(path);
    if (!f) continue;
    const html = await f.async("string");
    const hdom = new DOMParser().parseFromString(html, "text/html");
    for (const bad of hdom.querySelectorAll("script,style")) bad.remove();
    for (const el of hdom.querySelectorAll("p,div,h1,h2,h3,h4,h5,h6,li,blockquote,article,section"))
      el.insertAdjacentText("afterend", "\n");
    for (const el of hdom.querySelectorAll("br")) el.replaceWith("\n");
    let t = (hdom.body.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (t) texts.push(t);
  }
  if (!texts.length) throw new Error("No readable content in EPUB.");
  return { title: file.name, text: texts.join("\n\n") };
}
async function parsePdf(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "libs/pdf.worker.min.js";
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    let s = "";
    for (const it of tc.items) {
      if (it.str) s += it.str;
      s += it.hasEOL || it.hasBreak ? "\n" : " ";
    }
    pages.push(s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim());
  }
  const text = pages.join("\n\n");
  await pdf.destroy();
  if (!text.trim()) throw new Error("No selectable text — this PDF may be scanned images.");
  return { title: file.name, text };
}

/* ---------------- generation flow ---------------- */
$("#generateBtn").onclick = startGeneration;
$("#cancelBtn").onclick = () => cancelGeneration();
$("#stopBtn").onclick = () => { cancelGeneration(true, true); };

function currentText() {
  if (mode === "text") return $("#textInput").value;
  return docText;
}

async function startGeneration() {
  const text = currentText();
  const w = wordsOf(text);
  if (w < 2) return toast("Add some text or a file first.");
  const payload = voicePayload();
  if (!payload) return toast("Choose a voice first.");
  if (gen.active) return;

  ensureAudio(true);
  const session = (gen.session || 0) + 1;
  Object.assign(gen, {
    session,
    active: true, done: false, wantsPlay: true, playerStarted: false,
    frameBuf: new Uint8Array(0), pool: new Uint8Array(0), recv: 0, jobId: null,
    title: docTitle || (mode === "text" ? "My text" : "Narration"),
    voiceLabel: voiceLabel(),
  });
  gen.title = gen.title || "Narration";
  if (mode === "text" && !docTitle) {
    const first = text.replace(/\s+/g, " ").trim().slice(0, 48);
    if (first) gen.title = first + (text.trim().length > 48 ? "…" : "");
  }
  player.stop();
  $("#playerCard").hidden = false;
  $("#playerTitle").textContent = gen.title;
  $("#playerVoice").textContent = gen.voiceLabel + " · Pocket TTS 3";
  $("#downloadBtn").hidden = true;
  $("#playerNote").textContent = "Playing as it generates…";
  $("#progressCard").hidden = false;
  $("#generateBtn").disabled = true;
  $("#genTitle").textContent = "Generating “" + gen.title + "”";
  setMediaSession();
  requestWakeLock();
  $("#playerCard").scrollIntoView({ behavior: "smooth", block: "nearest" });

  gen.ctrl = new AbortController();
  const signal = gen.ctrl.signal;
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, text, title: gen.title }),
      signal: gen.ctrl.signal,
    });
    if (!res.ok) {
      let msg = "Generation failed";
      try { msg = (await res.json()).detail || msg; } catch (e) {}
      throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    }
    gen.jobId = res.headers.get("X-Job-Id");
    const est = parseInt(res.headers.get("X-Est-Seconds") || "0", 10);
    gen.estBytes = Math.max(48000, est * 48000);
    gen.reader = res.body.getReader();
    while (true) {
      // Keep at most a minute of upcoming audio plus 30 seconds of rewind history.
      while (player.queueReal() > 60 && !signal.aborted) await sleep(250);
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      const { done, value } = await gen.reader.read();
      if (done) break;
      feed(value);
    }
    // flush
    if (gen.pool.length) decodePool();
    await decodeChain;
    const finished = await fetch("/api/jobs/" + gen.jobId, { signal }).then(r => r.json());
    if (finished.status !== "done") throw new Error(finished.error || "Generation did not finish. Please try again.");
    gen.done = true;
    $("#genBar").style.width = "100%";
    $("#genPct").textContent = "100%";
    $("#genEta").textContent = "done";
    if (gen.jobId) {
      $("#downloadBtn").hidden = false;
      $("#downloadBtn").onclick = () => {
        const a = document.createElement("a");
        a.href = "/api/download/" + gen.jobId;
        a.download = "";
        a.click();
        toast("Use Share → Save to Files to keep the audio.");
      };
    }
    player.useFinished("/api/download/" + gen.jobId);
    toast("Audio ready — tap Save to download");
  } catch (err) {
    if (err.name === "AbortError") { /* cancelled */ }
    else {
      toast("Error: " + err.message, 6000);
      $("#playerNote").textContent = err.message;
      if (gen.jobId) fetch("/api/jobs/" + gen.jobId + "/cancel", { method: "POST" }).catch(() => {});
      player.stop();
    }
  }
  if (session !== gen.session) return;
  releaseWakeLock();
  gen.active = false;
  gen.reader = null;
  $("#generateBtn").disabled = false;
  $("#progressCard").hidden = true;
  setTimeout(refreshRecent, 1500);
}

function cancelGeneration(silent, closePlayer) {
  const wasActive = gen.active || (gen.jobId && !gen.done);
  gen.session = (gen.session || 0) + 1;
  releaseWakeLock();
  if (gen.ctrl) { try { gen.ctrl.abort(); } catch (e) {} }
  if (wasActive && gen.jobId) fetch("/api/jobs/" + gen.jobId + "/cancel", { method: "POST" }).catch(() => {});
  gen.active = false; gen.done = false;
  player.stop();
  $("#progressCard").hidden = true;
  $("#generateBtn").disabled = false;
  if (closePlayer) $("#playerCard").hidden = true;
  if (!silent) toast("Stopped");
}

/* ---------------- media session (lock screen) ---------------- */
function setMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: gen.title, artist: gen.voiceLabel, album: "Pocket TTS 3",
  });
  navigator.mediaSession.playbackState = "playing";
  navigator.mediaSession.setActionHandler("play", () => player.play());
  navigator.mediaSession.setActionHandler("pause", () => player.pause());
  try { navigator.mediaSession.setActionHandler("seekto", (d) => { if (d.seekTime != null) player.seek(d.seekTime); });
  navigator.mediaSession.setActionHandler("seekbackward", () => player.seek(Math.max(0, player._pos() - 15)));
  navigator.mediaSession.setActionHandler("seekforward", () => player.seek(player._pos() + 15)); } catch (_) {}
}

/* player controls */
$("#playBtn").onclick = () => { player.toggle(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = player.src ? "playing" : "paused"; };
$("#backBtn").onclick = () => player.seek(Math.max(0, player._pos() - 15));
$("#fwdBtn").onclick = () => player.seek(player._pos() + 15);
const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
let speedIdx = 0;
$("#speedBtn").onclick = () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  player.setSpeed(SPEEDS[speedIdx]);
  $("#speedBtn").textContent = SPEEDS[speedIdx] + "×";
};

/* ---------------- recent jobs ---------------- */
async function refreshRecent() {
  try {
    const r = await (await fetch("/api/jobs")).json();
    const list = r.jobs || [];
    const card = $("#recentCard");
    if (!list.length) { card.hidden = true; return; }
    card.hidden = false;
    const el = $("#recentList");
    el.innerHTML = "";
    for (const j of list.slice(0, 5)) {
      const div = document.createElement("div");
      div.className = "recent-item";
      const when = new Date(j.created * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      div.innerHTML = `<div class="r-main"><div class="r-title"></div><div class="r-meta"></div></div>`;
      div.querySelector(".r-title").textContent = j.title;
      div.querySelector(".r-meta").textContent = `${j.voice} · ${fmtTime(j.duration_s)} · ${when}`;
      const b = document.createElement("button");
      b.className = "v-btn";
      b.textContent = "⬇︎ M4A";
      b.onclick = () => {
        const a = document.createElement("a");
        a.href = "/api/download/" + j.id;
        a.click();
      };
      div.appendChild(b);
      el.appendChild(div);
    }
  } catch (e) {}
}

/* ---------------- status + setup ---------------- */
async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    statusInfo = s;
    $("#statusSub").textContent = s.ready
      ? (s.cloning_enabled ? "cloning ready" : "built-in voices only")
      : (s.error ? "Model unavailable — retrying…" : "Preparing voices… first use may take a minute");
    $("#setupBtnTop").hidden = s.cloning_enabled;
    setupScreenNote();
    $("#generateBtn").disabled = gen.active || !s.ready;
    renderChips();
    if (!s.ready) setTimeout(refreshStatus, 4000);
    return s;
  } catch (e) {
    $("#statusSub").textContent = "server offline";
    setTimeout(refreshStatus, 5000);
    return null;
  }
}

let setupDone = false;
function showSetupIfNeeded(s) {
  if (!s) { showMain(); return; }  // server offline — show main, statusSub explains
  if (s.cloning_enabled || s.ready_flag) { setupDone = true; showMain(); return; }
  if (setupDone || !s.ready) { showMain(); return; }
  $("#setup").hidden = false;
  $("#main").hidden = true;
  const saved = localStorage.getItem("ptt3.hf");
  if (saved) {
    $("#token").value = saved;
    $("#setupMsg").innerHTML = "This server needs the voice-cloning model downloaded once. A saved token was found in this browser — tap <b>Connect model</b> again (e.g. after a server restart).";
  }
}
function setupScreenNote() {
  if (statusInfo && statusInfo.ready_flag) {
    $("#setupMsg").innerHTML = "Voice cloning is <b>connected</b> on this server. Nothing more to do.";
    $("#setupBtn").disabled = true;
  }
}
$("#setupSkip").onclick = () => { setupDone = true; showMain(); };
$("#setupBtn").onclick = async () => {
  const token = $("#token").value.trim();
  if (!token) return toast("Paste your Hugging Face token (hf_…) first.");
  const btn = $("#setupBtn");
  btn.disabled = true;
  $("#setupStatus").textContent = "Verifying token…";
  try {
    $("#setupStatus").textContent = "Downloading the model (~210 MB) — usually under a minute…";
    const r = await (await fetch("/api/setup", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })).json();
    if (!r.ok) throw new Error(r.detail || "Setup failed");
    localStorage.setItem("ptt3.hf", token);
    $("#setupStatus").textContent = `Connected as ${r.hf_user} — voice cloning enabled ✓`;
    setTimeout(() => { setupDone = true; showMain(); refreshStatus(); }, 800);
  } catch (e) {
    $("#setupStatus").textContent = "✕ " + e.message;
  }
  btn.disabled = false;
};
function showMain() {
  $("#setup").hidden = true;
  $("#main").hidden = false;
}

/* ---------------- voice cloning ---------------- */
let sampleBlob = null;
let pendingVoice = null;   // {state_b64, duration_s, size_mb}
let rec = null, recStream = null, recTimer = null, recLevel = null, recSecs = 0;

$("#recBtn").onclick = async () => {
  if (rec) return;
  try { ensureAudio(true); } catch (e) {}
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    return toast("Microphone unavailable: " + e.message, 4000);
  }
  const mime = ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  try {
    rec = new MediaRecorder(recStream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  } catch (e) {
    rec = new MediaRecorder(recStream);
  }
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    recStream.getTracks().forEach((t) => t.stop());
    recStream = null; rec = null;
    clearInterval(recTimer); cancelAnimationFrame(recLevel);
    $("#recUI").hidden = true;
    $("#recBtn").disabled = false;
    sampleBlob = new Blob(chunks, { type: mime || "audio/mp4" });
    if (sampleBlob.size < 10000) return toast("That was too short — record at least 3 seconds.", 3500);
    $("#sampleMeta").textContent = `Recorded ${recSecs.toFixed(0)}s · ${(sampleBlob.size / 1024 / 1024).toFixed(1)} MB`;
    $("#sampleUI").hidden = false;
  };
  rec.start(250);
  recSecs = 0;
  $("#recUI").hidden = false;
  $("#recBtn").disabled = true;
  $("#recTime").textContent = "0:00";
  recTimer = setInterval(() => {
    recSecs += 1;
    $("#recTime").textContent = fmtTime(recSecs);
    if (recSecs >= 30 && rec) rec.stop();
  }, 1000);
  // level meter
  const ac = ensureAudio();
  const srcNode = ac.createMediaStreamSource(recStream);
  const an = ac.createAnalyser();
  an.fftSize = 512;
  srcNode.connect(an);
  const data = new Uint8Array(an.frequencyBinCount);
  const tick = () => {
    an.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
    $("#levelBar").style.width = Math.min(100, (peak / 120) * 100) + "%";
    recLevel = requestAnimationFrame(tick);
  };
  tick();
};
$("#stopRecBtn").onclick = () => { if (rec && rec.state !== "inactive") rec.stop(); };

$("#uploadBtn").onclick = () => $("#voiceFileInput").click();
$("#voiceFileInput").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (f.size > 40e6) return toast("File too large (max 40 MB).");
  sampleBlob = f;
  let dur = "";
  try {
    const a = new Audio(URL.createObjectURL(f));
    await new Promise((res) => { a.onloadedmetadata = res; a.onerror = res; setTimeout(res, 3000); });
    if (isFinite(a.duration)) dur = ` · ${a.duration.toFixed(0)}s`;
  } catch (err) {}
  $("#voiceName").value = f.name.replace(/\.[^.]+$/, "").slice(0, 40) || "My voice";
  $("#sampleMeta").textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(1)} MB${dur}`;
  $("#sampleUI").hidden = false;
};

$("#createBtn").onclick = async () => {
  if (!sampleBlob) return;
  const btn = $("#createBtn");
  btn.disabled = true;
  const name = $("#voiceName").value.trim() || "My voice";
  $("#cloneStatus").textContent = "Analyzing voice & building voice print…";
  $("#previewCard").hidden = true;
  requestWakeLock();
  try {
    const fd = new FormData();
    fd.append("file", sampleBlob, name + ".m4a");
    fd.append("name", name);
    const r = await (await fetch("/api/clone", { method: "POST", body: fd })).json();
    if (!("state_b64" in r)) throw new Error(r.detail || "Cloning failed");
    pendingVoice = { state_b64: r.state_b64, duration_s: r.duration_s, size_mb: r.size_mb };
    $("#cloneStatus").textContent = "Speaking a test sentence in your voice…";
    const previewResponse = await fetch("/api/preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice_state_b64: pendingVoice.state_b64 }),
    });
    if (!previewResponse.ok) {
      const error = await previewResponse.json();
      throw new Error(error.detail || "Voice preview failed. Please try again.");
    }
    const pr = await previewResponse.blob();
    const audio = $("#previewAudio");
    if (audio.src && audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(pr);
    $("#previewCard").hidden = false;
    $("#cloneStatus").textContent = "Voice ready. Listen below, then save it.";
    $("#previewCard").scrollIntoView({behavior:"smooth", block:"center"});
    audio.play().catch(() => {});
    $("#saveVoiceBtn").onclick = async () => {
      try { await idbPut("voices", {
        id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
        name, state_b64: pendingVoice.state_b64,
        duration_s: pendingVoice.duration_s, size_mb: pendingVoice.size_mb,
        createdAt: Date.now(),
        previewWav: pr,
      }); } catch (_) { toast("Could not save the voice. Check available storage and try again.", 5000); return; }
      pendingVoice = null;
      sampleBlob = null;
      $("#sampleUI").hidden = true;
      $("#previewCard").hidden = true;
      await loadMyVoices();
      toast(`“${name}” saved in this browser`);
    };
    $("#discardVoiceBtn").onclick = () => {
      pendingVoice = null; sampleBlob = null;
      $("#sampleUI").hidden = true;
      $("#previewCard").hidden = true;
      $("#previewAudio").src = "";
      $("#cloneStatus").textContent = "";
    };
  } catch (e) {
    $("#cloneStatus").textContent = "✕ " + e.message;
  }
  btn.disabled = false;
  releaseWakeLock();
};

async function loadMyVoices() {
  try { myVoices = (await idbAll("voices")).sort((a, b) => b.createdAt - a.createdAt); }
  catch (_) { myVoices = []; toast("Voice storage is unavailable. Use Safari with browser storage enabled.", 5000); }
  renderChips();
  renderVoiceList();
}
function renderVoiceList() {
  const el = $("#voiceList");
  el.innerHTML = "";
  if (!myVoices.length) {
    el.innerHTML = '<div class="empty">No cloned voices yet.<br>Record or upload a sample above.</div>';
    return;
  }
  for (const v of myVoices) {
    const div = document.createElement("div");
    div.className = "voice-item";
    const when = new Date(v.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    div.innerHTML = `
      <div class="v-main">
        <div class="v-name"></div>
        <div class="v-meta">${when} · ${v.size_mb || "?"} MB · sample ${fmtTime(v.duration_s || 0)}</div>
      </div>`;
    div.querySelector(".v-name").textContent = v.name;
    const play = document.createElement("button");
    play.className = "v-btn"; play.textContent = "▶︎ Play";
    play.onclick = () => {
      try { ensureAudio(true); } catch (e) {}
      const a = new Audio(URL.createObjectURL(v.previewWav));
      a.play().catch(() => {});
    };
    const use = document.createElement("button");
    use.className = "v-btn"; use.textContent = "Use";
    use.onclick = () => {
      selVoice = { kind: "clone", id: v.id, name: v.name };
      switchTab("read");
      renderChips();
      toast(`“${v.name}” selected`);
    };
    const del = document.createElement("button");
    del.className = "v-btn del"; del.textContent = "✕";
    del.onclick = async () => {
      if (!confirm(`Delete voice “${v.name}”?`)) return;
      await idbDel("voices", v.id);
      if (selVoice && selVoice.kind === "clone" && selVoice.id === v.id) selVoice = null;
      await loadMyVoices();
    };
    div.append(play, use, del);
    el.appendChild(div);
  }
}

/* ---------------- tabs ---------------- */
function switchTab(t) {
  $("#viewRead").hidden = t !== "read";
  $("#viewVoices").hidden = t !== "voices";
  $("#tabRead").classList.toggle("active", t === "read");
  $("#tabVoices").classList.toggle("active", t === "voices");
}
$("#tabRead").onclick = () => switchTab("read");
$("#tabVoices").onclick = () => switchTab("voices");
$("#setupBtnTop").onclick = () => { setupDone = false; $("#main").hidden = true; $("#setup").hidden = false; };

/* ---------------- boot ---------------- */
(async function boot() {
  showMain();
  const s = await refreshStatus();
  showSetupIfNeeded(s);
  await loadMyVoices();
  refreshRecent();
})();

/* Keep the screen awake while new audio is being prepared, when iOS permits it. */
let wakeLock = null;
async function requestWakeLock() {
  if (!navigator.wakeLock || document.visibilityState !== "visible" || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } catch (_) {}
}
function releaseWakeLock() { if (wakeLock) wakeLock.release().catch(() => {}); wakeLock = null; }
document.addEventListener("visibilitychange", () => { if (gen.active) requestWakeLock(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// Expose the same text-entry action to browsers that support WebMCP.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: "stage_narration_text",
      title: "Prepare text for narration",
      description: "Place text in the Read tab. The user can choose a voice and tap Generate audio.",
      inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 500000 } }, required: ["text"], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 500000) throw new Error("Provide between 1 and 500,000 characters of text.");
        if (gen.active) throw new Error("Wait for the current narration to finish.");
        switchTab("read"); setMode("text"); $("#textInput").value = input.text;
        return { status: "ready_to_generate", words: wordsOf(input.text) };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
    window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
  } catch (_) {}
}
