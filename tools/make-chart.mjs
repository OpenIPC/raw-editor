/*
 * A synthetic frame with a ColorChecker in it, at corners the caller chose.
 *
 * Detection has to be tested against a frame where the right answer is known
 * before the engine sees it, and no real photograph offers that -- on the lab
 * frame the chart's corners are wherever they are, to within however well I can
 * click. So the chart is drawn through a homography and the corners that drew
 * it are what the test compares against.
 */
import { makeDng } from './make-dng.mjs';
import { CHART_SRGB, CHART_COLS, CHART_ROWS } from '../src/calibrate.js';

/* The unit square to the given quad, same shape as the solver in calibrate.js
 * but inverted: this one maps chart space to the picture. */
function homography(c) {
	const src = [[0, 0], [1, 0], [1, 1], [0, 1]];
	const A = [], b = [];
	for (let i = 0; i < 4; i++) {
		const [u, v] = src[i], [x, y] = c[i];
		A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
		A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
	}
	const n = 8, m = A.map((row, i) => row.concat([b[i]]));
	for (let col = 0; col < n; col++) {
		let piv = col;
		for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
		[m[col], m[piv]] = [m[piv], m[col]];
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const k = m[r][col] / m[col][col];
			for (let cc = col; cc <= n; cc++) m[r][cc] -= k * m[col][cc];
		}
	}
	const hh = m.map((row, i) => row[n] / m[i][i]);
	return [hh[0], hh[1], hh[2], hh[3], hh[4], hh[5], hh[6], hh[7], 1];
}

/* The picture back to chart space, so each pixel can ask which patch it is in. */
function invert3(h) {
	const [a, b, c, d, e, f, g, i, j] = h;
	const A = e * j - f * i, B = -(d * j - f * g), C = d * i - e * g;
	const det = a * A + b * B + c * C;
	const s = 1 / det;
	return [A * s, -(b * j - c * i) * s, (b * f - c * e) * s,
		B * s, (a * j - c * g) * s, -(a * f - c * d) * s,
		C * s, -(a * i - b * g) * s, (a * e - b * d) * s];
}

export function makeChartFrame({ width = 640, height = 480, corners,
	background = [700, 900, 600], gap = 0.12, surround = 120, noise = 6, seed = 7,
	saturated = null } = {}) {
	if (!corners) throw new Error('corners are the point of this');
	const H = homography(corners), Hi = invert3(H);
	const rgb = new Float64Array(width * height * 3);
	for (let i = 0; i < width * height; i++) {
		rgb[i * 3] = background[0]; rgb[i * 3 + 1] = background[1]; rgb[i * 3 + 2] = background[2];
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const w = Hi[6] * (x + 0.5) + Hi[7] * (y + 0.5) + Hi[8];
			const u = (Hi[0] * (x + 0.5) + Hi[1] * (y + 0.5) + Hi[2]) / w;
			const v = (Hi[3] * (x + 0.5) + Hi[4] * (y + 0.5) + Hi[5]) / w;
			if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
			const cx = Math.floor(u * CHART_COLS), cy = Math.floor(v * CHART_ROWS);
			const fx = u * CHART_COLS - cx, fy = v * CHART_ROWS - cy;
			const o = (y * width + x) * 3;
			// Inside the gap between patches: the chart's dark surround, which
			// is what separates one patch from the next.
			if (fx < gap || fx > 1 - gap || fy < gap || fy > 1 - gap) {
				rgb[o] = rgb[o + 1] = rgb[o + 2] = surround;
				continue;
			}
			const p = CHART_SRGB[cy * CHART_COLS + cx];
			// sRGB values scaled into raw counts; the detector never looks at
			// colour, so exactness here does not matter, only that the patches
			// are flat and the gaps are not.
			for (let k = 0; k < 3; k++) rgb[o + k] = 200 + p[k] * 13;
		}
	}
	// A region driven past the ADC's range -- a window, a lamp -- which reads
	// as the white level exactly, with no noise left in it at all.
	if (saturated) {
		const [sx, sy, sw, sh] = saturated;
		for (let y = sy; y < sy + sh && y < height; y++)
			for (let x = sx; x < sx + sw && x < width; x++)
				rgb[(y * width + x) * 3] = rgb[(y * width + x) * 3 + 1] = rgb[(y * width + x) * 3 + 2] = 1e6;
	}
	let s = seed;
	const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
	const px = new Uint16Array(width * height);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const p = (y % 2 === 0) ? (x % 2 === 0 ? 0 : 1) : (x % 2 === 0 ? 1 : 2);
			const v = rgb[(y * width + x) * 3 + p] + rnd() * noise * 2;
			px[y * width + x] = Math.max(0, Math.min(4095, Math.round(v)));
		}
	return { bytes: makeDng({ width, height, pixels: px, black: 0, white: 4095 }), corners };
}
