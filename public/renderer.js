/*
 * Spectrum Foundry renderer: audio analysis + all visualizer styles.
 * Shared by the browser app (window.SpectrumRenderer) and the Node render server (require).
 * Every style draws through a standard Canvas 2D context, so the same code runs on
 * an HTML canvas and on @napi-rs/canvas.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SpectrumRenderer = factory();
})(typeof self !== "undefined" ? self : this, function () {
"use strict";
let makeCanvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
function setCanvasFactory(fn) { makeCanvas = fn; }
const TAU = Math.PI * 2;
const SR = 48000;
const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
const lerp = (a, b, k) => a + (b - a) * k;

/* ---------------- palettes ---------------- */
const PALETTES = [
  { id: "ember",  name: "Ember",  stops: ["#ff2d2d", "#ff8a00", "#ffe066"], bg: "#0d0705" },
  { id: "lagoon", name: "Lagoon", stops: ["#0096ff", "#00f0d0", "#b6ff7a"], bg: "#03111a" },
  { id: "aurora", name: "Aurora", stops: ["#6a4dff", "#2ee6c5", "#d6ff6b"], bg: "#070914" },
  { id: "synth",  name: "Synth",  stops: ["#ff2fb3", "#9b4dff", "#36d6ff"], bg: "#0b0716" },
  { id: "dusk",   name: "Dusk",   stops: ["#ffd27a", "#ff6f61", "#a23d8f"], bg: "#160a15" },
  { id: "ice",    name: "Ice",    stops: ["#4f7dff", "#a8d8ff", "#ffffff"], bg: "#050913" },
  { id: "mono",   name: "Mono",   stops: ["#9a9a9a", "#ffffff", "#ffffff"], bg: "#000000" },
  { id: "paper",  name: "Paper",  stops: ["#1d1d1f", "#d9361e", "#1d1d1f"], bg: "#f2eee6", light: true },
  { id: "custom", name: "Custom", stops: ["#ff4d6d", "#4dd2ff"], bg: "#0a0912" },
];
function hexRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map(c => c + c).join(""); const n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function lum(rgb) { return (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255; }
function buildPalette(p) {
  const stops = p.stops.map(hexRgb), bg = hexRgb(p.bg);
  const light = p.light ?? lum(bg) > 0.5;
  const lut = [], rgb = [], heat = [];
  const sample = (arr, x) => { const f = clamp(x) * (arr.length - 1), i = Math.min(arr.length - 2, Math.floor(f)), k = f - i; return [0, 1, 2].map(c => Math.round(lerp(arr[i][c], arr[i + 1][c], k))); };
  const heatStops = [bg, ...stops.map(s => s)];
  heatStops.splice(1, 0, stops[0].map((c, i) => Math.round(lerp(bg[i], c, 0.35))));
  for (let i = 0; i < 256; i++) {
    const c = sample(stops, i / 255); rgb.push(c); lut.push(`rgb(${c[0]},${c[1]},${c[2]})`);
    const h = sample(heatStops, i / 255); heat.push(`rgb(${h[0]},${h[1]},${h[2]})`);
  }
  return { ...p, light, lut, rgb, heat, bgRgb: bg, bgCss: p.bg, fg: light ? "#1a1a1c" : "#f6f5fa", fgDim: light ? "rgba(26,26,28,.6)" : "rgba(246,245,250,.62)", blend: light ? "multiply" : "lighter" };
}
const col = (o, x) => o.pal.lut[clamp(x * 255 | 0, 0, 255)];
const rgba = (o, x, a) => { const c = o.pal.rgb[clamp(x * 255 | 0, 0, 255)]; return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
function hGrad(ctx, x0, x1, o, mirror = false) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  for (let i = 0; i <= 8; i++) { const u = i / 8; g.addColorStop(u, col(o, mirror ? Math.abs(u - 0.5) * 2 : u)); }
  return g;
}
function vGrad(ctx, y0, y1, o) { const g = ctx.createLinearGradient(0, y0, 0, y1); for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, col(o, i / 6)); return g; }
function ringGrad(ctx, cx, cy, o, rot = 0) {
  if (ctx.createConicGradient) {
    const g = ctx.createConicGradient(rot - Math.PI / 2, cx, cy);
    for (let i = 0; i <= 12; i++) { const u = i / 12; g.addColorStop(u, col(o, 1 - Math.abs(u - 0.5) * 2)); }
    return g;
  }
  return col(o, 0.5);
}
function rr(ctx, x, y, w, h, r) { if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
function glow(ctx, o, s, color, k = 1) { if (o.glow > 0) { ctx.shadowColor = color; ctx.shadowBlur = o.glow * 34 * s * k; } }
function noGlow(ctx) { ctx.shadowBlur = 0; ctx.shadowColor = "transparent"; }
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------------- analysis ---------------- */
const N = 4096, WAVE = 512;
function makeFFT(n) {
  const bits = Math.log2(n), rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  const cs = new Float32Array(n / 2), sn = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(TAU * i / n); sn[i] = -Math.sin(TAU * i / n); }
  const re = new Float32Array(n), im = new Float32Array(n);
  return (input, mags) => {
    for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
        const l = i + j + half, a = i + j;
        const tr = re[l] * cs[k] - im[l] * sn[k], ti = re[l] * sn[k] + im[l] * cs[k];
        re[l] = re[a] - tr; im[l] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    for (let i = 0; i < n / 2; i++) mags[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  };
}
const fft = makeFFT(N);
const hann = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(TAU * i / (N - 1)));
const fbuf = new Float32Array(N), mags = new Float32Array(N / 2), waveBuf = new Float32Array(WAVE);
let bandCache = { key: "" };
function bandLayout(n, fmin, fmax) {
  const key = n + ":" + fmin + ":" + fmax;
  if (bandCache.key === key) return bandCache;
  const lo = new Float32Array(n), hi = new Float32Array(n), fc = new Float32Array(n);
  const r = Math.log(fmax / fmin);
  for (let b = 0; b < n; b++) {
    const f0 = fmin * Math.exp(r * b / n), f1 = fmin * Math.exp(r * (b + 1) / n);
    lo[b] = f0 * N / SR; hi[b] = f1 * N / SR; fc[b] = Math.sqrt(f0 * f1);
  }
  let bassN = 0; for (let b = 0; b < n; b++) if (fc[b] < 150) bassN = b + 1;
  bandCache = { key, lo, hi, fc, bassN: Math.max(1, bassN) };
  return bandCache;
}
function analyze(t, o, out) {
  const pcm = o.pcm, n = out.length, L = bandLayout(n, o.fmin, o.fmax);
  const c = Math.floor(t * SR), s0 = c - N / 2;
  let sq = 0;
  for (let i = 0; i < N; i++) { const j = s0 + i; const v = j >= 0 && j < pcm.length ? pcm[j] : 0; sq += v * v; fbuf[i] = v * hann[i]; }
  fft(fbuf, mags);
  const norm = 4 / N;
  for (let b = 0; b < n; b++) {
    const lo = L.lo[b], hi = L.hi[b];
    let m;
    if (hi - lo < 1) { const x = (lo + hi) / 2, i = Math.floor(x), k = x - i; m = lerp(mags[i] || 0, mags[i + 1] || 0, k); }
    else { m = 0; for (let i = Math.floor(lo), e = Math.min(N / 2 - 1, Math.ceil(hi)); i <= e; i++) if (mags[i] > m) m = mags[i]; }
    let db = 20 * Math.log10(m * norm + 1e-9) + 3.0 * Math.log2(L.fc[b] / 1000);
    let v = (db + 66) / 54;
    v = clamp(v * o.gain);
    out[b] = v * v * (1.6 - 0.6 * v);
  }
  const ws = c - 1024;
  for (let i = 0; i < WAVE; i++) { const j = ws + i * 4; waveBuf[i] = j >= 0 && j < pcm.length ? pcm[j] : 0; }
  let bass = 0; for (let b = 0; b < L.bassN; b++) bass += out[b]; bass /= L.bassN;
  return { wave: waveBuf, bass, energy: clamp(Math.sqrt(sq / N) * 3.2 * o.gain) };
}
function createState(seed = 7) { return { rng: mulberry(seed), bands: null, raw: null, peaks: null, bassAvg: 0.3, beat: 0, hist: [], histAcc: 0, spec: null, specAcc: 0, stars: null, rings: [], ringAcc: 0, f: {} }; }
function computeFrame(st, t, dt, o) {
  const n = o.bands;
  if (!st.bands || st.bands.length !== n) { st.bands = new Float32Array(n); st.raw = new Float32Array(n); st.peaks = new Float32Array(n); st.hist = []; st.rings = []; }
  const a = analyze(t, o, st.raw);
  const rel = 1 - Math.pow(o.smooth, dt * 60), att = 1 - Math.pow(0.25, dt * 60);
  for (let i = 0; i < n; i++) {
    const v = st.raw[i], s = st.bands[i];
    st.bands[i] = s + (v - s) * (v > s ? att : rel);
    st.peaks[i] = st.bands[i] > st.peaks[i] ? st.bands[i] : Math.max(0, st.peaks[i] - dt * 0.4);
  }
  st.bassAvg += (a.bass - st.bassAvg) * (1 - Math.pow(0.97, dt * 60));
  const hit = clamp((a.bass - st.bassAvg - 0.04) * 5);
  st.beat = Math.max(hit, st.beat - dt * 3.5);
  const f = st.f;
  f.bands = st.bands; f.peaks = st.peaks; f.raw = st.raw; f.wave = a.wave; f.bass = a.bass; f.energy = a.energy; f.beat = st.beat; f.t = t; f.dt = dt;
  return f;
}

