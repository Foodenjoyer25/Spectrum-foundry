"use strict";
/*
 * Spectrum Foundry server: serves the web app and renders videos on request.
 *
 *   GET    /api/capabilities      -> what this server allows (used by the UI to enable server rendering)
 *   POST   /api/jobs              -> multipart: audio (required), background (optional image), options (JSON)
 *   GET    /api/jobs/:id          -> job status and progress
 *   GET    /api/jobs/:id/video    -> the finished MP4 (?download=1 for an attachment)
 *   DELETE /api/jobs/:id          -> cancel a job and delete its files
 */
const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { fork, execFileSync } = require("child_process");
const R = require("../public/renderer.js");

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const PORT = Number(env("PORT", 8080));
const MAX_UPLOAD_MB = Number(env("MAX_UPLOAD_MB", 500));
const MAX_CONCURRENT = Math.max(1, Number(env("MAX_CONCURRENT_JOBS", 1)));
const MAX_QUEUE = Math.max(1, Number(env("MAX_QUEUED_JOBS", 20)));
const JOB_TTL_MIN = Math.max(1, Number(env("JOB_TTL_MINUTES", 60)));
const MAX_DURATION = Number(env("MAX_DURATION_SECONDS", 0));
const ALLOW_4K = env("ALLOW_4K", "true") !== "false";
const DATA_DIR = path.resolve(env("DATA_DIR", path.join(require("os").tmpdir(), "spectrum-foundry")));
const FFMPEG = env("FFMPEG_PATH", "ffmpeg");

fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "jobs"), { recursive: true });

let ffmpegVersion = null;
try { ffmpegVersion = execFileSync(FFMPEG, ["-version"]).toString().split("\n")[0]; }
catch (e) { console.warn("ffmpeg was not found; server-side rendering is disabled."); }

const SIZES = new Set(["1920x1080", "1280x720", "3840x2160", "1080x1080", "1080x1350", "1080x1920"]);
const STYLE_IDS = new Set(R.STYLES.map(s => s.id));
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Validate and normalise options sent by the browser. Throws with a readable message. */
function sanitizeOptions(raw) {
  let q; try { q = JSON.parse(raw || "{}"); } catch (e) { throw new Error("Options are not valid JSON"); }
  const num = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const str = (v, max) => (typeof v === "string" ? v : "").replace(/[\u0000-\u001f]/g, "").slice(0, max);
  const size = `${q.width}x${q.height}`;
  if (!SIZES.has(size)) throw new Error("Unsupported output size " + size);
  if (size === "3840x2160" && !ALLOW_4K) throw new Error("4K output is disabled on this server");
  if (!STYLE_IDS.has(q.style)) throw new Error("Unknown style");
  const p = q.palette || {};
  const stops = Array.isArray(p.stops) ? p.stops.filter(c => HEX.test(c)).slice(0, 6) : [];
  if (stops.length < 2 || !HEX.test(p.bg)) throw new Error("Invalid palette");
  const fmin = num(q.fmin, 20, 400, 35);
  return {
    style: q.style, palette: { stops, bg: p.bg, light: typeof p.light === "boolean" ? p.light : undefined },
    bgMode: ["solid", "glow", "image"].includes(q.bgMode) ? q.bgMode : "glow", dim: num(q.dim, 0, 0.9, 0.55),
    bands: Math.round(num(q.bands, 16, 192, 64)), gain: num(q.gain, 0.4, 2.5, 1), smooth: num(q.smooth, 0, 0.95, 0.8), glow: num(q.glow, 0, 1, 0.5),
    fmin, fmax: num(q.fmax, fmin * 4, 22000, 16000),
    title: str(q.title, 120), artist: str(q.artist, 160), textPos: ["bl", "tl", "c", "none"].includes(q.textPos) ? q.textPos : "bl",
    showProgress: !!q.showProgress, showTime: !!q.showTime,
    clipStart: num(q.clipStart, 0, 1e6, 0), clipEnd: num(q.clipEnd, 0, 1e6, 0),
    width: Number(q.width), height: Number(q.height), fps: [24, 30, 60].includes(Number(q.fps)) ? Number(q.fps) : 30,
    quality: ["standard", "high", "max"].includes(q.quality) ? q.quality : "high",
  };
}

/* ---------------- jobs ---------------- */
const jobs = new Map();
const queue = [];
let running = 0;

