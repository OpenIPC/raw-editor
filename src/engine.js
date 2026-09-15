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
export const DEMOSAIC = { none: 0, bilinear: 1, gradient: 2, rcd: 3 };

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
		this.gammaPtr = this.fwdPtr = this.histPtr = this.samplePtr = 0;
		this.statsPtr = this.defectPtr = this.chartPtr = this.histPtrD = 0;
		this.defectRoom = 0;

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
			// RCD by default, so a caller who does not choose gets the closest
			// reconstruction rather than the cheapest one. It costs a full
			// green plane on the first develop of a frame -- about 75 ms on
			// 2592x1520 -- and nothing after that, because the plane is kept.
			cfa: i.cfa, demosaic: DEMOSAIC.rcd, black: i.black, white: i.white,
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

	/*
	 * What the sensor read at one spot, per plane, black-subtracted.
	 *
	 * Returns the neutral that spot implies -- the three means scaled so green
	 * is 1, which is exactly the form AsShotNeutral takes -- so a caller who
	 * clicked something grey can hand it straight back as the white balance.
	 */
	samplePatch(cx, cy, radius = 6, opts = {}) {
		const x = this.x, i = this.info;
		const black = opts.black === undefined ? i.black : opts.black;
		const cfa = opts.cfa === undefined ? i.cfa : opts.cfa;
		if (!this.samplePtr) this.samplePtr = x.alloc(3 * 4);
		const rc = x.sample_patch(Math.round(cx), Math.round(cy), Math.round(radius),
			black, cfa, this.samplePtr);
		// Not the generic size error: the only way this fails is a box that
		// fell outside the frame or was too small to hold all three planes,
		// and "implausible image dimensions" would send a reader looking at
		// the file instead of at where they clicked.
		if (rc !== 0) throw new Error('that spot is outside the frame');
		const m = new Float32Array(x.memory.buffer, this.samplePtr, 3);
		const [r, g, b] = [m[0], m[1], m[2]];
		// A patch with no green has no scale to divide by, and one at the black
		// point is noise: both are refused rather than answered with infinity.
		if (!(g > 0)) throw new Error('that patch is too dark to read a colour from');
		return { raw: [r, g, b], neutral: [r / g, 1, b / g] };
	}

	/*
	 * What is wrong with the sensor rather than with the picture.
	 *
	 * The engine returns a noise VARIANCE because it has no libc to take a
	 * root with; the sigma a person reads is taken here, next to the gamma
	 * curve, for the same reason.
	 */
	diagnose(opts = {}) {
		const x = this.x, i = this.info;
		const cfa = opts.cfa === undefined ? i.cfa : opts.cfa;
		const white = opts.white === undefined ? i.white : opts.white;
		const sigmas = opts.sigmas === undefined ? 8 : opts.sigmas;
		// Reaches an allocation size and a native write limit, so it is pinned
		// to a sane integer here rather than trusted: a NaN, a negative or a
		// billion would each go somewhere unpleasant.
		const asked = opts.maxDefects === undefined ? 4096 : Math.floor(Number(opts.maxDefects));
		const max = Number.isFinite(asked) ? Math.max(0, Math.min(1 << 20, asked)) : 4096;
		/* Keep only candidates whose neighbourhood is in the darkest N% of the
		 * frame. 100 is every one of them, which is what a caller that has not
		 * thought about it gets. */
		const bg = opts.backgroundPercentile === undefined
			? 100 : Math.max(1, Math.min(100, Number(opts.backgroundPercentile) || 100));
		if (!this.statsPtr) this.statsPtr = x.alloc(21 * 4);
		if (!this.histPtrD) this.histPtrD = x.alloc(256 * 4);
		if (!this.defectPtr || this.defectRoom < max) {
			this.defectPtr = x.alloc(max * 2 * 4);
			this.defectRoom = max;
		}
		if (!this.statsPtr || !this.defectPtr || !this.histPtrD)
			throw new Error('out of memory diagnosing the frame');
		const n = x.diagnose(cfa, white, sigmas, bg, this.statsPtr, this.defectPtr, max,
			this.histPtrD);
		if (n < 0) throw new Error(ERRORS[n] || 'the frame could not be diagnosed');
		const s = new Float32Array(x.memory.buffer, this.statsPtr, 21);
		const d = new Int32Array(x.memory.buffer, this.defectPtr, Math.min(n, max) * 2);
		const defects = [];
		for (let k = 0; k < d.length; k += 2) defects.push({ x: d[k], y: d[k + 1] });
		const counts = Array.from(new Uint32Array(x.memory.buffer, this.histPtrD, 256));
		return {
			clipped: [s[0], s[1], s[2]],
			noise: [Math.sqrt(s[3]), Math.sqrt(s[4]), Math.sqrt(s[5])],
			darkest: [s[6], s[7], s[8]],
			blackFloor: [s[9], s[10], s[11]],
			defectCount: n,
			defects,                 // capped at maxDefects; defectCount is the total
			truncated: n > max,
			/*
			 * How far every pixel sits from the mean of its same-colour
			 * neighbours, binned. EMVA 1288 asks for this rather than a count,
			 * on the grounds that no single definition of "defective" can
			 * serve every application -- so the distribution is the answer and
			 * the threshold is the reader's to place.
			 */
			deviation: {
				counts,
				binWidth: s[18],
				min: s[19],
				sigma: s[17],        // spatial sigma, for the Gaussian overlay
				total: counts.reduce((a, b) => a + b, 0),
			},
			/* Clark-Evans: 1 is spatially random, below 1 clustered. A set of
			 * real defects is random; one that tracks the picture is not. */
			spread: s[15] >= 3 ? { index: s[13], z: s[14], over: s[15] } : null,
			backgroundCut: s[16] || null,
		};
	}

	/*
	 * Where the colour chart is, if it can be found at all.
	 *
	 * Returns the four corners in full-frame pixels in chart order and how many
	 * of the 24 cells it actually saw, or null when nothing on the frame looks
	 * like a lattice of patches. Null is a normal answer -- most frames have no
	 * chart in them -- so it is returned rather than thrown.
	 */
	detectChart(opts = {}) {
		const x = this.x, i = this.info;
		const cfa = opts.cfa === undefined ? i.cfa : opts.cfa;
		if (!this.chartPtr) this.chartPtr = x.alloc(8 * 4);
		if (!this.chartPtr) throw new Error('out of memory looking for the chart');
		const found = x.detect_chart(cfa, this.chartPtr);
		if (found <= 0) return null;
		const f = new Float32Array(x.memory.buffer, this.chartPtr, 8);
		return {
			corners: [[f[0], f[1]], [f[2], f[3]], [f[4], f[5]], [f[6], f[7]]],
			cells: found,
		};
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
