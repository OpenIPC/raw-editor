/*
 * A frame with defects put where the test wants them.
 *
 * The Clark-Evans index is the thing an operator will read to decide whether a
 * scan found silicon or scenery, so it has to be checked against an
 * arrangement known before the engine sees it. A photograph cannot give that:
 * whatever its defects are arranged like is what they are arranged like.
 */
import { makeDng } from './make-dng.mjs';

/*
 * `shared` defects land in the same places whatever the seed, and `n` land
 * wherever the seed puts them. That is the shape of the real problem: a sensor
 * carries the same handful of bad pixels into every capture, while whatever
 * the lens was pointed at supplies a different crop of false positives each
 * time. A fixture built only from independent scatterings shares nothing by
 * construction, which makes any N-of-M rule look like it finds nothing.
 */
export function makeDefectFrame({ width = 512, height = 512, n = 120, shared = 0,
	mode = 'scattered', level = 300, spike = 420, seed = 1 } = {}) {
	let s = seed >>> 0;
	const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const px = new Uint16Array(width * height);
	// A flat, quiet field: the defects are meant to be the only structure, so
	// nothing else may compete with them for the scan's attention.
	for (let i = 0; i < px.length; i++) px[i] = level + Math.round((rnd() - 0.5) * 4);

	const put = (x, y) => {
		if (x < 4 || y < 4 || x >= width - 4 || y >= height - 4) return;
		px[y * width + x] = spike;
	};
	if (mode === 'clustered') {
		// A few tight clumps, which is what scene detail looks like.
		const clumps = Math.max(1, Math.round(n / 12));
		for (let c = 0; c < clumps; c++) {
			const cx = 20 + rnd() * (width - 40), cy = 20 + rnd() * (height - 40);
			for (let k = 0; k < n / clumps; k++)
				// Spaced by 4 so each defect keeps its own same-colour
				// neighbours; adjacent spikes would mask one another.
				put(Math.round(cx + (rnd() - 0.5) * 40) & ~1,
					Math.round(cy + (rnd() - 0.5) * 40) & ~1);
		}
	} else {
		for (let k = 0; k < n; k++)
			put(Math.round(8 + rnd() * (width - 16)) & ~1,
				Math.round(8 + rnd() * (height - 16)) & ~1);
	}
	// The sensor's own, from a seed of their own, so every frame gets these.
	const fixed = [];
	if (shared > 0) {
		let f = 20240917 >>> 0;
		const frnd = () => ((f = (f * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
		for (let k = 0; k < shared; k++) {
			const x = Math.round(8 + frnd() * (width - 16)) & ~1;
			const y = Math.round(8 + frnd() * (height - 16)) & ~1;
			put(x, y);
			fixed.push([x, y]);
		}
	}
	return { bytes: makeDng({ width, height, pixels: px, black: 0, white: 4095 }), shared: fixed };
}
