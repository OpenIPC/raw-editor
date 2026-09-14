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

	// The white balance is not fitted; it is read off the neutral row, so it is
	// an independent check on the same data. Close but not equal on purpose:
	// the chart's neutral patches are not exactly neutral -- white is published
	// as 243,243,242 and the 5 step as 122,122,121 -- so their mean ratio
	// cannot land exactly on the response to D50 white, and a tolerance that
	// demanded it would be testing the chart rather than the code.
	const wb = apply3(PLANTED, [0.9642, 1.0, 0.8249]);
	assert('and the white balance matches the planted response to D50 white',
		Math.abs(got.neutral[0] - wb[0] / wb[1]) < 5e-3 &&
		Math.abs(got.neutral[2] - wb[2] / wb[1]) < 5e-3,
		`${got.neutral.map((v) => v.toFixed(4))} vs ${[wb[0] / wb[1], 1, wb[2] / wb[1]].map((v) => v.toFixed(4))}`);

	assert('the live matrix keeps a neutral neutral', [0, 1, 2].every((r) => {
		const sum = got.ccm[r * 3] + got.ccm[r * 3 + 1] + got.ccm[r * 3 + 2];
		return Math.abs(sum - 1) < 1e-9;
	}), JSON.stringify(got.ccm.map((v) => +v.toFixed(4))));

	// Noiseless input through an exactly-recovered matrix: the residual is the
	// chart's own non-linearity against a 3x3, not the solver's error.
	assert('and the fit it reports is the fit it achieved',
		got.fit.meanDeltaE < 3 && got.fit.maxDeltaE < 12,
		`mean dE ${got.fit.meanDeltaE.toFixed(2)}, max ${got.fit.maxDeltaE.toFixed(2)}`);

	let refused = '';
	try { solveFromPatches(patches.slice(0, 23)); } catch (e) { refused = e.message; }
	assert('a short measurement is refused rather than fitted', /24 patches/.test(refused), refused);
	refused = '';
	try { solveFromPatches(patches.map((p, i) => (i === 3 ? [NaN, 1, 1] : p))); }
	catch (e) { refused = e.message; }
	assert('and so is one with a patch that is not a number',
		/three finite numbers/.test(refused), refused);

	check('the chart is 24 patches', CHART_SRGB.length, 24);

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

console.log('\nhostile metadata stays data');
const hostile = engine.open(readFileSync(new URL('../tests/hostile-model.dng', import.meta.url)));
check('the model is carried through verbatim', hostile.model, '<img src=x onerror="window.__pwned=1">');
check('and the frame still reads correctly', [hostile.width, hostile.cfaName, hostile.black], [256, 'RGGB', 50]);

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
