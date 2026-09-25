/*
 * Focus statistics: what the ISP's AF block measured, turned into something a
 * person focusing a lens can read.
 *
 * Nothing here talks to a camera. It takes numbers and returns numbers, so it
 * can be tested without one.
 *
 * The camera divides the frame into a grid and, per zone, runs two horizontal
 * IIR banks and two vertical FIR banks over it, accumulating the response of
 * each. More detail in the passband means a bigger number, so the numbers peak
 * where the picture is sharpest -- that, and nothing more, is what autofocus
 * hunts. A zone also carries `y`, a luma accumulator, and `hlcnt`, the count of
 * pixels over the high-luma threshold.
 */

/* The blend the camera's own AF reduction uses: the second horizontal bank at
 * 0.85 and the second vertical at 0.15, in q6. Deliberately the same arithmetic
 * rather than a prettier one, because the page and the camera must not be able
 * to disagree about where the peak is -- an operator who focuses on this
 * display and then lets autofocus run should not watch it move. */
const BLEND_SHIFT = 6;
const BELTA = 54;
const SCALE = 1 << BLEND_SHIFT;

export function blend(z) {
	/* Arithmetic, not `>>`. The shift operator coerces to signed 32-bit, so a
	 * weighted sum past 2^31 wraps negative -- and a negative focus value does
	 * not merely read wrong, it sinks below every real zone in peak selection
	 * and drives normalise() below the zero it promises. A camera's own u16
	 * fields cannot reach that (65535 * 64 is 4.2 million), but these arrive as
	 * JSON over a network and nothing upstream of here guarantees they are u16.
	 * The result is identical for every input a camera can actually produce. */
	return Math.trunc(((z.h2 * BELTA) + (z.v2 * (SCALE - BELTA))) / SCALE);
}

/*
 * Whether a zone measured anything at all.
 *
 * A zone with no light in it, and a zone blown out to white, both report a
 * small focus value -- and so does a zone that is simply out of focus. They
 * are not the same answer and must not be drawn the same: a dark corner
 * painted "soft" tells the operator to chase focus that was never the problem.
 *
 * `y` is a sum over the zone, so the threshold scales with how many pixels
 * went into it; the caller passes the span it saw. Clipping is the more
 * interesting case of the two, because a specular highlight in an otherwise
 * fine zone will pin the filters without dimming the luma.
 */
/*
 * The per-zone accumulators are u16, and a zone that reaches the top of that
 * range has stopped measuring: the filter's real response went higher and the
 * counter could not say so.
 *
 * This is NOT the same as `clipped`, which is about the picture -- pixels over
 * the high-luma threshold, a specular highlight in an otherwise fine zone. A
 * saturated zone can be perfectly exposed. What is full is the counter, and
 * the cause is the filter's gain, not the scene.
 *
 * It matters most to anything comparing one reading with another, because a
 * pinned value cannot fall: a defocus sweep across a saturated peak reports
 * that nothing changed, which is indistinguishable from a filter that cannot
 * see focus at all. The two need different answers -- cut the gain, or change
 * the filter -- so they must not produce the same number.
 */
export const ZONE_CEILING = 65535;

export function zoneSaturated(z, ceiling = ZONE_CEILING) {
	/* The two the blend is made of, and only those. h1 and v1 belong to the
	 * other bank and can sit at the ceiling all day without touching the value
	 * this page reports. */
	return z.h2 >= ceiling || z.v2 >= ceiling;
}

export function zoneState(z, { yFloor = 0, hlCeil = 0 } = {}) {
	if (z.hlcnt > hlCeil) return 'clipped';
	if (z.y <= yFloor) return 'unlit';
	return 'measured';
}

/*
 * Summarise one grid: the blended value per zone, which of them are worth
 * believing, and where the sharpest measured zone is.
 *
 * Thresholds are derived from the grid rather than fixed, because `y` and
 * `hlcnt` are accumulators whose scale depends on the zone size, the AF
 * accumulator shifts and the sensor -- a constant that suits one camera
 * silently mislabels every zone on another. The floor is a fraction of the
 * grid's own median luma, so a frame that is dark everywhere still gets a
 * usable reading rather than being declared entirely unlit.
 */
