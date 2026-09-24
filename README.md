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

**Bad pixels** reports what is wrong with the sensor rather than with the picture:
pixels that disagree with every one of their same-colour neighbours by more
than the noise explains, the black level the frame itself implies against the
one the file claims, what has already clipped, and how noisy the rest is. All
of it off the mosaic — a demosaiced frame has smeared every one of those into
its neighbours, so the same measurements taken after interpolation would be
measurements of the interpolation.

**Find the bad pixels** is the same machinery with a way in. Five captures,
each scanned and kept, and then the sites that turned up in four of them: a
pixel that is genuinely bad is bad in every capture, while noise and scene
detail come and go. It grades the first capture rather than trusting what it
was told — on a lab gk7205v300 + imx335 a frame taken inside a black box sits
0.000 to 0.001 of the way from black to saturation, against 0.105 for a lit
scene — and a covered lens and an uncovered one then get opposite advice: leave
the camera alone, or move it between captures so that detail in the scene
cannot line up with itself. It ends in a list of coordinates you can save.

Narrowing the search to the darkest part of the frame helps a frame with a
picture in it and ruins one without. The cut is a percentile of the local
background, so on a frame that is dark all over it sits just under the level
nearly every pixel is at, and a hot pixel lifts its own neighbourhood above it
— so the gate removes the defects first. On that camera's 7 s dark frame, 3921
sites arranged at a Clark-Evans index of 1.00 become 104 at 0.68, which reads
as "following the picture" about a frame with no picture in it. The guided run
never narrows a dark frame and the panel says why.

The noise figure is a median of local differences rather than a mean square,
because a frame is mostly flat and occasionally an edge and squaring gives the
edges all the say: on a synthetic frame with one hard boundary, a mean-square
estimate read 98 counts where 12 had been added.

**Four demosaics**, scored against the RGB image the test mosaics them from —
mean error per channel, lower is closer to the picture that was thrown away:

| | | |
|---|---|---|
| Bilinear | 5.24 | average the neighbours |
| Gradient | 2.97 | Malvar-He-Cutler: corrected by the curvature of the plane that was measured |
| RCD | **2.28** | ratio-corrected, directional, colour differences against a finished green — **the default** |

RCD is written from the method Luis Sanz Rodríguez published, not ported:
RawTherapee's implementation is GPLv3 and this tree is not, so its code could
not be used here even though it is the reference everyone means by RCD. It is
also the only one that cannot work a pixel at a time — red and blue are carried
as differences against green, so green has to exist everywhere first. That plane
is built once per frame and kept: on a 2592x1520 frame the first develop costs
about 75 ms more than the others and every one after it is level with them.

**There is no AMaZE.** A faithful one is around a thousand lines of intricate
float maths with no reference output here to check a port against, and something
approximate wearing that name would be worse than not having it.

## What the engine does, and what it does not

Handles uncompressed Bayer DNG at 8, 10, 12, 14 and 16 bits, little-endian.
The 16-bit case is stored rather than packed, one sample per two bytes, which
is what the older HiSilicon parts write — until the reader learned it, every
camera in that class answered "unsupported bit depth". It reads
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

## Licence

MIT — see [LICENSE](LICENSE). The same licence `majestic-webui` carries, which
matters here because RCD is implemented from the published method rather than
ported: the reference implementation is GPLv3 and could not be used in a tree
under this licence. [CONTRIBUTING.md](CONTRIBUTING.md) has the rest.
