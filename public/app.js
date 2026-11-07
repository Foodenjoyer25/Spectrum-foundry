(() => {
"use strict";
const $ = (s) => document.querySelector(s);
const { SR, TAU, PALETTES, STYLES, clamp, mulberry, buildPalette, createState, computeFrame, renderFrame, renderWarm, warmFrames, warmUpExport, fmtTime } = window.SpectrumRenderer;

/* ---------------- app state ---------------- */
let audio = null;
const ui = {
  style: "radial", pal: "aurora", bgMode: "glow", textPos: "bl", bgImg: null, bgFile: null, proc: "client",
};
function opts() {
  const p = ui.pal === "custom" ? { ...PALETTES.find(x => x.id === "custom"), stops: [$("#c1").value, $("#c2").value], bg: $("#cbg").value } : PALETTES.find(x => x.id === ui.pal);
  const key = JSON.stringify([p.stops, p.bg]);
  if (!opts.cache || opts.cache.key !== key) opts.cache = { key, built: buildPalette(p) };
  const dur = audio ? audio.duration : 1;
  let cs = clamp(parseFloat($("#clipStart").value) || 0, 0, dur), ce = parseFloat($("#clipEnd").value);
  if (!(ce > cs)) ce = dur; ce = Math.min(ce, dur);
  const fmin = clamp(parseFloat($("#fmin").value) || 35, 20, 400), fmax = clamp(parseFloat($("#fmax").value) || 16000, fmin * 4, 22000);
  return {
    style: ui.style, pal: opts.cache.built, bgMode: ui.bgMode, bgImg: ui.bgImg, dim: +$("#dim").value,
    bands: +$("#bands").value, gain: +$("#gain").value, smooth: +$("#smooth").value, glow: +$("#glow").value,
    fmin, fmax, title: $("#title").value.trim(), artist: $("#artist").value.trim(), textPos: ui.textPos,
    showProgress: $("#showProgress").checked, showTime: $("#showTime").checked, clipStart: cs, clipEnd: ce,
    pcm: audio ? audio.pcm : null,
  };
}
function outSize() { const [w, h] = $("#res").value.split("x").map(Number); return { W: w, H: h }; }

/* ---------------- preview ---------------- */
const pv = $("#preview"), pctx = pv.getContext("2d");
let curT = 0, playing = false, actx = null, src = null, playStart = 0, pvState = null, lastNow = 0, busy = false;
function sizePreview() {
  const { W, H } = outSize();
  const w = Math.round(W * Math.min(1, 1280 / W, 1280 / H)), h = Math.round(H * Math.min(1, 1280 / W, 1280 / H));
  if (pv.width !== w || pv.height !== h) { pv.width = w; pv.height = h; pvState = null; }
}
function nowT() { if (!playing) return curT; const lat = (actx.outputLatency || 0) + (actx.baseLatency || 0); return Math.max(0, actx.currentTime - playStart - lat); }
function drawPaused() {
  if (!audio || busy) return;
  sizePreview();
  const o = opts();
  pvState = renderWarm(pctx, pv.width, pv.height, curT, o, warmFrames(o.style));
}
let pausedRaf = 0;
function schedulePaused() { if (playing) return; cancelAnimationFrame(pausedRaf); pausedRaf = requestAnimationFrame(drawPaused); }
function loop(ts) {
  if (!playing) return;
  const dt = clamp((ts - lastNow) / 1000, 0.001, 0.1); lastNow = ts;
  const t = nowT();
  if (t >= audio.duration) { pause(); curT = 0; updateTimeline(); schedulePaused(); return; }
  sizePreview();
  if (!pvState) pvState = createState();
  renderFrame(pctx, pv.width, pv.height, pvState, t, dt, opts());
  curT = t; updateTimeline();
  requestAnimationFrame(loop);
}
function play() {
  if (!audio || busy) return;
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  actx.resume();
  if (curT >= audio.duration - 0.05) curT = 0;
  src = actx.createBufferSource(); src.buffer = audio.buffer; src.connect(actx.destination);
  src.start(0, curT); playStart = actx.currentTime - curT; playing = true;
  setPlayIcon(true); lastNow = performance.now(); requestAnimationFrame(loop);
}
function pause() {
  if (!playing) return;
  curT = nowT(); playing = false;
  try { src.stop(); } catch (e) {}
  src = null; setPlayIcon(false);
}
function seek(t) {
  const was = playing; if (was) pause();
  curT = clamp(t, 0, audio ? audio.duration : 0); updateTimeline();
  if (was) play(); else { schedulePaused(); scheduleThumbs(); }
}
function setPlayIcon(on) {
  $("#playIcon").innerHTML = on ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4.5v15l13-7.5z"/>';
  $("#play").setAttribute("aria-label", on ? "Pause" : "Play");
}
$("#play").onclick = () => playing ? pause() : play();
document.addEventListener("keydown", e => { if (e.code === "Space" && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); playing ? pause() : play(); } });

/* ---------------- timeline ---------------- */
const tl = $("#timeline"), tlc = $("#tlCanvas");
let overview = null;
function buildOverview() {
  const bins = 600, pcm = audio.pcm, per = Math.floor(pcm.length / bins); overview = new Float32Array(bins);
  let mx = 1e-6;
  for (let b = 0; b < bins; b++) { let p = 0; for (let i = b * per, e = i + per; i < e; i += 16) { const v = Math.abs(pcm[i]); if (v > p) p = v; } overview[b] = p; if (p > mx) mx = p; }
  for (let b = 0; b < bins; b++) overview[b] /= mx;
}
function updateTimeline() {
  if (!audio) return;
  const dpr = window.devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
  if (tlc.width !== Math.round(w * dpr)) { tlc.width = Math.round(w * dpr); tlc.height = Math.round(h * dpr); }
  const c = tlc.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.documentElement), accent = cs.getPropertyValue("--accent").trim(), muted = cs.getPropertyValue("--muted").trim();
  const o = opts(), d = audio.duration, x0 = o.clipStart / d * w, x1 = o.clipEnd / d * w;
  c.globalAlpha = 0.12; c.fillStyle = accent; c.fillRect(x0, 0, x1 - x0, h); c.globalAlpha = 1;
  const p = curT / d;
  for (let i = 0; i < w; i += 2) {
    const v = overview[Math.floor(i / w * overview.length)] || 0, bh = Math.max(1, v * (h - 10));
    c.fillStyle = i / w <= p ? accent : muted; c.globalAlpha = i / w <= p ? 0.95 : 0.45;
    c.fillRect(i, (h - bh) / 2, 1.2, bh);
  }
  c.globalAlpha = 1; c.fillStyle = accent; c.fillRect(p * w - 1, 0, 2, h);
  $("#tcNow").textContent = fmtTime(curT, true); $("#tcDur").textContent = fmtTime(d);
  tl.setAttribute("aria-valuenow", Math.round(p * 100));
  $("#tcClip").textContent = (o.clipStart > 0 || o.clipEnd < d) ? "clip " + fmtTime(o.clipStart) + "–" + fmtTime(o.clipEnd) : "full track";
}
let dragging = false;
function tlSeek(e) { const r = tl.getBoundingClientRect(); seek(clamp((e.clientX - r.left) / r.width) * audio.duration); }
tl.addEventListener("pointerdown", e => { if (!audio || busy) return; dragging = true; tl.setPointerCapture(e.pointerId); tlSeek(e); });
tl.addEventListener("pointermove", e => { if (dragging) tlSeek(e); });
tl.addEventListener("pointerup", () => { dragging = false; });
tl.addEventListener("keydown", e => { if (!audio) return; if (e.key === "ArrowRight") seek(curT + 5); if (e.key === "ArrowLeft") seek(curT - 5); });
window.addEventListener("resize", () => updateTimeline());