export function summarise(zones, rows, cols, opts = {}) {
	/* The shape, before the count. `rows * cols === zones.length` alone admits
	 * 0 x 0, 1.5 x 2 and -1 x -3, and every one of those divides a frame into
	 * cells that are empty, fractional or off-screen -- a grid drawn wrong
	 * rather than a grid refused. */
	for (const [name, v] of [['rows', rows], ['cols', cols]])
		if (!Number.isSafeInteger(v) || v <= 0)
			throw new Error(`${name} is not a positive whole number: ${v}`);
	if (!Array.isArray(zones) || zones.length !== rows * cols)
		throw new Error(`expected ${rows * cols} zones, got ${zones && zones.length}`);
	/* Refuse a grid that is not numbers rather than drawing one. Everything
	 * below assumes finite, non-negative accumulators; a NaN would propagate
	 * into the peak and the normalisation as a zone that is neither brighter
	 * nor darker than any other, and a negative would sit under every real
	 * one. The caller already has to handle a camera that stopped answering,
	 * and this is that same case. */
	for (let i = 0; i < zones.length; i++) {
		const z = zones[i];
		if (!z) throw new Error(`zone ${i} is missing`);
		for (const k of ['h1', 'h2', 'v1', 'v2', 'y', 'hlcnt']) {
			const v = z[k];
			if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
				throw new Error(`zone ${i} field ${k} is not a count: ${v}`);
		}
	}

	const ys = zones.map((z) => z.y).slice().sort((a, b) => a - b);
	const medianY = ys[ys.length >> 1] || 0;
	const yFloor = opts.yFloor !== undefined ? opts.yFloor : medianY * 0.15;
	const hlCeil = opts.hlCeil !== undefined ? opts.hlCeil : 0;

	const fv = zones.map(blend);
	const state = zones.map((z) => zoneState(z, { yFloor, hlCeil }));

	let peak = -1, peakAt = -1;
	for (let i = 0; i < fv.length; i++) {
		if (state[i] !== 'measured') continue;
		if (fv[i] > peak) { peak = fv[i]; peakAt = i; }
	}
	const measured = state.filter((s) => s === 'measured').length;
	const ceiling = opts.ceiling !== undefined ? opts.ceiling : ZONE_CEILING;
	const sat = zones.map((z) => zoneSaturated(z, ceiling));
	/* Saturation is reported, not subtracted. Dropping a pinned zone from the
	 * peak would handpoint the reading at some lower zone and carry on as if
	 * the number meant something; the honest answer is that the peak is real
	 * but cannot rise, and the caller is told so. */
	return {
		rows, cols, fv, state, measured,
		peak: peakAt < 0 ? null : peak,
		peakAt: peakAt < 0 ? null : { row: (peakAt / cols) | 0, col: peakAt % cols, index: peakAt },
		unlit: state.filter((s) => s === 'unlit').length,
		clipped: state.filter((s) => s === 'clipped').length,
		saturated: sat.filter(Boolean).length,
		/* Per zone, for anything drawing the grid or reducing it further. */
		satZone: sat,
		/* The one that decides whether a comparison is worth anything: the
		 * grid's own peak sitting at the ceiling is what makes a sweep flat.
		 *
		 * Any zone TIED at the peak, not just the one that happened to win it.
		 * Peak selection keeps the first strict maximum, and a pinned zone can
		 * tie with an unpinned one at the same blended value -- {h2: 65534,
		 * v2: 5} and {h2: 65535, v2: 0} both come to 55295 -- so reading the
		 * flag off the winning index alone lets grid order decide whether the
		 * reading is trustworthy. If anything at the top of the grid cannot
		 * rise, the peak cannot rise. */
		peakSaturated: peakAt >= 0 &&
			fv.some((v, i) => v === peak && state[i] === 'measured' && sat[i]),
	};
}

/*
 * Peak-hold across successive grids.
 *
 * Focusing by hand means sweeping through the peak, and the peak is gone by the
 * time a person has looked from the lens to the screen. Holding the best value
 * seen -- per zone, and overall -- turns "was that it?" into something still on
 * the display. `reset()` when the scene or the framing changes, because a held
 * maximum from a different picture is worse than no history.
 */
