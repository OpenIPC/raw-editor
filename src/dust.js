/*
 * Dust on the glass in front of the sensor: the camera's answer, made into
 * something a person cleaning a camera can act on.
 *
 * Nothing here talks to a camera. The camera measures -- it has the frames,
 * and it measures on raw where it can, before any tone mapping decides how
 * dark a speck reads -- and this module checks what came back, places it on
 * the frame being shown, and says what it means.
 *
 * Three kinds of answer arrive:
 *
 *   a measurement   { width, height, source, thresholdPct, spots: [...] }
 *   a comparison    the same, plus `baseline`: each spot saved before the
 *                   clean, judged cleared / remains / unjudged, and `new`
 *   a sites answer  { width, height, ircut, spots: [..., site], sites }:
 *                   measured with the IR-cut filter in and out, so a speck
 *                   on the filter can be told from one on the cover glass
 *
 * Coordinates are in the pixels of the frame the camera measured. The frame
 * open here may be another size -- a raw frame where the camera measured its
 * main stream, say -- so placing a spot scales it rather than trusting it.
 */

function num(v, name, lo, hi) {
	if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
		throw new Error(`The camera's dust answer has a bad ${name}.`);
	return v;
}

function spotOf(s, w, h, extra) {
	if (!s || typeof s !== 'object')
		throw new Error('The camera\'s dust answer has a spot that is not one.');
	const out = {
		x: num(s.x, 'spot position', 0, w),
		y: num(s.y, 'spot position', 0, h),
		radius: num(s.radius, 'spot radius', 0, Math.max(w, h)),
		pct: num(s.attenuationPct, 'spot depth', 0, 100),
		marginal: s.marginal === true,
	};
	return extra ? Object.assign(out, extra(s)) : out;
}

function frameOf(j) {
	if (!j || typeof j !== 'object')
		throw new Error('The camera did not answer with a dust measurement.');
	const width = num(j.width, 'width', 1, 65535);
	const height = num(j.height, 'height', 1, 65535);
	return { width, height };
}

const STATES = new Set(['cleared', 'remains', 'unjudged']);

/* A measurement, or a comparison: refused whole if any part is malformed,
 * because a half-believed list puts rings where the camera said nothing and
 * leaves out the ones it did. */
export function readMeasurement(j) {
	const { width, height } = frameOf(j);
	if (!Array.isArray(j.spots))
		throw new Error('The camera\'s dust answer has no spot list.');
	const m = {
		width, height,
		source: j.source === 'raw' || j.source === 'luma' ? j.source : null,
		thresholdPct: num(j.thresholdPct, 'threshold', 0, 100),
		luma: j.luma === undefined ? null : num(j.luma, 'luma', 0, 255),
		gain: j.gain === undefined ? null : num(j.gain, 'gain', 0, 1e6),
		spots: j.spots.map((s) => spotOf(s, width, height)),
		baseline: null,
	};
	if (j.baseline !== undefined) {
		const b = j.baseline;
		if (!b || typeof b !== 'object' || !Array.isArray(b.spots) ||
			!Array.isArray(b.new))
			throw new Error('The camera\'s comparison is incomplete.');
		m.baseline = {
			taken: typeof b.taken === 'string' ? b.taken : null,
			comparable: b.comparable !== false,
			warnings: Array.isArray(b.warnings)
				? b.warnings.filter((w) => typeof w === 'string') : [],
			spots: b.spots.map((s) => spotOf(s, width, height, (s2) => {
				if (!STATES.has(s2.state))
					throw new Error('The camera\'s comparison has a spot with no verdict.');
				return { now: num(s2.nowPct, 'spot depth', 0, 100), state: s2.state };
			})),
			fresh: b.new.map((s) => spotOf(s, width, height)),
		};
	}
	return m;
}

const SITES = new Set(['glass', 'filter', 'window']);

