/*
 * Decode tests/fixture.dng and check the result against numbers measured off
 * the camera that produced it — not against the engine's own output. A test
 * that only proves the code runs would pass with the colour pipeline inverted.
 *
 * The fixture is a 256x256 RGGB crop of a real IMX335 frame at ISO 1926,
 * lit by a warm lamp, so the scene is strongly amber. Every expectation below
 * comes from that measurement.
 */
import { readFileSync } from 'node:fs';
import { instantiate, DEMOSAIC } from '../src/engine.js';

let failures = 0;
function check(name, got, want, tol = 0) {
	const ok = typeof want === 'number' && tol
		? Math.abs(got - want) <= tol
		: JSON.stringify(got) === JSON.stringify(want);
	console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}: ${JSON.stringify(got)}` +
		(ok ? '' : ` (expected ${JSON.stringify(want)}${tol ? ` +-${tol}` : ''})`));
	if (!ok) failures++;
}
function assert(name, cond, detail = '') {
	console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${detail ? ': ' + detail : ''}`);
	if (!cond) failures++;
}

const engine = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
const info = engine.open(readFileSync(new URL('../tests/fixture.dng', import.meta.url)));

console.log('the file describes itself');
check('width', info.width, 256);
check('height', info.height, 256);
check('bits', info.bits, 10);
check('cfa', info.cfaName, 'RGGB');
check('black level', info.black, 50);
check('white level', info.white, 1023);
check('iso', info.iso, 1926);
check('exposure seconds', info.exposure, 0.04, 1e-4);
check('camera model', info.model, 'HiSilicon imx335');
check('as-shot neutral R', info.neutral[0], 0.4952, 1e-3);
check('as-shot neutral B', info.neutral[2], 0.8232, 1e-3);
assert('forward matrix present', info.hasForward);

// A ForwardMatrix is defined to map white-balanced camera values to XYZ(D50),
// so its rows must sum to the D50 white point. This is the cheapest way to
// tell real calibration from a zeroed default.
const D50 = [0.9642, 1.0, 0.8249];
for (let r = 0; r < 3; r++) {
	const sum = info.forward[r * 3] + info.forward[r * 3 + 1] + info.forward[r * 3 + 2];
	check(`forward row ${r} sums to D50`, Math.round(sum * 1e4) / 1e4, D50[r], 0.004);
}

console.log('\nunpacking lands on the right pixels');
// Measured on the source crop before packing. If the bit unpacking or the
// row stride were wrong these would move.
const raw = new Uint16Array(engine.x.memory.buffer, engine.x.dng_raw_ptr(), 256 * 256);
const mean = (ox, oy) => {
	let s = 0, n = 0;
	for (let y = oy; y < 256; y += 2) for (let x = ox; x < 256; x += 2) { s += raw[y * 256 + x]; n++; }
	return s / n;
};
check('R plane mean', Math.round(mean(0, 0) * 1e3) / 1e3, 152.752, 0.01);
check('Gr plane mean', Math.round(mean(1, 0) * 1e3) / 1e3, 152.676, 0.01);
check('Gb plane mean', Math.round(mean(0, 1) * 1e3) / 1e3, 152.441, 0.01);
check('B plane mean', Math.round(mean(1, 1) * 1e3) / 1e3, 79.486, 0.01);
let lo = 65535, hi = 0;
for (let i = 0; i < raw.length; i++) { if (raw[i] < lo) lo = raw[i]; if (raw[i] > hi) hi = raw[i]; }
check('raw minimum', lo, 51);
check('raw maximum', hi, 409);
assert('nothing exceeds the declared white level', hi <= info.white, `max ${hi} <= ${info.white}`);

console.log('\nthe Bayer probe narrows the field to the right diagonal');
const probe = engine.probeCFA();
probe.ranked.forEach((r) => console.log(`        ${r.name} ${r.score.toFixed(4)}`));
// The two patterns sharing the true green diagonal must both survive, and the
// two with the wrong one must not. Anything that claims a single winner here
// is claiming more than one frame can support.
check('survivors', probe.survivors.map((r) => r.name).sort(), ['BGGR', 'RGGB']);
assert('the file\'s own pattern is among them',
	probe.survivors.some((r) => r.name === info.cfaName));
assert('and the wrong diagonal is clearly rejected',
	probe.ranked[3].score < probe.ranked[0].score * 0.8,
	`${probe.ranked[3].score.toFixed(3)} vs ${probe.ranked[0].score.toFixed(3)}`);
assert('the probe admits it cannot separate the survivors', probe.ambiguous);

console.log('\ndeveloping');
const none = engine.develop({ demosaic: DEMOSAIC.none }).pixels;
// In the mosaic view each pixel carries exactly one plane, so a green site
// must have no red in it. This is what catches a plane_at() that is off by one.
let greenSiteRed = 0;
for (let y = 0; y < 256; y += 2) for (let x = 1; x < 256; x += 2) greenSiteRed += none[(y * 256 + x) * 4];
check('no red at green sites in the mosaic view', greenSiteRed, 0);

const rgba = engine.develop({ demosaic: DEMOSAIC.bilinear }).pixels;
let sum = [0, 0, 0];
for (let i = 0; i < 256 * 256; i++) { sum[0] += rgba[i * 4]; sum[1] += rgba[i * 4 + 1]; sum[2] += rgba[i * 4 + 2]; }
const avg = sum.map((v) => Math.round(v / (256 * 256)));
console.log(`        developed means R ${avg[0]} G ${avg[1]} B ${avg[2]}`);
// The camera's own JPEG of this scene averaged R 92 G 43 B 8 — strongly amber.
// The ordering is the falsifiable part: get the colour matrix or the CFA
// wrong and it inverts.
assert('the scene reads amber, as the camera itself rendered it',
	avg[0] > avg[1] && avg[1] > avg[2], `R ${avg[0]} > G ${avg[1]} > B ${avg[2]}`);
assert('the frame is not degenerate', avg[0] > 10 && avg[0] < 250);

// A stepped preview must be the same picture, smaller — not a differently
// wrong one, which is what happens if the step breaks the CFA phase.
const prev = engine.develop({ demosaic: DEMOSAIC.bilinear, step: 4 });
check('preview dimensions', [prev.width, prev.height], [64, 64]);
let psum = [0, 0, 0];
for (let i = 0; i < prev.width * prev.height; i++) {
	psum[0] += prev.pixels[i * 4]; psum[1] += prev.pixels[i * 4 + 1]; psum[2] += prev.pixels[i * 4 + 2];
}
const pavg = psum.map((v) => Math.round(v / (prev.width * prev.height)));
console.log(`        preview means  R ${pavg[0]} G ${pavg[1]} B ${pavg[2]}`);
assert('the preview matches the full render within a few levels',
	Math.abs(pavg[0] - avg[0]) < 8 && Math.abs(pavg[1] - avg[1]) < 8 && Math.abs(pavg[2] - avg[2]) < 8,
	`preview ${pavg} vs full ${avg}`);

engine.develop({ demosaic: DEMOSAIC.bilinear });
const hist = engine.histogram();
const total = hist.r.reduce((a, b) => a + b, 0);
check('histogram counts every pixel', total, 256 * 256);

console.log('\nrepeated renders are free');
// The engine allocates from a bump allocator with no free, reset only when a
// frame is opened. Scratch buffers therefore have to be per-frame, or a minute
// of dragging a slider is thousands of allocations that are never reclaimed.
const memBefore = engine.x.memory.buffer.byteLength;
for (let i = 0; i < 300; i++) { engine.develop({ demosaic: DEMOSAIC.bilinear, step: 4 }); engine.histogram(); }
const memAfter = engine.x.memory.buffer.byteLength;
assert('300 develop+histogram cycles grow wasm memory by nothing',
	memAfter === memBefore, `${memBefore} -> ${memAfter} bytes`);

console.log('\npicking a neutral');
// The promise of the picker is one thing: whatever you click on comes out
// grey. That is testable without knowing what the subject was, and it is
// exactly the invariant a wrong CFA offset or a canvas-instead-of-mosaic
// sample would break.
{
	const at = { x: 128, y: 128 };
	const got = engine.samplePatch(at.x, at.y, 6);
	check('green is the scale, so it comes back as exactly 1', got.neutral[1], 1);
	assert('red and blue are positive multiples of it',
		got.neutral[0] > 0 && got.neutral[2] > 0, JSON.stringify(got.neutral));

	const r = engine.develop({ demosaic: DEMOSAIC.bilinear, neutral: got.neutral });
	let acc = [0, 0, 0], n = 0;
	for (let y = at.y - 6; y <= at.y + 6; y++)
		for (let x = at.x - 6; x <= at.x + 6; x++) {
			const o = (y * r.width + x) * 4;
			acc[0] += r.pixels[o]; acc[1] += r.pixels[o + 1]; acc[2] += r.pixels[o + 2]; n++;
		}
	const m = acc.map((v) => v / n);
	assert('and the patch it was taken from renders grey',
		Math.abs(m[0] - m[1]) < 6 && Math.abs(m[2] - m[1]) < 6,
		`R ${m[0].toFixed(1)} G ${m[1].toFixed(1)} B ${m[2].toFixed(1)}`);

	// The as-shot balance is what the camera chose, and the fixture's scene is
	// strongly amber, so the two must not be the same answer -- if they were,
	// the picker would be reading something it had already balanced.
	assert('which is not simply the as-shot value read back',
		Math.abs(got.neutral[0] - info.neutral[0]) > 0.01,
		`picked ${got.neutral[0].toFixed(4)} vs as shot ${info.neutral[0].toFixed(4)}`);

	let refused = '';
	try { engine.samplePatch(-100, -100, 2); } catch (e) { refused = e.message; }
	assert('a patch outside the frame is refused, not answered',
		/outside the frame/.test(refused), refused || '(no error)');
}