export function peakHold() {
	let best = null, low = null, bestOverall = 0, lowOverall = null, shape = null;
	return {
		push(sum) {
			/* Shape, not length. Two grids of the same size and different
			 * shape put the same index in a different part of the picture, so
			 * a record kept across the change describes the wrong zones -- and
			 * the overall extrema have to go with it, because they are the
			 * gate that decides whether the lens has moved at all. Clearing
			 * only the per-zone arrays left that gate holding a range measured
			 * on a camera that no longer exists. */
			const sig = sum.rows + 'x' + sum.cols;
			if (!best || best.length !== sum.fv.length || shape !== sig) {
				best = sum.fv.map(() => null);
				low = sum.fv.map(() => null);
				bestOverall = 0;
				lowOverall = null;
				shape = sig;
			}
			for (let i = 0; i < sum.fv.length; i++) {
				/* Only a zone that measured may set its own record. A blown
				 * zone reports a huge response -- that is the whole reason the
				 * current-frame peak skips it -- and holding that value would
				 * make it the zone's permanent, unbeatable maximum, still
				 * standing long after the highlight moved off and the zone
				 * became readable. `null` where a zone has never yet measured,
				 * because 0 is a reading and "no reading" is not. */
				if (sum.state[i] !== 'measured') continue;
				if (best[i] === null || sum.fv[i] > best[i]) best[i] = sum.fv[i];
				/* The other end of the same record. A zone's best alone cannot
				 * say whether the zone ever RESPONDED to the lens moving, and
				 * that is the difference between a part of the frame that is
				 * out of focus and one with nothing in it to focus on. */
				if (low[i] === null || sum.fv[i] < low[i]) low[i] = sum.fv[i];
			}
			if (sum.peak !== null && sum.peak > bestOverall) bestOverall = sum.peak;
			if (sum.peak !== null && (lowOverall === null || sum.peak < lowOverall))
				lowOverall = sum.peak;
			return { best: best.slice(), bestOverall, low: low.slice(), lowOverall };
		},
		reset() {
			best = null; low = null; bestOverall = 0; lowOverall = null; shape = null;
		},
	};
}

/*
 * Map a grid to 0..1 for drawing, against the best value currently held rather
 * than this grid's own maximum. Normalising each frame to itself would make
 * every frame look equally sharp -- the display would be brightest at the peak
 * and just as bright far away from it, which is exactly the information the
 * operator came for.
 */
export function normalise(sum, ceiling) {
	const top = ceiling || sum.peak || 1;
	return sum.fv.map((v, i) => (sum.state[i] === 'measured' ? Math.min(1, v / top) : null));
}

/*
 * A readable grid.
 *
 * 255 coloured cells show that there is a bright patch somewhere and say
 * nothing about what anything reads. Someone calibrating autofocus wants a
 * number they can compare between parts of the frame, which means far fewer
 * cells and the value printed in each.
 *
 * The fine grid stays the measurement -- this only reduces it for display, so
 * nothing here can change where the peak actually is.
 *
 * Blocks are sized by boundary rather than by a constant width, because
 * neither 15 rows nor 17 columns divides evenly by anything an operator would
 * want to look at: 3 across leaves columns of 5, 6 and 6. The value is the
 * MEAN over the measured zones in the block, not the sum, so blocks of
 * different sizes stay comparable -- and not the maximum, which is the
 * reduction clamping already defeats.
 */
function bounds(len, n) {
	const out = [];
	for (let b = 0; b < n; b++)
		out.push([Math.floor(b * len / n), Math.floor((b + 1) * len / n)]);
	return out;
}

