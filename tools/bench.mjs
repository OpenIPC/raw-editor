/* Wall-clock on a full frame. The design assumes dragging a slider
 * re-develops the picture; if that costs more than a few tens of ms the
 * interaction has to change, so the number belongs in the repo. */
import { readFileSync } from 'node:fs';
import { instantiate, DEMOSAIC } from '../src/engine.js';

const file = process.argv[2];
if (!file) { console.error('usage: bench.mjs <file.dng>'); process.exit(2); }
const engine = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
const t0 = performance.now();
const info = engine.open(readFileSync(file));
const openMs = performance.now() - t0;
console.log(`${info.width}x${info.height} ${info.bits}-bit ${info.cfaName}`);
console.log(`  open + unpack      ${openMs.toFixed(1)} ms`);

for (const [name, d] of [['none', DEMOSAIC.none], ['bilinear', DEMOSAIC.bilinear]]) {
	for (const step of [1, 2, 4]) {
		engine.develop({ demosaic: d, step });     // warm
		const runs = 5, t = performance.now();
		for (let i = 0; i < runs; i++) engine.develop({ demosaic: d, step });
		const ms = (performance.now() - t) / runs;
		const r = engine.develop({ demosaic: d, step });
		console.log(`  ${name.padEnd(9)} step ${step}  ${String(r.width + 'x' + r.height).padEnd(10)}` +
			` ${ms.toFixed(1).padStart(6)} ms  ${(1000 / ms).toFixed(0).padStart(4)} fps`);
	}
}
const t2 = performance.now();
for (let i = 0; i < 5; i++) engine.histogram();
console.log(`  histogram          ${((performance.now() - t2) / 5).toFixed(1)} ms`);
const t3 = performance.now();
engine.probeCFA();
console.log(`  CFA probe          ${(performance.now() - t3).toFixed(1)} ms`);
