# PixelPress

I got tired of uploading my photos to random "free image compressor" sites. You drag a picture in, it goes off to some server you know nothing about, and half the time the page is more ads than tool. So I built the version I actually wanted: **the file never leaves your device.**

PixelPress compresses and converts images entirely in your browser using the Canvas API. No uploads, no accounts, no tracking, no ads. Close the tab and it's like it was never there — because it wasn't, anywhere except your own machine.

**Live:** coming up on Vercel (link lands here once deployed)

## What it does

- Drop in as many images as you like — JPG, PNG, WebP, GIF, BMP
- Pick an output format (JPEG / PNG / WebP) and a quality level
- Optionally cap the width so big camera photos come down to a sane size
- See before/after sizes per image, download one by one or grab everything as a ZIP
- Click any image for a before/after comparison slider

## Why browser-side?

Two reasons. Privacy is the obvious one — screenshots, documents, personal photos, none of it should have to visit a stranger's server just to get smaller. The less obvious one is speed: there's no upload queue and no download wait for the processing itself. Your own CPU does the work and it's usually faster than the round trip.

## Honest limitations

I'd rather list these than let you find them:

- **Animated GIFs** get compressed as a still first frame. Canvas can't write animated GIFs, and pretending otherwise would just produce a broken file.
- **PNG output ignores the quality slider** — PNG compression is lossless, so there's no quality knob to turn. The UI disables the slider instead of lying about it.
- **HEIC photos** (iPhone default) won't open in most browsers. That's a browser limitation, not much I can do until they support it.
- Very large batches of huge images can eat RAM, since everything happens locally. A dozen photos is fine; two hundred 50MP RAW conversions is not what this is for.

## Running it locally

No build step, no dependencies to install. It's plain HTML, CSS and JavaScript (ES modules), so you just need any static server:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk won't work in most browsers because ES modules need to be served over HTTP. That trips everyone up the first time.

## Tech notes

- Vanilla JS, split into `js/compress.js` (the canvas work), `js/ui.js` (rendering) and `js/app.js` (state and wiring)
- ZIP downloads use [JSZip](https://stuk.github.io/jszip/) from a CDN; if the CDN is unreachable it falls back to downloading files one by one
- Transparent images converted to JPEG get a white background, because JPEG has no alpha channel

## License

MIT — do what you want with it. If you build something on top, a link back is appreciated but not required.
