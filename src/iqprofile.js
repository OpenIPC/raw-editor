/*
 * A camera's colour calibration as its IQ profile holds it, and a new one built
 * from charts shot under the lights the camera actually sees.
 *
 * HiSilicon-family ISPs (and Goke's, which are the same silicon) do not run on
 * one colour matrix. Automatic white balance follows a curve through
 * colour-temperature space, and the colour matrix is blended between a few
 * tables by the temperature AWB estimates. A vendor calibration is therefore a
 * set: white balance at a reference temperature, the curve, and three to seven
 * matrices. The profile carries them as
 *
 *   [static_awb]  AutoStaticWb  = "R, Gr, Gb, B"          256 = 1.0
 *                 AutoCurvePara = "p1, p2, q1, a1, 128, c1"
 *   [static_ccm]  TotalNum, AutoColorTemp, AutoCCMTable_N  sign-magnitude 8.8
 *
 * Nothing here talks to a camera: it reads profile text, fits numbers and
 * writes profile text, so tools/smoke.mjs can check every step against a
 * camera's own tables.
 */

/* ---- the profile text ------------------------------------------------- */

/* Sections to { key: value }. Values keep backslash continuations joined and
 * lose their quotes; comments (';' or '#') and blank lines are dropped. */
export function parseIni(text) {
	const out = {};
	let sec = null;
	const lines = String(text).replace(/\\\r?\n/g, ' ').split(/\r?\n/);
	for (const raw of lines) {
		const line = raw.replace(/[;#].*$/, '').trim();
		if (!line) continue;
		const h = /^\[([^\]]+)\]$/.exec(line);
		if (h) { sec = h[1].trim(); out[sec] = out[sec] || {}; continue; }
		const kv = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
		if (kv && sec) out[sec][kv[1]] = kv[2].replace(/"/g, '').trim();
	}
	return out;
}

/* A list of numbers, or null when any entry is not a finite number -- a
 * profile that says "NaN" or trails a comma is not one to build on. */
const numbers = (v) => {
	if (v === undefined) return null;
	const out = v.split(/[,|\s]+/).filter(Boolean).map(Number);
	return out.length && out.every(Number.isFinite) ? out : null;
};

/* The colour half of a profile, decoded. Anything malformed comes back null
 * rather than half-read, because a profile is built on top of it and written
 * to a camera: a zero curve is a real (and broken) curve, and a table set
 * that is short a temperature would be blended at an undefined one. */
export function readColour(ini) {
	const awb = ini.static_awb || {}, ccm = ini.static_ccm || {};
	const staticWb = numbers(awb.AutoStaticWb);
	const curve = numbers(awb.AutoCurvePara);
	const total = ccm.TotalNum !== undefined ? Number(ccm.TotalNum) : NaN;
	const cts = numbers(ccm.AutoColorTemp);
	let tables = null;
	/* The chip's own limits: three to seven tables, temperatures 500 to 30000,
	 * falling from one to the next. */
	if (Number.isInteger(total) && total >= 3 && total <= 7 && cts && cts.length >= total) {
		tables = [];
		for (let i = 0; i < total && tables; i++) {
			const t = numbers(ccm['AutoCCMTable_' + i]);
			const ct = cts[i];
			if (!t || t.length !== 9 || !(ct >= 500 && ct <= 30000) ||
				(i && !(ct < cts[i - 1])) || t.some((v) => v < 0 || v > 0xffff))
				tables = null;
			else
				tables.push({ ct, matrix: t.map(decodeCcmValue) });
		}
	}
	return {
		staticWb: staticWb && staticWb.length === 4 && staticWb.every((v) => v > 0 && v <= 0xfff)
			? staticWb : null,
		curve: curve && curve.length === 6 && curve[4] === 128 && curve[3] !== 0 ? curve : null,
		ccm: tables,
	};
}

/* ---- the chip's numbers ----------------------------------------------- */

/* Colour-matrix values are sign-magnitude, not two's complement: bit 15 is a
 * sign flag and the low fifteen bits a magnitude, with 1.0 spelled 256. */
export function decodeCcmValue(v) {
	const mag = (v & 0x7fff) / 256;
	return v & 0x8000 ? -mag : mag;
}

export function encodeCcmValue(f) {
	const mag = Math.min(0x7fff, Math.round(Math.abs(f) * 256));
	return f < 0 && mag ? 0x8000 | mag : mag;
}

/*
 * A whole matrix, with each row summing to exactly 256 after rounding.
 * Rounding nine values independently leaves a row one or two off, which
 * tints every grey by that much -- and the camera refuses a row more than two
 * off. The residue goes into the diagonal, the largest term and so the one it
 * moves least in relative terms.
 */
export function encodeCcm(m) {
	const out = [];
	for (let r = 0; r < 3; r++) {
		const row = [0, 1, 2].map((c) => Math.round(m[r * 3 + c] * 256));
		const sum = row[0] + row[1] + row[2];
		row[r] += 256 - sum;
		for (const v of row) out.push(v < 0 ? 0x8000 | Math.min(0x7fff, -v) : Math.min(0x7fff, v));
	}
	return out;
}

/* ---- the AWB curve ---------------------------------------------------- */

/*
 * What the chip's CalGainByTemp answers for a temperature, at shift 0: the
 * integer arithmetic of the vendor library, reproduced exactly. Measured on a
 * Hi3516EV300 + IMX335 over CT 1500..15000 in steps of 250 at five shifts,
 * and a port of this same arithmetic matched all 275 answers to the LSB.
 *
 *   t = 256000000 / CT                     mired x 256
 *   x = (a1/2 + (t - c1)*256) / a1         sqrt(G/R) relative to the static WB, Q8
 *   X = x*x ; Y = (p1*X + p2*65536 + den/2) / den,  den = q1 + X/256
 *   R = (2^24/X * SR + 128) / 256 ;  B = (2^24/Y * SB + 128) / 256
 *
 * then, with gain normalisation on (the lab camera has it on), everything
 * scaled so the smallest of R, G, B is 256, and R, B clamped to 256..640 and
 * 256..1024 -- constants in the library, not settings.
 */
const tdiv = (a, b) => Math.trunc(a / b);

export function gainsForCt(ct, staticWb, curve, { normalise = true } = {}) {
	const [p1, p2, q1, a1, , c1] = curve;
	const t = tdiv(256000000, ct);
	const x = tdiv(tdiv(a1, 2) + (t - c1) * 256, a1);
	const X = x * x;
	const den = q1 + (X >> 8);
	const Y = tdiv(p1 * X + p2 * 65536 + tdiv(den, 2), den || 1);
	let R = tdiv(tdiv(0x1000000, X) * staticWb[0] + 0x80, 256);
	let B = tdiv(tdiv(0x1000000, Y) * staticWb[3] + 0x80, 256);
	let G = 256;
	if (normalise) {
		const m = Math.min(R, 256, B);
		const k = Math.floor((m / 2 + 65536) / m) >>> 0;
		R = (k * R + 0x80) >>> 8; B = (k * B + 0x80) >>> 8; G = k & 0xffff;
	}
	R = Math.min(Math.max(R & 0xffff, 256), 640);
	B = Math.min(Math.max(B & 0xffff, 256), 1024);
	return [R, G, G, B];
}

/* The temperature the curve was built around: where x is 256, so the gains
 * are the static WB. The library never reads u16RefColorTemp -- this is it. */
export const refCtOf = (curve) => 256000000 / (curve[3] + curve[5]);

/*
 * A new curve from neutrals measured at known temperatures.
 *
 * points: [{ ct, r, b }] -- the gains that made a grey grey, as multipliers
 * with green at 1 (so r = 1 / neutral[0]). The curve itself is written in the
 * camera's raw ratios, Xa = 1/r and Ya = 1/b, which is what the chip's X and Y
 * are once its reference white is divided out: X / 65536 = Xa * SR/256.
 * vendor: { staticWb, curve } -- the curve the camera has now, which supplies
 * the reference temperature and whatever the points cannot pin down.
 *
 * The two halves of the curve are each linear in their unknowns once written
 * in the right variables:
 *
 *   temperature:  sqrt(G/R) = alpha + beta * mired
 *   locus:        (G/B) (Q + G/R) = P (G/R) + R0
 *
 * Two lights determine the first exactly; the second has three unknowns, and
 * with fewer than three lights it would be underdetermined. Rather than
 * invent the missing direction, it is held to the camera's current curve: each
 * unknown carries a weak pull toward the vendor's value, which the data
 * overrules wherever it has anything to say. With one light, the slope of the
 * first comes from the vendor too.
 *
 * Returns the chip's integers -- static WB at the reference temperature and
 * the six curve values -- and, per point, what the chip will answer there.
 */
export function fitAwbCurve(points, vendor) {
	if (!points.length) throw new Error('no neutrals to fit a curve to');
	for (const p of points)
		if (!(p.ct >= 1500 && p.ct <= 15000) || !(p.r > 0) || !(p.b > 0))
			throw new Error('a kept light has no usable temperature or white balance');
	for (let i = 0; i < points.length; i++)
		for (let j = i + 1; j < points.length; j++)
			if (Math.abs(points[i].ct - points[j].ct) < 300)
				throw new Error(`two kept lights are within 300 K of each other ` +
					`(${points[i].ct} and ${points[j].ct} K); a curve needs different lights`);
	const [vp1, vp2, vq1, va1, , vc1] = vendor.curve;
	const vSR = vendor.staticWb[0] / 256, vSB = vendor.staticWb[3] / 256;
	const refCt = refCtOf(vendor.curve);
	const mired = (ct) => 1e6 / ct;

	/* The vendor's curve in the same absolute variables. From the chip's
	 * sqrt(X/65536) = (256*mired - c1)/a1 with X/65536 = Xa*SR:
	 *   sqrt(Xa) = (256*mired - c1) / (a1 * sqrt(SR)). */
	const vBeta = 256 / (va1 * Math.sqrt(vSR));
	const vAlpha = -vc1 / (va1 * Math.sqrt(vSR));
	const vQ = vq1 / (256 * vSR), vP = vp1 / (256 * vSB), vR0 = vp2 / (256 * vSR * vSB);

	/* sqrt(Xa) against mired. */
	let alpha, beta;
	const us = points.map((p) => Math.sqrt(1 / p.r));
	if (points.length === 1) {
		beta = vBeta;
		alpha = us[0] - beta * mired(points[0].ct);
	} else {
		let sm = 0, su = 0, smm = 0, smu = 0;
		for (let i = 0; i < points.length; i++) {
			const m = mired(points[i].ct);
			sm += m; su += us[i]; smm += m * m; smu += m * us[i];
		}
		const n = points.length, d = n * smm - sm * sm;
		if (Math.abs(d) < 1e-12) throw new Error('the lights are all the same temperature');
		beta = (n * smu - sm * su) / d;
		alpha = (su - beta * sm) / n;
	}
	/* Warmer light is redder light, on every sensor: the red gain a grey needs
	 * falls as the temperature falls, so sqrt(G/R) rises with mired. A slope
	 * of zero or the wrong sign is two lights whose temperatures do not match
	 * their colour -- a mistyped temperature, most often -- and a curve fitted
	 * through them would divide by it. */
	if (!(beta > 0))
		throw new Error('the kept lights\' white balance does not change with temperature ' +
			'the way light does — check the temperatures entered for them');

	/* The locus, regularised toward the vendor's. Rows are scaled by the
	 * vendor's magnitudes so the pull means the same for each unknown. */
	const prior = [vQ, vP, vR0];
	const scale = prior.map((v) => Math.max(Math.abs(v), 1e-3));
	const rows = [], rhs = [];
	for (const p of points) {
		const Xa = 1 / p.r, Ya = 1 / p.b;
		rows.push([Ya * scale[0], -Xa * scale[1], -1 * scale[2]]);
		rhs.push(-Xa * Ya);
	}
	const lambda = 1e-3;
	for (let k = 0; k < 3; k++) {
		const row = [0, 0, 0]; row[k] = lambda;
		rows.push(row); rhs.push(lambda * prior[k] / scale[k]);
	}
	const z = lsq(rows, rhs).map((v, k) => v * scale[k]);
	const [Q, P, R0] = z;

	/* The static WB is the curve at the reference temperature. */
	const uRef = alpha + beta * mired(refCt);
	const XaRef = uRef * uRef;
	const YaRef = (P * XaRef + R0) / (Q + XaRef);
	const SRg = 1 / XaRef, SBg = 1 / YaRef;
	const SR = Math.round(SRg * 256), SB = Math.round(SBg * 256);

	/* Back to the chip's parameters, in terms of the rounded static WB. */
	const sr = SR / 256, sb = SB / 256;
	const a1 = Math.round(256 / (beta * Math.sqrt(sr)));
	const c1 = Math.round(-alpha * a1 * Math.sqrt(sr));
	const p1 = Math.round(P * 256 * sb), q1 = Math.round(Q * 256 * sr);
	/* p1 + p2 = q1 + 256 is what puts the static WB on the curve; kept exact
	 * rather than left to rounding. */
	const p2 = q1 + 256 - p1;
	const staticWb = [SR, 256, 256, SB];
	const curve = [p1, p2, q1, a1, 128, c1];
	/* What the camera will take: gains the ISP can hold, a curve with no
	 * hole in it, and numbers that are numbers. */
	if (![SR, SB].every((v) => v > 0 && v <= 0xfff) || !(a1 > 0) ||
		!curve.every(Number.isFinite) || !(Q + XaRef > 0))
		throw new Error('the kept lights do not fit a white balance curve this camera can ' +
			'use — keep lights further apart in temperature, or check their temperatures');

	const at = points.map((p) => {
		const g = gainsForCt(Math.round(p.ct), staticWb, curve, { normalise: false });
		return { ct: p.ct, r: g[0] / 256, b: g[3] / 256, wantR: p.r, wantB: p.b };
	});
	return { staticWb, curve, refCt, at, vendorBeta: vBeta, vendorAlpha: vAlpha };
}

/* Least squares by the normal equations, for the three-unknown locus. */
function lsq(A, b) {
	const n = A[0].length;
	const M = [], v = [];
	for (let i = 0; i < n; i++) {
		M.push(new Array(n).fill(0)); v.push(0);
		for (let r = 0; r < A.length; r++) {
			v[i] += A[r][i] * b[r];
			for (let j = 0; j < n; j++) M[i][j] += A[r][i] * A[r][j];
		}
	}
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
		[M[c], M[p]] = [M[p], M[c]]; [v[c], v[p]] = [v[p], v[c]];
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const k = M[r][c] / M[c][c];
			for (let j = c; j < n; j++) M[r][j] -= k * M[c][j];
			v[r] -= k * v[c];
		}
	}
	return v.map((x, i) => x / M[i][i]);
}