/* ---------------- style gallery ---------------- */
const stylesEl = $("#styles");
const thumbs = {};
for (const s of STYLES) {
  const b = document.createElement("button"); b.className = "style-btn"; b.id = "style-" + s.id;
  b.setAttribute("aria-pressed", String(s.id === ui.style));
  const c = document.createElement("canvas"); c.width = 320; c.height = 180; thumbs[s.id] = c;
  const lab = document.createElement("span"); lab.innerHTML = `${s.name}<small>${s.tag}</small>`;
  b.append(c, lab);
  b.onclick = () => { ui.style = s.id; for (const x of stylesEl.children) x.setAttribute("aria-pressed", String(x === b)); pvState = null; schedulePaused(); };
  stylesEl.append(b);
}
let thumbTimer = 0;
function scheduleThumbs() { clearTimeout(thumbTimer); thumbTimer = setTimeout(drawThumbs, 120); }
function drawThumbs() {
  if (!audio || busy) return;
  const base = opts(), t = Math.max(curT, 0.05);
  for (const s of STYLES) {
    const c = thumbs[s.id], ctx = c.getContext("2d");
    renderWarm(ctx, c.width, c.height, t, { ...base, style: s.id, textPos: "none", showProgress: false, showTime: false }, warmFrames(s.id));
  }
}