export function readSites(j) {
	const { width, height } = frameOf(j);
	if (!Array.isArray(j.spots))
		throw new Error('The camera\'s answer has no spot list.');
	const spots = j.spots.map((s) => spotOf(s, width, height, (s2) => {
		if (!SITES.has(s2.site))
			throw new Error('The camera\'s answer has a spot with no site.');
		return {
			site: s2.site,
			inPct: num(s2.inPct, 'spot depth', 0, 100),
			outPct: num(s2.outPct, 'spot depth', 0, 100),
		};
	}));
	return { width, height, source: j.source === 'raw' ? 'raw' : null, spots };
}

/* Where a spot measured on a `report`-sized frame sits on a `frame`-sized
 * one, and how big it is there. Each axis on its own: a stream can be scaled
 * differently across than down. */
export function place(spot, report, frame) {
	const sx = frame.width / report.width, sy = frame.height / report.height;
	return { x: spot.x * sx, y: spot.y * sy, radius: spot.radius * Math.min(sx, sy) };
}

function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }

/* What a measurement says, as one sentence a person reads first. */
export function verdict(m) {
	if (m.baseline) {
		const b = m.baseline;
		if (!b.comparable)
			return 'Not judged: the light is too different from when the ' +
				'"before" was saved. Measure again in light like it.';
		const n = b.spots.length;
		const cleared = b.spots.filter((s) => s.state === 'cleared').length;
		const fresh = b.fresh.length;
		if (!n && !fresh) return 'Nothing then, nothing now: the glass is clean.';
		const left = n - cleared;
		let say = n === 0 ? 'The "before" had no spots.'
			: n === 1 ? (cleared ? 'The spot cleared.' : 'The spot is still there.')
				: cleared === n ? `All ${n} spots cleared.`
					: cleared === 0 ? `None of the ${n} spots cleared.`
						: `${cleared} of ${n} spots cleared, ${left} ${left === 1 ? 'remains' : 'remain'}.`;
		if (fresh) say += ` ${plural(fresh, 'new spot', 'new spots')}.`;
		return say;
	}
	const n = m.spots.length;
	if (!n) return 'No dust found.';
	const firm = m.spots.filter((s) => !s.marginal).length;
	const deepest = m.spots.reduce((a, s) => Math.max(a, s.pct), 0);
	return `${plural(n, 'spot', 'spots')} found` +
		(firm < n ? ` (${n - firm} less certain)` : '') +
		`, the darkest taking ${deepest.toFixed(1)}% of the light.`;
}

export function sitesVerdict(s) {
	const n = s.spots.length;
	if (!n) return 'No dust found in either position of the filter.';
	const c = { glass: 0, filter: 0, window: 0 };
	for (const sp of s.spots) c[sp.site]++;
	if (c.glass === n) return n === 1
		? 'The spot is on the sensor\'s cover glass: it stayed when the filter moved.'
		: `All ${n} spots are on the sensor's cover glass: they stayed when the filter moved.`;
	const parts = [];
	if (c.glass) parts.push(`${c.glass} on the cover glass`);
	if (c.filter) parts.push(`${c.filter} on the IR-cut filter`);
	if (c.window) parts.push(`${c.window} on the glass that replaces it at night`);
	return `${plural(n, 'spot', 'spots')}: ${parts.join(', ')}.`;
}

/* The rings to draw: where, how big, and what kind -- the class carries the
 * meaning, so the stylesheet and a test both read the same word. */
export function rings(m, frame) {
	const out = [];
	const add = (s, kind, label) => {
		const p = place(s, m, frame);
		out.push({ ...p, kind: s.marginal ? kind + ' marginal' : kind, label });
	};
	if (m.baseline && m.baseline.comparable) {
		for (const s of m.baseline.spots)
			add(s, s.state, s.state === 'cleared' ? 'cleared'
				: `${s.now.toFixed(1)}%`);
		for (const s of m.baseline.fresh) add(s, 'new', `new ${s.pct.toFixed(1)}%`);
	} else if (m.baseline) {
		for (const s of m.baseline.spots) add(s, 'unjudged', `${s.pct.toFixed(1)}%`);
	} else if (m.spots[0] && m.spots[0].site) {
		for (const s of m.spots) add(s, s.site, s.site);
	} else {
		for (const s of m.spots) add(s, 'dust', `${s.pct.toFixed(1)}%`);
	}
	return out;
}
