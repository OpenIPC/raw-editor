# raw-editor

A raw developer and sensor-diagnostic tool for IP cameras, running in the
browser. It reads the DNG that [majestic](https://github.com/OpenIPC/majestic)
serves at `/image.dng` and develops it locally — the camera does no work beyond
handing over the frame.

Served from a CDN rather than shipped in the firmware: only some HiSilicon and
Goke boards serve raw at all, and the WebUI image is one tarball for every
board, so an editor nobody on that camera can use would be dead weight on all
of them.

```
https://cdn.jsdelivr.net/gh/OpenIPC/raw-editor@v0.1.0/dist/
```

## Build

No emscripten. The engine is arithmetic over one linear memory — no syscalls,
no libc — so a freestanding `wasm32` link is enough and leaves a module of a
few KB:

```sh
./tools/build.sh          # needs clang with the wasm32 target, and wasm-ld
node tools/smoke.mjs      # decodes tests/fixture.dng, checks it against truth
node tools/bench.mjs frame.dng
```

`dist/` is committed and is exactly what jsDelivr serves, so a CDN URL and a
local checkout are the same bytes. CI rebuilds and fails if they drift.

To look at a frame: serve `dist/` and open `test.html`, then drop a `.dng` on it.

## What the engine does, and what it does not

Handles uncompressed Bayer DNG at 8, 10, 12 and 14 bits, little-endian. It reads
`BlackLevel`, `WhiteLevel`, `CFAPattern`, `AsShotNeutral`, `ForwardMatrix1`,
`UniqueCameraModel`, ISO and exposure, and develops through the forward matrix
to sRGB — which is the transform the DNG spec defines for white-balanced camera
values, and the reason `ColorMatrix1` is read but not used for rendering.

**The Bayer probe narrows to two candidates and stops there.** It scores each
pattern by how well the two green sites agree: they share a filter, so across
any scene their means land within a fraction of a percent, and a pattern with
the wrong green diagonal does not come close. That eliminates two of the four.

It cannot separate the remaining two — RGGB and BGGR differ only in which corner
is red, and no statistic of a single frame settles it. The obvious grey-world
test does not work either: on the amber frame this engine was written against,
grey-world ranks the *wrong* pattern first, because the scene genuinely is not
grey. So the probe reports both survivors and says it is ambiguous, and a person
looks at two renders.

## Measured

A 2592×1520 10-bit frame, on a desktop x86:

| | full | 1/2 | 1/4 |
|---|---|---|---|
| bilinear | 182 ms | 45 ms | 11 ms |
| none (mosaic) | 79 ms | 19 ms | 5 ms |

open + unpack 13 ms · histogram 0.6 ms · CFA probe 1.2 ms

Full resolution is 5.5 fps, which is not a live slider — so `develop()` takes a
`step`, and the interactive path renders a reduced preview with the full size on
release. Stepping moves in whole Bayer quads so the preview keeps the CFA phase;
the smoke test asserts a stepped render matches the full one.