console.log('\nsampling a chart patch: its own pedestals, and not the ADC ceiling');
{
	const { makeDng } = await import('./make-dng.mjs');
	const W = 32, H = 32;
	const e = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
	// Four pedestals, one per 2x2 position, and exactly 100 codes of signal
	// above each. Read with one black level for the whole frame, the four
	// planes would come back 100, 90, 80, 70 (and green averaged); read per
	// position they are all 100.
	const BL = [200, 210, 220, 230];
	const px = new Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) px[y * W + x] = BL[((y & 1) << 1) | (x & 1)] + 100;
	e.open(makeDng({ width: W, height: H, pixels: px, black: BL, white: 4095 }));
	const flat = e.samplePatch(16, 16, 6);
	assert('each CFA position loses its own pedestal, not the first one\'s',
		flat.raw.every((v) => Math.abs(v - 100) < 1e-3), JSON.stringify(flat.raw));
	check('and nothing there is clipped', flat.clipped, 0);

	// The same four pedestals written as RATIONAL pairs, which the
	// specification allows: read as 32-bit words they came back as alternating
	// numerators and denominators.
	e.open(makeDng({ width: W, height: H, pixels: px, black: BL, white: 4095, blackRational: true }));
	const rat = e.samplePatch(16, 16, 6);
	assert('rational pedestals are read as the values they are',
		rat.raw.every((v) => Math.abs(v - 100) < 1e-3), JSON.stringify(rat.raw));

	// Four values in a row are not four CFA positions. Under a 1x4 repeat
	// they are not subtracted per 2x2 site; the first is used for the frame.
	e.open(makeDng({ width: W, height: H, pixels: px, black: BL, white: 4095, blackRepeat: [1, 4] }));
	const row = e.samplePatch(16, 16, 6);
	check('four pedestals in a row are not read as a 2x2',
		row.raw.map((v) => Math.round(v)), [100, 115, 130]);

	// The same frame with a third of the red sites at the white level: the
	// mean is of the rest, and the fraction says how much was set aside.
	const hot = px.slice();
	let n = 0;
	for (let y = 0; y < H; y += 2)
		for (let x = 0; x < W; x += 2) if (((x + y) >> 1) % 3 === 0) { hot[y * W + x] = 4095; n++; }
	e.open(makeDng({ width: W, height: H, pixels: hot, black: BL, white: 4095 }));
	const got = e.samplePatch(16, 16, 6);
	assert('a clipped photosite is left out of the patch\'s mean',
		Math.abs(got.raw[0] - 100) < 1e-3, 'red ' + got.raw[0].toFixed(2));
	assert('and counted', got.clipped > 0.05 && got.clipped < 0.15, got.clipped.toFixed(3));

	// The camera's own characterisation reaches the page, to the precision a
	// rational over 10000 carries.
	const CM = [0.6, -0.1, -0.05, -0.4, 1.3, 0.1, -0.1, 0.25, 0.55];
	e.open(makeDng({ width: W, height: H, pixels: px, black: 0, white: 4095,
		colorMatrices: [{ matrix: CM, illuminant: 17 }, { matrix: CM.map((v) => v * 0.9), illuminant: 21 }] }));
	const cms = e.info.colorMatrices;
	assert('ColorMatrix1/2 and their illuminants are read',
		cms.length === 2 && cms[0].illuminant === 17 && cms[1].illuminant === 21 &&
		cms[0].matrix.every((v, i) => Math.abs(v - CM[i]) < 1e-4),
		JSON.stringify(cms.map((c) => c.illuminant)));
}

console.log('\na blown highlight develops to white, not to the white balance gains');
/*
 * A neutral that has clipped is still a neutral. The sensor stops counting at
 * the white level, so every plane reads the same ceiling and the ratios the
 * white balance exists to correct are gone with it -- which means the balance
 * must not be let loose to invent new ones. Divide a clipped (1, 1, 1) by an
 * AsShotNeutral of (0.5, 1, 0.55) without bounding the result and the matrix
 * is handed (2.00, 1.00, 1.82), which is not white but magenta, and a forward
 * matrix renders that magenta faithfully.
 *
 * It reached a user as pink cars: on a hi3516ev300 + imx335 car park every
 * white car developed to 255,194,255 while dcraw, given the same file and the
 * same multipliers, rendered them 253,253,254.
 *
 * Two uniform frames rather than one scene with two patches, so no demosaic
 * ever reaches across the boundary between them and the expected answer is the
 * same at every interior pixel.
 */
{
	const { makeDng } = await import('./make-dng.mjs');
	const W = 32, H = 32, BLACK = 200, WHITE = 4095;
	// The ForwardMatrix1 off the camera that produced the pink cars. Its rows
	// sum to D50, so a neutral going in has to be a neutral coming out -- that
	// property is the whole of what is being tested here.
	const FWD = [0.564968, 0.172974, 0.225710,
		0.113403, 0.879468, 0.006847,
		-0.013249, -0.821984, 1.657816];
	const NEU = [0.5, 1.0, 0.55];

	// RGGB, every quad the same, so each plane carries one level everywhere.
	const flat = (rgb) => {
		const px = new Uint16Array(W * H);
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++)
				px[y * W + x] = rgb[(y % 2 === 0) ? (x % 2 === 0 ? 0 : 1) : (x % 2 === 0 ? 1 : 2)];
		return makeDng({ width: W, height: H, pixels: px, black: BLACK, white: WHITE });
	};
	const centre = async (bytes, gain = 1) => {
		const e = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
		e.open(bytes);
		const r = e.develop({ demosaic: DEMOSAIC.bilinear, neutral: NEU, forward: FWD,
			useForward: true, gain, step: 1 });
		const o = ((H / 2) * W + W / 2) * 4;   // interior: the border mirrors
		return [r.pixels[o], r.pixels[o + 1], r.pixels[o + 2]];
	};
	const spread = (v) => Math.max(...v) - Math.min(...v);

	// Half scale in each plane, in the as-shot ratio, so this one is a neutral
	// the balance can still do its job on. It is the control: it says the
	// matrix and the neutral above really do render a grey as grey, which is
	// what makes the clipped case below evidence of anything.
	const grey = await centre(flat([1174, 2148, 1271]));
	console.log(`        an unclipped neutral develops to R ${grey[0]} G ${grey[1]} B ${grey[2]}`);
	assert('an unclipped neutral develops to a grey', spread(grey) <= 2 && grey[1] > 20 && grey[1] < 235,
		`${grey} spread ${spread(grey)}`);

	const blown = await centre(flat([WHITE, WHITE, WHITE]));
	console.log(`        a clipped neutral develops to  R ${blown[0]} G ${blown[1]} B ${blown[2]}`);
	assert('a clipped neutral develops to a grey too', spread(blown) <= 3, `${blown} spread ${spread(blown)}`);
	assert('and that grey is white, not some darker neutral', blown[1] >= 250, `G ${blown[1]}`);

	/*
	 * The case that actually reached the user. Green carries a gain of 1.0 and
	 * saturates a stop and a half before red and blue do, so the usual state of
	 * a bright neutral is not "all three clipped" but "green clipped, the other
	 * two still counting" -- on the car that started this, 97% of green samples
	 * sat at the white level against 38% of red. A fix that only neutralises
	 * pixels where every plane has gone is no fix for the frame that reported
	 * the bug.
	 */
	const part = await centre(flat([3121, WHITE, 3413]));   // a neutral at 1.5x full scale
	console.log(`        green alone clipped develops to R ${part[0]} G ${part[1]} B ${part[2]}`);
	assert('a neutral with only green clipped develops to a grey', spread(part) <= 3,
		`${part} spread ${spread(part)}`);

	/*
	 * And the headroom has to survive, because the Exposure slider is what
	 * pulls it back: the control runs -3..+3 stops as gain = 2^v, so a render
	 * at gain < 1 is the normal way to look into a highlight.
	 *
	 * A plane that never reached the sensor ceiling can still exceed 1 once
	 * divided by its neutral -- that is real measurement, not saturation, and
	 * capping it would quietly cost a stop. Both candidate answers are worked
	 * out here from the raw levels and the matrix rather than read back from
	 * the engine, so this says which of the two the engine computed.
	 */
	const XYZ50_TO_SRGB = [3.1338561, -1.6168667, -0.4906146,
		-0.9787684, 1.9161415, 0.0334540,
		0.0719453, -0.2289914, 1.4052427];
	const GAIN = 0.25;                                      // -2 stops
	const RAW = [3316, 1174, 1174];                         // red at 0.80 of full scale: bright, not clipped
	const lin = RAW.map((v) => (v - BLACK) / (WHITE - BLACK));
	assert('the red plane under test is genuinely below the ceiling', lin[0] < 1,
		`lin R ${lin[0].toFixed(4)}`);
	// The engine quantises through a 1024-entry sRGB table, so predict the same way.
	const encode = (v) => {
		const s = Math.round(Math.max(0, Math.min(1, v)) * 1023) / 1023;
		return Math.round(255 * (s <= 0.0031308 ? s * 12.92 : 1.055 * Math.pow(s, 1 / 2.4) - 0.055));
	};
	const redOut = (w) => {
		let s = 0;
		for (let k = 0; k < 3; k++) {
			let m = 0;
			for (let j = 0; j < 3; j++) m += XYZ50_TO_SRGB[j] * FWD[j * 3 + k];
			s += m * w[k];
		}
		return encode(s * GAIN);
	};
	const kept = redOut(lin.map((v, i) => v / NEU[i]));
	const capped = redOut(lin.map((v, i) => Math.min(v / NEU[i], 1)));
	const got = await centre(flat(RAW), GAIN);
	console.log(`        at ${GAIN}x gain red reads ${got[0]}; keeping the headroom predicts ${kept}, capping it ${capped}`);
	assert('the two answers are far enough apart to tell apart', Math.abs(kept - capped) > 20,
		`kept ${kept} vs capped ${capped}`);
	assert('an unclipped plane above the neutral keeps its headroom for the exposure slider',
		Math.abs(got[0] - kept) <= 2, `read ${got[0]}, headroom predicts ${kept}, capped predicts ${capped}`);
}

console.log('\nan odd pixel count still unpacks all the way to the end');
// The packed unpackers step in whole groups, so a count that is not a multiple
// of the group has a tail they do not reach. A Bayer frame always has even
// dimensions and never exercises it -- which is why it is worth a test, since
// everything downstream reads the whole buffer regardless.
{
	const { makeDng } = await import('./make-dng.mjs');
	const W = 5, H = 5;                       // 25 pixels: twelve pairs and one
	const px = new Uint16Array(W * H);
	for (let i = 0; i < px.length; i++) px[i] = 100 + i * 37;
	const e4 = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
	e4.open(makeDng({ width: W, height: H, pixels: px, black: 0, white: 4095 }));
	const raw = new Uint16Array(e4.x.memory.buffer, e4.x.dng_raw_ptr(), W * H);
	let wrong = 0;
	for (let i = 0; i < px.length; i++) if (raw[i] !== px[i]) wrong++;
	check('every pixel of an odd-length frame survives, the last one included', wrong, 0);
	check('and the last one is the value that was written', raw[W * H - 1], px[W * H - 1]);
}

