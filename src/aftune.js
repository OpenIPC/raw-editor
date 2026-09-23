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
	return {
		rows, cols, fv, state, measured,
		peak: peakAt < 0 ? null : peak,
		peakAt: peakAt < 0 ? null : { row: (peakAt / cols) | 0, col: peakAt % cols, index: peakAt },
		unlit: state.filter((s) => s === 'unlit').length,
		clipped: state.filter((s) => s === 'clipped').length,
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
	let best = null, bestOverall = 0;
	return {
		push(sum) {
			if (!best || best.length !== sum.fv.length) best = sum.fv.map(() => null);
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
			}
			if (sum.peak !== null && sum.peak > bestOverall) bestOverall = sum.peak;
			return { best: best.slice(), bestOverall };
		},
		reset() { best = null; bestOverall = 0; },
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