/* ---------------- controls ---------------- */
const swEl = $("#swatches");
for (const p of PALETTES) {
  const b = document.createElement("button"); b.className = "sw"; b.id = "pal-" + p.id; b.setAttribute("aria-pressed", String(p.id === ui.pal));
  const grad = p.id === "custom" ? "conic-gradient(from 90deg, #ff4d6d, #ffd166, #06d6a0, #4dd2ff, #9b5de5, #ff4d6d)" : `linear-gradient(90deg, ${p.stops.join(",")})`;
  b.innerHTML = `<i style="background:${grad}; box-shadow: inset 0 -6px 0 ${p.bg}"></i><b>${p.name}</b>`;
  b.onclick = () => { ui.pal = p.id; for (const x of swEl.children) x.setAttribute("aria-pressed", String(x === b)); $("#customColors").hidden = p.id !== "custom"; onLook(); };
  swEl.append(b);
}
function segment(id, key, after) {
  const el = $(id);
  el.addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; ui[key] = b.dataset.v; for (const x of el.children) x.setAttribute("aria-pressed", String(x === b)); after && after(); onLook(); });
}
segment("#bgMode", "bgMode", () => { $("#bgImageField").hidden = ui.bgMode !== "image"; if (ui.bgMode === "image" && !ui.bgImg) $("#bgFile").click(); });
segment("#textPos", "textPos");
segment("#proc", "proc", () => updateProcNote());
$("#bgPick").onclick = () => $("#bgFile").click();
$("#bgFile").onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try { ui.bgImg = await createImageBitmap(file); ui.bgFile = file; $("#bgPick").textContent = "Image: " + file.name; onLook(); }
  catch (err) { setStatus("That image could not be read. Try a JPG or PNG.", true); }
};
const outputs = { bands: v => v, gain: v => (+v).toFixed(2) + "×", smooth: v => (+v).toFixed(2), glow: v => (+v).toFixed(2), dim: v => Math.round(v * 100) + "%" };
for (const k in outputs) $("#" + k).addEventListener("input", e => { $("#" + k + "Out").textContent = outputs[k](e.target.value); onLook(); });
for (const id of ["#c1", "#c2", "#cbg", "#title", "#artist", "#showProgress", "#showTime", "#fmin", "#fmax"]) $(id).addEventListener("input", onLook);
for (const id of ["#clipStart", "#clipEnd"]) $(id).addEventListener("input", () => { updateTimeline(); onLook(); });
$("#res").addEventListener("change", () => { pvState = null; sizePreview(); onLook(); });
function onLook() { if (!playing) schedulePaused(); scheduleThumbs(); }

/* ---------------- loading audio ---------------- */
async function decode(ab) {
  const ctx = new OfflineAudioContext(2, 1, SR);
  return await new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
}
function setAudio(buffer, name, meta) {
  pause();
  const ch = buffer.numberOfChannels, len = buffer.length, pcm = new Float32Array(len);
  for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < len; i++) pcm[i] += d[i] / ch; }
  audio = { buffer, pcm, duration: buffer.duration, name, file: null };
  curT = Math.min(buffer.duration * 0.35, 9.5);
  $("#fileName").textContent = name;
  $("#fileMeta").textContent = meta || `${fmtTime(buffer.duration)} · ${ch === 1 ? "mono" : "stereo"} · drop another file to replace`;
  $("#clipEnd").placeholder = buffer.duration.toFixed(1);
  buildOverview(); updateTimeline(); pvState = null; schedulePaused(); scheduleThumbs();
}
async function loadFile(file) {
  if (busy) return;
  $("#fileName").textContent = "Decoding " + file.name + "…";
  try {
    const buf = await decode(await file.arrayBuffer());
    setAudio(buf, file.name, `${fmtTime(buf.duration)} · ${buf.numberOfChannels === 1 ? "mono" : "stereo"} · ${(file.size / 1048576).toFixed(1)} MB`);
    audio.file = file;
    $("#title").value = file.name.replace(/\.[^.]+$/, "").replace(/[_]+/g, " ");
    $("#artist").value = ""; $("#clipStart").value = 0; $("#clipEnd").value = "";
    curT = Math.min(buf.duration * 0.3, 30); updateTimeline(); onLook();
  } catch (e) {
    $("#fileName").textContent = audio ? audio.name : "No audio loaded";
    $("#fileMeta").textContent = `“${file.name}” could not be decoded by this browser. Try MP3, WAV or M4A.`;
  }
}
$("#file").onchange = e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; };
const drop = $("#drop");
for (const ev of ["dragenter", "dragover"]) document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) document.addEventListener(ev, e => { e.preventDefault(); if (ev === "drop" || e.target === document.documentElement) drop.classList.remove("over"); });
document.addEventListener("drop", e => { const f = e.dataTransfer && e.dataTransfer.files[0]; if (f) loadFile(f); });

