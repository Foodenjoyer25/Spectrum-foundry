"use strict";
/*
 * Renders one job in a child process (forked by server.js):
 *   1. ffmpeg decodes the upload to 48 kHz mono float PCM for analysis
 *   2. the shared renderer draws each frame on a Skia canvas (@napi-rs/canvas)
 *   3. raw RGBA frames are piped to ffmpeg, which muxes them with the original audio as H.264 + AAC MP4
 * Progress is reported to the parent over IPC.
 */
const { spawn } = require("child_process");
const path = require("path");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const R = require("../public/renderer.js");

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const PRESET = process.env.X264_PRESET || "veryfast";
const CRF = { standard: 23, high: 19, max: 16 };

function registerFonts() {
  const pick = (pkg, file) => { try { return require.resolve(`@fontsource/${pkg}/files/${file}`); } catch (e) { return null; } };
  const fonts = [
    ["bricolage-grotesque", "bricolage-grotesque-latin-800-normal.woff2", "Bricolage Grotesque"],
    ["bricolage-grotesque", "bricolage-grotesque-latin-ext-800-normal.woff2", "Bricolage Grotesque"],
    ["ibm-plex-mono", "ibm-plex-mono-latin-500-normal.woff2", "IBM Plex Mono"],
    ["ibm-plex-mono", "ibm-plex-mono-latin-ext-500-normal.woff2", "IBM Plex Mono"],
  ];
  for (const [pkg, file, family] of fonts) { const p = pick(pkg, file); if (p) GlobalFonts.registerFromPath(p, family); }
}

function send(msg) { if (process.send) process.send(msg); }

function decodePcm(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(R.SR), "-f", "f32le", "pipe:1"]);
    const chunks = []; let err = "";
    ff.stdout.on("data", d => chunks.push(d));
    ff.stderr.on("data", d => { err += d; });
    ff.on("error", reject);
    ff.on("close", code => {
      if (code !== 0) return reject(new Error("Could not decode the audio file" + (err ? ": " + err.trim().split("\n").pop() : "")));
      const buf = Buffer.concat(chunks);
      const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4)));
      resolve(pcm);
    });
  });
}

async function run(job) {
  const { options: q, audioPath, backgroundPath, outPath } = job;
  registerFonts();
  R.setCanvasFactory((w, h) => createCanvas(w, h));

  send({ type: "status", status: "decoding" });
  const pcm = await decodePcm(audioPath);
  const duration = pcm.length / R.SR;
  if (duration < 0.1) throw new Error("The audio file contains no sound");
  const maxDur = Number(process.env.MAX_DURATION_SECONDS || 0);

  const clipStart = Math.min(Math.max(0, q.clipStart || 0), duration);
  let clipEnd = q.clipEnd > clipStart ? Math.min(q.clipEnd, duration) : duration;
  if (maxDur > 0 && clipEnd - clipStart > maxDur) throw new Error(`Clips longer than ${maxDur} seconds are not allowed on this server`);
  if (clipEnd - clipStart < 0.1) throw new Error("The clip is shorter than 0.1 seconds");

  let bgImg = null;
  if (backgroundPath) { try { bgImg = await loadImage(backgroundPath); } catch (e) { bgImg = null; } }

  const o = {
    style: q.style, pal: R.buildPalette({ id: "job", name: "job", stops: q.palette.stops, bg: q.palette.bg, light: q.palette.light }),
    bgMode: q.bgMode, bgImg, dim: q.dim, bands: q.bands, gain: q.gain, smooth: q.smooth, glow: q.glow,
    fmin: q.fmin, fmax: q.fmax, title: q.title, artist: q.artist, textPos: q.textPos,
    showProgress: q.showProgress, showTime: q.showTime, clipStart, clipEnd, pcm,
  };
  const W = q.width, H = q.height, fps = q.fps;
  const canvas = createCanvas(W, H), ctx = canvas.getContext("2d");
  const total = Math.max(1, Math.round((clipEnd - clipStart) * fps));

  const args = [
    "-v", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(fps), "-i", "pipe:0",
    "-ss", clipStart.toFixed(3), "-t", (clipEnd - clipStart).toFixed(3), "-i", audioPath,
    "-map", "0:v:0", "-map", "1:a:0?",
    "-c:v", "libx264", "-preset", PRESET, "-crf", String(CRF[q.quality] || 19), "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-movflags", "+faststart", "-shortest", outPath,
  ];
  const enc = spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
  let encErr = "", encClosed = false;
  enc.stderr.on("data", d => { encErr += d; if (encErr.length > 8000) encErr = encErr.slice(-8000); });
  const encDone = new Promise((resolve, reject) => {
    enc.on("error", reject);
    enc.on("close", code => { encClosed = true; code === 0 ? resolve() : reject(new Error("ffmpeg failed: " + (encErr.trim().split("\n").pop() || "exit " + code))); });
  });
  enc.stdin.on("error", () => {});

  send({ type: "status", status: "rendering", totalFrames: total });
  const st = R.createState();
  R.warmUpExport(ctx, W, H, st, o, fps);
  const t0 = Date.now();
  let lastReport = 0;
  for (let i = 0; i < total; i++) {
    if (encClosed) break;
    R.renderFrame(ctx, W, H, st, clipStart + i / fps, 1 / fps, o);
    const ok = enc.stdin.write(Buffer.from(canvas.data()));
    if (!ok) await new Promise(r => {
      const done = () => { enc.stdin.off("drain", done); enc.off("close", done); r(); };
      enc.stdin.once("drain", done); enc.once("close", done);
    });
    const now = Date.now();
    if (now - lastReport > 400 || i === total - 1) {
      lastReport = now;
      const rate = (i + 1) / Math.max(0.001, (now - t0) / 1000);
      send({ type: "progress", frame: i + 1, totalFrames: total, progress: (i + 1) / total, speed: rate / fps, eta: (total - i - 1) / rate });
    }
  }
  enc.stdin.end();
  send({ type: "status", status: "finishing" });
  await encDone;
}

// Exit only after the final IPC message has been flushed to the parent.
const finish = (msg, code) => process.send ? process.send(msg, () => process.exit(code)) : process.exit(code);
process.on("message", msg => {
  if (msg && msg.type === "start") {
    run(msg.job).then(() => finish({ type: "done" }, 0)).catch(e => finish({ type: "error", error: e && e.message ? e.message : String(e) }, 1));
  }
});