export function coarsen(s, n, opts = {}) {
	if (!Number.isSafeInteger(n) || n <= 0)
		throw new Error(`not a block count: ${n}`);
	/* Per-zone 'some' / 'none' / 'unknown', from zoneDetail or a sweep. A
	 * block is only called empty when every zone in it that could be measured
	 * agrees -- one textured corner is enough to focus on. */
	const detail = opts.detail || null;
	/* Asking for more blocks than there are zones would hand back empty cells
	 * reported as "nothing measurable", which is a different claim entirely. */
	const rowsN = Math.min(n, s.rows), colsN = Math.min(n, s.cols);
	const rb = bounds(s.rows, rowsN), cb = bounds(s.cols, colsN);
	const blocks = [];
	for (let br = 0; br < rowsN; br++) {
		for (let bc = 0; bc < colsN; bc++) {
			const [r0, r1] = rb[br], [c0, c1] = cb[bc];
			let sum = 0, measured = 0, saturated = 0, total = 0;
			let withDetail = 0, knownDetail = 0;
			for (let r = r0; r < r1; r++) {
				for (let c = c0; c < c1; c++) {
					const i = r * s.cols + c;
					total++;
					/* Only the two real answers count as knowing. Anything
					 * else -- absent, short array, undefined -- is "not
					 * looked at yet", not "nothing there". Read the other way
					 * round, a detail array that did not line up captioned
					 * every block on a frame nobody had swept. */
					const d = detail ? detail[i] : undefined;
					if (d === 'some' || d === 'none') {
						knownDetail++;
						if (d === 'some') withDetail++;
					}
					if (s.state[i] !== 'measured') continue;
					measured++;
					sum += s.fv[i];
				}
			}
			for (let r = r0; r < r1; r++)
				for (let c = c0; c < c1; c++)
					if (s.satZone && s.satZone[r * s.cols + c]) saturated++;
			blocks.push({
				row: br, col: bc, rowSpan: [r0, r1], colSpan: [c0, c1],
				/* null, not 0. A block with nothing worth believing in it has
				 * no value, and zero is a value -- one that sorts below every
				 * real block and reads as "measured, and very soft". */
				value: measured ? Math.round(sum / measured) : null,
				measured, total, saturated,
				/* 'none' is a statement about the SCENE -- there is nothing in
				 * this part of the frame to focus on -- and it is the reason a
				 * block reads low far more often than bad focus is. 'unknown'
				 * until the lens has moved enough to tell the two apart. */
				detail: !knownDetail ? 'unknown' : (withDetail ? 'some' : 'none'),
			});
		}
	}
	/* An empty block is never the sharpest. It cannot be: it has nothing in it
	 * that focus could sharpen, and naming it would point the operator at the
	 * one part of the frame that can never answer. Only if NOTHING has detail
	 * does the plain maximum stand, because then the alternative is naming no
	 * block at all on a frame that may simply not have been swept yet. */
	const pick = (ok) => {
		let at = null;
		for (let i = 0; i < blocks.length; i++) {
			const b = blocks[i];
			if (b.value === null || !ok(b)) continue;
			if (at === null || b.value > blocks[at].value) at = i;
		}
		return at;
	};
	const best = pick((b) => b.detail !== 'none');
	return { rows: rowsN, cols: colsN, blocks, best: best !== null ? best : pick(() => true) };
}

/*
 * What a defocus sweep says about each zone SEPARATELY.
 *
 * A sweep walks the lens and reads the whole grid at every stop, so it already
 * holds one focus curve per zone -- and the position where a zone peaks is the
 * distance that part of the frame is at. The scene mostly agrees; anything
 * that disagrees sharply is at a different distance from everything else.
 *
 * The common cause is nothing in the scene at all: dirt on the dome, a spider
 * web, a leaf against the glass. Those sit a few millimetres from the lens, so
 * they come into focus nowhere near where the picture does, and they are
 * exactly what drags a cheap autofocus onto the glass and keeps it there. An
 * operator cannot see this on a live image -- a smear reads as a soft patch --
 * but across a sweep it is unmistakable.
 *
 * It is reported as "focuses at a different distance", which is what was
 * measured. A near object that is genuinely part of the scene produces the
 * same signature and is not a fault; naming the cause is the operator's job,
 * and the two need looking at with the same eye anyway.
 */