/* ---------------- demo track ---------------- */
async function makeDemo() {
  const dur = 26, ctx = new OfflineAudioContext(2, SR * dur, SR);
  const master = ctx.createGain(); master.gain.value = 0.7;
  const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
  master.connect(comp); comp.connect(ctx.destination);
  const noise = ctx.createBuffer(1, SR, SR); const nd = noise.getChannelData(0); const rnd = mulberry(3);
  for (let i = 0; i < SR; i++) nd[i] = rnd() * 2 - 1;
  const bpm = 118, beat = 60 / bpm, bar = beat * 4;
  const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  const env = (g, t, a, peak, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  const drumsIn = bar * 2;
  for (let t = drumsIn; t < dur - 0.5; t += beat) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.13);
    env(g, t, 0.003, 1.0, 0.38); o.connect(g).connect(master); o.start(t); o.stop(t + 0.45);
  }
  const hit = (t, type, f, q, peak, d) => {
    const s = ctx.createBufferSource(); s.buffer = noise; const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ctx.createGain(); env(g, t, 0.002, peak, d); s.connect(fl).connect(g).connect(master); s.start(t, rnd() * 0.5); s.stop(t + d + 0.05);
  };
  for (let t = drumsIn; t < dur - 0.5; t += beat / 2) hit(t, "highpass", 8000, 0.7, (Math.round(t / (beat / 2)) % 2) ? 0.28 : 0.12, 0.05);
  for (let t = drumsIn + beat; t < dur - 0.5; t += beat * 2) hit(t, "bandpass", 1900, 0.8, 0.7, 0.2);
  for (let t = 0, k = 0; t < dur - 0.5; t += bar * 2, k++) {
    const ch = prog[k % 4];
    for (const m of ch) for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(m); o.detune.value = det;
      const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.setValueAtTime(700, t); fl.frequency.linearRampToValueAtTime(2400, t + bar); fl.frequency.linearRampToValueAtTime(900, t + bar * 2);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.035, t + 0.4); g.gain.setValueAtTime(0.035, t + bar * 2 - 0.3); g.gain.linearRampToValueAtTime(0.0001, t + bar * 2);
      o.connect(fl).connect(g).connect(master); o.start(t); o.stop(t + bar * 2 + 0.05);
    }
    if (t >= drumsIn - 0.01) for (let e = 0; e < 16; e++) {
      const tt = t + e * beat / 2; if (tt > dur - 0.5) break;
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = hz(ch[0] - 24 + (e % 4 === 3 ? 12 : 0));
      const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.Q.value = 6; fl.frequency.setValueAtTime(1400, tt); fl.frequency.exponentialRampToValueAtTime(180, tt + 0.2);
      const g = ctx.createGain(); env(g, tt, 0.005, 0.32, 0.22); o.connect(fl).connect(g).connect(master); o.start(tt); o.stop(tt + 0.3);
    }
    if (t >= bar * 4 - 0.01) for (let e = 0; e < 32; e++) {
      const tt = t + e * beat / 4; if (tt > dur - 0.5) break;
      const notes = [ch[0], ch[1], ch[2], ch[1] + 12];
      const o = ctx.createOscillator(); o.type = "square"; o.frequency.value = hz(notes[e % 4] + 12);
      const fl = ctx.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.value = 2600 + 1800 * Math.sin(e / 5);
      const g = ctx.createGain(); env(g, tt, 0.004, 0.05, 0.11); o.connect(fl).connect(g).connect(master); o.start(tt); o.stop(tt + 0.14);
    }
  }
  return await ctx.startRendering();
}

