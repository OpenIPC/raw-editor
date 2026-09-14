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
node tools/ui-check.mjs   # drives the built editor in a real browser
node tools/bench.mjs frame.dng
```

`dist/` is committed and is exactly what jsDelivr serves, so a CDN URL and a
local checkout are the same bytes. CI rebuilds and fails if they drift.

To look at a frame: serve `dist/` and open `demo.html`, then drop a `.dng` on
it. `test.html` beside it is the bare engine harness — no studio, just the
decode and a canvas — which is the quicker thing to reach for when the question
is about the engine rather than the interface.

The studio is mounted by the host page, not by itself:

```js
import { mountEditor } from './editor.js';
const editor = mountEditor(document.getElementById('root'), {
	base: './',
	capture: async () => {
		const r = await fetch('/image.dng', { credentials: 'same-origin' });
		if (!r.ok) throw new Error('The camera answered ' + r.status + '.');
		return { bytes: new Uint8Array(await r.arrayBuffer()), name: 'frame.dng' };
	},
	onExit: () => history.back(),
});
editor.open(bytes, 'frame.dng');   // optional: a frame you already have
```

`base` is where the module's own files live, which is the CDN directory in
production. The editor owns everything inside the root it is given: markup,
styles and its worker.

`capture` is how a frame gets in without a file to drag. Give it an async
function returning `{ bytes, name }` and the editor grows its own **Capture**
button, in the chrome and in the empty state; leave it out and neither appears,
because a button that cannot work is worse than no button. **Download** hands
back the bytes exactly as they arrived — not the developed preview — and is
offered as soon as a frame is open, whatever it was opened from.

**Picking a neutral.** White balance starts at `AsShotNeutral` — the balance the
camera chose — and the picker is how you overrule it: arm it in the White
balance panel and click anything in the frame that ought to be grey. The sample
is taken from the mosaic, not from the canvas, which is the whole point: the
canvas has already been white-balanced, so reading it back would measure the
balance in force rather than the scene. Resetting either slider goes back to as
shot.

This matters more on a camera than on a DSLR. `AsShotNeutral` is *defined* as
what the camera's AWB settled on, so a DNG faithfully carries that AWB's
mistakes: on a lab gk7205v300 under a 2272 K lamp the AWB over-corrected, and
both the camera's own JPEG and this editor rendered the chart's grey row 20 to
30 levels blue — the same error, because both are obeying the same white
balance. Clicking one grey patch brought the row to within a couple of levels
of neutral.

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