function publicJob(j) {
  return {
    id: j.id, status: j.status, progress: j.progress, frame: j.frame, totalFrames: j.totalFrames, speed: j.speed, eta: j.eta,
    error: j.error, size: j.size, queuePosition: j.status === "queued" ? queue.indexOf(j) + 1 : 0, filename: j.filename,
  };
}
function removeFiles(j) {
  for (const f of [j.audioPath, j.backgroundPath, j.outPath]) if (f) fs.rm(f, { force: true }, () => {});
}
function pump() {
  while (running < MAX_CONCURRENT && queue.length) start(queue.shift());
}
function start(j) {
  running++;
  j.status = "decoding"; j.startedAt = Date.now();
  const child = fork(path.join(__dirname, "render-job.js"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  j.child = child;
  child.on("message", m => {
    if (m.type === "status") { j.status = m.status; if (m.totalFrames) j.totalFrames = m.totalFrames; }
    else if (m.type === "progress") Object.assign(j, { frame: m.frame, totalFrames: m.totalFrames, progress: m.progress, speed: m.speed, eta: m.eta });
    else if (m.type === "done") j.succeeded = true; // status flips to "done" on exit, once the file size is known
    else if (m.type === "error") { j.status = "error"; j.error = m.error; }
  });
  child.on("exit", code => {
    running--; j.child = null; j.finishedAt = Date.now();
    if (j.status === "cancelled") removeFiles(j);
    else if (j.succeeded && code === 0) { j.status = "done"; j.progress = 1; }
    else { j.status = "error"; j.error = j.error || "The render process stopped unexpectedly (exit " + code + ")"; }
    if (j.status === "done") {
      try { j.size = fs.statSync(j.outPath).size; } catch (e) { j.status = "error"; j.error = "The output file is missing"; }
      console.log(`job ${j.id} done in ${((j.finishedAt - j.startedAt) / 1000).toFixed(1)}s (${(j.size / 1048576).toFixed(1)} MB)`);
    } else if (j.status === "error") console.warn(`job ${j.id} failed: ${j.error}`);
    if (j.audioPath) fs.rm(j.audioPath, { force: true }, () => {});
    if (j.backgroundPath) fs.rm(j.backgroundPath, { force: true }, () => {});
    pump();
  });
  child.send({ type: "start", job: { options: j.options, audioPath: j.audioPath, backgroundPath: j.backgroundPath, outPath: j.outPath } });
}
// Delete finished jobs (and their videos) after the TTL.
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MIN * 60000;
  for (const [id, j] of jobs) if (j.finishedAt && j.finishedAt < cutoff) { removeFiles(j); jobs.delete(id); }
}, 60000).unref();

/* ---------------- http ---------------- */
const app = express();
app.disable("x-powered-by");
const upload = multer({
  dest: path.join(DATA_DIR, "uploads"),
  limits: { fileSize: MAX_UPLOAD_MB * 1048576, files: 2, fields: 5, fieldSize: 64 * 1024 },
});

app.get("/api/capabilities", (req, res) => {
  res.json({
    server: !!ffmpegVersion, maxUploadMB: MAX_UPLOAD_MB, maxDurationSeconds: MAX_DURATION || null, allow4k: ALLOW_4K,
    jobTtlMinutes: JOB_TTL_MIN, concurrentJobs: MAX_CONCURRENT, queued: queue.length, running, styles: R.STYLES.map(s => s.id),
  });
});
app.get("/healthz", (req, res) => res.json({ ok: true, running, queued: queue.length }));

app.post("/api/jobs", (req, res) => {
  upload.fields([{ name: "audio", maxCount: 1 }, { name: "background", maxCount: 1 }])(req, res, err => {
    const files = req.files || {};
    const cleanup = () => { for (const k in files) for (const f of files[k]) fs.rm(f.path, { force: true }, () => {}); };
    if (err) {
      cleanup();
      const msg = err.code === "LIMIT_FILE_SIZE" ? `The file is larger than this server's ${MAX_UPLOAD_MB} MB limit` : err.message;
      return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: msg });
    }
    if (!ffmpegVersion) { cleanup(); return res.status(503).json({ error: "ffmpeg is not installed on this server" }); }
    if (!files.audio) { cleanup(); return res.status(400).json({ error: "No audio file was uploaded" }); }
    if (queue.length >= MAX_QUEUE) { cleanup(); return res.status(503).json({ error: "The server queue is full. Try again in a few minutes." }); }
    let options;
    try { options = sanitizeOptions(req.body && req.body.options); }
    catch (e) { cleanup(); return res.status(400).json({ error: e.message }); }
    const id = crypto.randomBytes(12).toString("hex");
    const audioFile = files.audio[0], bgFile = files.background && files.background[0];
    const base = (options.title || audioFile.originalname.replace(/\.[^.]+$/, "") || "spectrum").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "").trim().slice(0, 80) || "spectrum";
    const style = R.STYLES.find(s => s.id === options.style).name;
    const j = {
      id, status: "queued", progress: 0, createdAt: Date.now(), options,
      audioPath: audioFile.path, backgroundPath: bgFile && options.bgMode === "image" ? bgFile.path : null,
      outPath: path.join(DATA_DIR, "jobs", id + ".mp4"),
      filename: `${base} - ${style} ${options.width}x${options.height}.mp4`,
    };
    if (bgFile && !j.backgroundPath) fs.rm(bgFile.path, { force: true }, () => {});
    jobs.set(id, j); queue.push(j); pump();
    res.status(202).json(publicJob(j));
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found. Finished videos are deleted after " + JOB_TTL_MIN + " minutes." });
  res.set("Cache-Control", "no-store").json(publicJob(j));
});

app.get("/api/jobs/:id/video", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== "done") return res.status(404).json({ error: "Video not available" });
  const opts = { headers: { "Content-Type": "video/mp4", "Cache-Control": "private, max-age=3600" } };
  if (req.query.download) res.download(j.outPath, j.filename, opts);
  else res.sendFile(j.outPath, opts);
});

app.delete("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found" });
  const qi = queue.indexOf(j);
  if (qi >= 0) { queue.splice(qi, 1); j.status = "cancelled"; j.finishedAt = Date.now(); removeFiles(j); }
  else if (j.child) { j.status = "cancelled"; j.child.kill("SIGKILL"); }
  else { removeFiles(j); jobs.delete(j.id); }
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"], maxAge: "1h" }));

const server = app.listen(PORT, () => {
  console.log(`Spectrum Foundry listening on :${PORT} (server rendering ${ffmpegVersion ? "on" : "off"}, ${MAX_CONCURRENT} concurrent job(s), data in ${DATA_DIR})`);
});
const shutdown = () => { for (const j of jobs.values()) if (j.child) j.child.kill("SIGKILL"); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
