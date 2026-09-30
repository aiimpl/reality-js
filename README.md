# Reality.js — the shoreline

A sunny shoreline, drawn in the browser with nothing but three.js.
No photos, no video, no texture images. The sky, sea, sand, foam and glints are all computed in shaders.

**Open in your browser: https://aiimpl.github.io/reality-js/**

## What's in it
- 21 seconds of shoreline: swell rolls in, breaks into whitewater, runs up the sand and drains back — seven times
- Foam lace: as the foam thins, holes grow until only thin threads remain; the lace keeps re-forming as it drains
- Glints: only the facets whose slope reflects the sun light up; far away they merge into a band of light
- Green light through the backlit crests, and a thin film of water left on the wet sand
- Handheld-style camera sway and auto-exposure drift
- Export: 1920×1080, 30fps PNG sequence and mp4

## Changes in v1.1
Fixes from replies on X:
- **Foam shadows**: the foam threads shade their camera-facing edges and cast a shadow a few cm toward the camera (the sun is behind the waves, 20° up)
- **No more Voronoi**: the backwash lace is built from noise contours instead of Voronoi cells, so the holes are uneven. Two layers swap every 2.2s, so the pattern keeps changing and thins out instead of sitting still
- **No marching pixels**: glints blink in place instead of drifting toward the beach; the white dots on the dry sand are gone
- **Speed**: the offshore swell and ripples move at shallow-water speed

The breaking waves (whitewater) are unchanged from v1.0.

## Requirements
- Viewing: any browser with WebGL2 (Chrome / Safari / Edge)
- Exporting: Python 3.10+, Google Chrome, ffmpeg

## Usage
```sh
make serve            # open http://127.0.0.1:8791/ (?t=10 starts at 10s)
make setup            # install Playwright for exporting
make video            # 630 frames into build/frames → build/reality.mp4
```
On an Apple silicon Mac, exporting takes about 1–2 seconds per frame.

## How it works
- **Grid**: water and sand share one grid (finer near the camera, reaching 9 km out) and get their heights from the same function. Where the water film is thinner than the sand, the water is discarded per pixel
- **Waves** (`waveAt` in `shaders.js`): each wave is a closed-form function of time
  - Approach: steep front, gentle back
  - Break: the crest turns white from the top, and the whitewater bore runs up the beach at 2.8 m/s
  - Run-up: from the waterline it climbs with constant deceleration, stops and drains back; the leading edge is a thin line of foam
  - Oblique arrival (the right side lands first), with variation in height and breaking position along the shore
- **Ripples**: normals from 60 summed waves. Waves finer than a pixel are not drawn; their slope variance widens the glints instead
- **Glints**: the surface is split into small cells, each with a normally distributed slope; only cells facing the sun light up. Cells re-roll over time, so they twinkle
- **Foam**: lace made by thresholding noise contours; whitewater is a solid mass with shading and highlights
- **Post**: rendered at 2× and downsampled, 3 sub-frames averaged per frame (1/120 s shutter), bloom on the brightest spots only, plus a faint vertical streak under the sun
- **Camera**: interpolated from a table in `track.js` (horizon height, roll and exposure every 0.1 s)

## Files
```
index.html        page
main.js           grid, camera, wave list, render and export entry points
shaders.js        waves, foam, glints, sky and post-processing shaders
track.js          handheld camera motion and exposure table
tools/render.py   opens Chrome and saves one PNG per frame
tools/encode.sh   PNG sequence → mp4 (yuv420p)
vendor/three      three.js r160 (MIT)
```

## License
MIT (`LICENSE`). three.js is MIT as well, see `vendor/three/LICENSE`.