/* ---------------- export ---------------- */
let cancelFlag = false, resultBlob = null, resultName = "";
function setStatus(msg, err) { const s = $("#status"); s.textContent = msg; s.classList.toggle("err", !!err); }
function setProgress(p) { $("#bar").style.width = (p * 100).toFixed(1) + "%"; }
const tick = () => new Promise(r => setTimeout(r, 0));
async function pickCodecs(W, H, fps, bitrate, ch) {
  if (!("VideoEncoder" in window) || !window.Mp4Muxer) return null;
  const px = W * H;
  const vc = [
    { mux: "avc", codec: px > 2228224 ? "avc1.640033" : "avc1.640028", extra: { avc: { format: "avc" } } },
    { mux: "avc", codec: px > 2228224 ? "avc1.4d0033" : "avc1.4d0028", extra: { avc: { format: "avc" } } },
    { mux: "vp9", codec: "vp09.00.40.08", extra: {} },
    { mux: "av1", codec: "av01.0.08M.08", extra: {} },
  ];
  let video = null;
  for (const c of vc) {
    const cfg = { codec: c.codec, width: W, height: H, bitrate, framerate: fps, ...c.extra };
    try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) { video = { ...c, cfg }; break; } } catch (e) {}
  }
  if (!video) return null;
  let aud = null;
  if ("AudioEncoder" in window) for (const c of [{ mux: "aac", codec: "mp4a.40.2" }, { mux: "opus", codec: "opus" }]) {
    const cfg = { codec: c.codec, sampleRate: SR, numberOfChannels: ch, bitrate: 192000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) { aud = { ...c, cfg }; break; } } catch (e) {}
  }
  return { video, audio: aud };
}
async function encodeAudio(muxer, a, o) {
  let err = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => err = e });
  enc.configure(a.cfg);
  const ch = a.cfg.numberOfChannels, b = audio.buffer;
  const s0 = Math.floor(o.clipStart * SR), s1 = Math.min(b.length, Math.floor(o.clipEnd * SR));
  const chans = []; for (let c = 0; c < ch; c++) chans.push(b.getChannelData(Math.min(c, b.numberOfChannels - 1)));
  const STEP = 4800;
  for (let i = s0; i < s1; i += STEP) {
    const n = Math.min(STEP, s1 - i), data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(chans[c].subarray(i, i + n), c * n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((i - s0) / SR * 1e6), data });
    enc.encode(ad); ad.close();
    if (err) throw err;
    if (enc.encodeQueueSize > 20) await tick();
  }
  await enc.flush(); enc.close();
  if (err) throw err;
}
async function exportWebCodecs(codecs, W, H, fps, bitrate, o, ec) {
  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: codecs.video.mux, width: W, height: H, frameRate: fps },
    audio: codecs.audio ? { codec: codecs.audio.mux, numberOfChannels: codecs.audio.cfg.numberOfChannels, sampleRate: SR } : undefined,
    fastStart: "in-memory", firstTimestampBehavior: "offset",
  });
  if (codecs.audio) { setStatus("Encoding audio…"); await encodeAudio(muxer, codecs.audio, o); }
  let err = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: e => err = e });
  enc.configure(codecs.video.cfg);
  const ctx = ec.getContext("2d", { alpha: false }), st = createState();
  const total = Math.max(1, Math.round((o.clipEnd - o.clipStart) * fps)), t0 = performance.now();
  warmUpExport(ctx, W, H, st, o, fps);
  for (let i = 0; i < total; i++) {
    if (cancelFlag) { enc.close(); return null; }
    if (err) throw err;
    const t = o.clipStart + i / fps;
    renderFrame(ctx, W, H, st, t, 1 / fps, o);
    const vf = new VideoFrame(ec, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close();
    while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2));
    if (i % 6 === 0) {
      const el = (performance.now() - t0) / 1000, rate = (i + 1) / el, eta = (total - i - 1) / rate;
      setProgress((i + 1) / total);
      setStatus(`Frame ${i + 1} of ${total} · ${(rate / fps).toFixed(2)}× real time · about ${fmtTime(eta)} left · ${codecs.video.mux.toUpperCase()}${codecs.audio ? " + " + codecs.audio.mux.toUpperCase() : " (no audio encoder)"}`);
      if (i % 18 === 0) pctx.drawImage(ec, 0, 0, pv.width, pv.height);
      await tick();
    }
  }
  setStatus("Finishing file…");
  await enc.flush(); enc.close();
  if (err) throw err;
  muxer.finalize();
  return { blob: new Blob([muxer.target.buffer], { type: "video/mp4" }), ext: "mp4" };
}
async function exportRealtime(W, H, fps, bitrate, o, ec) {
  if (!ec.captureStream || !window.MediaRecorder) throw new Error("This browser cannot record canvas video. Try a recent Chrome, Edge, Firefox or Safari.");
  const types = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mime = types.find(t => MediaRecorder.isTypeSupported(t)) || "";
  actx = actx || new (window.AudioContext || window.webkitAudioContext)(); await actx.resume();
  const ctx = ec.getContext("2d"), st = createState(), stream = ec.captureStream(fps);
  const dest = actx.createMediaStreamDestination(); stream.addTrack(dest.stream.getAudioTracks()[0]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 192000 });
  const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  const s = actx.createBufferSource(); s.buffer = audio.buffer; s.connect(dest);
  renderFrame(ctx, W, H, st, o.clipStart, 1 / fps, o);
  rec.start(500); const startAt = actx.currentTime + 0.1; s.start(startAt, o.clipStart, o.clipEnd - o.clipStart);
  const len = o.clipEnd - o.clipStart; let last = performance.now();
  await new Promise(resolve => {
    const step = () => {
      const now = performance.now(), dt = clamp((now - last) / 1000, 0.001, 0.1); last = now;
      const el = actx.currentTime - startAt;
      if (cancelFlag || el >= len) { resolve(); return; }
      renderFrame(ctx, W, H, st, o.clipStart + Math.max(0, el), dt, o);
      if (Math.random() < 0.2) pctx.drawImage(ec, 0, 0, pv.width, pv.height);
      setProgress(el / len); setStatus(`Recording in real time: ${fmtTime(el)} of ${fmtTime(len)}. Keep this tab visible.`);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  try { s.stop(); } catch (e) {}
  rec.stop(); await done;
  if (cancelFlag) return null;
  const type = mime.split(";")[0] || "video/webm";
  return { blob: new Blob(chunks, { type }), ext: type.includes("mp4") ? "mp4" : "webm" };
}
/* ---------------- server-side rendering ---------------- */
let server = null, serverXhr = null, resultUrl = null;
const QUALITY = { standard: 0.07, high: 0.12, max: 0.2 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function detectServer() {
  if (location.protocol === "file:") return null;
  try {
    const c = new AbortController(); const tm = setTimeout(() => c.abort(), 3000);
    const r = await fetch("api/capabilities", { signal: c.signal, cache: "no-store" }); clearTimeout(tm);
    if (!r.ok) return null;
    const j = await r.json(); return j && j.server ? j : null;
  } catch (e) { return null; }
}
function updateProcNote() {
  const n = $("#procNote");
  if (ui.proc === "server") n.textContent = `Your audio is uploaded to this server, rendered with ffmpeg (H.264 + AAC) and kept for ${server ? server.jobTtlMinutes : 60} minutes. Upload limit ${server ? server.maxUploadMB : "?"} MB.`;
  else n.textContent = server ? "Renders on this device. Nothing is uploaded." : "Renders on this device. Server rendering is available when you self-host the Docker image.";
}
function encodeWav(buffer) {
  const ch = Math.min(2, buffer.numberOfChannels), len = buffer.length, out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, str) => { for (let i = 0; i < str.length; i++) out.setUint8(o + i, str.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + len * ch * 2, true); w(8, "WAVE"); w(12, "fmt "); out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, buffer.sampleRate, true); out.setUint32(28, buffer.sampleRate * ch * 2, true);
  out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true); w(36, "data"); out.setUint32(40, len * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  for (let i = 0, o = 44; i < len; i++) for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, clamp(data[c][i], -1, 1) * 32767, true);
  return new Blob([out.buffer], { type: "audio/wav" });
}
function serverOptions(o, W, H, fps, quality) {
  return {
    style: o.style, palette: { stops: o.pal.stops, bg: o.pal.bg, light: o.pal.light }, bgMode: o.bgMode, dim: o.dim,
    bands: o.bands, gain: o.gain, smooth: o.smooth, glow: o.glow, fmin: o.fmin, fmax: o.fmax,
    title: o.title, artist: o.artist, textPos: o.textPos, showProgress: o.showProgress, showTime: o.showTime,
    clipStart: o.clipStart, clipEnd: o.clipEnd, width: W, height: H, fps, quality,
  };
}
async function exportServer(o, W, H, fps, quality) {
  const fd = new FormData();
  fd.append("options", JSON.stringify(serverOptions(o, W, H, fps, quality)));
  const file = audio.file || new File([encodeWav(audio.buffer)], (audio.name || "audio").replace(/[^\w.-]+/g, "_") + ".wav", { type: "audio/wav" });
  if (server && file.size > server.maxUploadMB * 1048576) throw new Error(`The audio file is ${(file.size / 1048576).toFixed(0)} MB; this server accepts up to ${server.maxUploadMB} MB`);
  fd.append("audio", file, file.name);
  if (o.bgMode === "image" && ui.bgFile) fd.append("background", ui.bgFile, ui.bgFile.name);
  const id = await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); serverXhr = x;
    x.open("POST", "api/jobs");
    x.upload.onprogress = e => { if (e.lengthComputable) { setProgress(e.loaded / e.total); setStatus(`Uploading ${(e.loaded / 1048576).toFixed(1)} of ${(e.total / 1048576).toFixed(1)} MB…`); } };
    x.onload = () => {
      let j = null; try { j = JSON.parse(x.responseText); } catch (e) {}
      if (x.status >= 200 && x.status < 300 && j && j.id) resolve(j.id);
      else reject(new Error(j && j.error ? j.error : "The server answered " + x.status));
    };
    x.onerror = () => reject(new Error("Could not reach the server"));
    x.onabort = () => resolve(null);
    x.send(fd);
  });
  serverXhr = null;
  if (!id) return null;
  setProgress(0);
  let j;
  for (;;) {
    if (cancelFlag) { fetch("api/jobs/" + id, { method: "DELETE" }).catch(() => {}); return null; }
    try { const r = await fetch("api/jobs/" + id, { cache: "no-store" }); j = await r.json(); if (!r.ok) throw new Error(j.error || "Job not found"); }
    catch (e) { throw new Error("Lost contact with the server: " + e.message); }
    if (j.status === "done") break;
    if (j.status === "error") throw new Error(j.error || "Server render failed");
    if (j.status === "cancelled") return null;
    setProgress(j.progress || 0);
    if (j.status === "queued") setStatus(`Waiting in the server queue (position ${j.queuePosition}).`);
    else if (j.status === "decoding") setStatus("Server is decoding the audio…");
    else if (j.status === "finishing") setStatus("Server is finishing the MP4…");
    else setStatus(`Server rendering frame ${j.frame} of ${j.totalFrames} · ${(j.speed || 0).toFixed(2)}× real time · about ${fmtTime(j.eta || 0)} left`);
    await sleep(700);
  }
  return { url: "api/jobs/" + id + "/video", size: j.size, ext: "mp4", server: true };
}

