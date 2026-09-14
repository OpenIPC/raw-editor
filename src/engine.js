/*
 * The engine's JS side: load the wasm, move bytes in and out of its memory.
 *
 * Two things live here rather than in C on purpose. The gamma curve, because
 * it needs pow() and C without libm has none — a 1024-entry table costs one
 * kilobyte and removes the only reason to link a maths library. And the error
 * strings, because a number crossing the boundary is cheap and a sentence is
 * not.
 */

const ERRORS = {
	0: 'ok',
	'-1': 'not a DNG (no little-endian TIFF header)',
	'-2': 'file is truncated',
	'-3': 'no image data in the file',
	'-4': 'unsupported bit depth (8, 10, 12 and 14 are handled)',
	'-5': 'the image data is compressed, which this build cannot read',
	'-6': 'implausible image dimensions',
};

export const CFA_NAMES = ['RGGB', 'GRBG', 'GBRG', 'BGGR'];
export const DEMOSAIC = { none: 0, bilinear: 1 };

/* sRGB's own transfer function, not a 2.2 power — the toe matters in the
 * shadows, which is exactly where a raw frame is judged. */
function gammaTable() {
	const t = new Uint8Array(1024);
	for (let i = 0; i < 1024; i++) {
		const v = i / 1023;
		const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
		t[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
	}
	return t;
}

/* Split so the smoke test can hand over bytes it read off disk: node has no
 * fetch for file:// and the engine must be testable without a browser. */
export async function instantiate(wasmBytes) {
	const { instance } = await WebAssembly.instantiate(wasmBytes, {});
	return new Engine(instance.exports);
}

export async function loadEngine(wasmUrl) {
	const src = await fetch(wasmUrl);
	if (!src.ok) throw new Error('engine.wasm: http ' + src.status);
	return instantiate(await src.arrayBuffer());
}

export class Engine {
	constructor(x) {
		this.x = x;
		// Scratch buffers live as long as the frame does. The engine's
		// allocator is a bump allocator with no free, so allocating these per
		// render grows memory for as long as a slider is moving — a minute of
		// dragging is thousands of renders.
		this.gammaPtr = 0;
		this.fwdPtr = 0;
		this.histPtr = 0;
	}

	get mem() {
		// The buffer is replaced whenever memory grows, so never cache it.
		return new Uint8Array(this.x.memory.buffer);
	}

	/* Parse and unpack. Returns the frame's own description of itself. */
	open(bytes) {
		const x = this.x;
		x.reset_alloc();
		this.gammaPtr = this.fwdPtr = this.histPtr = 0;

		const p = x.alloc(bytes.length);
		if (!p) throw new Error('out of memory holding the file');
		this.mem.set(bytes, p);

		const rc = x.dng_open(p, bytes.length);
		if (rc !== 0) throw new Error(ERRORS[rc] || 'unreadable file (' + rc + ')');

		const rc2 = x.dng_unpack();
		if (rc2 !== 0) throw new Error(ERRORS[rc2] || 'could not unpack (' + rc2 + ')');

		const f32 = new Float32Array(x.memory.buffer);
		const neutral = Array.from(f32.subarray(x.dng_neutral_ptr() >> 2, (x.dng_neutral_ptr() >> 2) + 3));
		const forward = Array.from(f32.subarray(x.dng_forward_ptr() >> 2, (x.dng_forward_ptr() >> 2) + 9));

		const m = this.mem, mp = x.dng_model_ptr();
		let model = '';
		for (let i = mp; m[i] && i < mp + 64; i++) model += String.fromCharCode(m[i]);

		this.info = {
			width: x.dng_width(), height: x.dng_height(), bits: x.dng_bits(),
			cfa: x.dng_cfa(), cfaName: CFA_NAMES[x.dng_cfa()],
			black: x.dng_black(), white: x.dng_white(),
			iso: x.dng_iso(), exposure: x.dng_exposure(),
			neutral, forward, hasForward: !!x.dng_has_forward(), model,
		};
		this.rgbaPtr = 0;
		return this.info;
	}

	#gamma() {
		if (!this.gammaPtr) {
			this.gammaPtr = this.x.alloc(1024);
			this.mem.set(gammaTable(), this.gammaPtr);
		}
		return this.gammaPtr;
	}

	/* Develop into RGBA. Returns a view on wasm memory — copy it if you mean
	 * to keep it, because the next call reuses the same buffer. */
	develop(opts = {}) {
		const x = this.x, i = this.info;
		const o = {
			cfa: i.cfa, demosaic: DEMOSAIC.bilinear, black: i.black, white: i.white,
			neutral: i.neutral, forward: i.forward, useForward: i.hasForward,
			gain: 1, step: 1, ...opts,
		};
		const step = o.step > 1 ? o.step & ~1 : 1;
		const ow = Math.floor(i.width / step), oh = Math.floor(i.height / step);
		const px = ow * oh;
		// One buffer, sized for the full frame, reused by every preview.
		if (!this.rgbaPtr) {
			this.rgbaPtr = x.alloc(i.width * i.height * 4);
			if (!this.rgbaPtr) throw new Error('out of memory developing the frame');
		}
		let fp = 0;
		if (o.useForward) {
			if (!this.fwdPtr) this.fwdPtr = x.alloc(9 * 4);
			fp = this.fwdPtr;
			new Float32Array(x.memory.buffer, fp, 9).set(o.forward);
		}
		const g = this.#gamma();
		const rc = x.develop(this.rgbaPtr, o.cfa, o.demosaic, o.black, o.white,
			o.neutral[0], o.neutral[1], o.neutral[2], fp, o.useForward ? 1 : 0,
			o.gain, g, step);
		if (rc !== 0) throw new Error(ERRORS[rc] || 'develop failed (' + rc + ')');
		this.lastPixels = px;
		return { pixels: new Uint8ClampedArray(x.memory.buffer, this.rgbaPtr, px * 4),
			width: ow, height: oh };
	}

	histogram() {
		const x = this.x, px = this.lastPixels || (this.info.width * this.info.height);
		if (!this.histPtr) this.histPtr = x.alloc(768 * 4);
		x.histogram(this.rgbaPtr, px, this.histPtr);
		const b = new Uint32Array(x.memory.buffer, this.histPtr, 768);
		return { r: b.slice(0, 256), g: b.slice(256, 512), b: b.slice(512, 768) };
	}

	/*
	 * Score all four Bayer orders by how well their two green sites agree.
	 *
	 * This reliably eliminates the two patterns with the wrong green diagonal
	 * and cannot separate the two that remain — RGGB and BGGR differ only in
	 * which corner is red, and no statistic of a single frame decides that.
	 * `ambiguous` says so, so a caller can show the survivors and let someone
	 * look rather than presenting a coin toss as a result.
	 */
	probeCFA() {
		const ranked = CFA_NAMES.map((name, cfa) => ({
			cfa, name, score: this.x.cfa_score(cfa),
		})).sort((a, b) => b.score - a.score);
		const ambiguous = ranked[1].score > ranked[0].score * 0.99;
		return { ranked, ambiguous, survivors: ranked.filter((r) => r.score > ranked[0].score * 0.99) };
	}
}
