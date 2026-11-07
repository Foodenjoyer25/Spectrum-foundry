# Spectrum Foundry

Turn any audio file into a spectrum visualizer video, right in the browser. Nothing is uploaded.

Open `index.html` in a recent Chrome, Edge, Safari or Firefox, drop in an audio file, pick a style and click **Render video**.

## Features

- 14 styles: Classic Bars, Mirror, Radial Burst, Oscilloscope, Halo, Spectrogram, Ridgeline, LED Meter, Liquid Blob, Warp Field, Skyline, Dot Matrix, Sunrise Arc, Tunnel
- 8 palettes plus custom colors; solid, glow or image backgrounds
- Bands, sensitivity, smoothing, glow and frequency-range controls
- Title/artist overlay, progress bar and timecode
- Output at 720p, 1080p, 4K, square, 4:5 or 9:16, at 24/30/60 fps, with optional start/end trim
- Faster-than-real-time MP4 export via WebCodecs (H.264, VP9 or AV1 video; AAC or Opus audio), using [mp4-muxer](https://github.com/Vanilagy/mp4-muxer)
- Real-time MediaRecorder fallback for browsers without WebCodecs

The whole video is held in memory until saved, so very long tracks at 4K/60 fps may need a lower setting.