$("#render").onclick = async () => {
  if (!audio || busy) return;
  pause(); busy = true; cancelFlag = false;
  $("#render").disabled = true; $("#renderBox").hidden = false; $("#cancelRow").hidden = false; $("#result").hidden = true;
  const badge = $("#badge"); badge.textContent = "Rendering"; badge.classList.add("rec");
  setProgress(0);
  try {
    try { await Promise.race([Promise.all([document.fonts.load('800 40px "Bricolage Grotesque"'), document.fonts.load('500 20px "IBM Plex Mono"')]), new Promise(r => setTimeout(r, 2500))]); } catch (e) {}
    const { W, H } = outSize(), fps = +$("#fps").value, o = opts();
    const quality = $("#quality").value, bitrate = Math.round(Math.min(60e6, W * H * fps * QUALITY[quality]));
    const t0 = performance.now();
    let out, codecs = null;
    if (ui.proc === "server" && server) {
      out = await exportServer(o, W, H, fps, quality);
    } else {
      const ec = document.createElement("canvas"); ec.width = W; ec.height = H;
      const ch = Math.min(2, audio.buffer.numberOfChannels);
      setStatus("Checking which video encoders this browser has…");
      codecs = await pickCodecs(W, H, fps, bitrate, ch);
      out = codecs ? await exportWebCodecs(codecs, W, H, fps, bitrate, o, ec) : await exportRealtime(W, H, fps, bitrate, o, ec);
    }
    if (!out) { setStatus("Render cancelled."); setProgress(0); return; }
    resultBlob = out.blob || null; resultUrl = out.url || null;
    const size = out.blob ? out.blob.size : out.size || 0;
    const base = (o.title || audio.name.replace(/\.[^.]+$/, "") || "spectrum").replace(/[\\/:*?"<>|]+/g, "").trim().slice(0, 80) || "spectrum";
    resultName = `${base} - ${STYLES.find(s => s.id === o.style).name} ${W}x${H}.${out.ext}`;
    setProgress(1);
    setStatus(`Done in ${fmtTime((performance.now() - t0) / 1000)}. ${W}×${H}, ${fps} fps, ${(size / 1048576).toFixed(1)} MB${out.server ? ", rendered on the server" : ""}${codecs && !codecs.audio ? ". This browser has no audio encoder, so the file is silent" : ""}.`);
    const v = $("#resultVideo"); if (v.src && v.src.startsWith("blob:")) URL.revokeObjectURL(v.src);
    v.onerror = () => { v.hidden = true; }; v.hidden = false; v.src = resultBlob ? URL.createObjectURL(resultBlob) : resultUrl;
    $("#saveNote").textContent = resultName;
    $("#result").hidden = false;
  } catch (e) {
    console.error(e); setStatus("Render failed: " + (e && e.message ? e.message : e) + ". Try a lower resolution or frame rate.", true);
  } finally {
    busy = false; $("#render").disabled = false; $("#cancelRow").hidden = true;
    badge.textContent = "Preview"; badge.classList.remove("rec");
    schedulePaused();
  }
};
$("#cancel").onclick = () => { cancelFlag = true; setStatus("Cancelling…"); if (serverXhr) serverXhr.abort(); };
$("#save").onclick = async () => {
  if (resultUrl) {
    const a = document.createElement("a"); a.href = resultUrl + "?download=1"; a.download = resultName;
    document.body.append(a); a.click(); a.remove(); $("#saveNote").textContent = "Saving " + resultName; return;
  }
  if (!resultBlob) return;
  let dl = null;
  try { if (window.claude && window.claude.use) dl = await window.claude.use("downloads"); } catch (e) {}
  if (dl) {
    try { await dl.save({ filename: resultName, data: resultBlob }); $("#saveNote").textContent = "Saved " + resultName; }
    catch (e) { $("#saveNote").textContent = e && e.code === "declined" ? "Save cancelled." : "Could not save: " + (e && e.message || e && e.code || e); }
    return;
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(resultBlob); a.download = resultName;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  $("#saveNote").textContent = "Saving " + resultName;
};

/* ---------------- boot ---------------- */
(async () => {
  updateProcNote();
  detectServer().then(info => {
    server = info; if (!info) return;
    const b = $("#proc button[data-v=server]"); b.disabled = false;
    if (!("VideoEncoder" in window)) b.click();
    updateProcNote();
  });
  sizePreview();
  pctx.fillStyle = "#07060b"; pctx.fillRect(0, 0, pv.width, pv.height);
  pctx.fillStyle = "#9b98ad"; pctx.font = "500 22px ui-monospace, monospace"; pctx.textAlign = "center"; pctx.fillText("Generating demo track…", pv.width / 2, pv.height / 2);
  try { await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]); } catch (e) {}
  try {
    const buf = await makeDemo();
    if (!audio) setAudio(buf, "Glass Harbor (demo)", `${fmtTime(buf.duration)} · stereo · synthesized in your browser. Drop your own file to replace it.`);
  } catch (e) {
    $("#fileName").textContent = "Choose an audio file"; $("#fileMeta").textContent = "Drop an audio file here or click to choose.";
  }
})();
window.__sf = { opts, STYLES, get audio() { return audio; } };
})();