export function sweepZones(frames, opts = {}) {
	if (!Array.isArray(frames) || frames.length < 3)
		throw new Error(`a sweep needs at least three readings, got ${frames && frames.length}`);
	const n = frames[0].fv.length;
	const rows = frames[0].rows, cols = frames[0].cols;
	/* Shape, not just count. Every index here is read back as a row and a
	 * column through the CURRENT grid's width, so two grids of the same size
	 * and different shape put the same index in a different part of the
	 * picture -- and a ring drawn over the wrong zone is worse than none. */
	for (const f of frames) {
		if (f.fv.length !== n || f.rows !== rows || f.cols !== cols)
			throw new Error('the grid changed shape during the sweep');
	}

	/* How much a zone has to move before its peak position means anything. A
	 * zone reading the same at every position -- a blank wall, a patch of sky
	 * -- has an argmax, and it is noise. Asking it where it focuses gets an
	 * answer indistinguishable from a confident one. */
	const swing = opts.swing !== undefined ? opts.swing : 0.25;
	/* How many times the scene's own disagreement a zone has to exceed before
	 * it counts as being at a different distance. */
	const apart = opts.apart !== undefined ? opts.apart : 3;

	const peakAt = new Array(n).fill(null);
	const why = new Array(n).fill('unmeasured');
	for (let i = 0; i < n; i++) {
		let hi = -1, lo = Infinity, at = -1, ever = false, pinned = false;
		for (let f = 0; f < frames.length; f++) {
			if (frames[f].sat && frames[f].sat[i]) pinned = true;
			if (frames[f].state[i] !== 'measured') continue;
			ever = true;
			const v = frames[f].fv[i];
			if (v > hi) { hi = v; at = f; }
			if (v < lo) lo = v;
		}
		/* A zone that hit the counter's ceiling anywhere along the sweep has
		 * no usable peak POSITION, which is a separate loss from the one the
		 * ratio suffers. Clamped readings plateau, the first of them wins the
		 * argmax, and where the counter happened to fill up is not where the
		 * lens was sharpest -- so the zone would be accused of focusing
		 * somewhere else on the strength of an artefact. `state` cannot carry
		 * this: summarise keeps saturation separate on purpose, because a
		 * pinned zone is still perfectly well exposed. */
		if (pinned) { why[i] = 'pinned'; continue; }
		/* `ever` is the whole question of whether anything was measured here.
		 * A zero maximum is an ANSWER to that, not an absence of one, and
		 * calling it unmeasured told the operator the zone could not be read
		 * when in fact it was read and had nothing in it. */
		if (!ever) { why[i] = 'unmeasured'; continue; }
		if (hi === 0) { why[i] = 'flat'; continue; }
		/* Never moved: there is nothing in this zone to focus on. Reported as
		 * its own answer, because a zone with no detail and a zone that is out
		 * of focus produce the same small number and need opposite responses
		 * -- point the camera somewhere with edges in it, or turn the lens. */
		if ((hi - lo) / hi < swing) { why[i] = 'flat'; continue; }
		why[i] = 'responded';
		peakAt[i] = at;
	}

	const heard = peakAt.filter((v) => v !== null).sort((a, b) => a - b);
	if (!heard.length)
		return { consensus: null, peakAt, why, suspect: [], heard: 0, rows, cols,
			flat: why.filter((w) => w === 'flat').length };
	/* Median, not mean. One smeared corner peaking at the far end of the sweep
	 * drags a mean toward itself and then measures everything else against a
	 * consensus it invented. */
	const consensus = heard[heard.length >> 1];
	/* How far out is far, measured against how tightly the SCENE agrees --
	 * not against the number of readings.
	 *
	 * Every zone is sampled at the same instants, so their peak ORDER means
	 * something however fast the lens was moving. What does not survive uneven
	 * travel is a threshold set as a fixed fraction of the reading count: an
	 * operator who slows down through focus piles most of the readings there,
	 * which spreads the normal zones out in index and makes a fixed fraction
	 * either blind or trigger-happy. The median absolute deviation of the
	 * zones that responded absorbs exactly that, because it is measured in the
	 * same distorted units as the thing being judged.
	 *
	 * The fraction stays as a FLOOR, so a scene where every zone agrees to the
	 * frame does not start flagging its own noise. */
	const dev = heard.map((v) => Math.abs(v - consensus)).sort((a, b) => a - b);
	const mad = dev[dev.length >> 1];
	/* The floor is two readings, NOT a fraction of how many were taken. A
	 * fraction looks prudent and is the bug: a long sweep gets a large floor,
	 * so the more carefully someone measures the blinder this gets. Two
	 * readings is only there to stop a scene that agrees to the frame from
	 * flagging its own noise. */
	const far = Math.max(2, Math.round(apart * mad));
	const suspect = [];
	for (let i = 0; i < n; i++)
		if (peakAt[i] !== null && Math.abs(peakAt[i] - consensus) > far) suspect.push(i);
	/* The shape travels with the finding. A consumer holding these indices
	 * across a grid change would otherwise place them by the new width. */
	return { consensus, peakAt, why, suspect, heard: heard.length, far, rows, cols,
		flat: why.filter((w) => w === 'flat').length };
}

