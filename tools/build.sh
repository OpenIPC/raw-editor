#!/bin/sh
# Build dist/ — the directory jsDelivr serves. Everything the browser loads
# ends up here and nowhere else, so the CDN URL and a local checkout are the
# same thing.
#
# No emscripten: the engine is arithmetic over one linear memory, with no
# syscalls and no libc, so a freestanding wasm32 link is enough and leaves a
# module a few KB rather than a few hundred.
set -e
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
mkdir -p dist

clang --target=wasm32 -O2 -flto -nostdlib -ffreestanding \
  -Wall -Wextra -Werror \
  -Wl,--no-entry -Wl,--export-dynamic -Wl,--lto-O2 \
  -Wl,--initial-memory=1114112 \
  -o dist/engine.wasm src/engine.c

# Copied verbatim; CI diffs dist/ against src/ so an edit without a
# rebuild cannot ship a stale copy.
for f in engine.js worker.js editor.js calibrate.js iqprofile.js aftune.js editor.css demo.html test.html; do
  cp "src/$f" dist/
done
ls -l dist/