console.log('\ngradient-corrected demosaicing beats bilinear on a frame we know the answer to');
// The only way to score a demosaic is against the picture it was made from:
// build an RGB scene, throw two thirds of it away in a Bayer pattern, and see
// which method puts back more of what was taken.
{
	const { makeDng } = await import('./make-dng.mjs');
	const W = 128, H = 128;
	const truth = new Float64Array(W * H * 3);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			// Detail of the kind demosaicing is judged on: a hard diagonal,
			// fine vertical lines, and a smooth ramp for it not to ruin.
			const diag = x + y > 120 ? 1 : 0;
			const lines = (x % 4 < 2) ? 1 : 0;
			const o = (y * W + x) * 3;
			truth[o] = 400 + diag * 2600 + lines * 300 + x * 4;
			truth[o + 1] = 600 + diag * 2000 + lines * 200 + y * 4;
			truth[o + 2] = 300 + diag * 1200 + lines * 500 + (x + y) * 2;
		}
	// RGGB: red at even/even, blue at odd/odd, green on the other two.
	const px = new Uint16Array(W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const p = (y % 2 === 0) ? (x % 2 === 0 ? 0 : 1) : (x % 2 === 0 ? 1 : 2);
			px[y * W + x] = Math.min(4095, Math.round(truth[(y * W + x) * 3 + p]));
		}

	const e3 = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
	e3.open(makeDng({ width: W, height: H, pixels: px, black: 0, white: 4095 }));

	// The same transfer the engine applies, so the comparison is like for like.
	const enc = (v) => {
		const s = Math.max(0, Math.min(1, v / 4095));
		return 255 * (s <= 0.0031308 ? s * 12.92 : 1.055 * Math.pow(s, 1 / 2.4) - 0.055);
	};
	const score = (mode) => {
		const r = e3.develop({ demosaic: mode, neutral: [1, 1, 1], useForward: false, gain: 1, step: 1 });
		let sum = 0, n = 0;
		for (let y = 3; y < H - 3; y++)
			for (let x = 3; x < W - 3; x++)
				for (let p = 0; p < 3; p++) {
					sum += Math.abs(r.pixels[(y * W + x) * 4 + p] - enc(truth[(y * W + x) * 3 + p]));
					n++;
				}
		return sum / n;
	};
	const bilinear = score(DEMOSAIC.bilinear);
	const gradient = score(DEMOSAIC.gradient);
	const rcd = score(DEMOSAIC.rcd);
	console.log(`       mean error per channel — bilinear ${bilinear.toFixed(2)}, ` +
		`gradient ${gradient.toFixed(2)}, rcd ${rcd.toFixed(2)}`);
	assert('gradient-corrected reconstructs the scene more closely than bilinear',
		gradient < bilinear * 0.9,
		`mean error per channel: bilinear ${bilinear.toFixed(2)}, gradient ${gradient.toFixed(2)}`);
	// RCD earns its place or it does not ship: it costs a full green plane and
	// a second pass, so beating the cheap filter is the whole justification.
	assert('and RCD reconstructs it more closely still',
		rcd < gradient * 0.95,
		`gradient ${gradient.toFixed(2)}, rcd ${rcd.toFixed(2)}`);
	// The green plane is cached for the frame, so a second develop must give
	// the same answer rather than a stale or half-built one.
	const again = score(DEMOSAIC.rcd);
	assert('and gives the same answer the second time, from its cached green',
		Math.abs(again - rcd) < 1e-9, `${rcd} then ${again}`);
	assert('and both are in the right ballpark rather than nonsense',
		bilinear < 40 && gradient > 0,
		`bilinear ${bilinear.toFixed(2)}, gradient ${gradient.toFixed(2)}`);
}

console.log('\ndiagnose finds what was planted, and nothing else');
// Built rather than measured: nobody knows where the hot pixels in a real
// frame are, so a test about finding them has to put them there first.
{
	const { makeDng } = await import('./make-dng.mjs');
	const W = 96, H = 96, BASE = 1000, SIGMA = 12;

	// A fixed sequence, so a failure is the code's and reproduces.
	let seed = 12345;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
	const gauss = () => {
		const u = Math.max(1e-9, rnd()), v = rnd();
		return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	};

	const px = new Uint16Array(W * H);
	for (let i = 0; i < px.length; i++)
		px[i] = Math.max(0, Math.min(4095, Math.round(BASE + gauss() * SIGMA)));

	const HOT = [[20, 30], [51, 44], [70, 12]];
	for (const [x, y] of HOT) px[y * W + x] = 4000;
	const DEAD = [[33, 61]];
	for (const [x, y] of DEAD) px[y * W + x] = 20;

	// A thin bright ridge, two pixels wide: the harder false positive. Its
	// crest really is higher than all four neighbours two pixels away, so no
	// rule about the candidate alone can tell it from a hot pixel.
	for (let y = 10; y < H - 10; y++)
		for (let x = 40; x < 42; x++)
			px[y * W + x] = Math.max(0, Math.min(4095, Math.round(3000 + gauss() * SIGMA)));

	// A hard vertical edge: the classic false positive, since every pixel on
	// its bright side towers over the two neighbours behind it.
	for (let y = 0; y < H; y++)
		for (let x = 60; x < W; x++)
			if (!(x === 70 && y === 12)) px[y * W + x] = Math.max(0, Math.min(4095,
				Math.round(2400 + gauss() * SIGMA)));

	// And a corner already blown, so the clipped fraction has a known answer.
	let clipR = 0;
	for (let y = 0; y < 8; y++)
		for (let x = 0; x < 8; x++) {
			px[y * W + x] = 4095;
			if (x % 2 === 0 && y % 2 === 0) clipR++;   // RGGB: red at even,even
		}

	const engine2 = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
	engine2.open(makeDng({ width: W, height: H, pixels: px, black: 0, white: 4095 }));
	const d = engine2.diagnose({ sigmas: 8 });

	check('the clipped red fraction is the corner that was blown',
		+(d.clipped[0] * (W * H / 4)).toFixed(0), clipR);
	assert('the noise it measures is the noise that was added',
		Math.abs(d.noise[1] - SIGMA) < SIGMA * 0.25,
		`measured ${d.noise[1].toFixed(2)} against a planted ${SIGMA}`);
	assert('the black floor is the base level, not the darkest single pixel',
		Math.abs(d.blackFloor[1] - BASE) < SIGMA * 4 && d.darkest[2] < d.blackFloor[2],
		`floor ${d.blackFloor[1]}, darkest blue ${d.darkest[2]}`);

	// The blown corner must not read as four hundred bad pixels. A clipped
	// pixel stopped counting at the white level, so where it saturated and its
	// neighbours came up just short it stands above all four by construction --
	// which on a real frame lit up the whole rim of a highlight.
	const inCorner = d.defects.filter((p) => p.x < 10 && p.y < 10).length;
	check('a blown highlight is not a field of defects', inCorner, 0);

	const found = new Set(d.defects.map((p) => p.x + ',' + p.y));
	for (const [x, y] of HOT.concat(DEAD))
		assert(`the defect planted at ${x},${y} was found`, found.has(x + ',' + y));
	assert('and neither the edge nor the ridge was mistaken for hundreds of them',
		d.defectCount < 12, `${d.defectCount} defects reported`);
	const onRidge = d.defects.filter((p) => p.x >= 38 && p.x <= 43).length;
	check('nothing on the ridge was called a defect', onRidge, 0);

	// A frame with nothing wrong must come back with nothing to report, which
	// is the half that a too-eager detector fails.
	const clean = new Uint16Array(W * H);
	seed = 999;
	for (let i = 0; i < clean.length; i++)
		clean[i] = Math.max(0, Math.min(4095, Math.round(BASE + gauss() * SIGMA)));
	engine2.open(makeDng({ width: W, height: H, pixels: clean, black: 0, white: 4095 }));
	const q = engine2.diagnose({ sigmas: 8 });
	check('a clean frame reports no defects', q.defectCount, 0);
	check('and nothing clipped', q.clipped.map((v) => +v.toFixed(6)), [0, 0, 0]);
}