/* ---------------- backgrounds & overlay ---------------- */
function drawBackground(ctx, W, H, f, o) {
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; noGlow(ctx);
  ctx.fillStyle = o.pal.bgCss; ctx.fillRect(0, 0, W, H);
  if (o.bgMode === "image" && o.bgImg) {
    const im = o.bgImg, sc = Math.max(W / im.width, H / im.height) * (1 + f.beat * 0.015);
    const w = im.width * sc, h = im.height * sc;
    ctx.drawImage(im, (W - w) / 2, (H - h) / 2, w, h);
    ctx.fillStyle = o.pal.bgCss; ctx.globalAlpha = o.dim; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
  } else if (o.bgMode === "glow") {
    const R = Math.max(W, H) * 0.75;
    const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, R);
    g.addColorStop(0, rgba(o, 0.35, (o.pal.light ? 0.12 : 0.16) + f.bass * 0.1));
    g.addColorStop(1, rgba(o, 0.35, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
}
function fmtTime(s, tenths) { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return m + ":" + (tenths ? r.toFixed(1).padStart(4, "0") : String(Math.floor(r)).padStart(2, "0")); }
function drawOverlay(ctx, W, H, f, o) {
  ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1; noGlow(ctx);
  const s = Math.min(W, H) / 1080, m = Math.round(Math.min(W, H) * 0.065);
  if (o.textPos !== "none" && (o.title || o.artist)) {
    const ts = 58 * s, as = 24 * s;
    ctx.textBaseline = "alphabetic";
    let x = m, y, align = "left";
    if (o.textPos === "bl") y = H - m - (o.showProgress ? 18 * s : 0) - (o.artist ? as * 1.5 : 0);
    else if (o.textPos === "tl") y = m + ts * 0.8;
    else { x = W / 2; align = "center"; y = H / 2 + ts * 0.3 - (o.artist ? as * 0.7 : 0); }
    ctx.textAlign = align;
    ctx.shadowColor = o.pal.light ? "rgba(255,255,255,.6)" : "rgba(0,0,0,.55)"; ctx.shadowBlur = 18 * s;
    if (o.title) { ctx.fillStyle = o.pal.fg; ctx.font = `800 ${ts}px "Bricolage Grotesque", "Avenir Next", sans-serif`; ctx.fillText(o.title, x, y, W - m * 2); }
    if (o.artist) { ctx.fillStyle = o.pal.fgDim; ctx.font = `500 ${as}px "IBM Plex Mono", ui-monospace, monospace`; ctx.fillText(o.artist, x, y + as * 1.6, W - m * 2); }
    noGlow(ctx);
  }
  const p = clamp((f.t - o.clipStart) / Math.max(0.001, o.clipEnd - o.clipStart));
  if (o.showProgress) {
    const y = H - m * 0.55, h = Math.max(2, 5 * s);
    ctx.fillStyle = o.pal.light ? "rgba(0,0,0,.12)" : "rgba(255,255,255,.14)"; ctx.fillRect(m, y, W - m * 2, h);
    ctx.fillStyle = hGrad(ctx, m, W - m, o); ctx.fillRect(m, y, (W - m * 2) * p, h);
  }
  if (o.showTime) {
    ctx.font = `500 ${22 * s}px "IBM Plex Mono", ui-monospace, monospace`; ctx.fillStyle = o.pal.fgDim; ctx.textAlign = "right";
    ctx.fillText(fmtTime(f.t - o.clipStart) + " / " + fmtTime(o.clipEnd - o.clipStart), W - m, o.showProgress ? H - m * 0.55 - 14 * s : H - m * 0.6);
  }
}

/* ---------------- styles ---------------- */
function mirrorVal(arr, u) { // u in 0..1 across, lows at center
  const n = arr.length, x = Math.abs(u - 0.5) * 2 * (n - 1), i = Math.floor(x), k = x - i;
  return lerp(arr[i], arr[Math.min(n - 1, i + 1)], k);
}
function smoothPath(ctx, pts, close) { // pts: [x0,y0,x1,y1,...] quadratic through midpoints
  const L = pts.length / 2; if (L < 2) return;
  if (close) {
    const mx = (pts[(L - 1) * 2] + pts[0]) / 2, my = (pts[(L - 1) * 2 + 1] + pts[1]) / 2;
    ctx.moveTo(mx, my);
    for (let i = 0; i < L; i++) { const j = (i + 1) % L; ctx.quadraticCurveTo(pts[i * 2], pts[i * 2 + 1], (pts[i * 2] + pts[j * 2]) / 2, (pts[i * 2 + 1] + pts[j * 2 + 1]) / 2); }
    ctx.closePath();
  } else {
    ctx.lineTo(pts[0], pts[1]);
    for (let i = 1; i < L - 1; i++) ctx.quadraticCurveTo(pts[i * 2], pts[i * 2 + 1], (pts[i * 2] + pts[i * 2 + 2]) / 2, (pts[i * 2 + 1] + pts[i * 2 + 3]) / 2);
    ctx.lineTo(pts[(L - 1) * 2], pts[(L - 1) * 2 + 1]);
  }
}
function ringBars(ctx, cx, cy, R, len, arr, o, s, rot, width) {
  const n = arr.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const v = arr[i], L = Math.max(2 * s, v * len);
    for (const side of [1, -1]) {
      const a = rot - Math.PI / 2 + side * (i + 0.5) / n * Math.PI;
      const c = Math.cos(a), sn = Math.sin(a);
      ctx.moveTo(cx + c * R, cy + sn * R); ctx.lineTo(cx + c * (R + L), cy + sn * (R + L));
    }
  }
  ctx.lineWidth = width; ctx.lineCap = "round"; ctx.strokeStyle = ringGrad(ctx, cx, cy, o, rot);
  glow(ctx, o, s, col(o, 0.5)); ctx.stroke(); noGlow(ctx);
}

const STYLES = [
  { id: "bars", name: "Classic Bars", tag: "EQ", draw(ctx, W, H, f, o) {
    const n = f.bands.length, s = Math.min(W, H) / 1080, mx = W * 0.07, base = H * 0.7, maxH = H * 0.5;
    const gap = (W - 2 * mx) / n, bw = Math.max(1, gap * 0.7), r = Math.min(bw / 2, 8 * s);
    ctx.fillStyle = hGrad(ctx, mx, W - mx, o);
    ctx.beginPath();
    for (let i = 0; i < n; i++) { const h = Math.max(3 * s, f.bands[i] * maxH); rr(ctx, mx + i * gap + (gap - bw) / 2, base - h, bw, h, [r, r, 0, 0]); }
    glow(ctx, o, s, col(o, 0.5)); ctx.fill(); noGlow(ctx);
    ctx.globalAlpha = 0.16; ctx.beginPath();
    for (let i = 0; i < n; i++) { const h = Math.max(3 * s, f.bands[i] * maxH) * 0.35; ctx.rect(mx + i * gap + (gap - bw) / 2, base + 6 * s, bw, h); }
    ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = o.pal.fgDim; ctx.globalAlpha = 0.5;
    ctx.beginPath(); for (let i = 0; i < n; i++) { const p = f.peaks[i] * maxH; if (p > 6 * s) ctx.rect(mx + i * gap + (gap - bw) / 2, base - p - 7 * s, bw, 3 * s); }
    ctx.fill(); ctx.globalAlpha = 1;
  }},
  { id: "mirror", name: "Mirror", tag: "symmetric", draw(ctx, W, H, f, o) {
    const n = f.bands.length, s = Math.min(W, H) / 1080, mx = W * 0.05, cy = H / 2, maxH = H * 0.34;
    const cols = n * 2, gap = (W - 2 * mx) / cols, bw = Math.max(1, gap * 0.62);
    ctx.fillStyle = hGrad(ctx, mx, W - mx, o, true);
    ctx.beginPath();
    for (let i = 0; i < cols; i++) {
      const bi = i < n ? n - 1 - i : i - n, h = Math.max(2 * s, f.bands[bi] * maxH);
      rr(ctx, mx + i * gap + (gap - bw) / 2, cy - h, bw, h * 2, bw / 2);
    }
    glow(ctx, o, s, col(o, 0.3)); ctx.fill(); noGlow(ctx);
  }},
  { id: "radial", name: "Radial Burst", tag: "circle", draw(ctx, W, H, f, o) {
    const s = Math.min(W, H) / 1080, cx = W / 2, cy = H / 2, R = s * 210 * (1 + f.beat * 0.08 + f.bass * 0.06);
    ringBars(ctx, cx, cy, R, s * 290, f.bands, o, s, f.t * 0.05, Math.max(2 * s, Math.min(10 * s, R * Math.PI / f.bands.length * 0.55)));
    ctx.beginPath(); ctx.arc(cx, cy, R - 14 * s, 0, TAU); ctx.lineWidth = 3 * s; ctx.strokeStyle = rgba(o, 0.2, 0.9); ctx.stroke();
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R - 18 * s);
    g.addColorStop(0, rgba(o, 0.1, 0.35 + f.beat * 0.3)); g.addColorStop(1, rgba(o, 0.1, 0.02));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R - 18 * s, 0, TAU); ctx.fill();
  }},
  { id: "scope", name: "Oscilloscope", tag: "waveform", draw(ctx, W, H, f, o) {
    const s = Math.min(W, H) / 1080, mx = W * 0.06, cy = H / 2, amp = H * 0.32 * o.gain;
    ctx.strokeStyle = o.pal.light ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.07)"; ctx.lineWidth = Math.max(1, s);
    ctx.beginPath();
    for (let i = 0; i <= 10; i++) { const x = mx + (W - 2 * mx) * i / 10; ctx.moveTo(x, H * 0.12); ctx.lineTo(x, H * 0.88); }
    for (let j = 0; j <= 8; j++) { const y = H * 0.12 + H * 0.76 * j / 8; ctx.moveTo(mx, y); ctx.lineTo(W - mx, y); }
    ctx.stroke();
    const pts = [];
    for (let i = 0; i < WAVE; i++) pts.push(mx + (W - 2 * mx) * i / (WAVE - 1), cy + clamp(f.wave[i] * amp / (H * 0.36), -1, 1) * H * 0.36);
    const g = hGrad(ctx, mx, W - mx, o);
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    for (const [w, a] of [[14, 0.12], [6, 0.35], [2.5, 1]]) {
      ctx.globalAlpha = a; ctx.lineWidth = w * s; ctx.strokeStyle = g; ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let i = 1; i < WAVE; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
      if (a === 1) glow(ctx, o, s, col(o, 0.5), 0.7);
      ctx.stroke(); noGlow(ctx);
    }
    ctx.globalAlpha = 1;
  }},
  { id: "halo", name: "Halo", tag: "polar wave", draw(ctx, W, H, f, o) {
    const s = Math.min(W, H) / 1080, cx = W / 2, cy = H / 2, R = s * 270 * (1 + f.beat * 0.05);
    const rot = f.t * 0.25;
    for (let layer = 0; layer < 3; layer++) {
      const pts = [], m = 256, rad = R * (1 - layer * 0.16), amp = s * (170 - layer * 40) * o.gain;
      for (let i = 0; i < m; i++) {
        const u = i / m, wi = Math.floor((u < 0.5 ? u * 2 : (1 - u) * 2) * (WAVE - 1));
        const r = rad + f.wave[(wi + layer * 37) % WAVE] * amp;
        const a = rot * (layer % 2 ? -1 : 1) + u * TAU;
        pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.beginPath(); smoothPath(ctx, pts, true);
      ctx.lineWidth = (3.5 - layer) * s; ctx.strokeStyle = ringGrad(ctx, cx, cy, o, rot + layer);
      ctx.globalAlpha = 1 - layer * 0.25;
      glow(ctx, o, s, col(o, layer / 2)); ctx.stroke(); noGlow(ctx);
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgba(o, 0.5, 0.6 + f.beat * 0.4); ctx.beginPath(); ctx.arc(cx, cy, s * (10 + f.bass * 26), 0, TAU); ctx.fill();
  }},
  { id: "spectrogram", name: "Spectrogram", tag: "scrolling", draw(ctx, W, H, f, o, st) {
    const s = Math.min(W, H) / 1080, n = f.bands.length;
    if (!st.spec || st.spec.width !== W || st.spec.height !== H) {
      st.spec = makeCanvas(W, H);
      const c = st.spec.getContext("2d"); c.fillStyle = o.pal.heat[0]; c.fillRect(0, 0, W, H); st.specAcc = 0;
    }
    const sc = st.spec.getContext("2d");
    st.specAcc += W * f.dt / 8;
    const dx = Math.floor(st.specAcc);
    if (dx > 0) {
      st.specAcc -= dx;
      sc.globalCompositeOperation = "copy"; sc.drawImage(st.spec, -dx, 0); sc.globalCompositeOperation = "source-over";
      const bh = H / n;
      for (let b = 0; b < n; b++) { sc.fillStyle = o.pal.heat[clamp(f.raw[b] * 255 | 0, 0, 255)]; sc.fillRect(W - dx, H - (b + 1) * bh, dx, Math.ceil(bh) + 1); }
    }
    ctx.drawImage(st.spec, 0, 0);
    ctx.font = `500 ${18 * s}px "IBM Plex Mono", ui-monospace, monospace`; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.strokeStyle = o.pal.light ? "rgba(0,0,0,.18)" : "rgba(255,255,255,.18)"; ctx.lineWidth = Math.max(1, s);
    const r = Math.log(o.fmax / o.fmin);
    for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      if (hz < o.fmin || hz > o.fmax) continue;
      const y = H - Math.log(hz / o.fmin) / r * H;
      ctx.beginPath(); ctx.moveTo(W - 14 * s, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = o.pal.fgDim; ctx.fillText(hz >= 1000 ? hz / 1000 + "k" : String(hz), W - 20 * s, y);
    }
    ctx.textBaseline = "alphabetic";
  }},
  { id: "ridges", name: "Ridgeline", tag: "history", draw(ctx, W, H, f, o, st) {
    const s = Math.min(W, H) / 1080, K = 34;
    st.histAcc += f.dt;
    if (st.histAcc >= 1 / 20 || st.hist.length === 0) { st.histAcc = 0; st.hist.unshift(Float32Array.from(f.bands)); if (st.hist.length > K) st.hist.pop(); }
    const front = H * 0.84, depth = H * 0.62, m = 96;
    for (let k = st.hist.length - 1; k >= 0; k--) {
      const arr = k === 0 ? f.bands : st.hist[k], d = k / K, sc = 1 - d * 0.5;
      const y0 = front - depth * (1 - Math.pow(1 - d, 1.4)), ww = W * 0.84 * sc, amp = H * 0.24 * sc;
      const pts = [];
      for (let i = 0; i <= m; i++) { const u = i / m, env = Math.pow(Math.sin(u * Math.PI), 1.5); pts.push(W / 2 + (u - 0.5) * ww, y0 - mirrorVal(arr, u) * amp * env); }
      ctx.beginPath(); ctx.moveTo(W / 2 - ww / 2, y0); smoothPath(ctx, pts, false); ctx.lineTo(W / 2 + ww / 2, y0);
      ctx.fillStyle = o.pal.bgCss; ctx.globalAlpha = 1; ctx.fill();
      ctx.globalAlpha = 1 - d * 0.85; ctx.lineWidth = (k === 0 ? 3 : 2) * s * sc; ctx.strokeStyle = col(o, 1 - d);
      if (k === 0) glow(ctx, o, s, col(o, 1));
      ctx.stroke(); noGlow(ctx);
    }
    ctx.globalAlpha = 1;
  }},
  { id: "led", name: "LED Meter", tag: "segments", draw(ctx, W, H, f, o, st) {
    const s = Math.min(W, H) / 1080, cols = Math.min(48, f.bands.length), segs = 22;
    const n = f.bands.length, mx = W * 0.08, top = H * 0.14, bot = H * 0.8;
    const gap = (W - 2 * mx) / cols, bw = gap * 0.78, sh = (bot - top) / segs, segH = sh * 0.68;
    const vals = new Float32Array(cols), pk = new Float32Array(cols);
    for (let c = 0; c < cols; c++) { const a = Math.floor(c * n / cols), b = Math.max(a + 1, Math.floor((c + 1) * n / cols)); let v = 0, p = 0; for (let i = a; i < b; i++) { v = Math.max(v, f.bands[i]); p = Math.max(p, f.peaks[i]); } vals[c] = v; pk[c] = p; }
    ctx.fillStyle = o.pal.light ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.05)"; ctx.beginPath();
    for (let c = 0; c < cols; c++) for (let j = 0; j < segs; j++) ctx.rect(mx + c * gap, bot - (j + 1) * sh, bw, segH);
    ctx.fill();
    glow(ctx, o, s, col(o, 0.5), 0.6);
    for (let j = 0; j < segs; j++) {
      ctx.fillStyle = col(o, j / (segs - 1)); ctx.beginPath(); let any = false;
      for (let c = 0; c < cols; c++) if (vals[c] * segs > j + 0.35) { ctx.rect(mx + c * gap, bot - (j + 1) * sh, bw, segH); any = true; }
      if (any) ctx.fill();
    }
    noGlow(ctx);
    ctx.fillStyle = o.pal.fg; ctx.beginPath();
    for (let c = 0; c < cols; c++) { const j = Math.min(segs - 1, Math.round(pk[c] * segs)); if (j > 0) ctx.rect(mx + c * gap, bot - (j + 1) * sh, bw, segH); }
    ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
  }},
  { id: "blob", name: "Liquid Blob", tag: "organic", draw(ctx, W, H, f, o) {
    const s = Math.min(W, H) / 1080, cx = W / 2, cy = H / 2, n = f.bands.length;
    ctx.globalCompositeOperation = o.pal.blend;
    for (let L = 0; L < 3; L++) {
      const R = s * (190 + L * 20) * (1 + f.beat * 0.06), amp = s * (240 - L * 50), rot = f.t * 0.12 * (L % 2 ? -1 : 1) + L * 2.1;
      const m = 48, pts = [];
      for (let i = 0; i < m; i++) {
        const u = i / m, v = mirrorVal(f.bands, (u + L * 0.17) % 1);
        const a = rot + u * TAU, r = R + v * amp;
        pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.beginPath(); smoothPath(ctx, pts, true);
      ctx.fillStyle = rgba(o, L / 2, o.pal.light ? 0.28 : 0.34); ctx.fill();
      ctx.lineWidth = 2.5 * s; ctx.strokeStyle = col(o, L / 2); glow(ctx, o, s, col(o, L / 2), 0.8); ctx.stroke(); noGlow(ctx);
    }
    ctx.globalCompositeOperation = "source-over";
  }},
  { id: "stars", name: "Warp Field", tag: "particles", draw(ctx, W, H, f, o, st) {
    const s = Math.min(W, H) / 1080, cx = W / 2, cy = H / 2, rnd = st.rng, COUNT = 700;
    if (!st.stars) { st.stars = []; for (let i = 0; i < COUNT; i++) st.stars.push({ x: rnd() * 2 - 1, y: rnd() * 2 - 1, z: rnd() * 0.95 + 0.05, c: rnd() }); }
    const speed = (0.08 + f.energy * 0.9 + f.beat * 1.6) * f.dt, F = Math.max(W, H) * 0.5;
    ctx.lineCap = "round";
    const buckets = [[], [], [], []];
    for (const p of st.stars) {
      const z0 = p.z; p.z -= speed;
      if (p.z <= 0.03) { p.x = rnd() * 2 - 1; p.y = rnd() * 2 - 1; p.z = 1; p.c = rnd(); continue; }
      const x0 = cx + p.x / z0 * F * 0.5, y0 = cy + p.y / z0 * F * 0.5, x1 = cx + p.x / p.z * F * 0.5, y1 = cy + p.y / p.z * F * 0.5;
      if (x1 < -50 || x1 > W + 50 || y1 < -50 || y1 > H + 50) { p.z = 0; continue; }
      buckets[Math.min(3, (p.c * 4) | 0)].push(x0, y0, x1, y1, (1 - p.z));
    }
    for (let b = 0; b < 4; b++) {
      const arr = buckets[b]; ctx.strokeStyle = col(o, b / 3);
      for (let i = 0; i < arr.length; i += 5) { ctx.lineWidth = Math.max(1, arr[i + 4] * 5 * s); ctx.globalAlpha = clamp(arr[i + 4] * 1.4); ctx.beginPath(); ctx.moveTo(arr[i], arr[i + 1]); ctx.lineTo(arr[i + 2], arr[i + 3]); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
    const R = s * 120 * (1 + f.beat * 0.1);
    ringBars(ctx, cx, cy, R, s * 110, f.bands, o, s, -f.t * 0.1, Math.max(2 * s, Math.min(6 * s, R * Math.PI / f.bands.length * 0.5)));
  }},
  { id: "mountain", name: "Skyline", tag: "filled curve", draw(ctx, W, H, f, o) {
    const s = Math.min(W, H) / 1080, n = f.bands.length, base = H * 0.78, maxH = H * 0.55;
    const layer = (arr, alpha, lw, k) => {
      const pts = []; for (let i = 0; i < n; i++) pts.push(W * i / (n - 1), base - arr[i] * maxH * k);
      ctx.beginPath(); ctx.moveTo(0, base); smoothPath(ctx, pts, false); ctx.lineTo(W, base); ctx.closePath();
      const g = ctx.createLinearGradient(0, base - maxH, 0, base);
      g.addColorStop(0, rgba(o, 0.9, alpha)); g.addColorStop(0.6, rgba(o, 0.4, alpha * 0.7)); g.addColorStop(1, rgba(o, 0, alpha * 0.1));
      ctx.fillStyle = g; ctx.fill();
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); smoothPath(ctx, pts, false);
      ctx.lineWidth = lw * s; ctx.strokeStyle = hGrad(ctx, 0, W, o); glow(ctx, o, s, col(o, 0.7)); ctx.stroke(); noGlow(ctx);
    };
    layer(f.peaks, 0.25, 1.5, 1.08);
    layer(f.bands, 0.75, 3, 1);
    ctx.fillStyle = o.pal.light ? "rgba(0,0,0,.25)" : "rgba(255,255,255,.25)"; ctx.fillRect(0, base, W, Math.max(1, 1.5 * s));
    ctx.globalAlpha = 0.18; ctx.save(); ctx.translate(0, base * 2); ctx.scale(1, -1);
    ctx.beginPath(); const pts = []; for (let i = 0; i < n; i++) pts.push(W * i / (n - 1), base - f.bands[i] * maxH * 0.4);
    ctx.moveTo(0, base); smoothPath(ctx, pts, false); ctx.lineTo(W, base); ctx.fillStyle = hGrad(ctx, 0, W, o); ctx.fill(); ctx.restore(); ctx.globalAlpha = 1;
  }},
  { id: "dots", name: "Dot Matrix", tag: "grid", draw(ctx, W, H, f, o) {
    const s = Math.min(W, H) / 1080, n = f.bands.length, cols = Math.min(64, n), rows = 11;
    const mx = W * 0.07, cy = H / 2, gap = (W - 2 * mx) / cols, rowH = Math.min(gap * 1.15, H * 0.36 / rows), rMax = Math.min(gap, rowH) * 0.42;
    const vals = new Float32Array(cols);
    for (let c = 0; c < cols; c++) { const u = c / (cols - 1); vals[c] = mirrorVal(f.bands, u); }
    ctx.fillStyle = o.pal.light ? "rgba(0,0,0,.07)" : "rgba(255,255,255,.06)"; ctx.beginPath();
    for (let c = 0; c < cols; c++) for (let j = -rows; j <= rows; j++) { const x = mx + (c + 0.5) * gap, y = cy + j * rowH; ctx.moveTo(x + rMax * 0.3, y); ctx.arc(x, y, rMax * 0.3, 0, TAU); }
    ctx.fill();
    glow(ctx, o, s, col(o, 0.5), 0.5);
    for (let j = 0; j <= rows; j++) {
      ctx.fillStyle = col(o, j / rows); ctx.beginPath();
      for (let c = 0; c < cols; c++) {
        const lvl = vals[c] * rows - j; if (lvl <= 0) continue;
        const r = rMax * clamp(lvl), x = mx + (c + 0.5) * gap;
        for (const y of j === 0 ? [cy] : [cy - j * rowH, cy + j * rowH]) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU); }
      }
      ctx.fill();
    }
    noGlow(ctx);
  }},
  { id: "arc", name: "Sunrise Arc", tag: "half circle", draw(ctx, W, H, f, o) {
    const s = Math.min(W, H) / 1080, n = f.bands.length, cx = W / 2, cy = H * 0.74, R = Math.min(W * 0.3, H * 0.3) * (1 + f.beat * 0.04), len = Math.min(W, H) * 0.3;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, rgba(o, 0.2, 0.05)); g.addColorStop(1, rgba(o, 0.6, 0.28 + f.bass * 0.3));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * 0.92, Math.PI, TAU); ctx.closePath(); ctx.fill();
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = Math.PI + (i + 0.5) / n * Math.PI, c = Math.cos(a), sn = Math.sin(a), L = Math.max(3 * s, f.bands[i] * len);
      ctx.moveTo(cx + c * R, cy + sn * R); ctx.lineTo(cx + c * (R + L), cy + sn * (R + L));
    }
    ctx.lineWidth = Math.max(2 * s, Math.min(14 * s, R * Math.PI / n * 0.55)); ctx.lineCap = "round";
    ctx.strokeStyle = hGrad(ctx, cx - R - len, cx + R + len, o); glow(ctx, o, s, col(o, 0.5)); ctx.stroke(); noGlow(ctx);
    ctx.fillStyle = o.pal.light ? "rgba(0,0,0,.3)" : "rgba(255,255,255,.3)"; ctx.fillRect(W * 0.08, cy + 10 * s, W * 0.84, Math.max(1, 2 * s));
    ctx.globalAlpha = 0.14; ctx.save(); ctx.translate(0, (cy + 10 * s) * 2); ctx.scale(1, -1); ctx.stroke(); ctx.restore(); ctx.globalAlpha = 1;
  }},
  { id: "tunnel", name: "Tunnel", tag: "rings", draw(ctx, W, H, f, o, st) {
    const s = Math.min(W, H) / 1080, cx = W / 2, cy = H / 2, maxR = Math.hypot(W, H) / 2;
    st.ringAcc += f.dt;
    if (st.ringAcc >= 1 / 15 || st.rings.length === 0) { st.ringAcc = 0; st.rings.push({ born: f.t, arr: Float32Array.from(f.bands), e: f.energy + f.beat * 0.5, rot: f.t * 0.4 }); }
    st.rings = st.rings.filter(r => f.t - r.born >= -0.01 && 40 * s * Math.exp((f.t - r.born) * 1.15) < maxR * 1.3);
    ctx.lineJoin = "round";
    for (const ring of st.rings) {
      const age = Math.max(0, f.t - ring.born), r0 = 40 * s * Math.exp(age * 1.15), m = 64, pts = [];
      for (let i = 0; i < m; i++) { const u = i / m, a = ring.rot + u * TAU, r = r0 * (1 + mirrorVal(ring.arr, u) * 0.45); pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
      ctx.beginPath(); smoothPath(ctx, pts, true);
      const fade = clamp(1 - r0 / (maxR * 1.25));
      ctx.globalAlpha = clamp(fade * (0.35 + ring.e)); ctx.lineWidth = Math.max(1, (1.5 + ring.e * 5) * s * (r0 / (300 * s)) ** 0.5);
      ctx.strokeStyle = col(o, clamp(age / 3)); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 90 * s);
    g.addColorStop(0, rgba(o, 0, 0.7 + f.beat * 0.3)); g.addColorStop(1, rgba(o, 0, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 90 * s, 0, TAU); ctx.fill();
  }},
];

function renderFrame(ctx, W, H, st, t, dt, o) {
  const f = computeFrame(st, t, dt, o);
  drawBackground(ctx, W, H, f, o);
  ctx.save(); STYLES.find(x => x.id === o.style).draw(ctx, W, H, f, o, st); ctx.restore();
  noGlow(ctx); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  drawOverlay(ctx, W, H, f, o);
}
function renderWarm(ctx, W, H, t, o, frames = 30) {
  const st = createState();
  const start = Math.max(0, t - frames / 30);
  const steps = Math.max(1, Math.round((t - start) * 30));
  // simple warm-up loop (drawing keeps history-based styles consistent)
  for (let i = steps; i >= 0; i--) renderFrame(ctx, W, H, st, t - i / 30, 1 / 30, o);
  return st;
}


const warmFrames = (id) => id === "spectrogram" ? 240 : id === "ridges" || id === "tunnel" ? 60 : 30;
// Feed the audio just before the clip through the renderer so history-based styles start full.
function warmUpExport(ctx, W, H, st, o, fps) {
  const warm = Math.min(Math.floor(o.clipStart * fps), Math.round(warmFrames(o.style) / 30 * fps));
  for (let i = warm; i >= 1; i--) renderFrame(ctx, W, H, st, o.clipStart - i / fps, 1 / fps, o);
}
return { SR, TAU, PALETTES, STYLES, clamp, lerp, mulberry, buildPalette, createState, computeFrame, renderFrame, renderWarm, warmFrames, warmUpExport, fmtTime, setCanvasFactory };
});