/*
 * Which parts of the frame have anything in them to focus on.
 *
 * A blank wall, a patch of sky, a smooth painted door: all of them report a
 * small focus value wherever the lens is, because focus statistics measure
 * detail and there is none there to measure. Shown as a bare number that
 * reads as "this part of the picture is soft", which sends an operator
 * chasing focus that was never the problem. The first person to calibrate
 * with this hit it immediately: "на 9 квадрате не нашлось резких объектов и
 * ему маленькую цифру дали".
 *
 * A zone with detail in it RESPONDS when the lens moves; a zone without one
 * does not. That is the whole test, and it needs the lens to have moved --
 * which is why nothing is claimed until the frame as a whole has shown it
 * has. Before then every zone is 'unknown', because "we have not looked yet"
 * and "there is nothing there" are different answers and only one of them is
 * the operator's problem.
 */
export function zoneDetail(hold, opts = {}) {
	/* How much the frame overall has to have moved before this says anything.
	 * Below it the lens has not been turned far enough to tell an empty zone
	 * from one that simply has not been swept past focus yet. */
	const moved = opts.moved !== undefined ? opts.moved : 0.2;
	/* How much a zone has to move to count as having something in it. */
	const detail = opts.detail !== undefined ? opts.detail : 0.15;
	const n = hold && hold.best ? hold.best.length : 0;
	const out = new Array(n).fill('unknown');
	if (!n || !hold.bestOverall || hold.lowOverall === null) return out;
	if ((hold.bestOverall - hold.lowOverall) / hold.bestOverall < moved) return out;
	for (let i = 0; i < n; i++) {
		const hi = hold.best[i], lo = hold.low[i];
		/* null is "never measured" and stays unknown. Zero is a READING, and
		 * a lit zone that reads zero at every lens position is the emptiest
		 * zone there is -- skipping it left the one block most in need of the
		 * caption without it. The accumulators cannot go negative, so hi === 0
		 * means lo === 0 too and there is no swing to divide for. */
		if (hi === null || lo === null) continue;
		out[i] = (hi === 0 || (hi - lo) / hi < detail) ? 'none' : 'some';
	}
	return out;
}

/*
 * Did the lens go one way?
 *
 * Everything sweepZones concludes about DISTANCE rests on one assumption: that
 * reading order is lens order. A motor guarantees it. A hand does not -- an
 * operator who turns forward, back, and forward again visits the same position
 * at three different indices, and two zones peaking at different indices may
 * be at the same distance after all. Uneven speed is survivable, and the
 * median absolute deviation handles it; going BACK is not, because it breaks
 * the mapping rather than stretching it.
 *
 * Detected from the scene's own curve rather than from any position the
 * readings do not carry: swept once through focus, the overall reading rises
 * and falls once. Crossing the halfway mark upwards more than once means the
 * lens came back. The ratio is unharmed either way -- highest over lowest does
 * not care what order they arrived in -- so only the distance findings are
 * withheld.
 */
export function sweptOneWay(peaks) {
	const v = peaks.filter((p) => typeof p === 'number' && isFinite(p));
	if (v.length < 4) return false;
	const hi = Math.max.apply(null, v), lo = Math.min.apply(null, v);
	if (hi <= lo) return false;
	/* Half way up the range: high enough that noise around the trough does not
	 * register as the lens turning round, low enough to catch a real second
	 * excursion. */
	const mid = lo + (hi - lo) / 2;
	let ups = 0;
	for (let i = 1; i < v.length; i++)
		if (v[i - 1] < mid && v[i] >= mid) ups++;
	return ups <= 1;
}
