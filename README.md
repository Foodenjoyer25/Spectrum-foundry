# Spectrum Foundry

Turn any audio file into a spectrum visualizer video. Pick one of 14 styles, tweak colours and text, and render an MP4 with the original sound, either **in your browser** or **on the server**.

## Run it with Docker

```bash
docker compose up -d --build
```

Then open http://localhost:8080.

Or without Compose:

```bash
docker build -t spectrum-foundry .
docker run -d -p 8080:8080 -v spectrum-data:/data --name spectrum-foundry spectrum-foundry
```

## Client-side or server-side processing

The **Processing** switch in the Output panel picks where the video is made:

| | In this browser | On the server |
|---|---|---|
| How | WebCodecs, frame by frame, muxed with mp4-muxer | Same renderer on a Skia canvas, piped into ffmpeg |
| Output | MP4 (H.264/VP9/AV1 + AAC/Opus, depending on the browser) | MP4, always H.264 + AAC |
| Upload | Nothing leaves the device | Audio (and background image) is uploaded |
| Good for | Privacy, no server load | Older browsers, phones, long or 4K renders |

The server option is enabled automatically when the page is served by the container. When `index.html` is opened as a plain file or hosted statically, only browser rendering is offered.

Both modes use the same drawing code (`public/renderer.js`), so the result looks the same either way.

## Configuration

Set these as environment variables on the container:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `MAX_UPLOAD_MB` | `500` | Largest audio upload accepted |
| `MAX_CONCURRENT_JOBS` | `1` | Videos rendered at the same time (each uses about one CPU core plus ffmpeg) |
| `MAX_QUEUED_JOBS` | `20` | Jobs that can wait in the queue before new ones are refused |
| `JOB_TTL_MINUTES` | `60` | How long finished videos are kept before being deleted |
| `MAX_DURATION_SECONDS` | unset | Optional cap on clip length |
| `ALLOW_4K` | `true` | Set to `false` to refuse 3840×2160 server renders |
| `X264_PRESET` | `veryfast` | x264 speed/size trade-off (`ultrafast` … `slow`) |
| `DATA_DIR` | `/data` | Where uploads and finished videos are stored |

There is no authentication. If you expose the server publicly, put it behind a reverse proxy with auth or rate limiting. The app uses relative URLs, so it also works under a sub-path.

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/capabilities` | Server limits; the UI uses this to detect server rendering |
| `POST` | `/api/jobs` | `multipart/form-data`: `audio` file, optional `background` image, `options` JSON |
| `GET` | `/api/jobs/:id` | Status: `queued`, `decoding`, `rendering`, `finishing`, `done`, `error`, `cancelled`, with progress |
| `GET` | `/api/jobs/:id/video` | The MP4 (`?download=1` for an attachment) |
| `DELETE` | `/api/jobs/:id` | Cancel and delete |
| `GET` | `/healthz` | Health check |

## Run without Docker

Needs Node.js 20+ and ffmpeg on the `PATH`.

```bash
npm install
npm start
```

## Features

- 14 styles: Classic Bars, Mirror, Radial Burst, Oscilloscope, Halo, Spectrogram, Ridgeline, LED Meter, Liquid Blob, Warp Field, Skyline, Dot Matrix, Sunrise Arc, Tunnel
- 8 palettes plus custom colours; solid, glow or image backgrounds
- Band count, sensitivity, smoothing, glow and frequency-range controls
- Title/artist overlay, progress bar and timecode
- 720p, 1080p, 4K, square, 4:5 or 9:16 output at 24/30/60 fps, with optional start/end trim

## Project layout

```
public/index.html     UI
public/app.js         browser app: preview, controls, browser export, server client
public/renderer.js    shared audio analysis + all visualizer styles (browser and Node)
public/vendor/        mp4-muxer (MIT) for browser MP4 export
server/server.js      Express server, upload handling and job queue
server/render-job.js  one render: ffmpeg decode -> canvas frames -> ffmpeg H.264/AAC
```