/* ---- a calibration as profile text ------------------------------------- */

/*
 * The matrices for the profile: one per light that was measured, and the
 * vendor's for the temperatures nobody measured -- the chip needs at least
 * three, and a vendor table 1500 K from any measurement is still better than
 * stretching ours across the gap. A vendor table closer than `near` kelvin to
 * a measured one is dropped: two tables that close would be blended as if
 * they described different light.
 */
export function mergeCcmTables(measured, vendor, { near = 600, max = 7 } = {}) {
	const ours = measured.map((m) => ({ ct: Math.round(m.ct), matrix: m.matrix, source: 'measured' }));
	if (ours.length > max)
		throw new Error(`the camera holds at most ${max} colour matrices and ${ours.length} lights are kept`);
	for (let i = 0; i < ours.length; i++)
		for (let j = i + 1; j < ours.length; j++)
			if (Math.abs(ours[i].ct - ours[j].ct) < 300)
				throw new Error(`two kept lights are within 300 K of each other (${ours[i].ct} and ` +
					`${ours[j].ct} K)`);
	/* Every measured matrix is kept; the vendor's fill what room is left,
	 * the ones furthest from any measurement first, because those are the
	 * temperatures nothing else speaks for. */
	const distance = (v) => Math.min(...ours.map((o) => Math.abs(o.ct - v.ct)));
	const keep = (vendor || []).filter((v) => ours.every((o) => Math.abs(o.ct - v.ct) >= near))
		.sort((a, b) => distance(b) - distance(a))
		.slice(0, Math.max(0, max - ours.length))
		.map((v) => ({ ...v, source: 'vendor' }));
	const all = ours.concat(keep).sort((a, b) => b.ct - a.ct);
	if (all.length < 3)
		throw new Error(`the camera needs at least three colour matrices and this makes ${all.length}`);
	return all;
}

export function colourFragment({ staticWb, curve, tables }) {
	const q = (a) => '"' + a.join(', ') + '"';
	const lines = [
		'; Colour calibration: white balance at the reference temperature, the',
		'; curve AWB follows away from it, and one colour matrix per temperature.',
		'; Matrices marked vendor are the camera\'s own, kept where nothing was',
		'; measured.',
		'[static_awb]',
		`AutoStaticWb              = ${q(staticWb)}`,
		`AutoCurvePara             = ${q(curve)}`,
		'',
		'[static_ccm]',
		`TotalNum                  = "${tables.length}"`,
		`AutoColorTemp             = ${q(tables.map((t) => t.ct))}`,
	];
	tables.forEach((t, i) => {
		lines.push(`; ${t.ct} K, ${t.source}`);
		lines.push(`AutoCCMTable_${i}`.padEnd(26) + '= ' + q(encodeCcm(t.matrix)));
	});
	return lines.join('\n') + '\n';
}
