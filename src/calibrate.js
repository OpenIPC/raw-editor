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

/* The bottom row, which is the only row that is neutral by construction. */
export const NEUTRAL_PATCHES = [18, 19, 20, 21, 22, 23];

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

export function apply3(m, v) {
	return [
		m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
		m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
		m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
	];
}

/* The chart in XYZ(D50), which is what ColorMatrix1 maps FROM. */
export const CHART_XYZ50 = CHART_SRGB.map((p) =>
	apply3(LINEAR_SRGB_TO_XYZ50, p.map(srgbToLinear)));

function mul3(a, b) {
	const o = new Array(9).fill(0);
	for (let r = 0; r < 3; r++)
		for (let c = 0; c < 3; c++)
			for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
	return o;
}

function inv3(m) {
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
function leastSquares3(xs, ys) {
	const YXt = new Array(9).fill(0), XXt = new Array(9).fill(0);
	for (let n = 0; n < xs.length; n++)
		for (let r = 0; r < 3; r++) {
			for (let c = 0; c < 3; c++) {
				YXt[r * 3 + c] += ys[n][r] * xs[n][c];
				XXt[r * 3 + c] += xs[n][r] * xs[n][c];
			}
		}
	const inv = inv3(XXt);
	return inv && mul3(YXt, inv);
}

/* Each row scaled to sum to one, so a neutral in maps to a neutral out. The
 * direction of every row is kept; only its gain moves. */
function normaliseRows(m) {
	const o = m.slice();
	for (let r = 0; r < 3; r++) {
		const s = o[r * 3] + o[r * 3 + 1] + o[r * 3 + 2];
		if (Math.abs(s) < 1e-9) return null;
		for (let c = 0; c < 3; c++) o[r * 3 + c] /= s;
	}
	return o;
}

const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);

/* CIE Lab against D50, the white point the rest of this file works in. */
function lab(xyz) {
	const x = f(xyz[0] / 0.9642), y = f(xyz[1] / 1.0), z = f(xyz[2] / 0.8249);
	return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function deltaE(a, b) {
	const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
	return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/*
 * measured: 24 camera RGB triples, black-subtracted, in chart order.
 *
 * Returns the white balance the neutral row implies, both matrices, and how
 * well the result actually fits -- because a solve always returns something and
 * the number is the only thing that says whether it is worth writing to a
 * camera.
 */
export function solveFromPatches(measured) {
	if (!Array.isArray(measured) || measured.length !== CHART_SRGB.length)
		throw new Error(`calibration needs ${CHART_SRGB.length} patches, got ` +
			(Array.isArray(measured) ? measured.length : 'none'));
	for (const p of measured)
		if (!p || p.length !== 3 || p.some((v) => !isFinite(v)))
			throw new Error('a patch was not three finite numbers');

	/* White balance first, from the row that is grey by construction. Using all
	 * six rather than the brightest keeps one clipped patch from carrying it. */
	const acc = [0, 0, 0];
	let used = 0;
	for (const i of NEUTRAL_PATCHES) {
		const [r, g, b] = measured[i];
		if (g <= 0) continue;
		acc[0] += r / g; acc[1] += 1; acc[2] += b / g;
		used++;
	}
	if (used < 2) throw new Error('the neutral patches are too dark to read a white balance from');
	const neutral = [acc[0] / used, 1, acc[2] / used];

	/* ColorMatrix1 maps XYZ to the camera as it actually responded, so it is
	 * fitted against the unbalanced measurement. */
	const fitted = leastSquares3(CHART_XYZ50, measured);
	if (!fitted) throw new Error('the patches do not determine a matrix — check the corners');

	/*
	 * ColorMatrix is defined up to a scale, and the measurement arrives in
	 * whatever units the sensor counts in -- raw code values, so a fit against
	 * XYZ comes out around a thousand times too large and a DNG carrying it
	 * would look absurd even though it is not wrong.
	 *
	 * The convention every real one follows is that the matrix applied to the
	 * D50 white point gives a camera neutral whose largest component is one.
	 * Checked against the gk7205v300's own ColorMatrix1, whose D50 response is
	 * 0.3394 / 1.0593 / 1.0022 -- a maximum of 1.06, which is that convention
	 * within rounding.
	 */
	const white = apply3(fitted, [0.9642, 1.0, 0.8249]);
	const peak = Math.max(Math.abs(white[0]), Math.abs(white[1]), Math.abs(white[2]));
	if (!(peak > 0)) throw new Error('the patches do not determine a matrix — check the corners');
	const colorMatrix = fitted.map((v) => v / peak);

	/* The live one starts from white-balanced camera values and lands in linear
	 * sRGB, then has its rows normalised so a neutral survives it. */
	const balanced = measured.map((p) => [p[0] / neutral[0], p[1] / neutral[1], p[2] / neutral[2]]);
	const targets = CHART_XYZ50.map((x) => apply3(XYZ50_TO_LINEAR_SRGB, x));
	const raw = leastSquares3(balanced, targets);
	const ccm = raw && normaliseRows(raw);
	if (!ccm) throw new Error('the patches do not determine a colour matrix — check the corners');

	/* The fit, in the units a photographer argues in. Scaled so the chart's
	 * white patch lands where the chart says it should, because a mean error
	 * dominated by exposure says nothing about colour. */
	const shot = apply3(ccm, balanced[18]);
	const k = shot[1] > 0 ? apply3(XYZ50_TO_LINEAR_SRGB, CHART_XYZ50[18])[1] / shot[1] : 1;
	let sum = 0, worst = 0;
	for (let i = 0; i < measured.length; i++) {
		const got = apply3(ccm, balanced[i]).map((v) => v * k);
		const e = deltaE(apply3(LINEAR_SRGB_TO_XYZ50, got), CHART_XYZ50[i]);
		sum += e;
		if (e > worst) worst = e;
	}
	return {
		neutral, colorMatrix, ccm,
		fit: { meanDeltaE: sum / measured.length, maxDeltaE: worst },
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
