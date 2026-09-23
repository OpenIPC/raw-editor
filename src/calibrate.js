/*
 * Calibrate: turn 24 measured patches into the two matrices a camera wants.
 *
 * They are different transforms in opposite directions and both come out of the
 * same measurement, which is the whole reason this file exists rather than one
 * solve and a transpose:
 *
 *   ColorMatrix1  XYZ(D50) -> camera, what a DNG carries. Its rows sum to
 *                 whatever the sensor's response makes them.
 *   the live CCM  camera -> display, applied after white balance. Its rows sum
 *                 to one, because a neutral must stay neutral.
 *
 * Nothing here talks to a camera. It takes numbers and returns numbers, so it
 * can be tested without one -- and it is: tools/smoke.mjs plants a known matrix,
 * generates the patches it would produce, and checks that what comes back is
 * the matrix that went in.
 */

/*
 * The ColorChecker Classic, sRGB, in the order the chart reads: four rows of
 * six, dark skin first, the neutral ramp along the bottom from white to black.
 * These are the values X-Rite publishes for the chart, not a measurement of any
 * particular one -- a chart that has faded in a window will calibrate to what it
 * has faded to.
 */
export const CHART_SRGB = [
	[115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
	[214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
	[56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
	[243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
];

/*
 * The same chart as the reference the fit is scored against: CIE Lab under
 * D50, as X-Rite publishes it for the ColorChecker Classic made after November
 * 2014 (X-Rite 2016; the same numbers the colour-science project carries as
 * DATA_COLORCHECKER24_AFTER_NOV2014_CIE_LAB). The sRGB above is kept for
 * drawing a chart -- it is 8-bit, gamut-clipped (cyan does not fit in sRGB and
 * comes out 8/133/161) and a different printing, and scoring against it cost
 * up to 7.8 ΔE on cyan before a camera was even involved.
 */
export const CHART_LAB50 = [
	[37.54, 14.37, 14.92], [64.66, 19.27, 17.5], [49.32, -3.82, -22.54],
	[43.46, -12.74, 22.72], [54.94, 9.61, -24.79], [70.48, -32.26, -0.37],
	[62.73, 35.83, 56.5], [39.43, 10.75, -45.17], [50.57, 48.64, 16.67],
	[30.1, 22.54, -20.87], [71.77, -24.13, 58.19], [71.51, 18.24, 67.37],
	[28.37, 15.42, -49.8], [54.38, -39.72, 32.27], [42.43, 51.05, 28.62],
	[81.8, 2.67, 80.41], [50.63, 51.28, -14.12], [49.57, -29.71, -28.32],
	[95.19, -1.03, 2.93], [81.29, -0.57, 0.44], [66.89, -0.75, -0.06],
	[50.76, -0.13, 0.14], [35.63, -0.46, -0.48], [20.64, 0.07, -0.46],
];

/* The bottom row, which is the only row that is neutral by construction. */
export const NEUTRAL_PATCHES = [18, 19, 20, 21, 22, 23];

/* The black patch reads a few codes above the pedestal on any real sensor, so
 * its ratios are mostly noise: it is left out of the white balance. */
const WB_PATCHES = [18, 19, 20, 21, 22];

export const CHART_COLS = 6;
export const CHART_ROWS = 4;

const srgbToLinear = (u) => {
	const s = u / 255;
	return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/* sRGB primaries to XYZ(D65), then Bradford-adapted to D50 -- which is the
 * connection space both DNG matrices are defined against. Folded into one
 * matrix so there is no intermediate to get wrong. */
const LINEAR_SRGB_TO_XYZ50 = [
	0.4360747, 0.3850649, 0.1430804,
	0.2225045, 0.7168786, 0.0606169,
	0.0139322, 0.0971045, 0.7141733,
];

const XYZ50_TO_LINEAR_SRGB = [
	3.1338561, -1.6168667, -0.4906146,
	-0.9787684, 1.9161415, 0.0334540,
	0.0719453, -0.2289914, 1.4052427,
];

const D50 = [0.9642, 1.0, 0.8249];

export function apply3(m, v) {
	return [
		m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
		m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
		m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
	];
}

const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const finv = (t) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) * 27 / 24389);

/* CIE Lab against D50, the white point the rest of this file works in. */
export function lab(xyz) {
	const x = f(xyz[0] / D50[0]), y = f(xyz[1] / D50[1]), z = f(xyz[2] / D50[2]);
	return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function labToXyz(L) {
	const fy = (L[0] + 16) / 116, fx = fy + L[1] / 500, fz = fy - L[2] / 200;
	return [finv(fx) * D50[0], finv(fy) * D50[1], finv(fz) * D50[2]];
}

/* The chart in XYZ(D50), which is what ColorMatrix1 maps FROM. */
export const CHART_XYZ50 = CHART_LAB50.map(labToXyz);

/* Kept for anything that draws the chart rather than scores against it. */
export const CHART_SRGB_XYZ50 = CHART_SRGB.map((p) =>
	apply3(LINEAR_SRGB_TO_XYZ50, p.map(srgbToLinear)));

function mul3(a, b) {
	const o = new Array(9).fill(0);
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
	return o;
}

export function inv3(m) {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
	const det = a * A + b * B + c * C;
	if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
	const s = 1 / det;
	return [
		A * s, -(b * i - c * h) * s, (b * f - c * e) * s,
		B * s, (a * i - c * g) * s, -(a * f - c * d) * s,
		C * s, -(a * h - b * g) * s, (a * e - b * d) * s,
	];
}

/*
 * The 3x3 M minimising |M x_i - y_i| over every pair, which is
 * M = (Y X^T)(X X^T)^-1. Twenty-four pairs for nine unknowns, so it is
 * comfortably overdetermined and the normal equations are well enough
 * conditioned to solve directly.
 */
function leastSquares3(xs, ys, ws) {
	const YXt = new Array(9).fill(0), XXt = new Array(9).fill(0);
	for (let n = 0; n < xs.length; n++) {
		const w = ws ? ws[n] : 1;
		if (!w) continue;
		for (let r = 0; r < 3; r++) {
			for (let c = 0; c < 3; c++) {
				YXt[r * 3 + c] += w * ys[n][r] * xs[n][c];
				XXt[r * 3 + c] += w * xs[n][r] * xs[n][c];
			}
		}
	}
	const inv = inv3(XXt);
	return inv && mul3(YXt, inv);
}

/* Each row scaled to sum to one -- used only to seed the real fit below. */
function normaliseRows(m) {
	const o = m.slice();
	for (let r = 0; r < 3; r++) {
		const s = o[r * 3] + o[r * 3 + 1] + o[r * 3 + 2];
		if (Math.abs(s) < 1e-9) return null;
		for (let c = 0; c < 3; c++) o[r * 3 + c] /= s;
	}
	return o;
}

/* CIE 1976 ΔE, the distance in Lab. Kept because it is the number people
 * quote; the fit is driven by ΔE2000 below. */
export function deltaE(a, b) {
	const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
	return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/*
 * CIEDE2000, from Sharma, Wu and Dalal, "The CIEDE2000 Color-Difference
 * Formula: Implementation Notes, Supplementary Test Data, and Mathematical
 * Observations" (Color Res. Appl. 30, 2005) -- including the notes' handling
 * of the hue mean and difference when a chroma is zero. tools/smoke.mjs checks
 * it against the paper's 34 test pairs.
 */
export function deltaE2000(L1, L2) {
	const rad = Math.PI / 180, deg = 180 / Math.PI;
	const C1 = Math.hypot(L1[1], L1[2]), C2 = Math.hypot(L2[1], L2[2]);
	const Cm = (C1 + C2) / 2, Cm7 = Math.pow(Cm, 7);
	const G = 0.5 * (1 - Math.sqrt(Cm7 / (Cm7 + Math.pow(25, 7))));
	const a1 = (1 + G) * L1[1], a2 = (1 + G) * L2[1];
	const c1 = Math.hypot(a1, L1[2]), c2 = Math.hypot(a2, L2[2]);
	const hue = (b, a) => {
		if (a === 0 && b === 0) return 0;
		const h = Math.atan2(b, a) * deg;
		return h < 0 ? h + 360 : h;
	};
	const h1 = hue(L1[2], a1), h2 = hue(L2[2], a2);
	const dL = L2[0] - L1[0], dC = c2 - c1;
	let dh = 0;
	if (c1 * c2 !== 0) {
		dh = h2 - h1;
		if (dh > 180) dh -= 360;
		else if (dh < -180) dh += 360;
	}
	const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(dh / 2 * rad);
	const Lm = (L1[0] + L2[0]) / 2, cm = (c1 + c2) / 2;
	let hm = h1 + h2;
	if (c1 * c2 !== 0) {
		if (Math.abs(h1 - h2) <= 180) hm /= 2;
		else hm = hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
	}
	const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) +
		0.32 * Math.cos((3 * hm + 6) * rad) - 0.20 * Math.cos((4 * hm - 63) * rad);
	const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
	const cm7 = Math.pow(cm, 7);
	const RC = 2 * Math.sqrt(cm7 / (cm7 + Math.pow(25, 7)));
	const Lm50 = (Lm - 50) ** 2;
	const SL = 1 + 0.015 * Lm50 / Math.sqrt(20 + Lm50);
	const SC = 1 + 0.045 * cm, SH = 1 + 0.015 * cm * T;
	const RT = -Math.sin(2 * dTheta * rad) * RC;
	const tl = dL / SL, tc = dC / SC, th = dH / SH;
	return Math.sqrt(tl * tl + tc * tc + th * th + RT * tc * th);
}

/* ---- colour temperature ------------------------------------------------ */

/* The Planckian locus in CIE 1931 xy, by Kim et al.'s cubic spline
 * ("Design of advanced color temperature control system for HDTV
 * applications", 2002), good from 1667 K to 25000 K. */
export function planckXy(T) {
	const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
	const x = T < 4000
		? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.179910
		: -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.240390;
	const x2 = x * x, x3 = x2 * x;
	const y = T < 2222
		? -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683
		: T < 4000
			? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
			: 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
	return [x, y];
}

const xyToUv = (x, y) => {
	const d = -2 * x + 12 * y + 3;
	return [4 * x / d, 6 * y / d];
};

/*
 * Correlated colour temperature: the temperature whose Planckian point is
 * nearest in CIE 1960 uv, which is the definition rather than an
 * approximation to it. Searched in mired, where the locus is close to evenly
 * spaced, and returned with Duv -- positive above the locus (greenish),
 * negative below (magenta) -- because a lamp far off the locus has a CCT that
 * means little, and saying how far off is the honest answer.
 */
export function cctFromXy(x, y) {
	const [u, v] = xyToUv(x, y);
	const dist = (mired) => {
		const [px, py] = planckXy(1e6 / mired);
		const [pu, pv] = xyToUv(px, py);
		return Math.hypot(u - pu, v - pv);
	};
	let lo = 1e6 / 25000, hi = 1e6 / 1667;
	let best = lo, bestD = Infinity;
	for (let m = lo; m <= hi; m += 1) {
		const d = dist(m);
		if (d < bestD) { bestD = d; best = m; }
	}
	lo = Math.max(1e6 / 25000, best - 1); hi = Math.min(1e6 / 1667, best + 1);
	for (let i = 0; i < 60; i++) {
		const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
		if (dist(a) < dist(b)) hi = b; else lo = a;
	}
	const mired = (lo + hi) / 2, T = 1e6 / mired;
	const [px, py] = planckXy(T);
	const [pu, pv] = xyToUv(px, py);
	return { cct: T, duv: Math.sign(v - pv) * Math.hypot(u - pu, v - pv) };
}

/* EXIF LightSource codes a DNG names its calibration illuminants by, as the
 * temperatures the DNG specification interpolates between. */
const ILLUMINANT_CCT = {
	1: 5500, 2: 4150, 3: 2850, 4: 5500, 9: 5500, 10: 6500, 11: 7500,
	12: 6430, 13: 5000, 14: 4150, 15: 3450, 17: 2856, 18: 4874, 19: 6774,
	20: 5503, 21: 6504, 22: 7504, 23: 5003, 24: 3200,
};

function xyzToXy(v) {
	const s = v[0] + v[1] + v[2];
	return s > 0 ? [v[0] / s, v[1] / s] : null;
}

/*
 * The light a neutral was seen under, from the camera's own characterisation.
 *
 * This is the DNG specification's procedure: guess a white, interpolate the
 * two ColorMatrix tags between their illuminants by inverse temperature,
 * map the camera neutral back to XYZ through the result, and repeat until the
 * temperature stops moving. With one matrix there is nothing to interpolate
 * and one pass is the answer.
 *
 * `neutral` is camera RGB of a grey (the AsShotNeutral form). Returns
 * { cct, duv, xy } or null when the matrices do not say.
 */
export function illuminantFromNeutral(neutral, colorMatrices) {
	const usable = (colorMatrices || []).filter((c) =>
		c && c.matrix && c.matrix.length === 9 && ILLUMINANT_CCT[c.illuminant]);
	if (!usable.length) return null;
	const pts = usable.map((c) => ({ m: c.matrix, t: ILLUMINANT_CCT[c.illuminant] }))
		.sort((a, b) => a.t - b.t);
	const at = (T) => {
		if (pts.length === 1 || T <= pts[0].t) return pts[0].m;
		const last = pts[pts.length - 1];
		if (T >= last.t) return last.m;
		const w = (1 / T - 1 / last.t) / (1 / pts[0].t - 1 / last.t);
		return pts[0].m.map((v, i) => w * v + (1 - w) * last.m[i]);
	};
	let T = 5000, out = null;
	for (let i = 0; i < 20; i++) {
		const inv = inv3(at(T));
		if (!inv) return null;
		const xy = xyzToXy(apply3(inv, neutral));
		if (!xy) return null;
		const got = cctFromXy(xy[0], xy[1]);
		out = { cct: got.cct, duv: got.duv, xy };
		if (Math.abs(got.cct - T) < 1) break;
		T = got.cct;
	}
	return out;
}

/* Bradford: XYZ seen under white `from` to the XYZ the same surface has
 * under white `to`. */
const BRADFORD = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];
function adaptation(from, to) {
	const inv = inv3(BRADFORD);
	const a = apply3(BRADFORD, from), b = apply3(BRADFORD, to);
	const D = [b[0] / a[0], 0, 0, 0, b[1] / a[1], 0, 0, 0, b[2] / a[2]];
	return mul3(inv, mul3(D, BRADFORD));
}

/* ---- the fit ----------------------------------------------------------- */

/*
 * A CCM whose rows sum to one, from the six numbers that are actually free:
 * each row's off-diagonals, with the diagonal whatever makes the row one. A
 * fit over these cannot produce a matrix that tints grey, so there is no
 * normalisation afterwards to move it off its optimum -- which is what
 * dividing an unconstrained fit by its row sums did.
 */
function ccmFrom(p) {
	return [
		1 - p[0] - p[1], p[0], p[1],
		p[2], 1 - p[2] - p[3], p[3],
		p[4], p[5], 1 - p[4] - p[5],
	];
}

/* Levenberg-Marquardt over a residual vector, with a forward-difference
 * Jacobian. Seven parameters and at most twenty-four residuals, so the normal
 * equations are solved directly. */
function levenberg(res, p0, iters = 200) {
	let p = p0.slice(), r = res(p), cost = r.reduce((s, v) => s + v * v, 0);
	let lambda = 1e-3;
	const n = p.length;
	for (let it = 0; it < iters; it++) {
		const J = [];
		for (let j = 0; j < n; j++) {
			const h = 1e-6 * Math.max(1, Math.abs(p[j]));
			const q = p.slice(); q[j] += h;
			const rq = res(q);
			J.push(rq.map((v, i) => (v - r[i]) / h));
		}
		const A = [], g = [];
		for (let a = 0; a < n; a++) {
			A.push([]);
			for (let b = 0; b < n; b++) {
				let s = 0;
				for (let i = 0; i < r.length; i++) s += J[a][i] * J[b][i];
				A[a].push(s);
			}
			let s = 0;
			for (let i = 0; i < r.length; i++) s += J[a][i] * r[i];
			g.push(-s);
		}
		let improved = false;
		for (let tries = 0; tries < 10; tries++) {
			const M = A.map((row, a) => row.map((v, b) => v + (a === b ? lambda * (v || 1e-9) : 0)));
			const step = solveN(M, g);
			if (!step) { lambda *= 10; continue; }
			const q = p.map((v, j) => v + step[j]);
			const rq = res(q), cq = rq.reduce((s, v) => s + v * v, 0);
			if (isFinite(cq) && cq < cost) {
				const done = cost - cq < 1e-10 * cost;
				p = q; r = rq; cost = cq; lambda = Math.max(lambda / 10, 1e-12);
				improved = true;
				if (done) return p;
				break;
			}
			lambda *= 10;
		}
		if (!improved) break;
	}
	return p;
}

function solveN(A, b) {
	const n = b.length;
	const m = A.map((row, i) => row.concat([b[i]]));
	for (let col = 0; col < n; col++) {
		let piv = col;
		for (let r = col + 1; r < n; r++)
			if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
		if (Math.abs(m[piv][col]) < 1e-18) return null;
		[m[col], m[piv]] = [m[piv], m[col]];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const k = m[r][col] / m[col][col];
			for (let c = col; c <= n; c++) m[r][c] -= k * m[col][c];
		}
	}
	return m.map((row, i) => row[n] / m[i][i]);
}

/* How much of a patch may be clipped before it stops counting. */
const CLIP_LIMIT = 0.02;

/* How many patches a fit needs before its answer means anything. */
const MIN_PATCHES = 12;

/*
 * Score a camera-to-display matrix on the chart, the way solveFromPatches
 * scores its own: white-balanced camera values through the matrix, one
 * exposure scale fitted so a matrix is not blamed for the exposure, ΔE2000
 * against the reference. Exported so a matrix from elsewhere -- the vendor's,
 * say -- can be judged on the same patches by the same rule.
 */
export function scoreCcm(ccm, balanced, weights) {
	const ws = weights || balanced.map(() => 1);
	const res = (k) => balanced.map((b, i) => ws[i] ?
		deltaE2000(lab(apply3(LINEAR_SRGB_TO_XYZ50, apply3(ccm, b).map((v) => v * k))),
			CHART_LAB50[i]) * Math.sqrt(ws[i]) : 0);
	const [logk] = levenberg((p) => res(Math.exp(p[0])), [0]);
	return summarise(balanced.map((b, i) => ws[i] ?
		deltaE2000(lab(apply3(LINEAR_SRGB_TO_XYZ50, apply3(ccm, b).map((v) => v * Math.exp(logk)))),
			CHART_LAB50[i]) : null), Math.exp(logk));
}

function summarise(errs, k) {
	const used = errs.filter((e) => e !== null);
	return {
		perPatch: errs,
		meanDeltaE: used.reduce((s, e) => s + e, 0) / used.length,
		maxDeltaE: Math.max(...used),
		exposure: k,
	};
}

/*
 * measured: 24 camera RGB triples, black-subtracted, in chart order.
 * opts.clipped: per patch, the fraction of it the sampler found clipped.
 * opts.colorMatrices: the DNG's ColorMatrix1/2 with their illuminants, so the
 *   light can be named.
 * opts.cct: the light's temperature, when someone knows it better than the
 *   camera does.
 *
 * Returns the white balance the neutral row implies, both matrices, the light,
 * and how well the result actually fits -- because a solve always returns
 * something and the number is the only thing that says whether it is worth
 * writing to a camera.
 */
export function solveFromPatches(measured, opts = {}) {
	if (!Array.isArray(measured) || measured.length !== CHART_LAB50.length)
		throw new Error(`calibration needs ${CHART_LAB50.length} patches, got ` +
			(Array.isArray(measured) ? measured.length : 'none'));
	for (const p of measured)
		if (!p || p.length !== 3 || p.some((v) => !isFinite(v)))
			throw new Error('a patch was not three finite numbers');

	const clipped = opts.clipped || measured.map(() => 0);
	const weights = measured.map((p, i) => (clipped[i] > CLIP_LIMIT || !(p[1] > 0) ? 0 : 1));
	/* Seven unknowns and one residual per patch. With too few patches left
	 * the fit is not determined -- it can land anywhere with an error of
	 * nothing, and a matrix that fits nothing because it was asked nothing is
	 * the one result that must never reach a camera. Twelve keeps the problem
	 * well over-determined and still survives a clipped white and a few
	 * saturated primaries. */
	const usable = weights.reduce((a, w) => a + w, 0);
	if (usable < MIN_PATCHES)
		throw new Error(`only ${usable} of the chart's patches are both lit and unclipped, ` +
			`and a fit needs at least ${MIN_PATCHES} — lower the exposure or light the chart ` +
			'more evenly');

	/*
	 * White balance first, from the greys that are neither clipped nor down
	 * in the noise -- but not quite as the camera saw them. The chart's greys
	 * are not neutral: its white is b* +2.9, a yellow a camera sees faithfully,
	 * and a balance that makes it grey puts a blue cast on everything else.
	 * Measured on a planted matrix, that alone left 0.4 ΔE2000 on a noiseless
	 * chart and the gains 0.7% off.
	 *
	 * So each grey's ratio is corrected by how far from neutral a linear model
	 * of the whole chart says that patch is: K maps the reference to what the
	 * camera recorded, K.D50 is its response to a true white, and the greys
	 * only contribute the part of their colour that is the light's. The greys
	 * stay the measurement; the model only supplies their known tint.
	 */
	const K = leastSquares3(CHART_XYZ50, measured, weights);
	if (!K) throw new Error('the patches do not determine a matrix — check the corners');
	const kw = apply3(K, D50);
	const acc = [0, 0, 0];
	let used = 0;
	for (const i of WB_PATCHES) {
		const [r, g, b] = measured[i];
		if (!weights[i]) continue;
		const m = apply3(K, CHART_XYZ50[i]);
		const tr = (m[0] / m[1]) / (kw[0] / kw[1]), tb = (m[2] / m[1]) / (kw[2] / kw[1]);
		if (!(tr > 0 && tb > 0)) continue;
		acc[0] += r / g / tr; acc[2] += b / g / tb;
		used++;
	}
	if (used < 2) throw new Error('fewer than two grey patches are both lit and unclipped — ' +
		'expose so the chart\'s white is below clipping and its greys are clear of black');
	const neutral = [acc[0] / used, 1, acc[2] / used];

	/* The light: what someone told us, or failing that what the camera's own
	 * matrices say. A temperature given is the answer, for the matrix as much
	 * as for the report -- adapting to the camera's guess while labelling it
	 * with the given temperature would describe two different lights. */
	const estimated = illuminantFromNeutral(neutral, opts.colorMatrices);
	const light = opts.cct
		? { cct: opts.cct, duv: null, xy: planckXy(opts.cct) }
		: estimated;

	/* The live one starts from white-balanced camera values and lands in linear
	 * sRGB, fitted in ΔE2000 with its rows held at one. */
	const balanced = measured.map((p) => [p[0] / neutral[0], p[1] / neutral[1], p[2] / neutral[2]]);
	const targets = CHART_XYZ50.map((x) => apply3(XYZ50_TO_LINEAR_SRGB, x));
	const seed = leastSquares3(balanced, targets, weights);
	const seedCcm = seed && normaliseRows(seed);
	if (!seedCcm) throw new Error('the patches do not determine a colour matrix — check the corners');
	const pred = (p, i) => apply3(ccmFrom(p), balanced[i]).map((v) => v * Math.exp(p[6]));
	const residual = (p) => balanced.map((_, i) => weights[i] ?
		deltaE2000(lab(apply3(LINEAR_SRGB_TO_XYZ50, pred(p, i))), CHART_LAB50[i]) : 0);
	/* Seed the exposure from the greys' Y, so the first step is not spent on it. */
	let yRef = 0, yGot = 0;
	for (const i of WB_PATCHES) if (weights[i]) {
		yRef += CHART_XYZ50[i][1];
		yGot += apply3(LINEAR_SRGB_TO_XYZ50, apply3(seedCcm, balanced[i]))[1];
	}
	const p0 = [seedCcm[1], seedCcm[2], seedCcm[3], seedCcm[5], seedCcm[6], seedCcm[7],
		Math.log(yGot > 0 ? yRef / yGot : 1)];
	const p = levenberg(residual, p0);
	const ccm = ccmFrom(p);
	const errs = balanced.map((_, i) => weights[i] ?
		deltaE2000(lab(apply3(LINEAR_SRGB_TO_XYZ50, pred(p, i))), CHART_LAB50[i]) : null);
	const fit = summarise(errs, Math.exp(p[6]));
	fit.meanDeltaE76 = errs.reduce((s, e, i) => s + (e === null ? 0 :
		deltaE(apply3(LINEAR_SRGB_TO_XYZ50, pred(p, i)), CHART_XYZ50[i])), 0) /
		errs.filter((e) => e !== null).length;
	fit.patches = weights.reduce((s, w) => s + w, 0);

	/*
	 * ColorMatrix1 maps XYZ *under the light the chart was lit by* to the
	 * camera. The reference is D50, so it is carried to that light first --
	 * without this the matrix claims a D50 calibration for a frame shot under
	 * a lamp, and a DNG reader interpolating by temperature puts it at the
	 * wrong end of the scale.
	 */
	/* With nothing to say what the light was, D50 exactly -- the reference's
	 * own white, which makes the adaptation an identity rather than a
	 * rounding error away from one. */
	const whiteXy = light ? light.xy : null;
	const white = whiteXy
		? [whiteXy[0] / whiteXy[1], 1, (1 - whiteXy[0] - whiteXy[1]) / whiteXy[1]]
		: D50.slice();
	/* K already maps the D50 reference to the camera; carrying the reference
	 * to the light first is the same fit with the adaptation folded in. */
	const fitted = mul3(K, inv3(adaptation(D50, white)));

	/*
	 * ColorMatrix is defined up to a scale, and the measurement arrives in
	 * whatever units the sensor counts in -- raw code values, so a fit against
	 * XYZ comes out around a thousand times too large and a DNG carrying it
	 * would look absurd even though it is not wrong.
	 *
	 * The convention every real one follows is that the matrix applied to its
	 * illuminant's white gives a camera neutral whose largest component is one.
	 * Checked against the gk7205v300's own ColorMatrix1, whose D50 response is
	 * 0.3394 / 1.0593 / 1.0022 -- a maximum of 1.06, which is that convention
	 * within rounding.
	 */
	const resp = apply3(fitted, white);
	const peak = Math.max(Math.abs(resp[0]), Math.abs(resp[1]), Math.abs(resp[2]));
	if (!(peak > 0)) throw new Error('the patches do not determine a matrix — check the corners');
	const colorMatrix = fitted.map((v) => v / peak);

	return {
		neutral, colorMatrix, ccm, balanced, weights,
		light, estimated,
		fit,
	};
}

/*
 * Where the 24 patch centres are, given the four corners someone dragged onto
 * the chart. A homography rather than a bilinear blend: a chart photographed
 * at an angle has converging edges, and a blend puts the far patches off their
 * targets by more than a patch.
 */
export function patchCentres(corners, inset = 0.34) {
	if (!Array.isArray(corners) || corners.length !== 4)
		throw new Error('four corners are needed');
	const H = homography(corners);
	if (!H) throw new Error('those corners are degenerate — the chart cannot be a line');
	const out = [];
	for (let r = 0; r < CHART_ROWS; r++)
		for (let c = 0; c < CHART_COLS; c++) {
			const u = (c + 0.5) / CHART_COLS, v = (r + 0.5) / CHART_ROWS;
			const p = project(H, u, v);
			/* The radius a sample may use without touching the patch's border,
			 * in the same units the caller gave its corners in. */
			const across = Math.hypot(project(H, u + 0.5 / CHART_COLS, v)[0] - p[0],
				project(H, u + 0.5 / CHART_COLS, v)[1] - p[1]);
			out.push({ x: p[0], y: p[1], radius: Math.max(1, across * inset) });
		}
	return out;
}

/* The unit square's corners to the four given, solved as the usual eight
 * unknowns with the ninth fixed at one. */
function homography(c) {
	const [p0, p1, p2, p3] = c;   /* top-left, top-right, bottom-right, bottom-left */
	const A = [], b = [];
	const src = [[0, 0], [1, 0], [1, 1], [0, 1]];
	const dst = [p0, p1, p2, p3];
	for (let i = 0; i < 4; i++) {
		const [u, v] = src[i], [x, y] = dst[i];
		A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
		A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
	}
	const h = solve8(A, b);
	return h && [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function project(H, u, v) {
	const w = H[6] * u + H[7] * v + H[8];
	if (!w) return [0, 0];
	return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
}

/* Gaussian elimination with partial pivoting, 8x8. Small and fixed, so an
 * explicit solver is clearer here than a general one. */
function solve8(A, b) {
	const n = 8;
	const m = A.map((row, i) => row.concat([b[i]]));
	for (let col = 0; col < n; col++) {
		let piv = col;
		for (let r = col + 1; r < n; r++)
			if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
		if (Math.abs(m[piv][col]) < 1e-12) return null;
		[m[col], m[piv]] = [m[piv], m[col]];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const k = m[r][col] / m[col][col];
			for (let c = col; c <= n; c++) m[r][c] -= k * m[col][c];
		}
	}
	return m.map((row, i) => row[n] / m[i][i]);
}