console.log('\ncalibration recovers a matrix it was not given');
// The only honest test of a solver is ground truth: plant a known camera
// response, generate the patches a chart would produce through it, and check
// that what comes back is what went in. A solve always returns SOMETHING, so
// "it ran" proves nothing at all.
{
	const { solveFromPatches, patchCentres, CHART_XYZ50, apply3, CHART_SRGB } =
		await import('../src/calibrate.js');

	// Measured off the lab gk7205v300's own ISP, so the shape is a real one.
	const PLANTED = [
		1.1209, -0.4122, -0.3991,
		-0.2130, 1.2110, 0.0651,
		-0.0550, 0.3546, 0.8493,
	];
	const patches = CHART_XYZ50.map((xyz) => apply3(PLANTED, xyz));
	const got = solveFromPatches(patches);

	// Recovered up to the scale the convention fixes, so the test is that it is
	// one scalar multiple of what was planted -- every entry sharing a single
	// ratio -- and that the scale it chose is the conventional one.
	const ratios = PLANTED.map((v, i) => (Math.abs(v) > 1e-6 ? got.colorMatrix[i] / v : null))
		.filter((v) => v !== null);
	const spread = Math.max(...ratios) - Math.min(...ratios);
	assert('ColorMatrix1 comes back as the one that was planted, to a scale',
		spread < 1e-9, 'entry ratios spread by ' + spread.toExponential(2));
	const wp = apply3(got.colorMatrix, [0.9642, 1.0, 0.8249]);
	assert('and scaled the way every real one is: D50 white peaks at 1',
		Math.abs(Math.max(...wp.map(Math.abs)) - 1) < 1e-9,
		'peak ' + Math.max(...wp.map(Math.abs)).toFixed(6));

	// The white balance is read off the neutral row, with each grey's own
	// published tint taken out -- the chart's white is b* +2.9, and a balance
	// that made it grey used to land 0.7% off the planted gains. Now it has to
	// land on the planted response to a true white.
	const wb = apply3(PLANTED, [0.9642, 1.0, 0.8249]);
	assert('and the white balance is the planted response to a true white',
		Math.abs(got.neutral[0] - wb[0] / wb[1]) < 1e-6 &&
		Math.abs(got.neutral[2] - wb[2] / wb[1]) < 1e-6,
		`${got.neutral.map((v) => v.toFixed(6))} vs ${[wb[0] / wb[1], 1, wb[2] / wb[1]].map((v) => v.toFixed(6))}`);

	assert('the live matrix keeps a neutral neutral', [0, 1, 2].every((r) => {
		const sum = got.ccm[r * 3] + got.ccm[r * 3 + 1] + got.ccm[r * 3 + 2];
		return Math.abs(sum - 1) < 1e-9;
	}), JSON.stringify(got.ccm.map((v) => +v.toFixed(4))));

	// A camera that IS a 3x3 away from the reference, noiselessly, has an exact
	// answer. The previous solver missed it -- 1.16 mean and 2.51 worst ΔE2000
	// on this same plant -- and not because of how it fitted: its balance was
	// read off greys that are not grey, and its reference was the chart's
	// 8-bit, gamut-clipped sRGB. This one scores 0.008 and 0.021.
	assert('and a noiseless chart fits to nothing',
		got.fit.meanDeltaE < 0.05 && got.fit.maxDeltaE < 0.15,
		`mean ΔE2000 ${got.fit.meanDeltaE.toFixed(3)}, max ${got.fit.maxDeltaE.toFixed(3)}`);

	// What the live matrix undoes is the planted camera, balanced: identity
	// through both, up to the one exposure scale.
	const XYZ50_TO_SRGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415,
		0.0334540, 0.0719453, -0.2289914, 1.4052427];
	const bal = patches.map((p) => [p[0] / got.neutral[0], p[1], p[2] / got.neutral[2]]);
	const worstRel = Math.max(...bal.map((b, i) => {
		const out = apply3(got.ccm, b).map((v) => v * got.fit.exposure);
		const want = apply3(XYZ50_TO_SRGB, CHART_XYZ50[i]);
		return Math.max(...out.map((v, c) => Math.abs(v - want[c])));
	}));
	assert('so the live matrix maps every balanced patch onto its reference',
		worstRel < 2e-3, 'worst linear error ' + worstRel.toExponential(2));

	// Where the fit itself matters is a camera that is NOT a 3x3 away: here
	// each patch is off by up to 3% per channel. Held at rows of one while it
	// minimises ΔE2000, the matrix must do at least as well on the mean as
	// fitting in linear RGB and normalising afterwards -- 0.926 against 0.985
	// on this seed. It minimises the squares, so its worst patch may be the
	// worse of the two (2.82 against 2.62 here), which is why only the mean is
	// asserted.
	{
		const { scoreCcm, inv3 } = await import('../src/calibrate.js');
		let seed = 7;
		const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
		const noisy = CHART_XYZ50.map((x) => apply3(PLANTED, x).map((v) => v * (1 + 0.06 * rnd())));
		const fitN = solveFromPatches(noisy);
		const balN = noisy.map((p) => [p[0] / fitN.neutral[0], p[1], p[2] / fitN.neutral[2]]);
		const S = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.0334540,
			0.0719453, -0.2289914, 1.4052427];
		const tg = CHART_XYZ50.map((x) => apply3(S, x));
		const YXt = new Array(9).fill(0), XXt = new Array(9).fill(0);
		for (let n = 0; n < 24; n++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
			YXt[r * 3 + c] += tg[n][r] * balN[n][c]; XXt[r * 3 + c] += balN[n][r] * balN[n][c];
		}
		const I = inv3(XXt), L = [];
		for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
			let v = 0;
			for (let k = 0; k < 3; k++) v += YXt[r * 3 + k] * I[k * 3 + c];
			L.push(v);
		}
		for (let r = 0; r < 3; r++) {
			const sum = L[r * 3] + L[r * 3 + 1] + L[r * 3 + 2];
			for (let c = 0; c < 3; c++) L[r * 3 + c] /= sum;
		}
		const other = scoreCcm(L, balN);
		assert('on a camera that is not a 3x3, the ΔE2000 fit beats fit-then-normalise on the mean',
			fitN.fit.meanDeltaE < other.meanDeltaE,
			`${fitN.fit.meanDeltaE.toFixed(3)} vs ${other.meanDeltaE.toFixed(3)}`);
	}

	// A white that clipped is a measurement of the ADC. Clip it hard in one
	// channel and say so: the balance must not move.
	const clippedPatches = patches.map((p, i) => (i === 18 ? [p[0], p[1], p[1] * 0.2] : p));
	const clipFrac = patches.map((_, i) => (i === 18 ? 0.4 : 0));
	const withClip = solveFromPatches(clippedPatches, { clipped: clipFrac });
	assert('a clipped white is left out of the balance, not averaged in',
		Math.abs(withClip.neutral[2] - got.neutral[2]) < 1e-3,
		`${withClip.neutral[2].toFixed(4)} vs ${got.neutral[2].toFixed(4)}`);
	check('and out of the fit', withClip.fit.patches, 23);

	// Seven unknowns need more than seven patches. With most of the chart
	// clipped the fit is not determined -- it can report nothing wrong about a
	// matrix it was asked nothing about -- and that is refused, not answered.
	let under = '';
	try {
		solveFromPatches(patches, { clipped: patches.map((_, i) => ([0, 1, 2, 3, 18, 19, 20].includes(i) ? 0 : 1)) });
	} catch (e) { under = e.message; }
	assert('a chart with too few usable patches is refused', /only 7 of the chart/.test(under), under);

	// A temperature given is the light, for the matrix as well as the label:
	// the camera's own matrices say D65 here, and 3000 K was given.
	const told = solveFromPatches(patches, {
		cct: 3000, colorMatrices: [{ matrix: PLANTED, illuminant: 17 }, { matrix: PLANTED, illuminant: 21 }],
	});
	const { planckXy } = await import('../src/calibrate.js');
	const [lx, ly] = planckXy(3000);
	const resp = apply3(told.colorMatrix, [lx / ly, 1, (1 - lx - ly) / ly]);
	assert('a given temperature is the one the matrix is fitted to',
		told.light.cct === 3000 && Math.abs(Math.max(...resp.map(Math.abs)) - 1) < 1e-9,
		`light ${told.light.cct} K, response to its white ${resp.map((v) => v.toFixed(3))}`);

	let refused = '';
	try { solveFromPatches(patches.slice(0, 23)); } catch (e) { refused = e.message; }
	assert('a short measurement is refused rather than fitted', /24 patches/.test(refused), refused);
	refused = '';
	try { solveFromPatches(patches.map((p, i) => (i === 3 ? [NaN, 1, 1] : p))); }
	catch (e) { refused = e.message; }
	assert('and so is one with a patch that is not a number',
		/three finite numbers/.test(refused), refused);

	check('the chart is 24 patches', CHART_SRGB.length, 24);

	// CIEDE2000 against the 34 pairs Sharma, Wu and Dalal published with their
	// implementation notes, to their four decimals. Pairs 7-16 are the ones
	// that catch the hue-mean and zero-chroma special cases.
	const { deltaE2000, cctFromXy, illuminantFromNeutral } = await import('../src/calibrate.js');
	const SHARMA = [
		[50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425], [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
		[50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412], [50, -1.3802, -84.2814, 50, 0, -82.7485, 1],
		[50, -1.1848, -84.8006, 50, 0, -82.7485, 1], [50, -0.9009, -85.5211, 50, 0, -82.7485, 1],
		[50, 0, 0, 50, -1, 2, 2.3669], [50, -1, 2, 50, 0, 0, 2.3669],
		[50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792], [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
		[50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195], [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
		[50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045], [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
		[50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461], [50, 2.5, 0, 50, 0, -2.5, 4.3065],
		[50, 2.5, 0, 73, 25, -18, 27.1492], [50, 2.5, 0, 61, -5, 29, 22.8977],
		[50, 2.5, 0, 56, -27, -3, 31.903], [50, 2.5, 0, 58, 24, 15, 19.4535],
		[50, 2.5, 0, 50, 3.1736, 0.5854, 1], [50, 2.5, 0, 50, 3.2972, 0, 1],
		[50, 2.5, 0, 50, 1.8634, 0.5757, 1], [50, 2.5, 0, 50, 3.2592, 0.335, 1],
		[60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
		[63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
		[61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
		[35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
		[22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
		[36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
		[90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
		[90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
		[6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
		[2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
	];
	const sharmaWorst = Math.max(...SHARMA.map((r) =>
		Math.abs(deltaE2000(r.slice(0, 3), r.slice(3, 6)) - r[6])));
	assert('ΔE2000 reproduces all 34 of Sharma\'s test pairs',
		sharmaWorst < 1e-4, 'worst ' + sharmaWorst.toExponential(2));

	// Named illuminants, whose CCTs are known: D65 6504 K, D50 5003 K,
	// illuminant A 2856 K. D65 and D50 sit above the locus, A on it.
	const d65 = cctFromXy(0.31271, 0.32902), d50 = cctFromXy(0.34567, 0.35850);
	const illA = cctFromXy(0.44757, 0.40745);
	assert('CCT names D65, D50 and A to within 0.5%',
		Math.abs(d65.cct / 6504 - 1) < 5e-3 && Math.abs(d50.cct / 5003 - 1) < 5e-3 &&
		Math.abs(illA.cct / 2856 - 1) < 5e-3,
		`${d65.cct.toFixed(0)} / ${d50.cct.toFixed(0)} / ${illA.cct.toFixed(0)}`);
	assert('and says which side of the locus', d65.duv > 0.002 && Math.abs(illA.duv) < 1e-3,
		`Duv ${d65.duv.toFixed(4)} / ${illA.duv.toFixed(4)}`);

	// The DNG procedure, with a camera whose two matrices are the same one:
	// the light a neutral names is then that matrix's inverse, directly.
	const neutralD65 = apply3(PLANTED, [0.95047, 1, 1.08883]);
	const named = illuminantFromNeutral(neutralD65,
		[{ matrix: PLANTED, illuminant: 17 }, { matrix: PLANTED, illuminant: 21 }]);
	assert('a neutral seen under D65 is named D65 by the camera\'s own matrices',
		named && Math.abs(named.cct / 6504 - 1) < 5e-3,
		named ? named.cct.toFixed(0) + ' K' : 'nothing');

	// Corners on an axis-aligned rectangle: the grid is then arithmetic anyone
	// can check by hand.
	const centres = patchCentres([[0, 0], [600, 0], [600, 400], [0, 400]]);
	check('24 centres', centres.length, 24);
	assert('the first patch sits half a cell in from the top-left corner',
		Math.abs(centres[0].x - 50) < 1e-6 && Math.abs(centres[0].y - 50) < 1e-6,
		`${centres[0].x}, ${centres[0].y}`);
	assert('and the last half a cell in from the bottom-right',
		Math.abs(centres[23].x - 550) < 1e-6 && Math.abs(centres[23].y - 350) < 1e-6,
		`${centres[23].x}, ${centres[23].y}`);

	// A chart photographed at an angle: the far edge is shorter, so a blend
	// would drift and a homography does not. The top edge here is half the
	// length of the bottom one.
	const skew = patchCentres([[150, 0], [450, 0], [600, 400], [0, 400]]);
	const topRun = skew[5].x - skew[0].x, bottomRun = skew[23].x - skew[18].x;
	assert('a tilted chart keeps its patches inside their cells',
		topRun > 0 && bottomRun > topRun * 1.6,
		`top row spans ${topRun.toFixed(1)}, bottom ${bottomRun.toFixed(1)}`);
}

console.log('\na chart beside a blown-out window is still a chart');
{
	/*
	 * A clipped area has no noise at all: every neighbourhood in it has a
	 * local range of exactly zero. Once that is a tenth of the frame the
	 * 10th-percentile noise estimate lands on zero, the flatness threshold
	 * collapses to one count, every patch's ordinary noise exceeds it, and the
	 * chart vanishes. Here the right 45% of the frame is saturated.
	 */
	const { makeChartFrame } = await import('./make-chart.mjs');
	const truth = [[40, 90], [330, 90], [330, 300], [40, 300]];
	const e = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
	e.open(makeChartFrame({ corners: truth, saturated: [350, 0, 290, 480] }).bytes);
	const ch = e.detectChart();
	assert('a chart beside a clipped region is found', !!ch && ch.cells === 24,
		ch ? ch.cells + ' cells' : 'nothing');
}

console.log('\na chart on a textured wall is still a chart');
{
	/*
	 * tests/chart-on-wood.dng is a real 768x576 crop off a Hi3516EV300 + IMX335:
	 * a 24-patch chart on a shelf against pine boards. Most of the frame is
	 * wood grain, not flat surface, and the detector's noise estimate was the
	 * median local range -- which here was the grain. The dark patches merged
	 * into the chart's grey surround and it reported nothing. The corners
	 * below were placed by hand on the frame, and the detector has to land
	 * within 6 px of them.
	 */
	const e = await instantiate(readFileSync(new URL('../dist/engine.wasm', import.meta.url)));
	const info = e.open(new Uint8Array(readFileSync(new URL('../tests/chart-on-wood.dng', import.meta.url))));
	const ch = e.detectChart({ cfa: info.cfa });
	assert('a chart on a wood wall is found', !!ch && ch.cells >= 18, ch ? ch.cells + ' cells' : 'nothing');
	const hand = [[192.4, 203.4], [577.5, 185.2], [594.2, 443.1], [208.4, 468.8]];
	const err = ch ? Math.max(...ch.corners.map((p, i) => Math.hypot(p[0] - hand[i][0], p[1] - hand[i][1]))) : Infinity;
	assert('where it actually is', err < 6, err.toFixed(1) + ' px from the hand-placed corners');
}

console.log('\nthe camera profile: its AWB curve, its matrices, and a new set built from lights');
{
	const P = await import('../src/iqprofile.js');
	// imx335's own calibration, as its sensor driver hands it to the ISP and as
	// a Hi3516EV300 exported it back.
	const SWB = [0x1E3, 0x100, 0x100, 0x1D1];
	const CURVE = [-0x12, 0x10B, -0x7, 0x2711F, 0x80, -0x1A5C1];
	// What that chip's CalGainByTemp answered at shift 0 (CT, R, G, B), read
	// over the vendor tuning protocol. The low end is the gain normalisation
	// (R held at 256, G raised); the high end is the library's hard clamp.
	const ORACLE = [[1500, 256, 415, 1024], [2000, 256, 294, 1024], [2250, 256, 261, 989],
		[2500, 277, 256, 859], [3000, 330, 256, 705], [4000, 417, 256, 543],
		[4750, 472, 256, 476], [5000, 487, 256, 460], [6500, 568, 256, 387],
		[8000, 630, 256, 347], [9000, 640, 256, 325], [12000, 640, 256, 291],
		[15000, 640, 256, 269]];
	const miss = ORACLE.filter(([ct, R, G, B]) => {
		const g = P.gainsForCt(ct, SWB, CURVE);
		return g[0] !== R || g[1] !== G || g[3] !== B;
	});
	assert('the AWB curve answers exactly what the chip answered, clamps and all',
		!miss.length, miss.map((m) => m[0] + ' K').join(', ') || 'all 13');
	assert('and the reference temperature is where it passes through the static WB',
		Math.abs(P.refCtOf(CURVE) - 4917) < 1, P.refCtOf(CURVE).toFixed(1));

	// The sign-magnitude matrix encoding, including a row whose rounding would
	// leave it off 256 and a zero that must not come out as negative zero.
	check('sign-magnitude: -168/256 is 32936', P.encodeCcmValue(-168 / 256), 32936);
	check('and back', P.decodeCcmValue(32936), -168 / 256);
	check('a negative zero is written as plain zero', P.encodeCcmValue(-0.0001), 0);
	// Row 0 rounds to 333 - 38 - 38 = 257 if each value is rounded alone.
	const enc = P.encodeCcm([1.3, -0.15, -0.15, -0.3011, 1.3907, -0.0896,
		-0.0042, -0.7703, 1.7745]);
	const rowSums = [0, 1, 2].map((r) => enc.slice(r * 3, r * 3 + 3)
		.reduce((a, v) => a + (v & 0x8000 ? -(v & 0x7fff) : v), 0));
	check('every encoded row sums to exactly 256', rowSums, [256, 256, 256]);

	// Reading a profile the camera exported: the whole colour half comes back.
	const exported = [
		'[static_awb]', 'AutoStaticWb              = "483, 256, 256, 465"',
		'AutoCurvePara             = "-18, 267, -7, 160031, 128, -107969"',
		'[static_ccm]', 'TotalNum                  = "3"',
		'AutoColorTemp             = "4900, 3850, 2650, 2100, 1600, 1400, 1000"',
		'AutoCCMTable_0            = "452, 32952, 32780, 32845, 356, 32791, 32769, 32965, 454"',
		'AutoCCMTable_1            = "448, 32939, 32789, 32833, 356, 32803, 32769, 32986, 475"',
		'AutoCCMTable_2            = "408, 32890, 32798, 32854, 381, 32807, 32769, 33112, 600"',
	].join('\n');
	const v = P.readColour(P.parseIni(exported));
	assert('an exported profile reads back as the camera\'s calibration',
		v.staticWb.join() === SWB.join() && v.curve.join() === CURVE.join() &&
		v.ccm.length === 3 && v.ccm[2].ct === 2650 && Math.abs(v.ccm[0].matrix[1] + 184 / 256) < 1e-9,
		JSON.stringify({ wb: v.staticWb, tables: v.ccm && v.ccm.map((t) => t.ct) }));

	// A curve fitted to lights measured on a camera that is NOT the one whose
	// curve it starts from. The lights here are an imx307's (its shipped
	// profile's curve), the starting point imx335's. The chip's own integer
	// arithmetic is itself up to 3.7 LSB off the continuous curve, so a fit is
	// held to 6 LSB -- two of those steps -- at the lights and across 2500 to
	// 8000 K.
	const TRUE = { staticWb: [451, 256, 256, 468], curve: [-37, 293, 0, 179537, 128, -123691] };
	const seen = (ct) => {
		const [p1, p2, q1, a1, , c1] = TRUE.curve;
		const x = 256 * (256e6 / ct - c1) / a1, X = x * x;
		const Y = (p1 * X + p2 * 65536) / (q1 + X / 256);
		return { ct, r: 2 ** 24 / X * TRUE.staticWb[0] / 65536, b: 2 ** 24 / Y * TRUE.staticWb[3] / 65536 };
	};
	for (const cts of [[6500, 2800], [7500, 6500, 5000, 4000, 3000, 2600]]) {
		const f = P.fitAwbCurve(cts.map(seen), { staticWb: SWB, curve: CURVE });
		const atLights = Math.max(...f.at.map((q) => Math.max(Math.abs(q.r - q.wantR),
			Math.abs(q.b - q.wantB)) * 256));
		let across = 0;
		for (let ct = 2500; ct <= 8000; ct += 250) {
			const a = P.gainsForCt(ct, f.staticWb, f.curve, { normalise: false });
			const b = P.gainsForCt(ct, TRUE.staticWb, TRUE.curve, { normalise: false });
			across = Math.max(across, Math.abs(a[0] - b[0]), Math.abs(a[3] - b[3]));
		}
		assert(`${cts.length} lights fit the other camera's curve`,
			atLights <= 6 && across <= 6 && f.curve[4] === 128 &&
			f.curve[0] + f.curve[1] === f.curve[2] + 256,
			`${atLights.toFixed(1)} LSB at the lights, ${across} across; ${f.curve}`);
	}
	// And a camera measured against its own curve gets its own curve back.
	const own = (ct) => {
		const [p1, p2, q1, a1, , c1] = CURVE;
		const x = 256 * (256e6 / ct - c1) / a1, X = x * x;
		const Y = (p1 * X + p2 * 65536) / (q1 + X / 256);
		return { ct, r: 2 ** 24 / X * SWB[0] / 65536, b: 2 ** 24 / Y * SWB[3] / 65536 };
	};
	const back = P.fitAwbCurve([6500, 2800].map(own), { staticWb: SWB, curve: CURVE });
	check('two lights on the camera\'s own curve give that curve back',
		[back.staticWb, back.curve].join('|'), [SWB, CURVE].join('|'));

	// The profile: measured matrices, the vendor's where nothing was measured,
	// never two within 600 K of each other, hottest first.
	const tables = P.mergeCcmTables([{ ct: 6400, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
		{ ct: 2750, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }], v.ccm);
	check('measured lights and the vendor\'s in between',
		tables.map((t) => `${t.ct}:${t.source}`).join(' '),
		'6400:measured 4900:vendor 3850:vendor 2750:measured');
	const frag = P.colourFragment({ staticWb: SWB, curve: CURVE, tables });
	const again = P.readColour(P.parseIni(frag));
	assert('and the fragment it writes reads back as what went in',
		again.ccm.length === 4 && again.ccm[1].ct === 4900 && again.curve.join() === CURVE.join(),
		frag.split('\n').slice(4, 12).join(' / '));
	let few = '';
	try { P.mergeCcmTables([{ ct: 5000, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] }], v.ccm.slice(0, 1)); }
	catch (e) { few = e.message; }
	assert('fewer than three matrices is refused, as the camera would', /at least three/.test(few), few);

	// Lights whose colour does not move with their temperature the way light
	// does -- the same balance at two temperatures, or redder at the hotter
	// one -- are a mistyped temperature, and a curve through them would
	// divide by a slope of zero or come out upside down.
	const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	const refuse = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
	const a = own(6500), b = own(2800);
	check('the same balance at two temperatures is refused',
		/does not change with temperature/.test(refuse(() =>
			P.fitAwbCurve([a, { ...a, ct: 2800 }], { staticWb: SWB, curve: CURVE }))), true);
	check('and so is a balance that goes the wrong way',
		/does not change with temperature/.test(refuse(() =>
			P.fitAwbCurve([{ ...a, ct: 2800 }, { ...b, ct: 6500 }], { staticWb: SWB, curve: CURVE }))), true);
	check('two lights at one temperature are refused',
		/within 300 K/.test(refuse(() =>
			P.fitAwbCurve([a, { ...b, ct: 6400 }], { staticWb: SWB, curve: CURVE }))), true);

	// Every measured matrix reaches the profile, however many vendor ones
	// there are; the vendor's only fill what is left.
	const seven = [7500, 6500, 5500, 4500, 3800, 3200, 2600].map((ct) => ({ ct, matrix: I3 }));
	const full = P.mergeCcmTables(seven, [{ ct: 10000, matrix: I3 }, { ct: 2000, matrix: I3 }, ...v.ccm]);
	check('seven measured lights are seven measured matrices',
		full.map((t) => t.source).join(), Array(7).fill('measured').join());
	check('an eighth light is refused rather than one silently dropped',
		/at most 7/.test(refuse(() => P.mergeCcmTables(
			seven.concat([{ ct: 2100, matrix: I3 }]), v.ccm))), true);

	// A profile that does not read cleanly is not built on.
	const bad = (text) => P.readColour(P.parseIni(text));
	check('NaN in the white balance is no white balance',
		bad('[static_awb]\nAutoStaticWb = "483, NaN, 256, 465"\n').staticWb, null);
	check('a table count of zero is no tables',
		bad('[static_ccm]\nTotalNum = "0"\nAutoColorTemp = "4900"\n').ccm, null);
	check('fewer temperatures than tables is no tables',
		bad(exported.replace('"4900, 3850, 2650, 2100, 1600, 1400, 1000"', '"4900, 3850"')).ccm, null);
	check('temperatures that do not fall are no tables',
		bad(exported.replace('"4900, 3850, 2650, 2100, 1600, 1400, 1000"', '"2650, 3850, 4900"')).ccm, null);
}

console.log('\n16-bit raw opens, which a whole class of camera emits');
{
	/*
	 * The older HiSilicon parts write BitsPerSample 16, uncompressed -- one
	 * little-endian sample per two bytes, no packing. The engine handled 8,
	 * 10, 12 and 14 and refused these outright with "unsupported bit depth",
	 * so every camera in that class was unopenable. Found by pointing the
	 * editor at a hi3518ev200.
	 */
	const { makeDng } = await import('./make-dng.mjs');
	const W = 64, H = 64;
	const px = new Uint16Array(W * H);
	// A ramp, so a byte-order mistake shows up as noise rather than passing.
	for (let i = 0; i < px.length; i++) px[i] = 8000 + (i % 11) * 300;
	px[33 * W + 20] = 60000;
	const bytes = makeDng({ width: W, height: H, pixels: px, bits: 16, black: 0, white: 65535 });
	const info = engine.open(bytes);
	check('the depth is read as 16', info.bits, 16);
	check('and the dimensions survive', [info.width, info.height], [W, H]);

	// Byte order is the thing most easily got wrong here, and a swapped pair
	// still produces a plausible-looking frame. The planted value is chosen so
	// that reading it big-endian gives something wildly different.
	const dev = engine.diagnose({ sigmas: 6 });
	assert('the planted hot pixel is found at the right place',
		dev.defects.some((p) => p.x === 20 && p.y === 33),
		JSON.stringify(dev.defects.slice(0, 3)));
	assert('and nothing else is', dev.defectCount === 1, String(dev.defectCount));
	assert('values come back in range, not byte-swapped',
		dev.blackFloor.every((v) => v >= 7000 && v <= 12000),
		dev.blackFloor.map((v) => v.toFixed(0)).join(' / '));
}

console.log('\nthe defect scan reports its own trustworthiness');
{
	// The fixture is a 256x256 crop, so these are shape checks rather than
	// checks on a defect population. What is being tested is that the extra
	// reporting is computed and internally consistent, not what it says about
	// one small frame.
	engine.open(readFileSync(new URL('../tests/fixture.dng', import.meta.url)));
	const d = engine.diagnose();

	check('the deviation histogram has EMVA’s 256 bins', d.deviation.counts.length, 256);
	assert('it counts nearly every pixel that has four same-colour neighbours',
		d.deviation.total > 0.9 * 252 * 252 && d.deviation.total <= 256 * 256,
		`${d.deviation.total} of ~${252 * 252}`);
	assert('its bin width comes from the noise, not the extremes', d.deviation.binWidth > 0,
		String(d.deviation.binWidth));
	/*
	 * The distribution has to be centred and roughly symmetric, or the
	 * Gaussian overlay drawn against it is meaningless. A pixel is as likely
	 * to sit above its neighbours as below.
	 */
	const mid = 128, lo = d.deviation.counts.slice(0, mid).reduce((a, b) => a + b, 0);
	const hi = d.deviation.counts.slice(mid).reduce((a, b) => a + b, 0);
	assert('and the deviations are balanced about zero, as noise is',
		Math.abs(lo - hi) < 0.2 * d.deviation.total, `${lo} below, ${hi} above`);
	assert('the spatial sigma is positive and of the order of the noise',
		d.deviation.sigma > 0 && d.deviation.sigma < 200, String(d.deviation.sigma));

	// The gate must actually restrict, and must be reported so a reader knows
	// a restricted scan when they see one.
	const gated = engine.diagnose({ backgroundPercentile: 25 });
	assert('asking for only the darker parts finds no more than the whole frame did',
		gated.defectCount <= d.defectCount, `${gated.defectCount} vs ${d.defectCount}`);
	assert('and it says where it looked', gated.backgroundCut > 0, String(gated.backgroundCut));
	assert('while the unrestricted scan says it looked everywhere',
		!d.backgroundCut, String(d.backgroundCut));
}

console.log('\nand says how the defects it found are arranged');
{
	/*
	 * Clark-Evans on frames built to have a known arrangement. This is the
	 * check that matters: the index is what tells an operator whether a scan
	 * found silicon or scenery, and it is worthless if it cannot tell a
	 * scattered set from a clumped one.
	 *
	 * The implementation is exercised through a synthetic frame rather than a
	 * photograph, so the expected answer is known before the engine runs.
	 */
	const { makeDefectFrame } = await import('./make-defects.mjs');

	engine.open(makeDefectFrame({ mode: 'scattered', n: 120, seed: 3 }).bytes);
	const scattered = engine.diagnose({ sigmas: 6 });
	assert('a scattered set reports an index near 1',
		scattered.spread && Math.abs(scattered.spread.index - 1) < 0.25,
		scattered.spread ? `R = ${scattered.spread.index.toFixed(3)} over ${scattered.spread.over}`
			: '(no index)');

	engine.open(makeDefectFrame({ mode: 'clustered', n: 120, seed: 3 }).bytes);
	const clustered = engine.diagnose({ sigmas: 6 });
	assert('a clumped set reports one well below 1',
		clustered.spread && clustered.spread.index < 0.7,
		clustered.spread ? `R = ${clustered.spread.index.toFixed(3)} over ${clustered.spread.over}`
			: '(no index)');
	assert('and the two are not merely different, but the right way round',
		scattered.spread && clustered.spread &&
		scattered.spread.index > clustered.spread.index + 0.3,
		`scattered ${scattered.spread?.index.toFixed(3)}, clustered ${clustered.spread?.index.toFixed(3)}`);

	// Too few points to say anything is reported as nothing, not as a number.
	engine.open(makeDefectFrame({ mode: 'scattered', n: 1, seed: 9 }).bytes);
	const sparse = engine.diagnose({ sigmas: 6 });
	assert('fewer than three defects gives no index rather than a meaningless one',
		sparse.spread === null || sparse.spread.over >= 3,
		JSON.stringify(sparse.spread));

	/*
	 * A cap on how many defects are kept must not change the verdict.
	 *
	 * The store fills in raster order, so what it keeps when it overflows is
	 * every defect down to some row and none below -- a census of the top of
	 * the frame. Divide that by the whole frame and the density comes out too
	 * low, the expected nearest-neighbour distance too high, and R too small:
	 * the run below read 0.420 against the same frame's 1.016 uncapped, and
	 * anything under 0.8 is reported to the operator as "these are following
	 * the picture". A scan that ran out of room was accusing them of
	 * photographing furniture.
	 *
	 * maxDefects is dropped rather than the frame made huge, because the
	 * arithmetic is the same either way and a 512x512 frame keeps the suite
	 * quick. The frame is opened again for the second reading: open() is the
	 * only thing that resets the bump allocator.
	 */
	const many = () => makeDefectFrame({ mode: 'scattered', n: 400, seed: 11 }).bytes;
	engine.open(many());
	const whole = engine.diagnose({ sigmas: 6 });
	engine.open(many());
	const capped = engine.diagnose({ sigmas: 6, maxDefects: 64 });
	assert('a cap that bites is reported as one',
		capped.truncated && capped.spread && capped.spread.over === 64,
		`truncated ${capped.truncated}, over ${capped.spread?.over}`);
	assert('and a capped scan still calls a scattered set scattered',
		capped.spread && Math.abs(capped.spread.index - 1) < 0.3,
		`R = ${capped.spread?.index.toFixed(3)} over ${capped.spread?.over} ` +
			`of ${capped.defectCount}`);
	assert('reading the same frame with and without the cap agrees',
		whole.spread && capped.spread &&
		Math.abs(whole.spread.index - capped.spread.index) < 0.25,
		`uncapped ${whole.spread?.index.toFixed(3)}, capped ${capped.spread?.index.toFixed(3)}`);
}

console.log('\nand how bright the frame it read was');
{
	/*
	 * The median of each plane, which is what says whether the lens was
	 * covered. Nothing else in the reading does: the black floor is the 0.1st
	 * percentile and is near black in any frame with a shadow in it.
	 *
	 * Checked against a frame built at a known level, and then against the
	 * real fixture, whose scene is a warm lamp on a card -- amber, so red sits
	 * well above blue and neither is near the floor.
	 */
	const { makeDefectFrame } = await import('./make-defects.mjs');
	engine.open(makeDefectFrame({ mode: 'scattered', n: 20, level: 300, seed: 5 }).bytes);
	const flat = engine.diagnose({ sigmas: 6 });
	assert('a frame built at a known level reads back at it',
		flat.median.every((v) => Math.abs(v - 300) <= 2),
		flat.median.join(' / '));

	engine.open(readFileSync(new URL('../tests/fixture.dng', import.meta.url)));
	const real = engine.diagnose();
	check('the fixture reads the level measured off it', real.median, [152, 152, 79]);
	assert('which is well clear of the black level the file declares',
		real.median.every((v) => v > 50),
		`black 50, medians ${real.median.join(' / ')}`);
}

console.log('\nthe chart is found where it was drawn');
{
	// A real photograph cannot test this: the chart's corners there are
	// wherever they are, to within however well anyone can click. So the
	// frames below are drawn through a homography and compared against the
	// corners that drew them.
	const { makeChartFrame } = await import('./make-chart.mjs');
	// Twice the area of a chart cell, and every case below beats it by a
	// wide margin -- the tolerance is here so noise cannot make the suite
	// flap, not because the answers are near it.
	const TOL = 3;
	const area = (c) => {
		let a = 0;
		for (let i = 0; i < 4; i++) { const p = c[i], q = c[(i + 1) % 4]; a += p[0] * q[1] - q[0] * p[1]; }
		return a;
	};
	const cases = [
		['square', [[120, 90], [520, 90], [520, 380], [120, 380]]],
		['tilted', [[120, 90], [520, 110], [500, 380], [140, 360]]],
		['in perspective', [[150, 60], [540, 120], [470, 420], [100, 330]]],
		['small in frame', [[300, 200], [460, 205], [458, 320], [298, 315]]],
		// Turned end for end: the lattice is identical, and only the grey
		// ramp says which way up it is.
		['upside down', [[520, 380], [120, 380], [120, 90], [520, 90]]],
		// On its side, so the six columns run down the frame rather than
		// across it. This is the case that makes the search swap its two
		// steps, and a swap reverses the handedness of the basis -- see the
		// winding check below, which is what this case exists to exercise.
		['on its side', [[400, 60], [400, 420], [200, 420], [200, 60]]],
	];
	for (const [name, truth] of cases) {
		engine.open(makeChartFrame({ corners: truth }).bytes);
		const got = engine.detectChart();
		if (!got) { assert(`a chart ${name} is found`, false); continue; }
		let worst = 0;
		for (let i = 0; i < 4; i++)
			worst = Math.max(worst, Math.hypot(got.corners[i][0] - truth[i][0],
				got.corners[i][1] - truth[i][1]));
		check(`a chart ${name} gives all 24 cells`, got.cells, 24);
		assert(`and its corners land where it was drawn`, worst < TOL,
			`worst corner off by ${worst.toFixed(1)} px`);
		/*
		 * The corners must wind the same way the chart does.
		 *
		 * This is not a detail of presentation. The lattice search takes its
		 * two steps from whichever neighbours it tried, so the basis can come
		 * out left-handed, and the corners then describe the chart MIRRORED --
		 * which a camera cannot see of something flat. Nothing downstream can
		 * catch it: the quad still lands on the chart to the pixel, and the
		 * solver is handed twenty-four plausible colours numbered from the
		 * wrong corner. Only the winding says so.
		 */
		assert(`and wind the same way round as the chart`,
			Math.sign(area(got.corners)) === Math.sign(area(truth)),
			`chart ${area(truth) > 0 ? '+' : '-'}, detected ${area(got.corners) > 0 ? '+' : '-'}`);
	}

	// Saying "no chart" is half the job: a detector that answers every frame
	// would hand the solver a lattice fitted to the furniture.
	for (const f of ['fixture.dng', 'hostile-model.dng']) {
		engine.open(readFileSync(new URL(`../tests/${f}`, import.meta.url)));
		assert(`${f} has no chart in it, and none is reported`, engine.detectChart() === null);
	}
}

console.log('\nhostile metadata stays data');
const hostile = engine.open(readFileSync(new URL('../tests/hostile-model.dng', import.meta.url)));
check('the model is carried through verbatim', hostile.model, '<img src=x onerror="window.__pwned=1">');
check('and the frame still reads correctly', [hostile.width, hostile.cfaName, hostile.black], [256, 'RGGB', 50]);

console.log('\nfocus statistics: the grid a person focuses a lens by');
{
	const A = await import('../src/aftune.js');

	// A grid is a plain array of six-field zones, row-major.
	const zone = (o = {}) => ({ h1: 0, h2: 0, v1: 0, v2: 0, y: 1000, hlcnt: 0, ...o });
	const grid = (rows, cols, f) => Array.from({ length: rows * cols }, (_, i) => f(i));

	// The blend is the camera's own integer arithmetic, not a tidier float one:
	// the page and the ISP must not be able to disagree about where the peak is.
	check('the blend is the chip\'s: (h2*54 + v2*10) >> 6',
		A.blend(zone({ h2: 640, v2: 64 })), (640 * 54 + 64 * 10) >> 6);
	check('and it is integer throughout', Number.isInteger(A.blend(zone({ h2: 7, v2: 3 }))), true);
	// `>>` would coerce this to signed 32-bit and hand back a negative focus
	// value -- which does not just read wrong, it sorts below every real zone
	// and takes normalise() under the zero it promises. A camera's u16 fields
	// cannot reach here; the JSON they arrive in can.
	{
		const huge = zone({ h2: 2 ** 26 });
		check('a sum past 2^31 does not wrap negative', A.blend(huge), (2 ** 26) * 54 / 64);
		assert('which the shift operator would have', (((2 ** 26) * 54) >> 6) < 0);
	}

	// Numbers, or nothing. A NaN propagates as a zone neither brighter nor
	// darker than any other and a negative sits under every real one.
	for (const bad of [{ h2: NaN }, { y: -1 }, { hlcnt: '4' }]) {
		let refused = false;
		try { A.summarise(grid(1, 1, () => zone(bad)), 1, 1); } catch { refused = true; }
		assert(`a zone carrying ${JSON.stringify(bad)} is refused`, refused);
	}

	// A pinned counter is the fault here that looks like a good result: large,
	// steady, and unable to move. Measured on an 85H50AI, a bank whose own sum
	// moved 2.6x across a defocus sweep reported a spread of 1/1.0, because its
	// peak zone sat on 65535 at both ends.
	{
		const at = A.summarise(grid(1, 2, (i) => zone({ h2: i ? 100 : A.ZONE_CEILING })), 1, 2);
		check('a zone at the top of the counter is counted', at.saturated, 1);
		assert('and the peak sitting there is called out', at.peakSaturated);

		// Reported, not subtracted. Dropping the pinned zone would hand back
		// some lower zone's value as though it were the peak.
		check('the pinned zone is still the peak', at.peak, A.blend(zone({ h2: A.ZONE_CEILING })));

		const below = A.summarise(grid(1, 2, (i) => zone({ h2: i ? 100 : A.ZONE_CEILING - 1 })), 1, 2);
		check('one short of the ceiling is not saturated', below.saturated, 0);
		assert('nor is its peak', !below.peakSaturated);

		// v2 shares the blend with h2, so it pins the value just as hard.
		const vert = A.summarise(grid(1, 1, () => zone({ v2: A.ZONE_CEILING })), 1, 1);
		check('v2 at the ceiling counts too', vert.saturated, 1);

		// h1 and v1 belong to the other bank and never reach the reported value.
		const other = A.summarise(grid(1, 1, () => zone({ h1: A.ZONE_CEILING, v1: A.ZONE_CEILING })), 1, 1);
		check('the other bank at its ceiling does not', other.saturated, 0);

		// Peak selection keeps the first strict maximum, so a pinned zone can
		// tie with an unpinned one and lose -- these two both blend to 55295.
		// Reading the flag off the winning index alone would let grid order
		// decide whether the sweep is trustworthy.
		{
			const lo = zone({ h2: A.ZONE_CEILING - 1, v2: 5 });
			const hi = zone({ h2: A.ZONE_CEILING, v2: 0 });
			check('the tie is a real one', A.blend(lo), A.blend(hi));
			const tied = A.summarise([lo, hi], 1, 2);
			assert('a pinned zone tied at the peak still condemns it', tied.peakSaturated);
			// ...and in the order where it wins outright, which is the easy case.
			assert('whichever way round they sit', A.summarise([hi, lo], 1, 2).peakSaturated);
		}

		// A saturated zone that is too dark to believe is not the peak, so the
		// sweep has nothing to distrust.
		const dark = A.summarise(grid(1, 2, (i) => (i
			? zone({ h2: 100 })
			: zone({ y: 0, h2: A.ZONE_CEILING }))), 1, 2);
		assert('a pinned zone that was never measured does not condemn the peak',
			!dark.peakSaturated);
	}

	// 255 coloured cells show that there is a bright patch somewhere and say
	// nothing about what anything reads. Reduced for display only -- this must
	// not be able to move where the peak actually is.
	{
		// A 2x4 grid, sharp down the right-hand side.
		const s = A.summarise(grid(2, 4, (i) => zone({ h2: (i % 4) >= 2 ? 800 : 100 })), 2, 4);
		const c = A.coarsen(s, 2);
		check('two blocks across', c.cols, 2);
		check('and two down', c.rows, 2);
		check('the sharp side reads higher',
			c.blocks[1].value > c.blocks[0].value, true);
		check('the best block is on that side', c.blocks[c.best].col, 1);

		// The mean, not the sum: 15 rows across 3 blocks divides evenly but 17
		// columns does not, and a sum would rank the wider block higher for
		// being wider.
		const even = A.summarise(grid(1, 5, () => zone({ h2: 640 })), 1, 5);
		const cc = A.coarsen(even, 2);
		check('blocks of different widths still compare',
			cc.blocks[0].value, cc.blocks[1].value);

		// A block with nothing believable in it has no value. Zero is a value,
		// and it sorts below every real block as though it had been measured.
		const dark = A.summarise(grid(1, 2, (i) => (i
			? zone({ h2: 800 }) : zone({ y: 0, h2: 800 }))), 1, 2);
		check('an unmeasurable block is null, not zero', A.coarsen(dark, 2).blocks[0].value, null);

		// More blocks than zones would hand back empty cells reported as
		// "nothing measurable", which is a different claim entirely.
		check('more blocks than zones is capped', A.coarsen(even, 99).cols, 5);
		let refused = false;
		try { A.coarsen(even, 0); } catch { refused = true; }
		assert('a zero block count is refused', refused);
	}

	// A blank wall, a patch of sky, a smooth door: all report a small focus
	// value wherever the lens is, because there is no detail there to measure.
	// Shown as a bare small number it reads as "this part is soft", and the
	// operator chases focus that was never the problem. Reported on the very
	// first calibration: "на 9 квадрате не нашлось резких объектов и ему
	// маленькую цифру дали".
	{
		const hold = A.peakHold();
		const frame = (a, b) => A.summarise([zone({ h2: a }), zone({ h2: b })], 1, 2);
		// Nothing has moved yet. "We have not looked" and "there is nothing
		// there" are different answers and only one is the operator's problem.
		let h = hold.push(frame(900, 500));
		check('before the lens moves, nothing is claimed', A.zoneDetail(h), ['unknown', 'unknown']);

		// Zone 0 responds as the lens sweeps; zone 1 never budges.
		h = hold.push(frame(200, 500));
		h = hold.push(frame(1400, 502));
		const d = A.zoneDetail(h);
		check('a zone that responded has something in it', d[0], 'some');
		check('a zone that never moved has not', d[1], 'none');

		// And it travels into the readable grid.
		const s = A.summarise([zone({ h2: 1400 }), zone({ h2: 502 })], 1, 2);
		const c = A.coarsen(s, 2, { detail: d });
		check('the block carries it', [c.blocks[0].detail, c.blocks[1].detail], ['some', 'none']);

		// One textured corner is enough to focus on, so a block is only called
		// empty when every zone in it that could be measured agrees.
		const wide = A.summarise([zone({ h2: 1400 }), zone({ h2: 502 })], 1, 2);
		check('a block with one textured zone is not empty',
			A.coarsen(wide, 1, { detail: d }).blocks[0].detail, 'some');

		// Anything that is not one of the two real answers is "not looked at
		// yet", not "nothing there". Read the other way round, a detail array
		// that did not line up captioned every block on an unswept frame.
		check('a short detail array leaves blocks unknown',
			A.coarsen(s, 2, { detail: [] }).blocks[0].detail, 'unknown');
		check('and so does no array at all', A.coarsen(s, 2).blocks[0].detail, 'unknown');

		// A lit zone reading zero at every position is the emptiest zone there
		// is. null is "never measured" and stays unknown; zero is a READING,
		// and skipping it left the block most in need of the caption without
		// one.
		{
			const h2 = A.peakHold();
			const z = (a, b) => A.summarise([zone({ h2: a }), zone({ h2: b })], 1, 2);
			h2.push(z(0, 900));
			h2.push(z(0, 200));
			const dz = A.zoneDetail(h2.push(z(0, 1500)));
			check('a zone that reads zero throughout is empty, not unknown', dz[0], 'none');
			check('while the one that moved is not', dz[1], 'some');
		}

		// The held record belongs to a SHAPE. Two grids of the same size and
		// different shape put the same index somewhere else in the picture,
		// and the overall range has to go with it -- it is the gate deciding
		// whether the lens moved at all.
		{
			const h3 = A.peakHold();
			const wide = A.summarise(grid(1, 4, (i) => zone({ h2: i ? 100 : 900 })), 1, 4);
			const tall = A.summarise(grid(2, 2, (i) => zone({ h2: i ? 100 : 900 })), 2, 2);
			h3.push(wide);
			h3.push(A.summarise(grid(1, 4, () => zone({ h2: 100 })), 1, 4));
			assert('the lens has visibly moved on the old shape',
				A.zoneDetail(h3.push(wide)).some((d) => d !== 'unknown'));
			// Same zone count, different shape: the record cannot carry over.
			check('a reshaped grid starts the record again',
				A.zoneDetail(h3.push(tall)), ['unknown', 'unknown', 'unknown', 'unknown']);
		}

		// An empty block can never be the sharpest: it has nothing in it that
		// focus could sharpen, and naming it points the operator at the one
		// part of the frame that can never answer.
		const s2 = A.summarise([zone({ h2: 300 }), zone({ h2: 900 })], 1, 2);
		const c2 = A.coarsen(s2, 2, { detail: ['some', 'none'] });
		check('an empty block is never the sharpest', c2.best, 0);
		// ...unless nothing has detail, when the alternative is naming none.
		check('but with nothing to go on the plain maximum stands',
			A.coarsen(s2, 2, { detail: ['none', 'none'] }).best, 1);
	}

	// Dirt on the dome focuses a few millimetres away, so across a sweep it
	// peaks nowhere near where the picture does -- which is exactly what drags
	// a cheap autofocus onto the glass. Invisible on a live image; unmistakable
	// across a sweep.
	{
		// Five positions, four zones. Three agree that focus is at position 3;
		// zone 1 peaks at position 0 and is at some quite different distance.
		const curve = (peak) => [0, 1, 2, 3, 4].map((p) => 1000 - Math.abs(p - peak) * 240);
		const scene = [curve(3), curve(0), curve(3), curve(3)];
		const frames = [0, 1, 2, 3, 4].map((p) => ({
			fv: scene.map((c) => c[p]),
			state: scene.map(() => 'measured'),
			sat: scene.map(() => false),
			rows: 1, cols: 4,
		}));
		const r = A.sweepZones(frames);
		check('the scene agrees where focus is', r.consensus, 3);
		check('and the odd one out is named', r.suspect, [1]);

		// A zone that never moves has an argmax and it is noise. Asking it
		// where it focuses gets an answer indistinguishable from a real one.
		const flat = frames.map((f) => ({ ...f, fv: [...f.fv.slice(0, 3), 500] }));
		const rf = A.sweepZones(flat);
		check('a zone that never moved is not accused', rf.suspect.includes(3), false);
		check('and is not counted as having an opinion', rf.peakAt[3], null);

		// How far out is "far" is measured against how tightly the scene agrees,
		// not against the number of readings. A hand that slows down through
		// focus piles most readings there and spreads the normal zones out in
		// index; a threshold set as a fixed fraction of the count then either
		// goes blind or starts flagging the scene itself.
		{
			// Seven zones that all peak within a frame or two of each other,
			// plus one far away -- across MANY readings, so a fixed 30%-of-count
			// threshold (here ~11 frames) would miss an outlier 6 frames out.
			const n = 38;
			const tight = (pk) => Array.from({ length: n }, (_, p) => 1000 - Math.abs(p - pk) * 60);
			const zs = [18, 19, 18, 20, 18, 19, 18, 25].map(tight);
			const fr = Array.from({ length: n }, (_, p) => ({
				fv: zs.map((c) => Math.max(10, c[p])),
				state: zs.map(() => 'measured'),
				sat: zs.map(() => false), rows: 1, cols: 8,
			}));
			const rr = A.sweepZones(fr);
			check('a tight scene makes a modest outlier visible', rr.suspect, [7]);
		}

		// ...but a scene that genuinely disagrees is not turned into outliers.
		{
			const n = 38;
			const spread = [6, 12, 18, 24, 30, 14, 22, 16].map(
				(pk) => Array.from({ length: n }, (_, p) => 1000 - Math.abs(p - pk) * 60));
			const fr = Array.from({ length: n }, (_, p) => ({
				fv: spread.map((c) => Math.max(10, c[p])),
				state: spread.map(() => 'measured'),
				sat: spread.map(() => false), rows: 1, cols: 8,
			}));
			assert('a scene spread over many distances is not all outliers',
				A.sweepZones(fr).suspect.length <= 2);
		}

		// Median, not mean: one smeared corner at the far end would drag a mean
		// toward itself and then judge everything else against it.
		const smear = [curve(4), curve(4), curve(0), curve(4), curve(4)];
		const rs = A.sweepZones([0, 1, 2, 3, 4].map((p) => ({
			fv: smear.map((c) => c[p]), state: smear.map(() => 'measured'),
			sat: smear.map(() => false), rows: 1, cols: 5 })));
		check('the consensus is the median', rs.consensus, 4);

		let short = false;
		try { A.sweepZones([{ fv: [1], state: ['measured'] }]); } catch { short = true; }
		assert('a sweep too short to have a shape is refused', short);

		// A clamped zone plateaus, so the FIRST ceiling reading wins its
		// argmax -- and where the counter filled up is not where the lens was
		// sharpest. Judged on that, the zone gets accused of focusing
		// somewhere else on the strength of an artefact. `state` cannot carry
		// this: a pinned zone is still perfectly well exposed.
		{
			const pin = [0, 1, 2, 3, 4].map((p) => ({
				fv: scene.map((c) => c[p]),
				state: scene.map(() => 'measured'),
				// zone 1 is the outlier; say its counter was full throughout
				sat: [false, true, false, false],
				rows: 1, cols: 4,
			}));
			const rp = A.sweepZones(pin);
			check('a clamped zone is given no peak position', rp.peakAt[1], null);
			check('so it is not accused of focusing elsewhere', rp.suspect, []);
			// ...and the rest of the frame still has its say.
			check('while the others still agree', rp.consensus, 3);
		}

		// A lit zone whose response is zero at every position was measured and
		// found empty, which is not the same as not being readable.
		{
			const zero = [0, 1, 2, 3, 4].map((p) => ({
				fv: [0, curve(3)[p], curve(3)[p], curve(3)[p]],
				state: Array(4).fill('measured'),
				sat: Array(4).fill(false), rows: 1, cols: 4,
			}));
			const rz = A.sweepZones(zero);
			check('a measured zero zone is flat, not unmeasured', rz.why[0], 'flat');
			check('and it is counted as such', rz.flat, 1);
		}

		// Two grids of the same SIZE and different shape put the same index in
		// a different part of the picture, and a ring over the wrong zone is
		// worse than no ring.
		{
			const one = (r, c) => ({ fv: [1, 2, 3, 4], state: Array(4).fill('measured'),
				sat: Array(4).fill(false), rows: r, cols: c });
			let reshaped = false;
			try { A.sweepZones([one(1, 4), one(2, 2), one(1, 4)]); } catch { reshaped = true; }
			assert('a grid that changed shape mid-sweep is refused', reshaped);
		}

		// The finding travels with the shape it was measured on, so a consumer
		// cannot place it by some later grid's width.
		check('a finding carries its own shape', [r.rows, r.cols], [1, 4]);
	}

	// A grid whose length disagrees with its shape would still draw -- shifted,
	// every zone in the wrong place. Refused rather than rendered.
	let threw = false;
	try { A.summarise(grid(2, 3, () => zone()), 3, 3); } catch { threw = true; }
	assert('a grid that disagrees with its shape is refused', threw);

	// And the count alone does not establish the shape: each of these satisfies
	// `rows * cols === zones.length` and then divides the frame into cells that
	// are empty, fractional or off-screen.
	for (const [r, c, n] of [[0, 0, 0], [1.5, 2, 3], [-1, -3, 3], [NaN, 1, 0]]) {
		let refused = false;
		try { A.summarise(grid(1, n, () => zone()), r, c); } catch { refused = true; }
		assert(`a ${r} x ${c} grid is refused`, refused);
	}

	// Dark, blown and simply-soft all report a small focus value, and drawing
	// them alike tells the operator to chase focus that was never the problem.
	{
		const g = grid(3, 3, (i) => {
			if (i === 0) return zone({ y: 1, h2: 10 });            // unlit
			if (i === 1) return zone({ y: 1000, h2: 9999, hlcnt: 40 }); // blown, but "sharp"
			return zone({ y: 1000, h2: 100 + i });
		});
		const s = A.summarise(g, 3, 3);
		check('a dark zone reads unlit, not soft', s.state[0], 'unlit');
		check('a blown zone reads clipped', s.state[1], 'clipped');
		check('and the rest are measured', s.measured, 7);
		// The blown zone has by far the largest response. If the peak followed
		// the raw maximum it would sit on a specular highlight and the operator
		// would focus on a reflection.
		assert('the peak ignores the clipped zone that outscores everything',
			s.peakAt.index !== 1, `peak at ${s.peakAt.index}`);
		check('the peak is the sharpest MEASURED zone', s.peakAt.index, 8);
	}

	// Focusing by hand sweeps through the peak, and it is gone by the time a
	// person looks up from the lens.
	{
		const hold = A.peakHold();
		hold.push(A.summarise(grid(1, 2, (i) => zone({ h2: i ? 100 : 400 })), 1, 2));
		const r = hold.push(A.summarise(grid(1, 2, (i) => zone({ h2: i ? 900 : 200 })), 1, 2));
		check('peak-hold keeps the best each zone ever showed',
			r.best, [A.blend(zone({ h2: 400 })), A.blend(zone({ h2: 900 }))]);
		check('and the best overall', r.bestOverall, A.blend(zone({ h2: 900 })));
		hold.reset();
		const after = hold.push(A.summarise(grid(1, 2, () => zone({ h2: 5 })), 1, 2));
		check('reset forgets it, because a held peak from another scene is a lie',
			after.bestOverall, A.blend(zone({ h2: 5 })));
	}

	// The reason the current-frame peak skips clipped zones applies twice over
	// to a held one: a highlight's response would become that zone's permanent
	// record, still standing long after the highlight moved off.
	{
		const hold = A.peakHold();
		const bogus = (i) => (i === 0
			? zone({ h2: 9999, hlcnt: 40 })     // blown, and "sharpest" on the grid
			: zone({ h2: 100 }));
		hold.push(A.summarise(grid(1, 2, bogus), 1, 2));
		const r = hold.push(A.summarise(grid(1, 2, (i) => zone({ h2: i ? 100 : 300 })), 1, 2));
		check('a clipped zone\'s response is not held against it once it measures',
			r.best[0], A.blend(zone({ h2: 300 })));

		const dark = A.peakHold();
		const d = dark.push(A.summarise(grid(1, 2, (i) => (i ? zone({ h2: 100 }) : zone({ y: 0, h2: 8000 }))), 1, 2));
		check('nor an unlit one\'s', d.best[0], null);
		check('and a zone that has never measured holds null, because 0 is a reading',
			d.best.map((v) => v === null), [true, false]);
	}

	// Normalising each frame to its own maximum makes every frame look equally
	// sharp -- brightest at the peak and just as bright far from it, which is
	// exactly the information the operator came for.
	{
		const s = A.summarise(grid(1, 2, (i) => zone({ h2: i ? 200 : 100 })), 1, 2);
		const ceiling = A.blend(zone({ h2: 800 }));
		const n = A.normalise(s, ceiling);
		assert('against a held ceiling, a soft frame reads soft', n[1] < 0.3, n[1].toFixed(2));
		const own = A.normalise(s);
		check('against its own maximum it would read perfectly sharp', own[1], 1);
	}

	// A zone that measured nothing has no value to draw, and 0 is a value.
	{
		const s = A.summarise(grid(1, 2, (i) => (i ? zone({ h2: 300 }) : zone({ y: 0 }))), 1, 2);
		check('an unmeasured zone normalises to null, not zero', A.normalise(s)[0], null);
	}
}

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
