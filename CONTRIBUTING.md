# Contributing

`README.md` says what this is, how it is built and what the engine does — start
there. This file is only about working *in* the tree: the loop, the rules a
change is held to, and the traps that have already cost somebody an afternoon.

Patches are welcome. Nothing here is ceremony; every rule below exists because
something went wrong without it, and most of them say which thing.

## The loop

```sh
./tools/build.sh          # regenerates dist/ — see below, this is not optional
node tools/smoke.mjs      # the engine, against measured ground truth
node tools/ui-check.mjs   # the interface, in a real browser (needs chromium)
```

CI runs five steps and you can run all of them locally in about a minute:

```sh
for f in src/*.js tools/*.mjs; do node --check "$f"; done
./tools/build.sh
for f in engine.js worker.js editor.js calibrate.js iqprofile.js editor.css demo.html test.html; do
  diff -q "src/$f" "dist/$f" || echo "OUT OF SYNC: $f"
done
node tools/smoke.mjs
node tools/ui-check.mjs
```

**`dist/` is committed, and CI diffs it against `src/`.** jsDelivr serves the
tag, so `dist/` *is* the release — an edit to `src/` without a rebuild ships
nothing and fails CI. This is the most common way a patch goes red. Run
`./tools/build.sh` and commit `dist/` in the same change.

## The engine is freestanding

`src/engine.c` is compiled to `wasm32` with no libc and no emscripten. There is
no `malloc`, no `printf`, no `sqrt`, no `pow`. Reaching for one does not fail to
link with a clear message — it fails in ways that waste time.

- Memory comes from the bump allocator in the module; `open()` calls
  `reset_alloc()`, so per-frame scratch is allocated after that and cached
  buffers must be re-checked, not assumed live.
- For a square root use `__builtin_sqrt`, which clang emits as the wasm
  `f64.sqrt` instruction. Everywhere else the engine returns a variance and
  lets the JS side take the root, which is why `diagnose()` reports
  `noise` already rooted but the wasm returns squares.
- Floats are `float` in the hot paths and `double` where an accumulation would
  drift. Both are free; the instruction set has them.

## Tests, and how they lie to you

Every trap below is one this tree actually fell into.

**`textContent` runs elements together.** A heading `Defects` immediately
followed by a paragraph starting `None.` reads as `DefectsNone.`, with no word
boundary between them — so `/\bNone\./` does not match and the check silently
passes or fails for the wrong reason. This has caught two separate checks in
`tests/ui-check.html`. Do not put `\b` at the start of a `textContent` regex.

**A test must fail without the fix.** Add the guard, revert the change, watch it
go red, put the change back. A winding check was added for a mirrored-lattice
bug and passed on every existing case, because none of them triggered the swap
that caused it; the case that did had to be constructed on purpose.

**A fixture built to match the bug proves nothing.** One synthetic chart was
generated with the same reversed winding the detector had, so detector and
fixture agreed and the test was green while the output was mirrored.

**Never assert a literal against itself.** `/in 1 second/.test('in 1 second.')`
passes whatever the code does. Assert against what the code actually rendered.

**Playwright's `route.continue()` fetches from Node, not from the browser.**
Intercepting requests to attach credentials means the page never performs the
fetch — so a check that "verified" a camera path through interception has
verified nothing about what a browser does with it. Use real credentials (a
form login, or `httpCredentials` with an `origin`) and let the page fetch.

## Fixtures

`tests/fixture.dng` is a real 256×256 crop off an IMX335 and the smoke test
asserts numbers measured on that exact file — pedestal, clipping fraction,
matrix row sums. It is ground truth, not sample data. Do not regenerate it; a
change that makes it fail is a change to the engine's answers.

Where a test needs an answer known *before* the engine runs, generate the frame:

| | |
|---|---|
| `tools/make-dng.mjs` | writes a DNG — 12-bit packed, or 16-bit stored |
| `tools/make-chart.mjs` | a ColorChecker through a homography at chosen corners |
| `tools/make-defects.mjs` | defects scattered or clustered, and `shared` ones present in every frame |

## Patches

- One concern per change, with the reasoning in the commit message rather than
  in the diff. Say what was measured, not what was expected.
- Comments explain *why*, and are worth most where the obvious thing is wrong.
  Several in this tree exist because the obvious thing was tried first.
- **No GPL code.** This tree is MIT — see `LICENSE`, which matches the one
  `majestic-webui` carries. GPL-licensed source cannot be copied into it, and
  that is not a technicality: RCD is written from Luis Sanz Rodríguez's
  published method rather than ported from RawTherapee, whose implementation is
  the reference everyone means by RCD and is GPLv3. Implement from the paper,
  and say in the commit message which paper.
- Numbers in a commit message or a comment should be ones you took. If a figure
  came from somewhere else, say where.

## Releasing

`dist/` at a tag is what the world gets:

1. merge to `main`, with `dist/` current
2. `git tag -a vX.Y.Z` and push the tag
3. jsDelivr serves `gh/OpenIPC/raw-editor@vX.Y.Z/dist/` within a minute or two
4. `majestic-webui` pins that tag in `www/a/raw-loader.js`

The WebUI degrades without the module — it is fetched at runtime with a timeout
and a session-long latch, and the raw page renders completely when it never
arrives. Keep it that way: nothing here may become load-bearing for the camera's
own interface.
