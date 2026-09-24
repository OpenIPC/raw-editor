/*
 * The studio.
 *
 * Mounts into a bare element and owns everything inside it: markup, styles and
 * the worker. The host page supplies a root and a frame; it knows nothing about
 * what goes on in here, which is what lets the whole editor live on a CDN while
 * the camera ships only a loader.
 *
 * Only controls the engine can actually honour are built. A knob that moves and
 * changes nothing is worse than an absent one, so white balance is exposed as
 * the red and blue gains the engine really applies rather than as a
 * temperature/tint pair it has no model for yet.
 */

import { solveFromPatches, patchCentres, scoreCcm, CHART_COLS, CHART_ROWS } from './calibrate.js';
import { parseIni, readColour, fitAwbCurve, gainsForCt, mergeCcmTables, colourFragment } from './iqprofile.js';
import { summarise, peakHold, normalise } from './aftune.js';

const CFA_NAMES = ['RGGB', 'GRBG', 'GBRG', 'BGGR'];
const DEMOSAIC = [
	['None', 0, 'the mosaic as recorded'],
	['Bilinear', 1, 'average the neighbours'],
	['Gradient', 2, 'Malvar-He-Cutler: bilinear, corrected by the curvature of ' +
		'the plane that was actually measured. Removes most of the colour on edges.'],
	['RCD', 3, 'Ratio-corrected: decides at each site whether the detail runs across ' +
		'or down, interpolates green along it, and carries red and blue as differences ' +
		'against that green. The closest of the four, and the only one that needs a ' +
		'pass over the whole frame first.'],
];

/*
 * While a control is moving, develop at a reduced scale: a 2592x1520 frame
 * costs ~180 ms at full size and ~11 ms at a quarter, and 180 ms is not a
 * live slider.
 *
 * The step is chosen from the frame and the stage rather than fixed, because
 * a fixed quarter turns a 256px crop into a 64px thumbnail. Steps move in
 * whole Bayer quads, so a preview keeps the CFA phase.
 */
const MAX_STEP = 4;
function fitStep(width, stageWidth) {
	if (!stageWidth) return 1;
	const s = Math.floor(width / Math.max(320, stageWidth));
	return Math.min(MAX_STEP, Math.max(1, s - (s % 2)));
}

const svg = (d, w = 20) =>
	`<svg viewBox="0 0 20 20" width="${w}" height="${w}" fill="none" stroke="currentColor" ` +
	`stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
	back: svg('<path d="M12.2 4.5 6.7 10l5.5 5.5"/>', 18),
	reset: svg('<path d="M4.2 10a5.8 5.8 0 1 0 1.9-4.3"/><path d="M3.4 3.6v3.9h3.9"/>', 13),
	warn: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
		'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
		'<path d="M12 4.6 21.2 19.4H2.8z"/><path d="M12 10.2v4"/><path d="M12 17.1h.01"/></svg>',
	shutter: svg('<circle cx="10" cy="10" r="6.4"/><path d="M10 3.6 13.2 9"/>' +
		'<path d="M16.1 12.6H9.8"/><path d="M6.8 15.6 10 10"/>', 15),
	save: svg('<path d="M10 3.4v8.4"/><path d="M6.6 8.6 10 12l3.4-3.4"/>' +
		'<path d="M4 13.6v2.2h12v-2.2"/>', 15),
	dropper: svg('<path d="M4 16h2.2l7-7"/><path d="M11.4 7.4 12.9 6l1.1 1.1 1.4-1.4' +
		'a1.6 1.6 0 0 0-2.3-2.3l-1.4 1.4L10.6 3.7 9.2 5.1z"/>', 14),
};

/*
 * The module owns its stylesheet, not the host. One <link> is shared by every
 * mount on the page and goes away with the last of them; a host that would
 * rather bundle the CSS itself passes styles: false.
 */
let sheetEl = null, sheetRefs = 0, sheetReady = null;
/*
 * The stylesheet, and a promise for when it has actually arrived.
 *
 * It comes from the same CDN as the module and is fetched by a <link> this
 * function appends, which means the browser has already painted the page by
 * the time it starts. Build the interface straight away and the operator gets
 * a second or two of unstyled markup first -- browser-default buttons at
 * browser-default size, spilling down the page -- and then the studio. So
 * callers wait on this before revealing anything.
 *
 * It resolves rather than rejects when the sheet fails: a stylesheet that will
 * not load is not a reason to show nothing at all, and the interface is still
 * usable, if ugly. What it must never do is hang, so there is a deadline.
 */
function acquireStylesheet(base, timeoutMs) {
	if (!sheetEl) {
		sheetEl = document.createElement('link');
		sheetEl.rel = 'stylesheet';
		sheetEl.href = new URL('editor.css', new URL(base, location.href)).href;
		sheetEl.dataset.rawEditor = '';
		sheetReady = new Promise((resolve) => {
			let done = false;
			const settle = () => { if (!done) { done = true; resolve(); } };
			sheetEl.addEventListener('load', settle);
			sheetEl.addEventListener('error', settle);
			setTimeout(settle, timeoutMs);
		});
		document.head.append(sheetEl);
		sheetRefs = 0;
	}
	sheetRefs++;
	return sheetReady;
}
function releaseStylesheet() {
	if (--sheetRefs > 0) return;
	sheetEl?.remove();
	sheetEl = null;
	sheetReady = null;
	sheetRefs = 0;
	bootStyleEl?.remove();
	bootStyleEl = null;
}

/*
 * The few rules the splash needs, injected rather than linked.
 *
 * They cannot live in editor.css: the whole point is to have something to
 * look at while editor.css is still in flight. A <style> element created here
 * applies the moment it is appended, with no network in the way.
 */
let bootStyleEl = null;
function acquireBootStyles() {
	if (bootStyleEl) return;
	bootStyleEl = document.createElement('style');
	bootStyleEl.dataset.rawEditorBoot = '';
	bootStyleEl.textContent =
		'@keyframes re-spin{to{transform:rotate(360deg)}}' +
		'.re-spinner{width:22px;height:22px;border-radius:50%;' +
		'border:2px solid rgba(255,255,255,.16);border-top-color:#5c70e8;' +
		'animation:re-spin .8s linear infinite}' +
		'@media (prefers-reduced-motion:reduce){.re-spinner{animation-duration:2.4s}}';
	document.head.append(bootStyleEl);
}

const el = (tag, cls, html) => {
	const n = document.createElement(tag);
	if (cls) n.className = cls;
	if (html !== undefined) n.innerHTML = html;
	return n;
};

/* A labelled slider with a detent at the frame's own value. */
class Row {
	constructor(name, { min, max, step = 1, value, fmt = (v) => v, onInput, onCommit }) {
		this.origin = value;
		this.fmt = fmt;
		this.node = el('div', 're-row');
		this.node.innerHTML =
			`<span class="re-rname">${name}</span>` +
			'<span class="re-track"><span class="re-tbg"></span><span class="re-tick"></span>' +
			'<span class="re-fill"></span><input type="range"></span>' +
			'<span class="re-rnum"></span>' +
			`<button class="re-rst" title="Reset ${name}">${ICON.reset}</button>`;
		this.input = this.node.querySelector('input');
		Object.assign(this.input, { min, max, step, value });
		this.num = this.node.querySelector('.re-rnum');
		this.tick = this.node.querySelector('.re-tick');
		this.fillEl = this.node.querySelector('.re-fill');
		this.rst = this.node.querySelector('.re-rst');

		this.input.addEventListener('input', () => { this.sync(); onInput?.(this.value); });
		this.input.addEventListener('change', () => { this.sync(); onCommit?.(this.value); });
		this.rst.addEventListener('click', () => {
			this.input.value = this.origin; this.sync(); onCommit?.(this.value);
		});
		this.sync();
	}
	get value() { return +this.input.value; }
	set value(v) { this.input.value = v; this.sync(); }
	pct(v) {
		const lo = +this.input.min, hi = +this.input.max;
		return hi === lo ? 0 : ((v - lo) / (hi - lo)) * 100;
	}
	sync() {
		const a = this.pct(this.origin), b = this.pct(this.value);
		this.tick.style.left = a + '%';
		this.fillEl.style.left = Math.min(a, b) + '%';
		this.fillEl.style.width = Math.abs(b - a) + '%';
		this.num.textContent = this.fmt(this.value);
		this.rst.disabled = this.value === this.origin;
	}
}

function segmented(items, active, onPick, { wide = true, tight = true } = {}) {
	const n = el('span', 're-seg' + (wide ? ' re-wide' : '') + (tight ? ' re-tight' : ''));
	items.forEach((it, i) => {
		const b = el('button', i === active ? 'on' : '', it.label);
		if (it.disabled) b.disabled = true;
		if (it.title) b.title = it.title;
		b.addEventListener('click', () => {
			if (b.disabled) return;
			[...n.children].forEach((c) => c.classList.remove('on'));
			b.classList.add('on');
			onPick(it.value, i);
		});
		n.append(b);
	});
	return n;
}

function histogramSVG(h) {
	const W = 300, H = 94, n = 256;
	const path = (bins, colour) => {
		let max = 0;
		for (let i = 0; i < n; i++) max = Math.max(max, bins[i]);
		if (!max) return '';
		// Square root, because a raw histogram is dominated by one or two bins
		// and a linear plot then shows a spike and nothing else.
		const pts = [];
		for (let i = 0; i < n; i++)
			pts.push(`${((i * W) / (n - 1)).toFixed(1)},${(H - Math.sqrt(bins[i] / max) * H).toFixed(1)}`);
		return `<polygon points="0,${H} ${pts.join(' ')} ${W},${H}" fill="${colour}" opacity=".55"/>`;
	};
	return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
		path(h.b, '#3b6fd8') + path(h.g, '#2fb673') + path(h.r, '#d8503b') + '</svg>';
}

export function mountEditor(root, {
	base = './', onExit, styles = true,
	/* Where a frame comes from when nobody dragged one in. An async function
	 * returning { bytes, name }; the editor shows its own Capture button only
	 * when it is given one, so a host with nothing to capture from -- a plain
	 * file viewer -- gets no button that cannot work. */
	capture,
	/* Whether to ask for that frame on its own, rather than waiting to be
	 * told. On by default: a host that mounts the editor with somewhere to
	 * capture from has said what it wants a frame for, and making the
	 * operator press a button first is a step that answers itself.
	 *
	 * It begins at mount, before the worker has booted, so the transfer
	 * overlaps the module and wasm still arriving. The cost of starting that
	 * early is that a host which mounts WITH a capture provider and then opens
	 * a frame of its own has already paid for one it will not use -- the
	 * editor stands down, but the bytes were fetched. Such a host should pass
	 * false; so should one whose capture is expensive or has side effects. */
	autoCapture = true,
	/* How a solved matrix reaches the camera, and how it is taken back:
	 * { apply({colorMatrix, ccm, neutral}), revert(), keep(), holdSeconds }.
	 * Without one, Calibrate still measures and solves -- the numbers are
	 * useful on their own -- and simply offers nothing to write them with.
	 *
	 * keep() is how the host learns the operator confirmed, and it is not
	 * optional politeness: a host that arms anything to undo the change -- a
	 * timer, an unload handler -- has no other way to know it must stand down,
	 * and would take back a calibration that was deliberately kept.
	 *
	 * Two more make a calibration a camera keeps across lights rather than a
	 * matrix for one: baseline() resolves to the camera's own profile text
	 * (the colour sections it runs today), and persist(ini) writes the colour
	 * sections given into the camera's profile. revert() and keep() then
	 * answer for whichever was written last. */
	calibrate,
	/* Live focus statistics: { zones(), intervalMs }. zones() resolves to the
	 * camera's AF grid -- { rows, cols, zones: [[h1,h2,v1,v2,y,hlcnt], ...] },
	 * row-major. Without one there is no Focus tab at all, because a focus
	 * display with nothing to display is worse than none.
	 *
	 * Reading is the whole of it unless the host also supplies `move(verb)`,
	 * where verb is 'near' | 'far' | 'stop'. With one, the panel grows a pair of
	 * hold-to-run buttons; without one it does not, because a focus control on a
	 * camera with no motor is a button that can only ever do nothing.
	 *
	 * `move` is the only part of this capability that writes, and it needs no
	 * countdown even so: a lens that went the wrong way is put back by holding
	 * the other button, and the grid says which way was right. `moveRepeatMs`
	 * is how often a held button re-sends, and must be shorter than whatever
	 * deadline the host's motor stops itself on; `moveMaxMs` is how long a hold
	 * may last before this side gives up on it regardless.
	 *
	 * A host that can also TUNE the filters supplies four more:
	 * { filters(), applyFilters(f), revertFilters(), keepFilters(f),
	 *   holdSeconds }. `filters()` resolves to what the camera is running as
	 * { gain: [7], shift: [4], enable: [3], coring: [3] }; apply puts a set on
	 * the camera without saving it, revert takes it back, keep makes it
	 * survive a restart. Without them the panel reads and does not write.
	 *
	 * These DO get a countdown, unlike `move`, and for a reason the lens
	 * buttons do not have: a filter that measures the wrong thing looks like a
	 * camera that will not focus, so there is nothing on screen to tell an
	 * operator which change to undo. The clock undoes it for them. */
	focus,
	/* How long to wait for the module to arrive and answer. The camera's own
	 * loader gives the CDN eight seconds; a test harness under a virtual clock
	 * needs a number well above whatever budget the browser is running on. */
	/* Reading number plates: the detector and recogniser, and the camera's own
	 * exposure. Shaped like `calibrate` on purpose, because it is the same
	 * bargain -- something that measures, something that writes to the camera,
	 * and a way back:
	 *
	 *   { reader(), readerSupported, exposure: { plan, apply, revert, keep,
	 *     supports, armed, holdSeconds } }
	 *
	 * Without one the Plates tab is not built at all. With one whose
	 * `readerSupported` is false, or whose `reader()` rejects, the tab still
	 * measures what the frame can support and still meters the camera -- only
	 * the naming of characters goes away, and that is worth saying out loud
	 * rather than hiding the tab.
	 *
	 * The reader is handed a develop from THIS editor's engine, which is the
	 * whole reason the feature belongs in here rather than beside it: a plate
	 * is fifty pixels across and a hand-rolled bilinear demosaic costs most of
	 * what the recogniser has to work with.
	 *
	 * Not the canvas, though. What is on screen is developed at `step` -- 2 on
	 * any ordinary stage -- because a preview only has to fill the stage. That
	 * halves the plate to 26x7 and the read with it, measured: 0.30 where the
	 * same frame at step 1 reads 0.98. So Plates asks the engine for its own
	 * full-resolution develop and reads that, and the operator goes on looking
	 * at the cheap one. */
	plates,
	startupTimeoutMs = 15000,
	/* How long to wait for the host to hand over a frame before giving the
	 * stage back. Generous: a raw frame is several megabytes off a device with
	 * a slow uplink, and six to eight seconds is normal on the boards this was
	 * measured on. It bounds the wait rather than budgeting it. */
	captureTimeoutMs = 45000,
} = {}) {
	root.classList.add('re-root');
	root.innerHTML = '';

	/*
	 * Nothing is shown until it can be shown properly.
	 *
	 * .re-root is `position: fixed; inset: 0`, so without its stylesheet the
	 * chrome is not merely unstyled -- it is laid out as ordinary page flow,
	 * browser-default buttons stacked down over whatever is underneath. The
	 * interface is therefore built hidden and revealed in one go.
	 *
	 * visibility rather than display, because the layout has to settle while
	 * it is hidden: the canvas sizes itself from its container, and a stage
	 * measured at display:none comes out zero. visibility inherits, which is
	 * what lets the splash below opt itself back in with one declaration.
	 */
	let splash = null;
	const reveal = () => {
		root.style.visibility = '';
		splash?.remove();
		splash = null;
	};
	if (styles) {
		acquireBootStyles();
		root.style.visibility = 'hidden';
		splash = el('div');
		splash.dataset.act = 'splash';
		splash.style.cssText = 'visibility:visible;position:fixed;inset:0;z-index:9999;' +
			'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
			'gap:13px;background:#14161c;color:#878a94;' +
			"font:13px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
		splash.append(el('div', 're-spinner'),
			Object.assign(el('div'), { textContent: 'Loading the editor…' }));
		root.append(splash);
		// Reveal on the sheet, or on the deadline. The interface being ugly is
		// recoverable; the interface never appearing is not.
		acquireStylesheet(base, startupTimeoutMs).then(reveal);
	}

	const state = { info: null, probe: null, cfa: 0, demosaic: 3, black: 0, white: 1023,
		neutral: [1, 1, 1], gain: 1, fit: true, busy: false,
		/* The file exactly as it arrived. Developing happens on a copy inside
		 * the worker, so this is what Download must hand back -- re-encoding
		 * what is on the canvas would save a preview, not the raw frame. */
		bytes: null, name: null };

	/* Whether the host opened a frame of its own. The automatic first capture
	 * stands down for it, including mid-flight. */
	let hostOpened = false;

	/* ---- chrome ---- */
	const top = el('div', 're-top');
	const backBtn = el('button', 're-btn re-sm', ICON.back);
	backBtn.title = 'Back';
	const nameEl = el('span', '', 'No frame');
	nameEl.style.cssText = 'font-size:13px;font-weight:500';
	const sensorChip = el('span', 're-chip');
	sensorChip.hidden = true;
	const modeItems = [
		{ label: 'Develop', value: 'develop' },
		{ label: 'Diagnose', value: 'diagnose' },
		{ label: 'Calibrate', value: 'calibrate' },
	];
	// Not created and disabled: a tab that can never work is worse than no tab,
	// and a host reading the DOM should find only what is really on offer.
	if (plates) modeItems.push({ label: 'Plates', value: 'plates' });
	if (focus) modeItems.push({ label: 'Focus', value: 'focus' });
	const modeSeg = segmented(modeItems, 0, (v) => setMode(v), { wide: false });
	// Not created at all without a provider, rather than created and hidden: a
	// disabled-looking control that can never work is worse than none, and a
	// host reading the DOM should find only what is really on offer.
	const capBtn = capture ? el('button', 're-btn re-pri', ICON.shutter) : null;
	if (capBtn) {
		capBtn.dataset.act = 'capture';
		capBtn.append(Object.assign(el('span'), { textContent: 'Capture' }));
		capBtn.title = 'Take a raw frame from the camera';
	}
	const saveBtn = el('button', 're-btn', ICON.save);
	saveBtn.dataset.act = 'save';
	saveBtn.append(Object.assign(el('span'), { textContent: 'Download' }));
	saveBtn.title = 'Save this frame as a .dng file';
	saveBtn.disabled = true;
	top.append(backBtn, nameEl, sensorChip, el('span', 're-rule'), modeSeg,
		el('span', 're-rule'));
	if (capBtn) top.append(capBtn);
	top.append(saveBtn);
	if (onExit) backBtn.addEventListener('click', onExit); else backBtn.hidden = true;

	const stage = el('div', 're-stage re-fit');
	const canvas = el('canvas');
	canvas.hidden = true;
	const drop = el('div', 're-drop');
	/* Rebuilt rather than written once: a failure replaces the contents of the
	 * drop zone, and what it replaces them with still has to offer the way
	 * forward. */
	function emptyState(message) {
		const parts = [];
		if (message) {
			const box = el('div', 're-notice re-warn', ICON.warn);
			box.style.maxWidth = '520px';
			box.append(Object.assign(el('div'), { textContent: message }));
			parts.push(box);
		} else {
			parts.push(Object.assign(el('div'), {
				textContent: 'Drop a .dng here',
				style: 'font-size:14px',
			}));
		}
		if (capture) {
			const b = el('button', 're-btn re-pri', ICON.shutter);
			b.dataset.act = 'capture';
			b.append(Object.assign(el('span'), { textContent: 'Capture a frame' }));
			b.addEventListener('click', takeFrame);
			parts.push(b);
		} else if (!message) {
			parts.push(Object.assign(el('div', 're-note'),
				{ textContent: 'or open one from the camera' }));
		}
		drop.replaceChildren(...parts);
	}

	/* The same panel while a frame is on its way. A raw frame is several
	 * megabytes off a camera with a hundred of them to spare, so this is
	 * seconds, not milliseconds, and an empty stage with a button on it reads
	 * as "nothing is happening" rather than "wait". */
	function capturingState() {
		acquireBootStyles();
		drop.replaceChildren(
			el('div', 're-spinner'),
			Object.assign(el('div'), {
				textContent: 'Capturing a frame…',
				style: 'font-size:14px;color:#b9bec9',
			}),
			Object.assign(el('div', 're-note'), {
				textContent: 'A raw frame is several megabytes, so this takes a moment.',
			}));
	}
	const busy = el('div', 're-busy', 'working');
	busy.hidden = true;
	const hud = el('div', 're-hud');
	hud.hidden = true;
	const fitBtn = el('button', 'on', 'Fit');
	const oneBtn = el('button', '', '100%');
	hud.append(fitBtn, oneBtn);
	stage.append(drop, canvas, hud, busy);

	const insp = el('div', 're-insp');
	const foot = el('div', 're-foot');
	const mid = el('div', 're-mid');
	mid.append(stage, insp);
	root.append(top, mid, foot);

	/* ---- worker ---- */
	let worker = null, seq = 0, dead = null;
	const pending = new Map();
	// Startup is a promise nobody else holds, so abandonAll has to be able to
	// settle it too — otherwise closing the editor while it is still starting
	// leaves the opener waiting for the startup timeout instead of being told
	// the editor was closed.
	let abortStartup = null;

	/* Settle everything in flight. A worker that has died, or been terminated,
	 * will never answer, and a request left in the map is a caller waiting for
	 * ever. */
	function abandonAll(reason) {
		dead = dead || reason;
		for (const p of pending.values()) p.reject(new Error(reason));
		pending.clear();
		abortStartup?.(new Error(reason));
	}

	function startWorker() {
		// A Worker cannot be constructed from a cross-origin URL, so the source
		// is fetched as text and run from a blob — and because a blob URL has no
		// useful base, the real one is injected ahead of it.
		return new Promise((resolve, reject) => {
			const give_up = setTimeout(
				() => reject(new Error('the editor did not start within ' +
					Math.round(startupTimeoutMs / 1000) + ' seconds')),
				startupTimeoutMs);
			const settle = (fn, arg) => { clearTimeout(give_up); abortStartup = null; fn(arg); };
			abortStartup = (e) => settle(reject, e);

			(async () => {
				const abs = new URL(base, location.href).href;
				const res = await fetch(abs + 'worker.js');
				// An error page parses as neither a module nor an error, so
				// without this the worker simply never answers.
				if (!res.ok) throw new Error('worker.js: http ' + res.status);
				const src = await res.text();
				const blob = new Blob([`self.ENGINE_BASE=${JSON.stringify(abs)};\n${src}`],
					{ type: 'text/javascript' });
				worker = new Worker(URL.createObjectURL(blob), { type: 'module' });

				worker.onmessage = (ev) => {
					const m = ev.data;
					if (m.type === 'ready') return settle(resolve);
					if (m.type === 'fatal') {
						abandonAll(m.message);
						fail(m.message);
						return settle(reject, new Error(m.message));
					}
					const p = pending.get(m.id);
					if (!p) return;
					pending.delete(m.id);
					m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m);
				};
				const died = (e) => {
					const why = e?.message || 'the editor stopped unexpectedly';
					abandonAll(why);
					fail(why);
					settle(reject, new Error(why));
				};
				worker.onerror = died;
				worker.onmessageerror = () => died({ message: 'the editor sent something unreadable' });
			})().catch((e) => settle(reject, e));
		});
	}

	const call = (type, payload, transfer = []) => new Promise((resolve, reject) => {
		if (dead) return reject(new Error(dead));
		const id = ++seq;
		pending.set(id, { resolve, reject });
		worker.postMessage({ id, type, payload }, transfer);
	});

	function fail(message) {
		drop.hidden = false;
		canvas.hidden = true;
		emptyState(message);
	}

	/* Ask the host for a frame. The editor knows nothing about where it comes
	 * from -- a camera, a file picker, a fixture in a test -- only that it
	 * takes a moment and can fail. */
	async function takeFrame(automatic) {
		if (!capture || state.busy) return;
		state.busy = true;
		if (capBtn) capBtn.disabled = true;
		if (state.info) {
			// A frame is already on screen: leave it there and say so in the
			// corner, rather than blanking the stage for the duration.
			busy.textContent = 'capturing';
			busy.hidden = false;
		} else {
			// Nothing to look at yet, so the stage itself does the saying. The
			// corner chip stays down -- two labels for one wait reads as two
			// things happening.
			capturingState();
		}
		/*
		 * A capture that never answers.
		 *
		 * The host hands over a promise and nothing more, so there is no way
		 * to cancel the fetch behind it -- only to stop waiting. Without that,
		 * a stalled transfer leaves "Capturing a frame..." on screen for ever
		 * with no button to press: measured on a lab camera, a 4.9 MB frame
		 * that normally arrives in six seconds once took a hundred and forty.
		 *
		 * So the wait is bounded and the stage is handed back. The fetch is
		 * left running, because it may well finish -- and if it does, and
		 * nothing has been opened in the meantime, its frame is still the one
		 * that was asked for and is used.
		 */
		let timedOut = false;
		const deadline = new Promise((resolve) =>
			setTimeout(() => { timedOut = true; resolve(null); }, captureTimeoutMs));
		try {
			const inFlight = capture();
			// Whichever comes first. The capture is not cancelled by losing.
			const got = await Promise.race([inFlight, deadline]);
			if (timedOut) {
				const secs = Math.max(1, Math.round(captureTimeoutMs / 1000));
				fail('The camera has not sent a frame in ' + secs +
					(secs === 1 ? ' second.' : ' seconds.') +
					' It may still arrive on its own; otherwise try again.');
				// Still worth having if it lands, so long as nobody has opened
				// anything since.
				inFlight.then((late) => {
					if (late && !state.info && !hostOpened && !dead)
						openBytes(late.bytes, late.name).catch(() => {});
				}, () => {});
				return;
			}
			// Only now is the engine wanted. Whatever of the module and the
			// wasm was still arriving has had the whole transfer to get here.
			await ready;
			// A host that opened a frame of its own while this was in the air
			// wins: it asked for something specific, this did not.
			if (automatic && (hostOpened || dead)) return;
			await openBytes(got.bytes, got.name);
		} catch (e) {
			fail(e && e.message ? e.message : 'The frame could not be captured.');
		} finally {
			state.busy = false;
			if (capBtn) capBtn.disabled = false;
			busy.textContent = 'working';
			busy.hidden = true;
			/*
			 * Whatever happened, the stage must stop claiming to be capturing.
			 * Every path out of the try above used to be responsible for this
			 * and one of them was not: an automatic capture standing down for
			 * a frame the host had opened returned early, leaving the spinner
			 * and "Capturing a frame..." sitting on top of a picture that had
			 * loaded perfectly well. Restoring it here covers every exit.
			 */
			if (drop.querySelector('.re-spinner')) {
				if (state.info) { drop.hidden = true; emptyState(); } else emptyState();
			}
		}
	}

	/* The file as it arrived, not what is on the canvas: the canvas holds a
	 * developed preview at whatever step the zoom asked for, and saving that
	 * would hand back a JPEG-shaped thing wearing a .dng name. */
	function saveFrame() {
		if (!state.bytes) return;
		const url = URL.createObjectURL(new Blob([state.bytes],
			{ type: 'image/x-adobe-dng' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = state.name || 'frame.dng';
		a.click();
		// Revoked on a timer: a download that has not begun by now never will,
		// and revoking immediately races the browser in Firefox.
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	}

	capBtn?.addEventListener('click', takeFrame);
	saveBtn.addEventListener('click', saveFrame);
	emptyState();

	/* ---- rendering ---- */
	let queued = null, running = false;
	async function render(step) {
		if (!state.info) return;
		if (running) { queued = step; return; }
		running = true;
		busy.hidden = step > 1;
		try {
			const r = await call('develop', {
				cfa: state.cfa, demosaic: state.demosaic, black: state.black,
				white: state.white, neutral: state.neutral,
				forward: state.info.forward, useForward: state.info.hasForward,
				gain: state.gain, step,
			});
			canvas.hidden = false; drop.hidden = true; hud.hidden = false;
			// A develop means the picture changed, so the reader's full-size
			// copy is of something that is no longer on screen.
			plateFull = null;
			canvas.width = r.width; canvas.height = r.height;
			canvas.getContext('2d').putImageData(new ImageData(r.pixels, r.width, r.height), 0, 0);
			if (mode === 'develop') histBox.innerHTML = histogramSVG(r.hist);
			zoomEl.textContent = state.fit ? 'Fit' : '100%';
			// The canvas may have changed size, and the overlays are positioned
			// against it.
			drawChart();
			drawPlateMarks();
		} catch (e) {
			fail(e.message);
		} finally {
			busy.hidden = true;
			running = false;
			if (queued !== null) { const s = queued; queued = null; render(s); }
		}
	}
	// Dragging always gets the cheap render; releasing gets what the current
	// zoom actually needs.
	const stepForFit = () => fitStep(state.info?.width || 0, stage.clientWidth);
	const preview = () => render(Math.max(stepForFit(), 2));
	const commit = () => render(state.fit ? stepForFit() : 1);

	/* ---- picking a neutral ---------------------------------------------
	 *
	 * The click is read off the mosaic, not off the canvas: the canvas holds a
	 * frame that has already been white-balanced and demosaiced, so reading it
	 * back would measure the balance currently applied rather than the scene.
	 * That is why this goes to the engine with image coordinates instead of
	 * sampling the pixels already on screen.
	 */
	let wbRows = null, wbNote = null, pickBtn = null, picking = false;

	function armPicker(on) {
		picking = on && !!state.info;
		stage.classList.toggle('re-pick', picking);
		pickBtn?.classList.toggle('re-pri', picking);
		if (picking && wbNote)
			wbNote.textContent = 'Click something in the picture that should be grey. ' +
				'A card, a wall, a paper — anything neutral, and not so bright it has clipped.';
	}

	/* Where in the frame a click landed.
	 *
	 * One formula covers both zooms: object-fit: contain letterboxes the image
	 * inside the element in Fit, and at 100% the element is exactly the image,
	 * so the scale works out at 1 and the offsets at 0.
	 */
	/* The mapping between the screen and the frame, in one place, because the
	 * picker reads it one way and the chart overlay draws through it the
	 * other. */
	function viewTransform() {
		const r = canvas.getBoundingClientRect();
		if (!r.width || !r.height || !canvas.width || !canvas.height) return null;
		const scale = Math.min(r.width / canvas.width, r.height / canvas.height);
		const step = Math.max(1, Math.round((state.info?.width || canvas.width) / canvas.width));
		return {
			rect: r, scale, step,
			ox: (r.width - canvas.width * scale) / 2,
			oy: (r.height - canvas.height * scale) / 2,
		};
	}

	function frameCoords(ev) {
		const t = viewTransform();
		if (!t) return null;
		const cx = (ev.clientX - t.rect.left - t.ox) / t.scale;
		const cy = (ev.clientY - t.rect.top - t.oy) / t.scale;
		if (cx < 0 || cy < 0 || cx >= canvas.width || cy >= canvas.height) return null;
		// The canvas may be a stepped preview; the engine wants full-frame
		// coordinates either way.
		return { x: cx * t.step, y: cy * t.step };
	}

	/* Frame coordinates back to where they sit inside the stage, so the overlay
	 * lands on the picture rather than beside it. */
	function stageCoords(x, y) {
		const t = viewTransform();
		if (!t) return null;
		const s = stage.getBoundingClientRect();
		return {
			x: t.rect.left - s.left + t.ox + (x / t.step) * t.scale,
			y: t.rect.top - s.top + t.oy + (y / t.step) * t.scale,
		};
	}

	async function pickAt(ev) {
		const at = frameCoords(ev);
		if (!at) return;
		armPicker(false);
		try {
			// Six pixels covers at least one full CFA quad at any step, and
			// averages away the sensor noise that a single site would carry.
			const got = await call('sample', {
				x: at.x, y: at.y, radius: 6, black: state.black, cfa: state.cfa,
			});
			state.neutral = got.neutral.slice();
			if (wbRows) { wbRows[0].value = state.neutral[0]; wbRows[2].value = state.neutral[2]; }
			if (wbNote)
				wbNote.textContent = 'Set from the picture: red ' +
					state.neutral[0].toFixed(3) + ', blue ' + state.neutral[2].toFixed(3) +
					'. Reset either slider to go back to what the camera chose.';
			await commit();
		} catch (e) {
			if (wbNote) wbNote.textContent = e.message;
		}
	}

	stage.addEventListener('click', (ev) => { if (picking) pickAt(ev); });

	/*
	 * Both overlays are positioned against the canvas, so anything that moves
	 * the canvas has to move them: a window resize, the inspector changing
	 * width, and the Fit/100% zoom, which resizes the element without the
	 * window ever changing. Watching the element itself catches all of those,
	 * where a window listener catches only the first.
	 */
	const onResize = () => { drawChart(); drawMarks(); drawFocusMarks(); };
	let ro = null;
	if (typeof ResizeObserver === 'function') {
		ro = new ResizeObserver(onResize);
		ro.observe(canvas);
	}
	window.addEventListener('resize', onResize);
	/* A press that ends anywhere but on the button still has to stop the lens.
	 * Dragging off it, switching window and hiding the tab all end the gesture
	 * without a pointerup ever reaching the button, and a motor left running
	 * because the page stopped watching is the one failure here that damages
	 * something. */
	const onLetGo = () => moveRelease();
	const onPointerLetGo = (ev) => moveReleaseFrom(ev);
	window.addEventListener('blur', onLetGo);
	window.addEventListener('pointerup', onPointerLetGo);
	window.addEventListener('pointercancel', onPointerLetGo);
	document.addEventListener('visibilitychange', onLetGo);

	/* ---- diagnose --------------------------------------------------------
	 *
	 * What is wrong with the sensor rather than with the picture. The numbers
	 * come from the mosaic -- a demosaiced frame has smeared every one of them
	 * into its neighbours -- and the defects are marked on the picture, because
	 * "eleven defects" and "eleven defects, all in that corner" are different
	 * findings and only one of them is visible as a number.
	 */
	let diag = null;

	/* A scan is a reading of one frame under one CFA: that is what tells it
	 * which neighbours are the same colour, so changing it leaves the old
	 * defect coordinates describing a frame nobody is looking at any more.
	 *
	 * The White control is deliberately NOT one of these. It sets where the
	 * render clips, which is a choice about the picture; the scan asks where
	 * the SENSOR saturates, which is in the file and does not move. */
	function invalidateScan() {
		if (!diag) return;
		diag = null;
		marks.replaceChildren();
		if (mode === 'diagnose') buildDiagnose();
	}
	const marks = el('div', 're-marks');
	marks.hidden = true;
	stage.append(marks);

	/* The plate overlay, separate from the defect one so switching tabs does
	 * not make one clear the other's work. */
	const plateMarks = el('div', 're-marks');
	plateMarks.hidden = true;
	stage.append(plateMarks);
	/* Set by buildPlates so the picture can drive the list. */
	let plateRepaint = null;

	/*
	 * Where the plates are, on the picture.
	 *
	 * The list on the right says what was found; this says where. A detection
	 * is drawn at its true size and then given a minimum, because at Fit a
	 * 46-pixel plate on a 2592-pixel frame is sixteen pixels of stage and a
	 * box that small is a dot -- the ring around it is a hit target, not a
	 * claim about the plate's extent. The label sits outside the ring for the
	 * same reason: over it, it would cover the thing it names.
	 *
	 * Clicking either end selects: a row selects its box, a box selects its
	 * row. They are two views of one selection, so neither owns it.
	 */
	function drawPlateMarks() {
		plateMarks.replaceChildren();
		if (mode !== 'plates' || !plateCands || !state.info) return;
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('class', 're-chart-svg');
		svg.style.pointerEvents = 'none';
		const floor = plateReader ? plateReader.floor : 0.5;
		plateCands.forEach((c, i) => {
			const a = stageCoords(c.box.left, c.box.top);
			const b = stageCoords(c.box.left + c.box.width, c.box.top + c.box.height);
			if (!a || !b) return;
			const sel = i === plateSel;
			const w = Math.max(18, b.x - a.x), h = Math.max(12, b.y - a.y);
			const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
			const r = document.createElementNS(NS, 'rect');
			r.setAttribute('x', cx - w / 2); r.setAttribute('y', cy - h / 2);
			r.setAttribute('width', w); r.setAttribute('height', h);
			r.setAttribute('rx', 3);
			r.setAttribute('fill', sel ? 'rgba(74,99,216,0.18)' : 'none');
			r.setAttribute('stroke', sel ? '#6f86ff'
				: c.minConf >= floor ? '#4ea97b' : 'rgba(255,255,255,0.55)');
			r.setAttribute('stroke-width', sel ? 2.5 : 1.5);
			r.style.pointerEvents = 'auto';
			r.style.cursor = 'pointer';
			r.addEventListener('click', (ev) => {
				ev.stopPropagation();
				plateSel = i;
				if (plateRepaint) plateRepaint();
				drawPlateMarks();
			});
			svg.append(r);
			if (sel) {
				/* The registration, whatever the confidence -- the size was no use
				 * to anyone standing in front of the picture. What confidence
				 * changes is the INK: white for a read above the floor, amber
				 * below it, matching the greyed-out rows in the list. So a
				 * doubtful reading is still shown, and still never looks like a
				 * certain one. The size is only the fallback for a candidate the
				 * reader returned nothing at all for. */
				const label = c.text ||
					(Math.round(c.box.width) + '×' + Math.round(c.box.height) + ' px');
				const ink = c.minConf >= floor ? '#fff' : '#f0c04a';
				/* Edged the way the camera's own OSD is: white ink standing on a
				 * black halo, so it reads on a red bonnet and on tarmac alike.
				 * majestic grows that halo from the glyph's own coverage; here
				 * the same effect comes from drawing the label twice, larger in
				 * black underneath and smaller in white on top.
				 *
				 * The black one is nudged up by the half-difference in size:
				 * both share a baseline, so without that the halo would be all
				 * under the letters and none above them. */
				const t = document.createElementNS(NS, 'text');
				t.setAttribute('x', cx);
				t.setAttribute('y', cy - h / 2 - 8);
				t.setAttribute('text-anchor', 'middle');
				t.setAttribute('font-size', '12');
				t.setAttribute('font-weight', '700');
				t.setAttribute('font-family', 'ui-monospace, SFMono-Regular, monospace');
				t.setAttribute('fill', ink);
				t.setAttribute('stroke', '#000');
				t.setAttribute('stroke-width', '3.5');
				t.setAttribute('stroke-linejoin', 'round');
				/* Stroke UNDER fill, which is what makes this a halo rather than
				 * an outline drawn over the letters and eating them from both
				 * sides. One element, so the two can never drift apart -- the
				 * black-behind-white version could not line up at all, because a
				 * larger copy of a nine-character string is a wider string and
				 * only its middle glyph lands where the smaller one's did. */
				t.setAttribute('paint-order', 'stroke fill');
				t.style.paintOrder = 'stroke fill';
				t.textContent = label;
				svg.append(t);
			}
		});
		plateMarks.append(svg);
	}

	/*
	 * How many rings the picture will carry at most, and how many of a given
	 * list actually get one. The panel quotes this number, so it is worked out
	 * in one place -- a cap the copy had to guess at is how the old wording
	 * came to name a count that was never on screen.
	 */
	const MARKS_CAP = 600;
	const markStep = (n) => Math.max(1, Math.ceil(n / MARKS_CAP));
	const markedCount = (n) => (n <= 0 ? 0 : Math.ceil(n / markStep(n)));

	function drawMarks() {
		marks.replaceChildren();
		if (mode !== 'diagnose' || !diag || !state.info) return;
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('class', 're-chart-svg');
		/*
		 * A cap on what is drawn, not on what is counted. This used to say ten
		 * thousand rings would cost a second to build, which does not survive
		 * being measured: in headless Chromium, building and laying out that
		 * many circles is 89.9 ms, against 47.0 ms for 4096 and 6.2 ms for
		 * 600 -- median of seven, on this desktop x86. So the cap is not
		 * really about the clock. It is that a frame cannot show ten thousand
		 * rings as ten thousand things; past a few hundred they merge into a
		 * wash that hides the picture underneath and says nothing the count
		 * beside it does not say better.
		 *
		 * Every k-th, and NOT the first six hundred. The list arrives in the
		 * order the scan walks the frame, which is row by row, so a prefix of
		 * it is the top of the picture and nothing else. On a camera frame
		 * carrying 4054 defects that put every ring inside the top 600/4054 =
		 * 15% of the rows, in a band with a ragged edge along the bottom of
		 * it, and it was read -- reasonably -- as the defects being clustered
		 * at the top of the sensor. They were not: the same scan's own spread
		 * index said 1.01, scattered. A stride samples the whole frame at the
		 * same cost, and being deterministic it survives the redraws that a
		 * resize or a tab switch bring.
		 */
		const step = markStep(diag.defects.length);
		for (let i = 0; i < diag.defects.length; i += step) {
			const d = diag.defects[i];
			const at = stageCoords(d.x, d.y);
			if (!at) continue;
			const c = document.createElementNS(NS, 'circle');
			c.setAttribute('cx', at.x);
			c.setAttribute('cy', at.y);
			c.setAttribute('r', 4);
			c.setAttribute('class', 're-mark');
			svg.append(c);
		}
		marks.append(svg);
	}


	/* ---- step 2: can a plate be read here? --------------------------------
	 *
	 * The Sensor card above asks whether the SENSOR is healthy. This asks
	 * whether this PICTURE can give up a registration, which is a different
	 * question with different answers -- a flawless sensor out of focus fails
	 * it, and a sensor with two hundred hot pixels passes.
	 *
	 * Three numbers, and only two of them are measurements.
	 *
	 * Sampling is exact: the plate's width in sensor pixels, straight off the
	 * detection.
	 *
	 * Noise is Immerkaer's single-image estimate -- a 3x3 mask that annihilates
	 * linear ramps, so what survives is the grain rather than the scene. It was
	 * checked against known added noise before it was allowed on screen: within
	 * 4% from 1 to 16 DN.
	 *
	 * Blur is NOT reported as a sigma, and that is deliberate. The obvious
	 * estimator -- blur the frame again and watch the gradient energy fall --
	 * was built, measured against known blur, and thrown away: it read 2.4 for
	 * a true 1.0 and its error grew with the answer, because the 1/sigma^2 it
	 * assumes is a property of an idealised edge and not of a photograph. A
	 * calibrated-looking number that is wrong by a factor of two is worse than
	 * no number.
	 *
	 * So the sharpness question is answered by EXPERIMENT instead: blur this
	 * plate by increasing amounts, read it again after each, and report how
	 * much it can take before it stops reading. That is the headroom, it needs
	 * no calibration, and it uses the recogniser that will actually do the job.
	 */
	function blurGray(px, w, h, sigma) {
		if (!(sigma > 0)) return px;
		const r = Math.max(1, Math.ceil(sigma * 3));
		const k = new Float64Array(2 * r + 1);
		let sum = 0;
		for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
		for (let i = 0; i < k.length; i++) k[i] /= sum;
		const t = new Float64Array(w * h), o = new Float64Array(w * h);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			let a = 0;
			for (let i = -r; i <= r; i++) {
				let xx = x + i; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
				a += px[y * w + xx] * k[i + r];
			}
			t[y * w + x] = a;
		}
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			let a = 0;
			for (let i = -r; i <= r; i++) {
				let yy = y + i; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
				a += t[yy * w + x] * k[i + r];
			}
			o[y * w + x] = a;
		}
		return o;
	}

	/* Immerkaer 1996. Validated against known noise before shipping. */
	function noiseDN(px, w, h) {
		let s = 0, n = 0;
		for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
			const i = y * w + x;
			const v = px[i - w - 1] - 2 * px[i - w] + px[i - w + 1]
				- 2 * px[i - 1] + 4 * px[i] - 2 * px[i + 1]
				+ px[i + w - 1] - 2 * px[i + w] + px[i + w + 1];
			s += Math.abs(v); n++;
		}
		return n ? (s / n) * Math.sqrt(Math.PI / 2) / 6 : 0;
	}

	function cropCanvas(src, box, padX, padY) {
		const x0 = Math.max(0, Math.round(box.left - box.width * padX));
		const y0 = Math.max(0, Math.round(box.top - box.height * padY));
		const x1 = Math.min(src.width, Math.round(box.left + box.width * (1 + padX)));
		const y1 = Math.min(src.height, Math.round(box.top + box.height * (1 + padY)));
		const c = el('canvas');
		c.width = Math.max(1, x1 - x0); c.height = Math.max(1, y1 - y0);
		c.getContext('2d', { willReadFrequently: true })
			.drawImage(src, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
		return { canvas: c, box: { left: box.left - x0, top: box.top - y0,
			width: box.width, height: box.height } };
	}

	function grayOf(cv) {
		const d = cv.getContext('2d', { willReadFrequently: true })
			.getImageData(0, 0, cv.width, cv.height).data;
		const g = new Float64Array(cv.width * cv.height);
		for (let i = 0; i < g.length; i++)
			g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
		return g;
	}

	function grayToCanvas(g, w, h) {
		const c = el('canvas'); c.width = w; c.height = h;
		const im = new ImageData(w, h);
		for (let i = 0; i < g.length; i++) {
			const v = g[i] < 0 ? 0 : (g[i] > 255 ? 255 : g[i]);
			im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v;
			im.data[i * 4 + 3] = 255;
		}
		c.getContext('2d', { willReadFrequently: true }).putImageData(im, 0, 0);
		return c;
	}

	function pct(v) { return (v * 100).toFixed(v >= 0.01 ? 1 : 3) + '%'; }

	/*
	 * Whether the plate you picked can be read: how many pixels across it is,
	 * and how much blur it survives before it stops reading.
	 *
	 * It lives on the Plates tab, under the list the plate is chosen from. It
	 * used to sit in Diagnose, which is about the sensor's own health and not
	 * about the picture -- and every one of these questions is about one
	 * plate, so the answer differed across a frame while the card sat on a tab
	 * with nothing to pick a plate on. Diagnose grew a guided run afterwards
	 * and this card landed in the middle of it, between the steps and their
	 * result, which is what finally made the misfiling obvious.
	 *
	 * Refilled rather than rebuilt, so choosing a different plate refreshes it
	 * where it stands instead of stacking a second copy underneath.
	 */
	let plateFitPanel = null;
	function buildPlateFitness() {
		if (!plates) return;
		if (!plateFitPanel) plateFitPanel = el('div', 're-panel');
		const panel = plateFitPanel;
		panel.replaceChildren();
		panel.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Reading a plate here</h3><span class="re-rule"></span>',
		}));
		const note = el('p', 're-note');
		panel.append(note);
		const rows = el('div');
		rows.style.cssText = 'display:flex;flex-direction:column;gap:7px;margin-top:9px';
		panel.append(rows);
		if (panel.parentNode !== insp) insp.append(panel);

		if (!plateCands || plateSel < 0) {
			note.textContent = 'Pick one of the plates above — these are questions about ' +
				'a single plate, and the answers differ across a frame.';
			return;
		}
		const c = plateCands[plateSel];
		const run = el('button', 're-btn re-pri', '');
		run.dataset.act = 'plate-fitness';
		run.textContent = 'Measure this plate';
		note.textContent = 'Three questions about the plate you picked. The first two are ' +
			'read off the frame; the third is answered by blurring it until it stops reading.';
		panel.insertBefore(run, rows);

		const bar = (label, frac, value, tone) => {
			const r = el('div');
			r.style.cssText = 'display:flex;align-items:center;gap:9px';
			r.append(Object.assign(el('span', 're-note'), {
				textContent: label, style: 'width:78px;flex:none',
			}));
			const track = el('div');
			track.style.cssText = 'flex:1;height:5px;border-radius:3px;background:var(--re-line,#2c313d)';
			const fill = el('div');
			fill.style.cssText = 'height:100%;border-radius:3px;width:' +
				Math.max(2, Math.min(100, frac * 100)).toFixed(0) + '%;background:' +
				(tone === 'warn' ? '#c9a227' : tone === 'good' ? '#4ea97b' : '#7c869b');
			track.append(fill);
			r.append(track);
			r.append(Object.assign(el('span', 're-mono'), {
				textContent: value, style: 'width:92px;text-align:right;font-size:12px',
			}));
			return r;
		};

		run.addEventListener('click', async () => {
			run.disabled = true;
			rows.replaceChildren();
			try {
				const full = await plateFrame();
				const cut = cropCanvas(full, c.box, 0.35, 1.1);
				const g = grayOf(cut.canvas);
				const w = cut.canvas.width, h = cut.canvas.height;

				// exact
				const px = Math.round(c.box.width);
				const chars = Math.round(c.box.height * 0.62);
				// measured
				const dn = noiseDN(g, w, h);
				// experiment
				note.textContent = 'Blurring it until it stops reading…';
				const floor = plateReader.floor;
				const steps = [0, 0.3, 0.6, 0.9, 1.2, 1.6, 2.0];
				const got = [];
				/* The whole sweep, no early exit. Confidence is NOT monotonic in
				 * blur -- measured on this camera, a plate went 0.69, 0.66,
				 * 0.83, 0.34 across +0.0 to +0.9 px, because a little blur is
				 * also a denoise and the recogniser is not above being helped
				 * by one. Stopping at the first dip would have reported the
				 * headroom as zero on a plate with half a pixel in hand. */
				for (const sg of steps) {
					const cv = sg ? grayToCanvas(blurGray(g, w, h, sg), w, h) : cut.canvas;
					const r = await plateReader.read(cv, cut.box);
					got.push({ sigma: sg, conf: r.minConf, text: r.text });
					note.textContent = 'Blurring it until it stops reading… +' + sg.toFixed(1) + ' px';
				}
				const ok = got.filter((x) => x.conf >= floor);
				const lastOk = ok.length ? ok[ok.length - 1] : null;
				const head = lastOk ? lastOk.sigma : null;
				// Did it dip below and come back? Worth saying, because it means
				// the number above is a range rather than a threshold.
				const bumpy = ok.length > 1 &&
					got.findIndex((x) => x === lastOk) !== ok.length - 1;

				rows.replaceChildren();
				rows.append(bar('Sampling', Math.min(1, px / 120), px + ' px wide',
					px >= 70 ? 'good' : px >= 45 ? '' : 'warn'));
				rows.append(bar('Noise', Math.min(1, dn / 12), dn.toFixed(1) + ' DN',
					dn <= 3 ? 'good' : dn <= 7 ? '' : 'warn'));
				rows.append(bar('Sharpness', head === null ? 0.04 : Math.min(1, head / 1.6),
					head === null ? 'none in hand' : '+' + head.toFixed(1) + ' px in hand',
					head === null ? 'warn' : head >= 0.9 ? 'good' : ''));

				const verdict = el('div', 're-notice');
				verdict.style.marginTop = '10px';
				if (head === null) {
					verdict.textContent = 'This plate is already at the edge. It reads at ' +
						got[0].conf.toFixed(2) + ' and the smallest blur worth measuring takes it ' +
						'below the threshold — so nothing done to the picture afterwards will ' +
						'help much. Focus, or a shorter shutter if it is moving, is what moves this.';
				} else {
					verdict.textContent = 'Worth reading. It survives ' + head.toFixed(1) +
						' px of added blur and still reads, so there is room in hand — stacking ' +
						'and a better develop have something to work with.' +
						(bumpy ? ' The reading is not a clean slope, though: it dips and recovers ' +
							'across the sweep, so treat the figure as roughly where the edge is ' +
							'rather than exactly.' : '');
				}
				panel.append(verdict);
				note.textContent = 'Measured on the plate you picked, ' + px + ' px wide.';

				const tbl = el('p', 're-note');
				tbl.style.cssText = 'margin-top:8px;white-space:pre';
				tbl.textContent = got.map((x) => '  +' + x.sigma.toFixed(1) + ' px blur → ' +
					x.conf.toFixed(2) + (x.conf >= floor ? '' : '  (below the floor)')).join('\n');
				panel.append(tbl);
			} catch (e) {
				note.textContent = 'Could not measure it: ' + e.message;
			}
			run.disabled = false;
			run.textContent = 'Measure again';
		});
	}

	/*
	 * The guided run: find this sensor's bad pixels without having to know how.
	 *
	 * Everything underneath this was already here -- the brightness gate, the
	 * tally across captures, the arrangement index -- and all of it was behind
	 * knowing to press Scan, knowing to choose Darkest, knowing to press Keep
	 * five times and knowing what "4 of 5" buys. This drives those, and owns
	 * no judgement of its own.
	 *
	 * Five captures, because one cannot tell a bad pixel from a noisy one: the
	 * tally wants a site to keep coming back, and the suggested rule works out
	 * at 4 of 5.
	 *
	 * It does NOT use the camera's own burst. `/image.dng?frames=N` averages
	 * consecutive frames in the sensor, and an average is the one thing that
	 * cannot answer this question -- a pixel that was wrong in every frame and
	 * a pixel that was wrong in one of sixteen come out of it looking alike.
	 * The same reasoning is written out where the Plates tab picks between the
	 * two paths.
	 */
	const HUNT_WANT = 5;

	function startHunt() {
		// A run starts from nothing kept, or the first tally would count
		// captures the operator has forgotten about.
		scanSet = [];
		needTouched = false;
		/* And from looking everywhere, whatever the last run or the operator
		 * left the gate on. The first capture decides whether to narrow it,
		 * and narrowing a frame that is dark all over destroys the answer
		 * rather than sharpening it -- see the note beside the gate. */
		bgPercent = 100;
		hunt = { taken: 0, dark: null, level: null, busy: false, failed: '', done: false, seen: opened };
		buildDiagnose();
		drawMarks();
	}

	/*
	 * One step: get a frame, read it, keep it.
	 *
	 * The first capture is also the one that decides which kind of run this
	 * is, and it decides it from the frame rather than from what it was told.
	 */
	async function huntStep() {
		if (!hunt || hunt.busy) return;
		hunt.busy = true;
		hunt.failed = '';
		buildDiagnose();
		try {
			if (capture) {
				const was = opened;
				await takeFrame();
				if (opened === was)
					throw new Error('That capture did not arrive. The message above says why.');
			} else if (!state.info) {
				throw new Error('Drop a frame on the picture first.');
			} else if (hunt.seen === opened) {
				/*
				 * With nowhere to capture from, the frames are brought in by
				 * hand -- and the same frame read twice would agree with
				 * itself perfectly, which is the one answer the tally must
				 * never be allowed to give. Every step needs a frame that has
				 * actually been opened since the last one.
				 */
				throw new Error('That is the frame this run has already read. ' +
					'Drop the next one on the picture, then read it.');
			}
			hunt.seen = opened;
			diag = await scanFrame();

			if (hunt.taken === 0) {
				hunt.level = frameLevel(diag);
				hunt.dark = hunt.level !== null && hunt.level < COVERED;
				/*
				 * A frame with a picture in it needs the brightness gate, and
				 * this is the moment to set it: the shadows of a scene are the
				 * nearest thing to a capped lens, and leaving the scan looking
				 * everywhere would fill the tally with scenery for four more
				 * captures before anyone found out.
				 */
				if (!hunt.dark && bgPercent === 100) {
					bgPercent = 25;
					diag = await scanFrame();
				}
			}
			keepCurrentScan();
			hunt.taken++;
		} catch (e) {
			hunt.failed = e && e.message ? e.message : 'That step did not finish.';
		} finally {
			hunt.busy = false;
			buildDiagnose();
			drawMarks();
		}
	}

	/* The end of a run: apply the rule the compare panel would have suggested,
	 * and put the survivors on the picture through the same path the Mark
	 * button uses. */
	function finishHunt() {
		const tally = tallyOf(scanSet);
		const M = scanSet.length;
		const need = Math.max(2, Math.ceil(M * 0.8));
		needN = need;
		const pts = [...tally].filter(([, c]) => c >= need)
			.map(([k]) => { const [x, y] = k.split(','); return { x: +x, y: +y }; });
		/*
		 * Whether any capture in this run hit the engine's store cap.
		 *
		 * It matters, and it is not visible in the result: a capture that
		 * overflowed kept a census of the top of its frame only, so every
		 * candidate below the row it stopped on was never a candidate for the
		 * tally either. The list that comes out is then short by an unknown
		 * amount in a known place, and the old code set truncated to false and
		 * presented it as the whole answer. It is still worth having -- the
		 * sites it did confirm are confirmed -- so the run finishes and says
		 * what it could not see rather than refusing.
		 */
		const clipped = scanSet.filter((v) => v.truncated);
		hunt.clipped = clipped.length;
		hunt.mostFound = clipped.reduce((m, v) => Math.max(m, v.found || 0), 0);
		diag = { ...diag, defects: pts, defectCount: pts.length, truncated: false,
			fromTally: { need, of: M, partial: clipped.length > 0 } };
		hunt.done = true;
		buildDiagnose();
		drawMarks();
	}

	/*
	 * The confirmed list, as a file.
	 *
	 * Plain text and one site per line, because nothing on the camera consumes
	 * a defect map yet and a list of coordinates is the one shape every other
	 * tool can read. The header carries what the list is only meaningful
	 * against: which sensor, at what exposure and gain, and under what rule --
	 * a map taken at seven seconds describes a sensor that is not the one
	 * running at a thirtieth.
	 */
	function exportDefects() {
		if (!diag || !diag.defects || !diag.defects.length) return;
		const i = state.info || {};
		const head = [
			'# sensor defect list, raw-editor',
			'# camera      ' + (i.model || 'unknown'),
			'# frame       ' + (i.width || '?') + 'x' + (i.height || '?') +
				' ' + (i.cfaName || ''),
			'# exposure    ' + (i.exposure ? (i.exposure * 1000).toFixed(1) + ' ms' : 'unknown'),
			'# iso         ' + (i.iso || 'unknown'),
			'# rule        ' + (diag.fromTally
				? 'seen in at least ' + diag.fromTally.need + ' of ' +
					diag.fromTally.of + ' captures'
				: 'a single capture, unconfirmed'),
			'# taken       ' + new Date().toISOString(),
			'# complete    ' + (diag.fromTally && diag.fromTally.partial
				? 'NO - a capture filled the scan\'s store, so sites near the bottom ' +
					'of the frame were never examined'
				: 'yes, as far as the scan could see'),
			'# ' + diag.defects.length + ' sites, x,y in sensor pixels',
		].join('\n');
		const body = diag.defects.map((p) => p.x + ',' + p.y).join('\n');
		const url = URL.createObjectURL(
			new Blob([head + '\n' + body + '\n'], { type: 'text/plain' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'defects.txt';
		a.click();
		// Same reasoning as saving the frame: revoking at once races the
		// browser in Firefox.
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	}

	function buildHunt() {
		const panel = el('div', 're-panel');
		panel.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Find the bad pixels</h3><span class="re-rule"></span>',
		}));

		if (!hunt) {
			panel.append(Object.assign(el('p', 're-note'), {
				style: 'margin:0 0 9px',
				textContent: 'Five captures, compared. A pixel that is genuinely bad is bad ' +
					'in every one of them; whatever comes and goes was noise, or something ' +
					'in the picture.',
			}));
			const go = el('button', 're-btn re-pri', '');
			go.dataset.act = 'hunt-start';
			go.textContent = 'Start';
			go.addEventListener('click', startHunt);
			panel.append(go);
			return panel;
		}

		const done = hunt.taken >= HUNT_WANT;
		panel.append(Object.assign(el('div', 're-rname'), {
			style: 'margin:0 0 7px',
			textContent: done ? 'done' : 'step ' + (hunt.taken + 1) + ' of ' + HUNT_WANT,
		}));

		if (hunt.taken === 0) {
			/*
			 * How to make it dark, not merely that dark is better.
			 *
			 * The panel underneath has always said a dark frame gives the only
			 * reliable answer, which is true and of no use at all on a fixed
			 * lens in a dome that cannot be capped.
			 */
			panel.append(Object.assign(el('p', 're-note'), {
				style: 'margin:0 0 9px',
				textContent: 'Make it dark first, if you can: at night with the infrared ' +
					'light switched off, and something opaque over the lens — black tape, ' +
					'or a box over the camera. Not a hand: with the infrared filter swung ' +
					'out, the sensor sees straight through skin. If you cannot, carry on ' +
					'anyway — it will take longer and say so.',
			}));
		} else {
			const tally = tallyOf(scanSet);
			let every = 0;
			for (const [, c] of tally) if (c === hunt.taken) every++;
			panel.append(Object.assign(el('p', 're-note'), {
				style: 'margin:0 0 7px',
				textContent: 'So far: ' + tally.size + ' site' + (tally.size === 1 ? '' : 's') +
					', ' + every + ' of which ' + (every === 1 ? 'has' : 'have') +
					' turned up every time.',
			}));
			panel.lastChild.dataset.act = 'hunt-progress';

			if (hunt.dark !== null) {
				const box = el('div', 're-notice ' + (hunt.dark ? 're-ok' : 're-warn'));
				box.style.cssText = 'margin:0 0 9px';
				box.dataset.act = 'hunt-verdict';
				box.append(Object.assign(el('div'), {
					textContent: hunt.dark
						? 'Covered — there is nothing in this frame but the sensor\u2019s own ' +
							'dark current, which is the best kind of frame for this. Leave the ' +
							'camera where it is and take the rest.'
						: 'There is still a picture in this frame: the middle of it sits ' +
							(hunt.level === null ? '' : (hunt.level * 100).toFixed(1) + '% ') +
							'of the way to saturation. Carrying on, looking only where the ' +
							'picture is dark — move the camera a little between captures, so ' +
							'that detail in the scene cannot line up with itself.',
				}));
				panel.append(box);
			}

			/*
			 * What the exposure buys, said where it can still be acted on.
			 *
			 * A defect's signal is dark current, which accumulates with time,
			 * so a warm pixel that is invisible in a short frame is plain in a
			 * long one. Measured on this camera in a black box, the same
			 * sensor reported 882 sites at 0.5 s, 1329 at 1 s, 1782 at 2 s and
			 * 3921 at 7 s. Which is also the warning: a map taken at seven
			 * seconds is not a map of the camera that runs at a thirtieth.
			 */
			if (state.info && state.info.exposure)
				panel.append(Object.assign(el('p', 're-note'), {
					style: 'margin:0 0 9px',
					textContent: 'Taken at ' + (state.info.exposure * 1000).toFixed(1) +
						' ms. Dark current builds up with time, so a longer exposure finds ' +
						'more of them — take these at the exposure the camera will really ' +
						'run at, or the list will describe a sensor you are not using. ' +
						(hunt.dark ? 'Dark current also climbs steeply with temperature, so a ' +
							'map taken on a cold camera understates a warm one — take it in ' +
							'the place the camera actually lives.' : ''),
				}));
		}

		if (hunt.failed) {
			const box = el('div', 're-notice re-warn');
			box.style.cssText = 'margin:0 0 9px';
			box.dataset.act = 'hunt-failed';
			box.append(Object.assign(el('div'), { textContent: hunt.failed }));
			panel.append(box);
		}

		const row = el('div');
		row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
		if (!done) {
			const go = el('button', 're-btn re-pri', '');
			go.dataset.act = 'hunt-step';
			go.textContent = hunt.busy ? 'Working…'
				: capture ? (hunt.taken === 0 ? 'Capture' : 'Capture ' + (hunt.taken + 1) +
					' of ' + HUNT_WANT)
					: 'Read the frame on screen';
			go.disabled = hunt.busy;
			go.addEventListener('click', huntStep);
			row.append(go);
			/* No capture provider: the frames have to be brought in by hand,
			 * and saying so is better than a button that cannot work. The
			 * Plates tab and Calibrate degrade the same way. */
			if (!capture)
				panel.append(Object.assign(el('p', 're-note'), {
					style: 'margin:0 0 9px',
					textContent: 'Drop the next frame on the picture, then read it.',
				}));
		} else if (!hunt.done) {
			const fin = el('button', 're-btn re-pri', '');
			fin.dataset.act = 'hunt-finish';
			fin.textContent = 'See what kept coming back';
			fin.addEventListener('click', finishHunt);
			row.append(fin);
		} else {
			if (hunt.clipped) {
				const box = el('div', 're-notice re-warn');
				box.style.cssText = 'margin:0 0 9px';
				box.dataset.act = 'hunt-partial';
				box.append(Object.assign(el('div'), {
					textContent: `${hunt.clipped} of these captures found more defects than ` +
						`the scan can hold — one reached ${hunt.mostFound}. Everything below ` +
						'the row it filled up on was never looked at, so this list is short ' +
						'by an unknown number of sites near the bottom of the frame. The ' +
						'ones it does name were seen every time and are real. A shorter ' +
						'exposure finds fewer, if you need the whole map.',
				}));
				panel.append(box);
			}
			const save = el('button', 're-btn re-pri', '');
			save.dataset.act = 'hunt-export';
			save.textContent = 'Save the list';
			save.disabled = !diag || !diag.defects || !diag.defects.length;
			save.addEventListener('click', exportDefects);
			row.append(save);
		}
		const stop = el('button', 're-btn', '');
		stop.dataset.act = 'hunt-stop';
		stop.textContent = hunt.done ? 'Done' : 'Do this by hand';
		stop.addEventListener('click', () => { hunt = null; buildDiagnose(); drawMarks(); });
		row.append(stop);
		panel.append(row);
		return panel;
	}

	function buildDiagnose() {
		insp.replaceChildren();
		insp.append(buildHunt());
		const panel = el('div', 're-panel');
		panel.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Sensor</h3><span class="re-rule"></span>',
		}));
		const run = el('button', 're-btn re-pri', '');
		run.dataset.act = 'scan';
		run.textContent = 'Scan the frame';
		panel.append(run);
		panel.append(Object.assign(el('p', 're-note'), {
			textContent: 'Read off the mosaic, before any interpolation. A frame of ' +
				'something flat and out of focus gives the cleanest answer — and a ' +
				'dark one gives the only reliable one.',
			style: 'margin:8px 0 0',
		}));

		/*
		 * Where to believe the scan.
		 *
		 * A defect's signal is dark current, which is added whatever the lens
		 * is pointed at; the scene's is not. Restricting to the darker parts of
		 * the frame is the nearest thing to a capped lens available to someone
		 * who cannot cap the lens, and measurably works: on a lab frame it
		 * moved the arrangement of the surviving set from plainly clustered
		 * towards plainly random.
		 */
		const gate = el('div');
		gate.style.cssText = 'margin-top:11px';
		gate.append(Object.assign(el('div', 're-rname'), { textContent: 'where to look' }));
		const gateSeg = el('div', 're-seg');
		gateSeg.style.cssText = 'margin-top:5px';
		for (const [label, pct, note] of [
			['Everywhere', 100, 'the whole frame, scene and all'],
			['Darker half', 50, 'where the picture is dim'],
			['Darkest', 25, 'closest to a capped lens'],
		]) {
			const b = el('button', pct === bgPercent ? 'on' : '', label);
			b.title = note;
			b.addEventListener('click', () => {
				if (bgPercent === pct) return;
				bgPercent = pct;
				// The old reading was taken somewhere else and no longer
				// describes what is being asked for.
				diag = null;
				buildDiagnose();
				drawMarks();
			});
			gateSeg.append(b);
		}
		gate.append(gateSeg);
		/*
		 * The gate helps a frame that has a picture in it and hurts one that
		 * does not.
		 *
		 * Its cut is a percentile of the local background, so on a frame that
		 * is dark all over it lands just under the level nearly every pixel
		 * sits at -- and a hot pixel lifts its own 7x7 background a couple of
		 * counts above that, which is enough to be gated out. It therefore
		 * throws away the defects in preference to everything else, on exactly
		 * the frames where the defects are all there is. Measured on this
		 * camera's 7 s dark frame: 3921 sites arranged at R = 1.00, textbook
		 * scattered, become 104 at R = 0.68 -- which the panel below reports
		 * as "these are following the picture", about a frame with no picture
		 * in it.
		 */
		if (diag && (() => { const l = frameLevel(diag); return l !== null && l < COVERED; })())
			gate.append(Object.assign(el('p', 're-note'), {
				style: 'margin:7px 0 0',
				textContent: 'This frame is already dark all over, so narrowing the search ' +
					'will only throw away real defects — the gate is for separating a ' +
					'sensor from a scene, and there is no scene here. Everywhere is the ' +
					'right answer for a frame like this one.',
			}));
		panel.append(gate);
		insp.append(panel);

		const out = el('div', 're-panel');
		out.hidden = true;
		insp.append(out);
		// A scan that is still valid is still worth showing. Leaving Diagnose
		// and coming back rebuilt an empty panel over a reading that had not
		// gone anywhere -- and the marks stayed on the picture, so there were
		// rings with nothing to explain them.
		if (diag) renderDiagnose(out);

		run.addEventListener('click', async () => {
			run.disabled = true;
			run.textContent = 'Scanning…';
			try {
				diag = await scanFrame();
				renderDiagnose(out);
				drawMarks();
			} catch (e) {
				out.hidden = false;
				const box = el('div', 're-notice re-warn', ICON.warn);
				box.append(Object.assign(el('div'), { textContent: e.message }));
				out.replaceChildren(box);
			} finally {
				run.disabled = false;
				run.textContent = 'Scan the frame';
			}
		});
	}

	/*
	 * One reading of the frame on screen, for whoever asked.
	 *
	 * Extracted so the Scan button and the guided run cannot drift apart: they
	 * have to ask the same question of the same frame or their answers are not
	 * comparable, and the tally across captures assumes they are.
	 *
	 * call() resolves with the worker's whole message; the reading is in
	 * `result`. Taking the envelope for the result produced "Cannot read
	 * properties of undefined (reading 'map')" from deep inside the renderer,
	 * which said nothing about why.
	 *
	 * The FILE's white level, not the slider's. state.white is a rendering
	 * choice -- pull it down to brighten the picture and every bright pixel
	 * would count as clipped, which would take the real hot pixels out of the
	 * report along with the highlights. Saturation is a property of the sensor
	 * and does not move when someone drags a control.
	 */
	async function scanFrame() {
		const reply = await call('diagnose',
			{ cfa: state.cfa, white: state.info.white, sigmas: 8,
				backgroundPercentile: bgPercent });
		const d = reply && reply.result;
		if (!d || !d.blackFloor)
			throw new Error('the frame was scanned but the reading came back empty');
		return d;
	}

	/*
	 * How far up from black the middle of the frame sits, 0 to 1.
	 *
	 * This is what says whether the lens is covered, and it is worth measuring
	 * rather than asking: an operator who believes the lens is covered and a
	 * lens that is covered are different things, and only one of them shows up
	 * in the numbers. Measured on this camera, a frame taken inside a black box
	 * reads 0.000 to 0.001 across exposures from 0.5 s to 7 s, while an
	 * ordinary lit scene reads 0.105. The cut below sits an order of magnitude
	 * clear of both, so nothing turns on where exactly it goes.
	 *
	 * The green plane, because it is the one with two sites in every quad and
	 * so the least noisy of the three.
	 */
	const COVERED = 0.01;
	function frameLevel(d) {
		if (!d || !d.median || !state.info) return null;
		const span = state.info.white - state.info.black;
		if (!(span > 0)) return null;
		return (d.median[1] - state.info.black) / span;
	}

	/* How many of the captures each site turned up in. A capture votes once,
	 * however many times the site appears in its own list. */
	function tallyOf(sets) {
		const t = new Map();
		for (const v of sets)
			for (const k of new Set(v.keys)) t.set(k, (t.get(k) || 0) + 1);
		return t;
	}

	/* Put the reading on screen into the set the tally runs over, replacing
	 * any earlier reading of the same frame rather than letting one capture
	 * vote twice. */
	function keepCurrentScan() {
		if (!diag) return;
		const keys = diag.defects.map((p) => p.x + ',' + p.y);
		/*
		 * Keyed on the frame that was opened, not on what it was called.
		 *
		 * A name is a display label and the contract does not require a host to
		 * vary it -- and when it does not, five captures collapse into one
		 * entry, the tally never sees a second vote, and a guided run ends
		 * having confirmed nothing at all. The case the old key existed for --
		 * reading one frame twice, which must not count twice -- is an open,
		 * so the open is what to count.
		 *
		 * Deduplicating on the READING rather than the open was tried, on the
		 * grounds that two captures of a real sensor never give byte-identical
		 * defect lists. They do not, but two other things do, and both matter:
		 * a fixture built to repeat the same view exactly, which is how the
		 * "these are following the picture" verdict is tested, and any pair of
		 * captures that find nothing at all, whose empty lists are equal. Both
		 * collapsed into a single capture and took the tally with them.
		 */
		scanSet = scanSet.filter((v) => v.id !== state.openId);
		scanSet.push({ id: state.openId, name: state.name || 'a frame', keys,
			/* Carried so the end of a run can say whether it saw everything. */
			truncated: !!diag.truncated, found: diag.defectCount });
	}

	function statLine(name, value, note) {
		const row = el('div');
		row.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin:3px 0';
		row.append(Object.assign(el('span', 're-rname'), { textContent: name }));
		row.append(Object.assign(el('span', 're-mono'), {
			textContent: value, style: 'font-size:12px;color:#e6e8ee',
		}));
		if (note) row.append(Object.assign(el('span', 're-note'), { textContent: note }));
		return row;
	}

	/*
	 * Clark-Evans, for a set assembled on this side.
	 *
	 * The engine computes this for the defects it finds; a set built from the
	 * tally across several captures is a different set and deserves the same
	 * question asked of it. Same definition: mean nearest-neighbour distance
	 * over what a random scattering of the same density would give.
	 */
	function spreadOf(pts, w, h) {
		if (!pts || pts.length < 3) return null;
		let sum = 0;
		for (const p of pts) {
			let best = Infinity;
			for (const q of pts) {
				if (q === p) continue;
				const d = (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y);
				if (d < best) best = d;
			}
			sum += Math.sqrt(best);
		}
		const area = w * h;
		const obs = sum / pts.length;
		const exp = 0.5 * Math.sqrt(area / pts.length);
		const se = 0.26136 / Math.sqrt(pts.length * pts.length / area);
		return { index: obs / exp, z: se > 0 ? (obs - exp) / se : 0, over: pts.length };
	}

	/*
	 * The deviation distribution, on a logarithmic axis.
	 *
	 * This is EMVA 1288's answer to "which pixels are defective", and it
	 * answers it by refusing the question: no single threshold serves every
	 * application, so the standard asks for the distribution and leaves the
	 * line to the reader. The log scale is the whole point -- it has to reach
	 * below one pixel per bin, or a single outlier is invisible against the
	 * four million ordinary ones beside it.
	 *
	 * The dashed curve is the Gaussian the frame's own spatial sigma implies.
	 * Where the bars follow it, the pixels are noise. Where they run above it
	 * -- the tails -- they are something else, and that is what a defect is.
	 */
	function deviationPlot(diag) {
		const d = diag.deviation;
		const wrap = el('div');
		wrap.style.cssText = 'margin:10px 0 2px';
		const W = 300, H = 104, PAD_L = 4, PAD_B = 14;
		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
		svg.setAttribute('class', 're-devplot');
		const ns = (t, a) => {
			const n = document.createElementNS('http://www.w3.org/2000/svg', t);
			for (const k in a) n.setAttribute(k, a[k]);
			return n;
		};
		const peak = Math.max(1, ...d.counts);
		const top = Math.log10(peak);
		// One pixel per bin is the floor worth drawing; below it there is
		// nothing to see and the axis would run to minus infinity.
		const yOf = (c) => {
			if (c < 1) return H - PAD_B;
			return H - PAD_B - (Math.log10(c) / top) * (H - PAD_B - 6);
		};
		const xOf = (i) => PAD_L + (i / (d.counts.length - 1)) * (W - PAD_L * 2);

		// Decade rules, so the log scale is readable as one.
		for (let p = 0; p <= Math.floor(top); p++) {
			const y = yOf(Math.pow(10, p));
			svg.append(ns('line', { x1: PAD_L, y1: y, x2: W - PAD_L, y2: y,
				stroke: 'currentColor', 'stroke-width': 0.5, opacity: 0.13 }));
		}
		for (let i = 0; i < d.counts.length; i++) {
			if (!d.counts[i]) continue;
			svg.append(ns('rect', { x: xOf(i), y: yOf(d.counts[i]),
				width: Math.max(0.8, (W - PAD_L * 2) / d.counts.length),
				height: Math.max(0.5, (H - PAD_B) - yOf(d.counts[i])),
				fill: 'currentColor', opacity: 0.55 }));
		}
		/*
		 * The Gaussian noise alone would give.
		 *
		 * Its width must come from the ORDINARY pixels, not from all of them.
		 * The plain standard deviation of this field is inflated by the very
		 * tails the curve exists to be compared against, so drawing it that way
		 * widens the reference until the outliers look like part of it -- which
		 * is the one thing the plot is for. EMVA 1288 takes its overlay from
		 * the spatial sigma after the correlated component has been filtered
		 * out, for the same reason.
		 *
		 * Estimated here from the median absolute deviation, read straight off
		 * the histogram: 1.4826 * MAD is the standard deviation of a Gaussian,
		 * and a few thousand wild values in four million cannot move a median.
		 */
		const quantile = (frac) => {
			let acc = 0;
			const want = d.total * frac;
			for (let i = 0; i < d.counts.length; i++) {
				acc += d.counts[i];
				if (acc >= want) return d.min + (i + 0.5) * d.binWidth;
			}
			return d.min + d.counts.length * d.binWidth;
		};
		const med = quantile(0.5);
		// The MAD, from the two quartiles: for a symmetric distribution the
		// half-interquartile range is the same statistic and needs one pass.
		const robust = Math.max(d.binWidth, (quantile(0.75) - quantile(0.25)) / 1.349);
		if (robust > 0 && d.binWidth > 0) {
			const pts = [];
			for (let i = 0; i < d.counts.length; i++) {
				const v = d.min + (i + 0.5) * d.binWidth - med;
				const p = d.total * (d.binWidth / (robust * Math.sqrt(2 * Math.PI))) *
					Math.exp(-(v * v) / (2 * robust * robust));
				if (p >= 1) pts.push(`${xOf(i).toFixed(1)},${yOf(p).toFixed(1)}`);
			}
			if (pts.length > 1)
				svg.append(ns('polyline', { points: pts.join(' '), fill: 'none',
					stroke: '#5c70e8', 'stroke-width': 1.2, 'stroke-dasharray': '3 2' }));
		}
		svg.append(ns('line', { x1: PAD_L, y1: H - PAD_B, x2: W - PAD_L, y2: H - PAD_B,
			stroke: 'currentColor', 'stroke-width': 0.5, opacity: 0.3 }));
		wrap.append(svg);
		const cap = el('div', 're-note');
		cap.style.cssText = 'display:flex;justify-content:space-between;font-size:10px';
		const edge = (d.counts.length / 2) * d.binWidth;
		cap.append(Object.assign(el('span'), { textContent: '−' + Math.round(edge) }),
			Object.assign(el('span'), { textContent: 'distance from neighbours' }),
			Object.assign(el('span'), { textContent: '+' + Math.round(edge) }));
		wrap.append(cap);
		wrap.append(Object.assign(el('p', 're-note'), {
			style: 'margin:6px 0 0',
			textContent: 'Every pixel, by how far it sits from its neighbours, counted on a ' +
				'logarithmic scale. The dashed curve is what noise alone would give. ' +
				'Everything beyond it is something else — on a frame with detail in it, ' +
				'mostly that detail. How far out a pixel has to be before it counts is a ' +
				'judgement, which is why the number above is not the whole answer.',
		}));
		return wrap;
	}

	function renderDiagnose(out) {
		out.hidden = false;
		out.replaceChildren();
		const i = state.info;
		const rgb = (a, f) => a.map(f).join('  ');

		out.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Defects</h3><span class="re-rule"></span>',
		}));
		/*
		 * What was found, and then -- separately -- what is on the picture.
		 *
		 * These used to be one sentence, and it named the wrong number: it
		 * quoted the stored list, up to 4096, while the overlay was drawing
		 * 600, and it only appeared at all when the store had overflowed. So
		 * the common case, a few thousand defects ringed six hundred at a
		 * time, said nothing whatsoever.
		 */
		const ringed = markedCount(diag.defects.length);
		out.append(Object.assign(el('p', 're-note'), {
			style: 'margin:0 0 7px',
			textContent: (diag.fromTally
				? `${diag.defectCount} site${diag.defectCount === 1 ? '' : 's'} turned up in at ` +
					`least ${diag.fromTally.need} of ${diag.fromTally.of} captures.`
				: diag.defectCount === 0
					? 'None. No pixel disagrees with all four of its neighbours by more than the noise explains.'
					: `${diag.defectCount} pixel${diag.defectCount === 1 ? '' : 's'} disagree with every ` +
						'one of their same-colour neighbours by more than the noise explains.')
				+ (ringed < diag.defects.length
					? (diag.truncated
						/*
						 * Not "through the frame" when the store stopped short.
						 * The rings sample the list evenly, but the list itself
						 * ends at the row the scan filled up on, so the bottom
						 * of the picture carries none -- and saying otherwise
						 * would be the same overstatement this cap was fixed
						 * for in the first place.
						 */
						? ` Rings mark ${ringed} of the ${diag.defects.length} it kept, ` +
							'spread through the part of the frame it reached.'
						: ` Rings mark ${ringed} of them, spread through the frame.`) : ''),
		}));
		if (diag.truncated)
			out.append(Object.assign(el('div', 're-notice re-warn'), {
				style: 'margin:0 0 8px',
				textContent: `The scan kept ${diag.defects.length} of them and stopped there, so ` +
					'the arrangement below was judged over the part of the frame it reached ' +
					'rather than all of it. Looking only where the picture is dark brings the ' +
					'count down, and a frame with the lens covered brings it down furthest.',
			}));

		/*
		 * How that count is spread over the frame.
		 *
		 * A count on its own says very little -- Sony ships an IMX415 as good
		 * with up to 800 white pixels in the dark -- and it says nothing at
		 * all about whether the scan found silicon or scenery. Hot pixels are
		 * created by a random process and land at random; anything driven by
		 * the picture sits where the picture had detail. So the arrangement is
		 * reported next to the number, because it is the part that says
		 * whether the number can be believed.
		 */
		const spread = diag.fromTally
			? spreadOf(diag.defects, state.info.width, state.info.height)
			: diag.spread;
		if (spread) {
			const R = spread.index;
			const scenery = R < 0.8, random = R >= 0.8 && R <= 1.25;
			out.append(statLine('spread', R.toFixed(2),
				random ? 'scattered, as sensor defects are'
					: scenery ? 'clustered — these are following the picture'
						: 'unusually even'));
			if (scenery)
				out.append(Object.assign(el('div', 're-notice re-warn'), {
					style: 'margin:8px 0 2px',
					textContent: 'These are not scattered the way sensor defects are. ' +
						'Most of them are probably detail in the scene. Scan a second, ' +
						'different view and compare, or point the camera at something plain.',
				}));
		}
		if (diag.backgroundCut)
			out.append(statLine('reading', 'below ' + Math.round(diag.backgroundCut),
				'only where the picture is dark'));

		out.append(deviationPlot(diag));

		/*
		 * Two captures of different views, intersected.
		 *
		 * This is the only thing here that reliably separates silicon from
		 * scenery without capping the lens, and the reason is that a sensor
		 * defect does not care what the camera is pointed at. Measured on a
		 * lab camera: 291 candidates in one view, 86 in another, 4 in both.
		 *
		 * Frames of the SAME view do not do it -- a static scene keeps its
		 * texture as faithfully as it keeps its defects, and three frames of
		 * one room agreed on 61 sites of which 57 left with the furniture.
		 */
		out.append(Object.assign(el('div', 're-shead'), {
			style: 'margin-top:14px',
			innerHTML: '<h3 class="re-cap">Compare</h3><span class="re-rule"></span>',
		}));
		/*
		 * How many captures each site turned up in.
		 *
		 * A strict intersection is the obvious rule and it is too harsh. Hot
		 * pixels and random-telegraph pixels are largely one population -- a
		 * 2023 study of a backside-illuminated sensor found every hot pixel it
		 * measured also showed RTS -- and an RTS site switches between discrete
		 * levels, so it need not clear the threshold in every frame. Requiring
		 * it to appear in all of them drops exactly those.
		 *
		 * So the rule is N of M, which is what the SFU group use for cameras
		 * that cannot produce raw: they ask for a candidate in at least three
		 * of six images. The tally is shown in full, because where the numbers
		 * fall is itself the answer -- a population that appears once each and
		 * never again is the scene, and one that keeps coming back is not.
		 */
		const held = scanSet.filter((v) => v.id !== state.openId);
		const all = held.concat([{ name: state.name || 'this frame',
			keys: diag.defects.map((p) => p.x + ',' + p.y) }]);
		const M = all.length;
		if (M < 2) {
			out.append(Object.assign(el('p', 're-note'), {
				style: 'margin:0 0 8px',
				textContent: 'One capture cannot tell a bad pixel from a noisy one or from ' +
					'a speck of detail. Keep this scan and take about five in all, moving ' +
					'the camera between them if you can.',
			}));
		} else {
			const tally = tallyOf(all);
			const atLeast = (n) => [...tally].filter(([, c]) => c >= n).map(([k]) => k);
			const suggested = Math.max(2, Math.ceil(M * 0.8));
			if (needN > M) needN = M;
			if (needN < 2) needN = 2;
			if (!needTouched) needN = suggested;

			out.append(Object.assign(el('p', 're-note'), {
				style: 'margin:0 0 7px',
				textContent: `Across ${M} captures: ` + all.map((v) => v.name).join(', ') + '.',
			}));
			// The tally, exactly: how many sites turned up in how many captures.
			const tbl = el('div');
			tbl.style.cssText = 'margin:0 0 9px';
			for (let n = M; n >= 1; n--) {
				const exactly = [...tally].filter(([, c]) => c === n).length;
				tbl.append(statLine(n === M ? 'in all ' + M : 'in ' + n + ' of ' + M,
					String(exactly), n === 1 ? 'seen once and never again' : ''));
			}
			out.append(tbl);

			const seg = el('div', 're-seg');
			seg.style.cssText = 'margin-bottom:8px;flex-wrap:wrap';
			for (let n = 2; n <= M; n++) {
				const b = el('button', n === needN ? 'on' : '', n + ' of ' + M);
				b.dataset.act = 'need-' + n;
				b.addEventListener('click', () => { needN = n; needTouched = true; renderDiagnose(out); });
				seg.append(b);
			}
			out.append(Object.assign(el('div', 're-rname'), { textContent: 'believe a site seen in' }));
			out.append(seg);

			const keys = atLeast(needN);

			/*
			 * What the evidence so far actually supports.
			 *
			 * There are two ways this measurement goes wrong and they need
			 * opposite remedies, so the operator should not have to work out
			 * which one they are in. Both are visible in the numbers already
			 * to hand.
			 *
			 * Noise puts a different set of sites over the threshold every
			 * time, so it shows up as a large population seen in exactly one
			 * capture. More captures fix that; it is what they are for.
			 *
			 * Detail in the picture does the opposite. It is in the same place
			 * in every capture of the same view, so it survives any number of
			 * them -- and no amount of repeating will shift it. What gives it
			 * away is its arrangement: scene detail clumps where the picture
			 * had detail, while defects are scattered at random. Only moving
			 * the camera removes it.
			 *
			 * Measured on two cameras: an old jxf22 with 36 real defects reads
			 * 60 of 116 sites seen once -- noise -- and its survivors come back
			 * randomly scattered. An IMX335 pointed at a furnished room reads
			 * almost nothing seen once, and survivors clustered at 0.52: all
			 * chair, no sensor.
			 */
			const pts = keys.map((k) => {
				const [x, y] = k.split(',').map(Number);
				return { x, y };
			});
			// Below about twenty points the nearest-neighbour index is noise
			// itself, and edge effects push it high, so it is not reported.
			const sp = pts.length >= 20
				? spreadOf(pts, state.info.width, state.info.height) : null;
			/*
			 * Judged on the SURVIVORS, not on how much was discarded.
			 *
			 * A tail of sites seen once and never again is normal and says
			 * nothing: it is noise finding a different way over the threshold
			 * each time, and discarding it is what the tally is for. Counting
			 * it as evidence of trouble condemns every measurement -- on the
			 * old camera whose answer is known good it is 60 sites of 116, and
			 * a rule keyed to that refused a correct reading.
			 */
			let verdict = null;
			if (M < 3)
				verdict = ['re-warn', 'Two captures cannot separate a bad pixel from a lucky ' +
					'one. Take about five, moving the camera between them if you can.'];
			else if (sp && sp.index < 0.8)
				verdict = ['re-warn', 'These keep coming back, but they are clumped rather than ' +
					'scattered, which is what detail in the picture looks like and not what a ' +
					'sensor looks like. Repeating the same view will not shift them — move the ' +
					'camera, or point it at something plain, and scan again.'];
			else if (sp)
				verdict = ['re-ok', 'These keep coming back and are scattered at random across ' +
					'the frame, which is what sensor defects look like.'];
			else if (pts.length)
				verdict = ['re-ok', `${pts.length} site${pts.length === 1 ? '' : 's'} came ` +
					`through every capture. Too few to judge how they are arranged, but ` +
					`surviving a change of view is the strongest evidence there is.`];
			else
				verdict = ['re-warn', 'Nothing appeared in enough captures to be believed. ' +
					'On a healthy sensor that is the right answer; if you expected defects, ' +
					'ask for fewer captures above, or take more.'];
			if (verdict) {
				const box = el('div', 're-notice ' + verdict[0], ICON.warn);
				box.style.cssText = 'margin:2px 0 9px';
				box.append(Object.assign(el('div'), { textContent: verdict[1] }));
				out.append(box);
			}

			const mark = el('button', 're-btn re-pri', '');
			mark.dataset.act = 'mark-common';
			mark.textContent = 'Mark those ' + keys.length;
			mark.disabled = keys.length === 0;
			mark.addEventListener('click', () => {
				/*
				 * The marks come from the tally, not from this frame's own
				 * list. A site that cleared the threshold in three captures out
				 * of four is a defect whether or not it cleared it in the one
				 * on screen -- and if it had to be in the current frame's list
				 * too, the rule would be an intersection again.
				 */
				diag = { ...diag, defects: pts, defectCount: pts.length, truncated: false,
					fromTally: { need: needN, of: M } };
				renderDiagnose(out);
				drawMarks();
			});
			out.append(mark);
		}

		const row = el('div');
		row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px';
		const keep = el('button', 're-btn', '');
		keep.dataset.act = 'hold-scan';
		const already = scanSet.some((v) => v.id === state.openId);
		keep.textContent = already ? 'Kept' : 'Keep this scan';
		keep.disabled = already;
		keep.addEventListener('click', () => {
			keepCurrentScan();
			renderDiagnose(out);
		});
		row.append(keep);
		if (scanSet.length) {
			const clear = el('button', 're-btn', '');
			clear.textContent = 'Forget ' + scanSet.length;
			clear.addEventListener('click', () => { scanSet = []; renderDiagnose(out); });
			row.append(clear);
		}
		out.append(row);

		out.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Black level</h3><span class="re-rule"></span>',
		}));
		out.append(statLine('file', String(i.black), 'what the DNG says'));
		out.append(statLine('frame', rgb(diag.blackFloor, (v) => v.toFixed(0).padStart(5)),
			'the darkest the frame really gets, per plane'));
		const floor = Math.min(...diag.blackFloor);
		out.append(Object.assign(el('p', 're-note'), {
			style: 'margin:5px 0 0',
			textContent: floor + 2 < i.black
				? 'The file claims a higher pedestal than the frame reaches, which clips the ' +
					'shadows to black. Worth checking against a lens-cap frame.'
				: 'Consistent with the file, as far as this frame can say — a scene with ' +
					'nothing truly dark in it cannot say much.',
		}));

		out.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Clipping</h3><span class="re-rule"></span>',
		}));
		out.append(statLine('R G B', rgb(diag.clipped, (v) => pct(v).padStart(7)),
			'at or above ' + i.white));

		out.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Noise</h3><span class="re-rule"></span>',
		}));
		out.append(statLine('R G B', rgb(diag.noise, (v) => v.toFixed(1).padStart(6)),
			'counts, one sigma'));
		out.append(Object.assign(el('p', 're-note'), {
			style: 'margin:5px 0 0',
			textContent: 'A median of local differences, so an edge in the frame does not ' +
				'read as noise' + (i.iso ? `. This frame is ISO ${i.iso}.` : '.'),
		}));
	}

	/* ---- calibrate -------------------------------------------------------
	 *
	 * Four corners dragged onto a colour chart, twenty-four patches read off
	 * the mosaic through them, and two matrices solved from the result. The
	 * solving lives in calibrate.js, which knows nothing about the DOM; this
	 * part is the corners, the numbers on screen, and the way back.
	 */
	let mode = 'develop';
	/* Which part of the frame the defect scan is allowed to believe, as a
	 * percentile of frame brightness. 100 is all of it. */
	let opened = 0;
	/* The guided run, or null when nobody asked for one. See buildHunt. */
	let hunt = null;
	let bgPercent = 100;
	/* Scans kept for comparison, each one a capture's defect set. They outlive
	 * the frames they came from, which is the whole point: a sensor defect is
	 * a property of the sensor and should survive every view of it. */
	let scanSet = [];
	/* How many captures a site must appear in before it is believed, and
	 * whether that was the operator's choice or this module's suggestion. */
	let needN = 2;
	let needTouched = false;

	let corners = null;          /* in frame coordinates */
	/* Whether this frame has been looked at yet. Per frame, so flipping back
	 * to Calibrate does not search again over corners someone has since
	 * dragged, and a new frame gets its own look. */
	let chartTried = false;
	let solved = null;
	/* The lights measured so far, one entry per chart shot someone chose to
	 * keep. Survives opening another frame, because the next light is the
	 * next frame. */
	const session = [];
	const chart = el('div', 're-chart');
	chart.hidden = true;
	stage.append(chart);

	/* The focus heatmap. Its own layer rather than a mode of the chart overlay:
	 * the chart draws where a person put something, this draws what the camera
	 * measured, and the two are never on screen together. */
	const focusMarks = el('div', 're-chart');
	focusMarks.hidden = true;
	stage.append(focusMarks);

	function defaultCorners() {
		const w = state.info?.width || 0, h = state.info?.height || 0;
		// A quad over the middle third, which is where someone holding a chart
		// up to a camera puts it.
		return [[w * 0.3, h * 0.35], [w * 0.7, h * 0.35],
			[w * 0.7, h * 0.72], [w * 0.3, h * 0.72]];
	}

	/*
	 * The overlay is built ONCE and afterwards only moved.
	 *
	 * It used to be rebuilt on every pointermove, which made the corners
	 * undraggable: replacing the node under the pointer destroys the element
	 * holding the pointer capture, so the corner jumped to wherever the first
	 * move landed and then stopped following. The drag also listens on the
	 * window rather than the grip, so it survives anything that does replace
	 * the overlay mid-gesture.
	 */
	let chartParts = null;

	function buildChartOnce() {
		if (chartParts) return chartParts;
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('class', 're-chart-svg');
		const quad = document.createElementNS(NS, 'polygon');
		quad.setAttribute('class', 're-chart-quad');
		svg.append(quad);
		const cells = [];
		for (let i = 0; i < CHART_COLS * CHART_ROWS; i++) {
			const c = document.createElementNS(NS, 'circle');
			c.setAttribute('class', 're-chart-cell');
			svg.append(c);
			cells.push(c);
		}
		chart.append(svg);

		const grips = [];
		for (let i = 0; i < 4; i++) {
			const g = el('div', 're-chart-grip');
			g.dataset.corner = String(i);
			g.title = ['top left', 'top right', 'bottom right', 'bottom left'][i];
			g.addEventListener('pointerdown', (ev) => {
				ev.preventDefault();
				// Listening on the window means hearing every pointer on it, so
				// the gesture has to name its own: two fingers on two corners
				// otherwise drive each other and the first one lifted ends both.
				const id = ev.pointerId;
				const move = (e) => {
					if (e.pointerId !== id) return;
					const at = frameCoords(e);
					if (!at || !corners) return;
					corners[i] = [at.x, at.y];
					positionChart();
				};
				const up = (e) => {
					if (e.pointerId !== id) return;
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', up);
					window.removeEventListener('pointercancel', up);
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', up);
				window.addEventListener('pointercancel', up);
			});
			chart.append(g);
			grips.push(g);
		}
		chartParts = { quad, cells, grips };
		return chartParts;
	}

	function positionChart() {
		if (mode !== 'calibrate' || !corners || !state.info || !chartParts) return;
		const pts = corners.map(([x, y]) => stageCoords(x, y));
		if (pts.some((p) => !p)) return;
		chartParts.quad.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));

		let cells = [];
		try { cells = patchCentres(corners); } catch { cells = []; }
		const t = viewTransform();
		chartParts.cells.forEach((dot, i) => {
			const c = cells[i];
			const at = c && stageCoords(c.x, c.y);
			if (!at) { dot.setAttribute('r', 0); return; }
			dot.setAttribute('cx', at.x);
			dot.setAttribute('cy', at.y);
			dot.setAttribute('r', Math.max(2, (c.radius / (t?.step || 1)) * (t?.scale || 1)));
		});
		chartParts.grips.forEach((g, i) => {
			g.style.left = pts[i].x + 'px';
			g.style.top = pts[i].y + 'px';
		});
	}

	function drawChart() {
		if (mode !== 'calibrate' || !corners || !state.info) return;
		buildChartOnce();
		positionChart();
	}

	async function measureChart() {
		if (!corners) return;
		const cells = patchCentres(corners);
		const patches = [], clipped = [];
		for (const c of cells) {
			const got = await call('sample', {
				x: c.x, y: c.y, radius: Math.max(4, Math.round(c.radius)),
				black: state.black, cfa: state.cfa,
			});
			patches.push(got.raw);
			clipped.push(got.clipped || 0);
		}
		return solveFromPatches(patches, {
			clipped,
			colorMatrices: state.info && state.info.colorMatrices,
		});
	}

	/* The panel, and the way back.
	 *
	 * Writing a colour matrix to a camera is not like changing a setting in a
	 * file: it persists, and a bad one makes the picture unwatchable, so the
	 * camera comes back from a reboot still wrong. This is the display-
	 * resolution bargain -- apply it, start a clock, and put it back unless
	 * someone says they can still see. The host does the applying and the
	 * reverting; the clock and the question live here, where the picture is.
	 */
	let holdTimer = null, holdTick = null;
	/* How the countdown in progress ends, while there is one. One at a time:
	 * revert() and keep() answer for whatever was written LAST, so a second
	 * write under a running countdown would have the first one's timer put
	 * the second one back. */
	let holdEnd = null;

	/* A hold that has been ended but whose revert or confirmation is still
	 * travelling. stopHold() clears holdEnd the moment finish() starts, so
	 * holdEnd alone says "nothing is waiting to be confirmed" while the camera
	 * is still being put back -- and a write admitted in that window is undone
	 * by the older request landing after it, leaving the camera on what it had
	 * before and the panel showing a countdown for something else. */
	let holdSettling = false;

	function stopHold() {
		if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
		if (holdTick) { clearInterval(holdTick); holdTick = null; }
		holdEnd = null;
	}

	/* The panel holding the countdown is going away -- another mode, a fresh
	 * Calibrate panel. Nobody can confirm a change they can no longer see, so
	 * it ends the way the clock would have ended it: put back. */
	function abandonHold() {
		if (holdEnd) holdEnd(true);
	}

	/* Refuse a second write while one is waiting to be confirmed or put back,
	 * and say so where the button was pressed. */
	function busyHolding(where) {
		if (!holdEnd && !holdSettling) return false;
		const box = el('div', 're-notice re-warn', ICON.warn);
		box.append(Object.assign(el('div'), {
			textContent: holdEnd
				? 'The last change is still waiting — keep it or put it back first.'
				: 'The last change is still being put back — try again in a moment.',
		}));
		where.append(box);
		return true;
	}

	function buildCalibrate() {
		abandonHold();
		insp.replaceChildren();
		const panel = el('div', 're-panel');
		panel.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Colour chart</h3><span class="re-rule"></span>',
		}));
		panel.append(Object.assign(el('p', 're-note'), {
			textContent: 'The chart is looked for as soon as this opens. Drag any corner ' +
				'that sits off it — the dark skin patch belongs at the top left, the black ' +
				'patch at the bottom right — and the dots show where each patch will be ' +
				'read from.',
		}));
		const out = el('div', 're-panel');
		out.hidden = true;

		const row = el('div');
		row.style.cssText = 'display:flex;gap:8px;margin-top:9px;flex-wrap:wrap';
		const measure = el('button', 're-btn re-pri', '');
		measure.dataset.act = 'measure';
		measure.textContent = 'Measure the chart';
		const find = el('button', 're-btn', '');
		// A handle that does not move: the label is 'Looking…' for as long as
		// it is looking, which is from the moment Calibrate opens.
		find.dataset.act = 'find-chart';
		find.textContent = 'Look again';
		const reset = el('button', 're-btn', '');
		reset.textContent = 'Reset corners';
		reset.addEventListener('click', () => { corners = defaultCorners(); drawChart(); });
		row.append(measure, find, reset);
		panel.append(row);
		insp.append(panel);
		insp.append(out);
		sessionBox = el('div', 're-panel');
		insp.append(sessionBox);
		renderSession();

		/*
		 * The corners, without the dragging.
		 *
		 * It only ever offers an answer: whatever it finds lands on the same
		 * four grips, which stay draggable, so a near miss is a starting point
		 * rather than something to undo. When it finds nothing it says so and
		 * changes nothing -- the default corners already on screen are better
		 * than a guess fitted to the furniture, and dragging them is the way
		 * through.
		 *
		 * Run on its own when Calibrate is first opened on a frame, and by the
		 * button after that -- which is why the button says "Look again"
		 * rather than offering to look in the first place.
		 */
		const say = (cls, text) => {
			out.hidden = false;
			out.replaceChildren(Object.assign(el('div', 're-notice ' + cls, ICON.warn), {}));
			out.firstChild.append(Object.assign(el('div'), { textContent: text }));
		};
		async function runFind() {
			if (find.disabled) return;
			find.disabled = true;
			find.textContent = 'Looking…';
			try {
				const got = await call('detect', { cfa: state.cfa });
				if (!got.chart) {
					say('re-warn', 'No chart found in this frame — drag the four corners ' +
						'onto it by hand. If there is one and it was missed, capture again ' +
						'with the chart flatter on or better lit, then Look again.');
				} else {
					corners = got.chart.corners;
					solved = null;
					drawChart();
					out.hidden = true;
					// A chart short of its full 24 is still worth offering, but
					// the corners came off fewer patches and are correspondingly
					// looser, so say so rather than let it read as exact.
					if (got.chart.cells < CHART_COLS * CHART_ROWS)
						say('re-warn', `Found the chart, but only ${got.chart.cells} of its ` +
							`${CHART_COLS * CHART_ROWS} patches stood out clearly. Check the ` +
							'corners before measuring.');
				}
			} catch (e) {
				say('re-warn', e.message);
			} finally {
				find.disabled = false;
				find.textContent = 'Look again';
			}
		}
		find.addEventListener('click', () => runFind());

		// The first look at a frame, taken without being asked. Only once per
		// frame: after that the corners may be somewhere a person put them.
		if (state.info && !chartTried) {
			chartTried = true;
			runFind();
		}

		measure.addEventListener('click', async () => {
			measure.disabled = true;
			measure.textContent = 'Measuring…';
			try {
				solved = await measureChart();
				renderSolved(out);
			} catch (e) {
				out.hidden = false;
				out.replaceChildren(Object.assign(el('div', 're-notice re-warn', ICON.warn), {}));
				out.firstChild.append(Object.assign(el('div'), { textContent: e.message }));
			} finally {
				measure.disabled = false;
				measure.textContent = 'Measure the chart';
			}
		});
	}

	function matrixTable(m) {
		const t = el('div', 're-mono');
		t.style.cssText = 'font-size:11px;line-height:1.6;margin-top:5px;color:#b6b9c2';
		for (let r = 0; r < 3; r++)
			t.append(Object.assign(el('div'), {
				textContent: [0, 1, 2].map((c) => m[r * 3 + c].toFixed(4).padStart(8)).join(' '),
			}));
		return t;
	}

	function renderSolved(out) {
		out.hidden = false;
		out.replaceChildren();
		out.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Result</h3><span class="re-rule"></span>',
		}));
		const fit = el('p', 're-note');
		fit.style.margin = '0 0 6px';
		// ΔE2000, which is what the fit minimises; ΔE76 alongside because it
		// is the number most published figures quote.
		const left = 24 - solved.fit.patches;
		fit.textContent = `Mean ΔE2000 ${solved.fit.meanDeltaE.toFixed(2)}, worst ` +
			`${solved.fit.maxDeltaE.toFixed(2)} (ΔE76 mean ${solved.fit.meanDeltaE76.toFixed(1)}). ` +
			'Under 2 is a good fit for a 3×3; a spiky light — most LEDs — will not do ' +
			'better, whatever the chart.' +
			(left ? ` ${left} patch${left > 1 ? 'es were' : ' was'} left out as clipped or unlit.` : '');
		out.append(fit);
		if (solved.light) {
			const lt = el('p', 're-note');
			lt.style.margin = '0 0 6px';
			lt.dataset.role = 'light';
			const duv = solved.light.duv;
			lt.textContent = `Light: about ${Math.round(solved.light.cct / 10) * 10} K` +
				(duv === null || duv === undefined ? '' : duv > 0.006 ? ', greenish — well off daylight' :
					duv < -0.006 ? ', magenta — well off daylight' : '') +
				', read off the camera\'s own colour matrices.';
			out.append(lt);
		}

		out.append(Object.assign(el('h3', 're-cap'), { textContent: 'Live matrix, camera to display' }));
		out.append(matrixTable(solved.ccm));
		out.append(Object.assign(el('h3', 're-cap'), { textContent: 'ColorMatrix1, XYZ to camera' }));
		out.append(matrixTable(solved.colorMatrix));

		const acts = el('div');
		acts.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
		const useHere = el('button', 're-btn', '');
		useHere.textContent = 'Use its white balance here';
		useHere.addEventListener('click', () => {
			state.neutral = solved.neutral.slice();
			setMode('develop');
			commit();
		});
		acts.append(useHere);

		if (calibrate && calibrate.apply) {
			const send = el('button', 're-btn re-pri', '');
			send.dataset.act = 'apply-to-camera';
			send.textContent = 'Apply to the camera';
			send.addEventListener('click', () => applyToCamera(out, send));
			acts.append(send);
		}
		out.append(acts);
		recordRow(out);
	}

	async function applyToCamera(out, send) {
		if (busyHolding(out)) return;
		const hold = Math.max(5, calibrate.holdSeconds || 30);
		send.disabled = true;
		try {
			await calibrate.apply({
				colorMatrix: solved.colorMatrix.slice(),
				ccm: solved.ccm.slice(),
				neutral: solved.neutral.slice(),
			});
		} catch (e) {
			send.disabled = false;
			const box = el('div', 're-notice re-warn', ICON.warn);
			box.append(Object.assign(el('div'), { textContent: e.message }));
			out.append(box);
			return;
		}

		armHold(out, send, hold, 'Applied to the camera.', calibrate);
	}

	/*
	 * From here the camera is carrying something new and something must take
	 * it back. The countdown is the default; confirming is the exception,
	 * which is the right way round for a change that can make the picture
	 * unwatchable.
	 */
	/* `host` supplies revert() and an optional keep(). It was `calibrate`
	 * implicitly until the Focus tab grew something to write, and a hold that
	 * put back the wrong thing would be worse than one that did nothing. */
	function armHold(out, send, hold, applied, host) {
		const bar = el('div', 're-notice re-warn', ICON.warn);
		bar.dataset.act = 'hold';
		const text = el('div');
		bar.append(text);
		out.append(bar);
		let left = hold;
		const paint = () => {
			text.textContent = `${applied} Putting it back in ${left}s ` +
				'unless you confirm the picture still looks right.';
		};
		paint();

		const keep = el('button', 're-btn re-pri re-sm', '');
		keep.dataset.act = 'keep';
		keep.textContent = 'Keep it';
		const back = el('button', 're-btn re-sm', '');
		back.dataset.act = 'revert';
		back.textContent = 'Put it back';
		const acts = el('div');
		acts.style.cssText = 'display:flex;gap:8px;margin-top:8px';
		acts.append(keep, back);
		bar.append(acts);

		let finished = false;
		const finish = async (revert) => {
			/* Once. Keep and Put-it-back are both live until one is pressed, and
			 * the clock can fire between the click and the first await -- two
			 * entries send a persist and a rollback at the same time and the
			 * camera keeps whichever answered last, which is not what the panel
			 * then says happened. */
			if (finished) return;
			finished = true;
			/* Only a revert. A confirmation in flight leaves the camera on what
			 * it already shows, so a write behind it is harmless; a revert is
			 * travelling to put the camera BACK, and a write admitted before it
			 * lands is undone by it. */
			if (revert) holdSettling = true;
			keep.disabled = true;
			back.disabled = true;
			stopHold();
			acts.remove();
			if (revert) {
				text.textContent = 'Putting it back…';
				try {
					await host.revert();
					text.textContent = 'Put back. The camera is on what it had before.';
				} catch (e) {
					text.textContent = 'Could not put it back: ' + e.message;
				}
				holdSettling = false;
				send.disabled = false;
				return;
			}

			/*
			 * Confirming is only real once the host has been told. It is the
			 * host's single signal to stand down whatever it armed to undo
			 * this, so saying "kept" when that signal failed to arrive would
			 * be the worst answer available: the operator stops watching, and
			 * the change is taken back anyway.
			 */
			if (host.keep) {
				text.textContent = 'Confirming…';
				try {
					await host.keep();
				} catch (e) {
					bar.append(acts);
					keep.disabled = false;
					back.disabled = false;
					finished = false;
					text.textContent = 'Applied, but confirming did not reach the camera: ' +
						e.message + ' It may still be put back on its own — try again.';
					send.disabled = false;
					return;
				}
			}
			bar.classList.remove('re-warn');
			/* Only a host with a keep() can make anything survive a restart.
			 * Saying so without one tells an operator their tuning is safe when
			 * the next power cycle will take it away. */
			text.textContent = host.keep
				? 'Kept. The camera will use this after a restart too.'
				: 'Kept for now. This camera cannot save it, so a restart '
					+ 'brings back what it had.';
			send.disabled = false;
		};
		keep.addEventListener('click', () => finish(false));
		back.addEventListener('click', () => finish(true));
		holdEnd = finish;
		holdTick = setInterval(() => { left--; if (left > 0) paint(); }, 1000);
		holdTimer = setTimeout(() => finish(true), hold * 1000);
	}

	/* ---- a calibration across lights --------------------------------------
	 *
	 * One chart shot gives a matrix for one light. The camera runs on a set:
	 * white balance at a reference temperature, the curve auto white balance
	 * follows away from it, and a matrix per temperature that it blends
	 * between. So each measured light can be kept, and once there are enough
	 * the set is built -- fitted to the lights measured, and falling back on
	 * the camera's own values for anything nobody measured -- and compared,
	 * light by light, with what the camera does now.
	 */
	function recordRow(out) {
		const row = el('div');
		row.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center';
		const ct = el('input', 're-in');
		ct.type = 'number'; ct.min = '1500'; ct.max = '15000'; ct.step = '10';
		ct.style.width = '7em';
		ct.dataset.role = 'record-ct';
		ct.title = 'The light\'s colour temperature, in kelvin';
		if (solved.light) ct.value = String(Math.round(solved.light.cct / 10) * 10);
		const add = el('button', 're-btn', '');
		add.dataset.act = 'record';
		add.textContent = 'Keep this light';
		add.addEventListener('click', () => {
			const k = Number(ct.value);
			if (!(k >= 1500 && k <= 15000)) {
				ct.focus();
				ct.setCustomValidity('between 1500 and 15000 K');
				ct.reportValidity();
				return;
			}
			/* Two lights at one temperature are one light measured twice: the
			 * curve cannot be fitted through them, and the camera would be
			 * handed two matrices to blend at the same point. */
			const near = session.find((r) => Math.abs(r.ct - k) < 300);
			if (near) {
				ct.setCustomValidity(`a light at ${near.ct} K is already kept — drop it first`);
				ct.reportValidity();
				return;
			}
			ct.setCustomValidity('');
			session.push({
				ct: k, neutral: solved.neutral.slice(), ccm: solved.ccm.slice(),
				balanced: solved.balanced, weights: solved.weights, fit: solved.fit,
			});
			add.disabled = true;
			add.textContent = 'Kept';
			renderSession();
		});
		row.append(Object.assign(el('span', 're-note'), { textContent: 'Light at' }), ct,
			Object.assign(el('span', 're-note'), { textContent: 'K' }), add);
		out.append(row);
	}

	let sessionBox = null;

	function renderSession() {
		if (!sessionBox) return;
		sessionBox.replaceChildren();
		sessionBox.hidden = !session.length;
		if (!session.length) return;
		sessionBox.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Lights kept</h3><span class="re-rule"></span>',
		}));
		session.forEach((r, i) => {
			const line = el('div', 're-mono');
			line.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:11px;margin:3px 0';
			line.dataset.role = 'kept-light';
			line.append(Object.assign(el('span'), {
				textContent: `${r.ct} K · ΔE2000 ${r.fit.meanDeltaE.toFixed(2)}`,
			}));
			const drop = el('button', 're-btn re-sm', '');
			drop.textContent = 'Drop';
			drop.addEventListener('click', () => { session.splice(i, 1); renderSession(); });
			line.append(drop);
			sessionBox.append(line);
		});
		const note = el('p', 're-note');
		note.textContent = session.length < 2
			? 'One light fixes the white balance there and its matrix; the curve between ' +
				'lights stays the camera\'s own. Keep a second, as far away in temperature ' +
				'as you can — daylight and a warm lamp — and the curve is fitted too.'
			: `${session.length} lights. Lights far apart in temperature pin the curve best.`;
		sessionBox.append(note);
		if (!(calibrate && calibrate.baseline)) {
			sessionBox.append(Object.assign(el('p', 're-note'), {
				textContent: 'Building a profile needs the camera\'s own colour calibration, ' +
					'which this page was not given a way to read.',
			}));
			return;
		}
		const build = el('button', 're-btn re-pri', '');
		build.dataset.act = 'build-profile';
		build.textContent = 'Build the camera profile';
		const result = el('div');
		build.addEventListener('click', async () => {
			build.disabled = true;
			try {
				buildProfile(result, readColour(parseIni(await calibrate.baseline())));
			} catch (e) {
				result.replaceChildren(Object.assign(el('div', 're-notice re-warn', ICON.warn), {}));
				result.firstChild.append(Object.assign(el('div'), { textContent: e.message }));
			} finally {
				build.disabled = false;
			}
		});
		sessionBox.append(build, result);
	}

	/* A vendor table set, blended at a temperature the way the camera blends
	 * it: linearly between the two tables either side, the end ones held. */
	function vendorCcmAt(tables, ct) {
		const t = tables.slice().sort((a, b) => b.ct - a.ct);
		if (ct >= t[0].ct) return t[0].matrix;
		if (ct <= t[t.length - 1].ct) return t[t.length - 1].matrix;
		for (let i = 0; i + 1 < t.length; i++)
			if (ct <= t[i].ct && ct >= t[i + 1].ct) {
				const w = (ct - t[i + 1].ct) / (t[i].ct - t[i + 1].ct);
				return t[i].matrix.map((v, k) => w * v + (1 - w) * t[i + 1].matrix[k]);
			}
		return t[0].matrix;
	}

	function buildProfile(result, vendor) {
		if (!vendor.staticWb || !vendor.curve || !vendor.ccm)
			throw new Error('The camera did not hand back its colour calibration — its ' +
				'firmware predates exporting [static_awb] and [static_ccm].');
		const awb = fitAwbCurve(session.map((r) => ({
			ct: r.ct, r: 1 / r.neutral[0], b: 1 / r.neutral[2],
		})), vendor);
		const tables = mergeCcmTables(session.map((r) => ({ ct: r.ct, matrix: r.ccm })), vendor.ccm);
		const ini = colourFragment({ staticWb: awb.staticWb, curve: awb.curve, tables });

		/* Light by light: what the camera does there today, and what this
		 * would do. Colour on the same balanced patches by the same rule; white
		 * balance as how far the gains the curve gives are from the gains that
		 * made that chart's grey grey. */
		result.replaceChildren();
		const tbl = el('div', 're-mono');
		tbl.dataset.role = 'profile-compare';
		tbl.style.cssText = 'font-size:11px;line-height:1.7;margin-top:8px;color:#b6b9c2';
		tbl.append(Object.assign(el('div'), {
			textContent: 'light     ΔE2000 now → new    white balance off now → new',
		}));
		const pct = (got, want) => Math.max(...got.map((g, k) => Math.abs(g / want[k] - 1))) * 100;
		for (const r of session) {
			const before = scoreCcm(vendorCcmAt(vendor.ccm, r.ct), r.balanced, r.weights).meanDeltaE;
			const want = [1 / r.neutral[0], 1 / r.neutral[2]];
			const gv = gainsForCt(Math.round(r.ct), vendor.staticWb, vendor.curve, { normalise: false });
			const gn = gainsForCt(Math.round(r.ct), awb.staticWb, awb.curve, { normalise: false });
			tbl.append(Object.assign(el('div'), {
				textContent: `${String(r.ct).padEnd(6)} K  ${before.toFixed(2).padStart(6)} → ` +
					`${r.fit.meanDeltaE.toFixed(2).padEnd(6)}      ` +
					`${pct([gv[0] / 256, gv[3] / 256], want).toFixed(1).padStart(5)}% → ` +
					`${pct([gn[0] / 256, gn[3] / 256], want).toFixed(1)}%`,
			}));
		}
		result.append(tbl);
		const pre = el('pre', 're-mono');
		pre.dataset.role = 'profile-ini';
		pre.style.cssText = 'font-size:10.5px;white-space:pre-wrap;margin-top:8px;color:#b6b9c2';
		pre.textContent = ini;
		result.append(pre);

		if (calibrate.persist) {
			const save = el('button', 're-btn re-pri', '');
			save.dataset.act = 'persist-profile';
			save.textContent = 'Save to the camera profile';
			save.addEventListener('click', async () => {
				if (busyHolding(result)) return;
				save.disabled = true;
				try {
					await calibrate.persist(ini);
				} catch (e) {
					save.disabled = false;
					const box = el('div', 're-notice re-warn', ICON.warn);
					box.append(Object.assign(el('div'), { textContent: e.message }));
					result.append(box);
					return;
				}
				armHold(result, save, Math.max(5, calibrate.holdSeconds || 30),
					'Saved into the camera profile.', calibrate);
			});
			result.append(save);
		}
	}

	/* ---- plates ----------------------------------------------------------
	 *
	 * Detect, read, and -- if the camera will take it -- point auto-exposure at
	 * the plate. Three things are worth knowing about how this is shaped.
	 *
	 * It ranks candidates by how well each one READS, not by how confidently it
	 * was found. Measured on an hi3516ev300 over a car park: the detector gives
	 * a real plate 0.56 and a stretch of kerb 0.51, which is no separation at
	 * all, while the reader gives them 0.97 and 0.24.
	 *
	 * It shows the rejects. A list that silently drops what it did not believe
	 * looks the same as a list that found nothing, and the operator is the one
	 * who knows which car matters.
	 *
	 * And it never prints a registration it does not trust. Below the reader's
	 * floor the characters are shown greyed with the confidence beside them,
	 * because a confident wrong plate is worse than no plate.
	 */
	let plateCands = null, plateSel = -1, plateReader = null;
	/* The full-resolution develop the reader works on, kept so that picking a
	 * different candidate does not pay for it again. Dropped whenever a new
	 * frame arrives, because it would then be a picture of the old one. */
	let plateFull = null, plateFullKey = '';

	/* What the cached develop was made WITH. The cache used to be validated on
	 * width alone and invalidated from render(), which clears it only after its
	 * own develop has returned -- so changing the demosaic and pressing Find
	 * inside that window handed the reader the PREVIOUS develop, and from
	 * v0.11.2 a warning describing a picture the reader never saw. Keyed on the
	 * parameters instead, the cache cannot be stale whoever clears it. */
	function developKey() {
		return [state.cfa, state.demosaic, state.black, state.white,
			state.gain, String(state.neutral)].join('|');
	}

	async function plateFrame() {
		const key = developKey();
		if (plateFull && plateFullKey === key && plateFull.width === state.info.width)
			return plateFull;
		const r = await call('develop', {
			cfa: state.cfa, demosaic: state.demosaic, black: state.black,
			white: state.white, neutral: state.neutral,
			forward: state.info.forward, useForward: state.info.hasForward,
			gain: state.gain, step: 1,
		});
		const c = el('canvas');
		c.width = r.width; c.height = r.height;
		c.getContext('2d', { willReadFrequently: true })
			.putImageData(new ImageData(r.pixels, r.width, r.height), 0, 0);
		plateFull = c;
		plateFullKey = key;
		return c;
	}


	/* ---- step 4: a burst, stacked ----------------------------------------
	 *
	 * Sixteen exposures of the plate's own rectangle, averaged. Worth knowing
	 * before reading any of this:
	 *
	 * THERE ARE TWO BURSTS HERE, and which one runs depends on the combine
	 * mode. A plain MEAN is done by the camera: `?frames=N` averages up to
	 * sixteen CONSECUTIVE sensor frames and returns one DNG. It is ONE request
	 * and one capture, with the raw dump left running in between, so the whole
	 * burst is 0.8 s of sensor time at 20 fps. REJECT cannot use it --
	 * finding an outlier needs the frames it is an outlier among, and an
	 * average has already thrown them away -- so it asks for them one at a
	 * time, about 0.79 s each whatever the rectangle's size, and sixteen of
	 * those span roughly THIRTEEN SECONDS. A car can move and a cloud can pass
	 * in that time; that is the price of being able to reject anything, and it
	 * is why the plain mean is the default rather than the other way round.
	 *
	 * On a camera too old to know `?frames=`, mean silently falls back to the
	 * slow path -- the module checks `X-Frames-Averaged` rather than trusting
	 * the request, because an old build serves a perfectly good single frame
	 * for a burst request and says nothing.
	 *
	 * THERE IS NO ALIGNMENT, deliberately. The camera is bolted down and its
	 * measured movement across a burst is 0.02 px RMS -- a fiftieth of a pixel.
	 * Sub-pixel registration would cost a Fourier transform per frame to correct
	 * a shift far below what any of this can see, and an integer-pixel
	 * alignment would be a no-op. If this ever runs on something that moves,
	 * that is the moment to add it, and the honest thing meanwhile is to say it
	 * is not there.
	 *
	 * The frames are developed by THIS engine, one at a time, because a crop is
	 * a DNG like any other and a second hand-rolled demosaic is exactly what
	 * cost the read its confidence the first time round. `open` replaces the
	 * file the editor is holding, so the original is put back afterwards.
	 */
	function stackMean(frames, n, reject) {
		const out = new Float32Array(n * 4);
		if (!reject) {
			for (const f of frames) for (let i = 0; i < n * 4; i++) out[i] += f[i];
			for (let i = 0; i < n * 4; i++) out[i] /= frames.length;
			return out;
		}
		/* Sigma-clipped: the mean and spread of each pixel across the burst,
		 * then the mean again of only those within two of them. What this is
		 * for is a headlight sweeping through, or a car leaving -- one frame
		 * out of twenty carrying something the other nineteen do not. */
		const k = frames.length;
		for (let i = 0; i < n * 4; i++) {
			let m = 0;
			for (let j = 0; j < k; j++) m += frames[j][i];
			m /= k;
			let v = 0;
			for (let j = 0; j < k; j++) { const d = frames[j][i] - m; v += d * d; }
			const sd = Math.sqrt(v / k);
			let acc = 0, cnt = 0;
			for (let j = 0; j < k; j++) {
				if (sd === 0 || Math.abs(frames[j][i] - m) <= 2 * sd) { acc += frames[j][i]; cnt++; }
			}
			out[i] = cnt ? acc / cnt : m;
		}
		return out;
	}

	function canvasFrom(buf, w, h) {
		const c = el('canvas');
		c.width = w; c.height = h;
		const im = new ImageData(w, h);
		for (let i = 0; i < w * h * 4; i++) im.data[i] = buf[i] < 0 ? 0 : (buf[i] > 255 ? 255 : buf[i]);
		c.getContext('2d', { willReadFrequently: true }).putImageData(im, 0, 0);
		return c;
	}

	function plateThumb(box, w, h) {
		const c = el('canvas');
		c.width = w; c.height = h;
		c.style.cssText = 'border-radius:4px;flex:none;image-rendering:pixelated';
		const mx = box.width * 0.12, my = box.height * 0.45;
		c.getContext('2d').drawImage(plateFull || canvas,
			Math.max(0, box.left - mx), Math.max(0, box.top - my),
			box.width + 2 * mx, box.height + 2 * my, 0, 0, w, h);
		return c;
	}

	/* One bar per character, each the width of its own glyph, so a contested
	 * position is under the character it is about. Fixed-width bars under
	 * proportionally-advancing text drift by a whole glyph across a plate. */
	function plateChars(text, per, floor) {
		const wrap = el('div');
		wrap.style.cssText = 'display:flex;gap:3px;align-items:flex-end';
		[...text].forEach((ch, i) => {
			const col = el('div');
			col.style.cssText = 'display:flex;flex-direction:column;gap:5px;align-items:stretch';
			const g = el('div', 're-mono', ch);
			g.style.cssText = 'font-size:19px;font-weight:700;line-height:1;text-align:center';
			const bar = el('div');
			const c = per && per[i] !== undefined ? per[i] : 1;
			bar.style.cssText = 'height:3px;border-radius:2px;background:' +
				(c >= floor ? '#4ea97b' : '#c9a227');
			col.append(g, bar);
			wrap.append(col);
		});
		return wrap;
	}

	function buildPlates() {
		insp.replaceChildren();

		const panel = el('div', 're-panel');
		panel.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Plates in this frame</h3><span class="re-rule"></span>',
		}));
		panel.append(Object.assign(el('p', 're-note'), {
			textContent: 'The detector runs over the developed frame in overlapping tiles — ' +
				'letterboxed whole, a fifty-pixel plate arrives at the detector eight pixels ' +
				'wide and it finds nothing. Candidates are listed best read first.',
		}));

		/* The reader is handed a develop from this engine, at whatever demosaic
		 * Develop is set to -- and two of the four cost it real accuracy. Scored
		 * against ground truth on 150 plate crops through THIS engine, at the
		 * sampling a plate arrives at (exact match, clean / one frame of noise /
		 * a twenty-frame stack):
		 *
		 *     none       12.0  /  0.0  /   2.0 %
		 *     bilinear   89.3  / 68.7  /  88.7 %
		 *     gradient   99.3  / 77.3  /  97.3 %
		 *     RCD        99.3  / 76.0  / 100.0 %
		 *
		 * RCD and gradient are the same answer within the noise of 150 samples;
		 * bilinear gives up about ten points and none gives up nearly all of it.
		 * So this says so rather than reading a crippled picture in silence --
		 * it does not override the choice, because someone comparing demosaics
		 * is exactly who would want to read through each of them. */
		if (state.demosaic < 2) {
			const warn = el('p', 're-note');
			warn.dataset.act = 'demosaic-warning';
			warn.style.cssText = 'margin-top:8px;color:#c9a227';
			warn.textContent = state.demosaic === 0
				? 'Develop is set to no demosaic, and the reader is handed what ' +
				  'Develop produces — it will read almost nothing. Gradient or RCD.'
				: 'Develop is set to Bilinear. Measured on this engine, that costs ' +
				  'the reader about ten points against Gradient or RCD.';
			panel.append(warn);
		}

		const row = el('div');
		row.style.cssText = 'display:flex;gap:8px;margin-top:9px;flex-wrap:wrap';
		const find = el('button', 're-btn re-pri', '');
		find.dataset.act = 'find-plates';
		find.textContent = plateCands ? 'Look again' : 'Find the plates';
		row.append(find);
		panel.append(row);

		const status = el('p', 're-note');
		status.style.marginTop = '8px';
		panel.append(status);

		const list = el('div');
		list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:10px';
		panel.append(list);
		insp.append(panel);
		/* Directly under the list, because that is what it asks about. */
		buildPlateFitness();

		const meter = el('div', 're-panel');
		meter.hidden = true;
		insp.append(meter);

		const burst = el('div', 're-panel');
		burst.hidden = true;
		insp.append(burst);

		function paintBurst() {
			burst.replaceChildren();
			burst.hidden = plateSel < 0 || !plates.burst;
			if (burst.hidden) return;
			const c = plateCands[plateSel];
			burst.append(Object.assign(el('div', 're-shead'), {
				innerHTML: '<h3 class="re-cap">Take a burst and stack it</h3><span class="re-rule"></span>',
			}));
			burst.append(Object.assign(el('p', 're-note'), {
				textContent: 'Mean asks the camera to average the frames itself: one ' +
					'request, sixteen consecutive sensor frames, under a second of sensor ' +
					'time. Reject cannot — an outlier cannot be found in an average that ' +
					'has already been taken — so it asks for the frames one at a time, ' +
					'each a separate capture about 0.8 s after the last. A camera too old ' +
					'to average them falls back to that slow path for Mean as well, and ' +
					'the progress line says so while it runs.',
			}));

			const row = el('div');
			row.style.cssText = 'display:flex;gap:8px;margin-top:9px;align-items:center;flex-wrap:wrap';
			const count = el('input');
			// Sixteen is the camera's own limit on `?frames=`; asking for more
			// would silently get sixteen, and a control that lies about what it
			// did is worse than one that stops where the hardware does.
			count.type = 'number'; count.min = '2'; count.max = '16'; count.value = '16';
			count.style.cssText = 'width:62px;background:transparent;color:inherit;' +
				'border:1px solid var(--re-line,#2c313d);border-radius:6px;padding:4px 6px';
			const modeSel = segmented([
				{ label: 'Mean', value: 'mean' },
				{ label: 'Reject', value: 'reject' },
			], 0, (v) => { combine = v; }, { wide: false });
			let combine = 'mean';
			const go = el('button', 're-btn re-pri', '');
			go.dataset.act = 'stack-burst';
			go.textContent = 'Stack a burst';
			row.append(Object.assign(el('span', 're-note'), { textContent: 'frames' }), count, modeSel, go);
            burst.append(row);

			const prog = el('p', 're-note');
			prog.dataset.act = 'burst-status';
			prog.style.marginTop = '8px';
			burst.append(prog);
			const cmp = el('div');
			cmp.dataset.act = 'burst-compare';
			cmp.style.cssText = 'display:flex;gap:14px;margin-top:10px;flex-wrap:wrap';
			burst.append(cmp);

			go.addEventListener('click', async () => {
				go.disabled = true;
				cmp.replaceChildren();
				const n = Math.max(2, Math.min(16, parseInt(count.value, 10) || 16));
				// A margin round the plate: the recogniser wants context, and a
				// rectangle cut exactly to the glyphs has none.
				const want = {
					left: Math.max(0, Math.round(c.box.left - c.box.width * 0.9)),
					top: Math.max(0, Math.round(c.box.top - c.box.height * 2.2)),
					width: Math.round(c.box.width * 2.8),
					height: Math.round(c.box.height * 5.4),
				};
				const full = plateFull || canvas;
				let got, single;
				try {
					/* Mean goes through the camera, which averages consecutive
					 * sensor frames and hands back one. Reject cannot: finding
					 * an outlier needs the frames it is an outlier among, and an
					 * average has already thrown them away. */
					const wantSeparate = combine === 'reject';
					prog.textContent = wantSeparate
						? 'Asking the camera for frame 1…'
						: 'Asking the camera to average ' + n + ' frames…';
					got = await plates.burst({
						rect: want, frameW: full.width, frameH: full.height, frames: n,
						separate: wantSeparate,
						onProgress: (i, k) => {
							/* The camera's own averaging is one request and
							 * reports no progress at all; this fires on the slow
							 * path, and on a firmware whose module still counts
							 * the single averaged request as one of one. */
							if (k <= 1) return;
							prog.textContent = 'Frame ' + i + ' of ' + k + ' — about ' +
								Math.max(0, Math.round((k - i) * 0.8)) + ' s left';
						},
					});
					// One plain frame to compare against. On the camera-averaged
					// path the burst is a single file, so the before picture has
					// to be asked for separately -- it costs about 20 ms.
					if (got.inCamera) {
						prog.textContent = 'And one plain frame to compare against…';
						const one = await plates.burst({
							rect: want, frameW: full.width, frameH: full.height,
							frames: 1, separate: true,
						});
						single = one.frames[0];
					}
				} catch (e) { prog.textContent = e.message; go.disabled = false; return; }

				const toDevelop = got.inCamera ? [single].concat(got.frames) : got.frames;
				prog.textContent = 'Developing ' + toDevelop.length + ' frame' +
					(toDevelop.length === 1 ? '' : 's') + '…';
				const devd = [];
				let W = 0, H = 0;
				try {
					for (let i = 0; i < toDevelop.length; i++) {
						const bytes = toDevelop[i];
						const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
						const o = await call('open', { bytes: buf }, [buf]);
						const d = await call('develop', {
							cfa: o.info.cfa, demosaic: state.demosaic, black: o.info.black,
							white: o.info.white, neutral: o.info.neutral,
							forward: o.info.forward, useForward: o.info.hasForward,
							gain: 1, step: 1,
						});
						W = d.width; H = d.height;
						devd.push(d.pixels);
						prog.textContent = 'Developing ' + (i + 1) + ' of ' + toDevelop.length + '…';
					}
				} catch (e) {
					prog.textContent = 'The engine would not develop a burst frame: ' + e.message;
				}
				// Whatever happened, the editor must get its own frame back --
				// `open` replaced it, and everything on screen refers to it.
				try {
					const b0 = state.bytes.slice();
					await call('open', { bytes: b0.buffer }, [b0.buffer]);
					plateFull = null;      // the engine held someone else's frame
					commit();
				} catch (e) { /* commit() reports through the usual path */ }

				if (devd.length < 2) { go.disabled = false; return; }
				/* On the camera-averaged path devd is [plain, averaged] and the
				 * stacking is already done; on the separate path it is every
				 * frame and the combining happens here. */
				const one = canvasFrom(devd[0], W, H);
				const st = got.inCamera
					? canvasFrom(devd[1], W, H)
					: canvasFrom(stackMean(devd, W * H, combine === 'reject'), W, H);
				const inCrop = {
					left: c.box.left - got.rect.left, top: c.box.top - got.rect.top,
					width: c.box.width, height: c.box.height,
				};
				prog.textContent = (got.inCamera ? got.averaged : got.frames.length) +
					' frames of ' + W + '×' + H + ', ' +
					(got.inCamera ? 'averaged by the camera' : 'combined here') +
					', cut at ' + got.rect.left + ',' + got.rect.top + '. Reading both…';
				let r1 = null, rN = null;
				try {
					r1 = await plateReader.read(one, inCrop);
					rN = await plateReader.read(st, inCrop);
				} catch (e) { prog.textContent = 'Read failed: ' + e.message; }

				const floor = plateReader.floor;
				const show = (title, cv, r) => {
					const box = el('div');
					box.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:190px';
					box.append(Object.assign(el('div', 're-note'), { textContent: title }));
					const view = el('canvas');
					view.width = 190; view.height = Math.round(190 * H / W);
					view.style.cssText = 'border-radius:6px;image-rendering:pixelated';
					view.getContext('2d').drawImage(cv, 0, 0, view.width, view.height);
					box.append(view);
					if (r) {
						box.append(r.minConf >= floor
							? plateChars(r.text, r.perChar, floor)
							: Object.assign(el('div', 're-mono'), {
								textContent: r.text || '—',
								style: 'font-size:15px;opacity:0.55;font-style:italic',
							}));
						box.append(Object.assign(el('div', 're-note'), {
							textContent: 'read ' + r.minConf.toFixed(2),
						}));
					}
					cmp.append(box);
				};
				show('one frame', one, r1);
				/* Not `combine` alone: a camera too old for `?frames=` falls
				 * back to the slow path with the mode still set to Mean, and
				 * labelling that "outliers rejected" would be a lie about what
				 * the picture on the right went through. */
				show(got.inCamera
					? got.averaged + ' frames, averaged by the camera'
					: got.frames.length + (combine === 'reject'
						? ' frames, outliers rejected' : ' frames, mean'), st, rN);
				if (r1 && rN) {
					const d = rN.minConf - r1.minConf;
					const same = rN.text === r1.text
						? ', same characters.' : ', and changed a character.';
					/* Only one of the two paths may claim cause. On the slow path
					 * the single frame IS the burst's own first frame, so the
					 * difference is the stacking and nothing else. On the camera's
					 * path there is no constituent frame to be had -- the average
					 * arrives already taken -- so the control is a separate
					 * capture, and whatever moved between the two is in that
					 * number as well. Saying "stacking moved the read" there would
					 * attribute a passing car to the arithmetic. */
					prog.textContent = got.inCamera
						? 'The averaged frame reads ' + rN.minConf.toFixed(2) + ' against ' +
							r1.minConf.toFixed(2) + ' for the plain one' + same +
							' They are two separate captures, so anything that moved ' +
							'between them is in that difference too.'
						: 'Stacking moved the read ' + (d >= 0 ? '+' : '') +
							d.toFixed(2) + ' — ' + r1.minConf.toFixed(2) + ' to ' +
							rN.minConf.toFixed(2) + same;
				}
				go.disabled = false;
			});
		}

		function paintList() {
			list.replaceChildren();
			if (!plateCands) return;
			if (!plateCands.length) {
				status.textContent = 'Nothing that looks like a plate. On a frame this wide ' +
					'that usually means the plates are smaller than the detector can see.';
				return;
			}
			const floor = plateReader ? plateReader.floor : 0.5;
			const good = plateCands.filter((c) => c.minConf >= floor).length;
			status.textContent = plateCands.length + ' found, ' + good + ' read with confidence.';
			plateCands.forEach((c, i) => {
				const r = el('div');
				const sel = i === plateSel;
				r.style.cssText = 'display:flex;gap:10px;align-items:center;padding:7px 8px;' +
					'border-radius:8px;cursor:pointer;border:1px solid ' +
					(sel ? 'var(--re-acc,#4a63d8)' : 'var(--re-line,#2c313d)') +
					(sel ? ';background:rgba(74,99,216,0.10)' : '');
				r.append(plateThumb(c.box, 104, 32));
				const t = el('div');
				t.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0';
				if (c.minConf >= floor) {
					t.append(plateChars(c.text, c.perChar, floor));
				} else {
					const q = el('div', 're-mono', c.text || '—');
					q.style.cssText = 'font-size:15px;opacity:0.55;font-style:italic';
					t.append(q);
				}
				t.append(Object.assign(el('div', 're-note'), {
					textContent: Math.round(c.box.width) + ' × ' + Math.round(c.box.height) +
						' px · detector ' + c.score.toFixed(2) + ' · read ' + c.minConf.toFixed(2),
				}));
				r.append(t);
				r.dataset.act = 'plate-row';
				r.addEventListener('click', () => {
				plateSel = i;
				paintList(); paintMeter(); paintBurst(); buildPlateFitness(); drawPlateMarks();
			});
				list.append(r);
			});
		}

		/* ---- pointing auto-exposure at the chosen plate --------------------
		 * Same bargain as Calibrate: say what it will really do, do it, and
		 * hold a countdown so a camera nobody confirms comes back on its own. */
		function paintMeter() {
			meter.replaceChildren();
			meter.hidden = plateSel < 0 || !plates.exposure;
			if (meter.hidden) return;
			const c = plateCands[plateSel];
			meter.append(Object.assign(el('div', 're-shead'), {
				innerHTML: '<h3 class="re-cap">Meter the camera here</h3><span class="re-rule"></span>',
			}));
			const box = {
				left: Math.round(c.box.left), top: Math.round(c.box.top),
				width: Math.round(c.box.width), height: Math.round(c.box.height),
			};
			const plan = plates.exposure.plan(box,
				(plateFull || canvas).width, (plateFull || canvas).height);
			if (!plan) { meter.hidden = true; return; }
			meter.append(Object.assign(el('p', 're-note'), {
				innerHTML: plan.grown
					? 'The ISP will not meter below ' + plan.minW + '×' + plan.minH +
					  ', so this ' + box.width + '×' + box.height + ' plate is grown around its ' +
					  'own centre to <b>' + plan.rect.width + '×' + plan.rect.height + '</b> — ' +
					  plan.factor.toFixed(0) + '× the area. Still far more selective than the ' +
					  'whole frame, but it is not what you picked.'
					: 'Auto-exposure will meter exactly ' + plan.rect.width + '×' + plan.rect.height + '.',
			}));
			const acts = el('div');
			acts.style.cssText = 'display:flex;gap:8px;margin-top:9px;flex-wrap:wrap';
			const arm = el('button', 're-btn re-pri', '');
			arm.dataset.act = 'meter-plate';
			arm.textContent = 'Point the exposure here';
			acts.append(arm);
			meter.append(acts);
			const note = el('p', 're-note');
			note.style.marginTop = '8px';
			meter.append(note);

			arm.addEventListener('click', async () => {
				arm.disabled = true;
				const hold = Math.max(5, plates.exposure.holdSeconds || 30);
				let left = hold, tick = null;
				const stop = () => { if (tick) { clearInterval(tick); tick = null; } };
				try {
					await plates.exposure.apply({
						rect: box, exposureMs: 1, aGain: 1024, dGain: 1024,
						aeStrategy: 'highlight',
						onExpire: (e) => {
							stop(); arm.disabled = false; acts.replaceChildren(arm);
							note.textContent = e
								? 'The camera would not take the old settings back: ' + e.message
								: 'Nobody confirmed it, so the camera put itself back.';
						},
					});
				} catch (e) {
					arm.disabled = false;
					note.textContent = e.message;
					return;
				}
				const keep = el('button', 're-btn re-pri', '');
				keep.textContent = 'Keep it';
				const back = el('button', 're-btn', '');
				back.textContent = 'Put it back';
				acts.replaceChildren(keep, back);
				const paint = () => {
					note.textContent = 'Metering the plate. Putting itself back in ' + left +
						' s unless you keep it.';
				};
				paint();
				tick = setInterval(() => { left--; if (left > 0) paint(); }, 1000);
				keep.addEventListener('click', async () => {
					stop(); await plates.exposure.keep();
					acts.replaceChildren(arm); arm.disabled = false;
					note.textContent = 'Kept. This camera stays metered here until it is changed back.';
				});
				back.addEventListener('click', async () => {
					stop();
					try { await plates.exposure.revert(); note.textContent = 'Put back.'; }
					catch (e) { note.textContent = 'Could not put it back: ' + e.message; }
					acts.replaceChildren(arm); arm.disabled = false;
				});
			});
		}

		find.addEventListener('click', async () => {
			if (!state.info) { status.textContent = 'Open or capture a frame first.'; return; }
			find.disabled = true;
			plateSel = -1; meter.hidden = true; burst.hidden = true; buildPlateFitness();
			try {
				if (!plateReader) {
					status.textContent = 'Fetching the reader…';
					plateReader = await plates.reader();
				}
				status.textContent = 'Developing the frame at full size…';
				const full = await plateFrame();
				plateCands = await plateReader.readAll(full, {
					onProgress: (i, n) => { status.textContent = 'Looking… tile ' + i + ' of ' + n; },
				});
				paintList();
				drawPlateMarks();
			} catch (e) {
				plateCands = null;
				status.textContent = plates.readerSupported
					? 'The plate reader could not be loaded. It is fetched from the internet ' +
					  'the first time it is used, so a camera with no route out never gets it.'
					: 'This browser cannot run the plate reader — it needs WebAssembly in a worker.';
			}
			find.disabled = false;
			find.textContent = 'Look again';
		});

		// What a click on the picture calls. Assigned here rather than passed,
		// because the overlay outlives any one build of this panel.
		plateRepaint = () => { paintList(); paintMeter(); paintBurst(); };
		paintList();
		if (plateSel >= 0) { paintMeter(); paintBurst(); }
		drawPlateMarks();
	}

	/* ---- Focus: what the camera's AF block measured, zone by zone ---------
	 *
	 * The picture underneath is the frame that was captured; the numbers over
	 * it are live. That mismatch is deliberate and is said out loud in the
	 * panel, because the alternative -- a still heatmap -- cannot be focused
	 * by, and a live preview is not this editor's job. The grid does not move
	 * while a lens is turned, so a fixed backdrop costs nothing: only the
	 * values change, and those are what is being read.
	 */
	let focusSum = null, focusBest = null, focusErr = null;
	let focusHold = null, focusTimer = null, focusStatus = null;
	/* Bumped whenever polling stops or restarts. A read already in flight
	 * carries the number it started under, and an answer whose number has
	 * moved on is dropped: it was measured of a poll that no longer exists --
	 * a closed tab, a cleared peak, another frame -- and writing it back would
	 * resurrect exactly the state that was just discarded. */
	let focusGen = 0;

	function stopFocusPoll() {
		if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
		focusGen++;
	}

	/* Clears what belonged to one scene. The held peak is the reason: it is a
	 * target to beat, and one carried over from a different frame or a moved
	 * lens can never be beaten, so it reads as "you are getting worse". */
	function resetFocusState() {
		focusSum = null; focusBest = null; focusErr = null; focusHold = null;
	}

	/* One grid, summarised. Shared by the poll and by the sweep so the two
	 * cannot come to different conclusions about the same camera. */
	async function readGrid() {
		const g = await focus.zones();
		const zones = g.zones.map((z) => (Array.isArray(z)
			? { h1: z[0], h2: z[1], v1: z[2], v2: z[3], y: z[4], hlcnt: z[5] }
			: z));
		return summarise(zones, g.rows, g.cols);
	}

	async function focusTick() {
		if (!focus) return;
		const gen = focusGen;
		let sum = null, err = null;
		try {
			sum = await readGrid();
		} catch (e) {
			err = e && e.message ? e.message : String(e);
		}
		if (gen !== focusGen) return;
		if (err !== null) {
			/* Cleared rather than kept: a camera that stopped answering should
			 * not leave the last good heatmap on screen looking current. */
			focusSum = null;
			focusErr = err;
		} else {
			focusSum = sum;
			focusErr = null;
			if (!focusHold) focusHold = peakHold();
			focusBest = focusHold.push(sum);
		}
		renderFocus();
		drawFocusMarks();
	}

	/* One read at a time, the next scheduled only once the last has landed.
	 * On a fixed interval a camera slower than the interval has two reads in
	 * flight at once, and the answer that arrives second is not necessarily
	 * the one measured second -- so the grid would step backwards in time. */
	function startFocusPoll() {
		stopFocusPoll();
		const gen = focusGen;
		const loop = async () => {
			await focusTick();
			if (gen !== focusGen) return;
			focusTimer = setTimeout(loop, (focus && focus.intervalMs) || 700);
		};
		loop();
	}

	function renderFocus() {
		if (!focusStatus) return;
		focusStatus.replaceChildren();
		if (focusErr) {
			const box = el('div', 're-notice re-warn', ICON.warn);
			box.append(Object.assign(el('div'), {
				textContent: 'The camera stopped answering: ' + focusErr,
			}));
			focusStatus.append(box);
			return;
		}
		if (!focusSum) {
			focusStatus.append(Object.assign(el('p', 're-note'), { textContent: 'Reading…' }));
			return;
		}
		const s = focusSum;
		const at = s.peakAt
			? `row ${s.peakAt.row + 1}, column ${s.peakAt.col + 1}`
			: 'nowhere it could measure';
		const line = el('p', 're-note');
		line.dataset.act = 'focus-status';
		/* The held best, not this instant's -- the number a person turning a
		 * barrel is trying to beat, and the one still on screen after they
		 * have swept past it. */
		line.textContent =
			`Sharpest at ${at}: ${s.peak === null ? '—' : s.peak}` +
			(focusBest ? `, best seen ${focusBest.bestOverall}` : '') + '. ' +
			`${s.measured} of ${s.rows * s.cols} zones measured` +
			(s.unlit ? `, ${s.unlit} too dark` : '') +
			(s.clipped ? `, ${s.clipped} blown out` : '') + '.';
		focusStatus.append(line);
		if (!s.measured) {
			const box = el('div', 're-notice re-warn', ICON.warn);
			box.append(Object.assign(el('div'), {
				textContent: 'Nothing in this frame is lit well enough to focus by. ' +
					'More light on the subject, or a longer exposure.',
			}));
			focusStatus.append(box);
		}
	}

	/* A lens runs while the button is held.
	 *
	 * The motor is told to keep going by being asked again, and it stops on its
	 * own once nobody asks -- which is what saves a lens whose release event was
	 * lost to a closed tab or a dropped network. That safety net only works if
	 * this side actually stops asking, so every way a press can end is wired to
	 * the same release: pointerup, a pointer leaving the button, a cancelled
	 * gesture, the window losing focus, the tab being hidden, and the editor
	 * being torn down.
	 *
	 * And a cap regardless. All of those are events that might not arrive; a
	 * repeat that never ends drives a lens into its mechanical stop, so the hold
	 * gives up by itself however healthy it looks. `moveMaxMs` lets a host that
	 * knows its mechanism shorten it -- ten seconds is a guess that suits a lens
	 * whose full travel takes a few, and nothing else. */
	const MOVE_MAX_MS = 10000;
	let moveTimer = null, moveGiveUp = null, moveVerb = null;
	/* Bumped by every press and every release. A move that fails reports it
	 * whenever the host gets round to it, which may be after the hold that sent
	 * it has ended and another has begun -- and a stale failure stopping a live
	 * hold makes the buttons unreliable for as long as one flaky answer is in
	 * flight. Carrying the number means a refusal only ever releases the hold
	 * that asked for it. */
	let moveGen = 0;
	/* Which pointer owns the hold, so a second finger touching and lifting
	 * somewhere else cannot end it. Only POINTER events are filtered by it:
	 * blur, a hidden tab, leaving the tab and teardown are not one pointer's
	 * business and still release unconditionally -- and if the owning pointer's
	 * release is genuinely lost, the give-up cap is what ends the hold. */
	let movePointer = null;

	/* A host reports a motor it cannot drive either by throwing or by rejecting,
	 * and both mean the same thing. Only the first is a synchronous exception,
	 * so a bare try/catch leaves a rejected move unobserved -- and the repeat
	 * goes on asking a motor that has already said no for the whole give-up
	 * window, raising an unhandled rejection each time round. */
	function moveSend(verb, onFail) {
		const gen = moveGen;
		const fail = function () {
			if (onFail && gen === moveGen) onFail();
		};
		let p;
		try {
			p = focus.move(verb);
		} catch (e) {
			fail();
			return;
		}
		if (p && typeof p.catch === 'function') {
			p.catch(fail);
		}
	}

	/* A release from a pointer that never owned the hold is somebody else's
	 * finger. An event carrying no pointerId at all is not a pointer's report
	 * and always counts. */
	function moveReleaseFrom(ev) {
		const id = ev && ev.pointerId;
		if (movePointer !== null && id !== undefined && id !== null &&
			id !== movePointer) {
			return;
		}
		moveRelease();
	}

	function moveRelease() {
		if (moveTimer) { clearInterval(moveTimer); moveTimer = null; }
		if (moveGiveUp) { clearTimeout(moveGiveUp); moveGiveUp = null; }
		if (!moveVerb) return;
		moveVerb = null;
		movePointer = null;
		moveGen++;
		/* Told to stop even though it would time out anyway: the deadline is
		 * the fallback, not the plan, and a lens that keeps creeping after the
		 * button came up reads as a broken control. A stop that itself fails
		 * has nothing left to try, so it is sent and not chased. */
		moveSend('stop', null);
	}

	function moveAsk() {
		if (!moveVerb) return;
		moveSend(moveVerb, moveRelease);
	}

	/* The sweep needs to KNOW whether a move happened, where the hold-to-run
	 * buttons only need to stop asking: it counts the steps it took out so it
	 * can give exactly that many back, and a step it counted but the camera
	 * refused is a step it will hand back one too many of. So this one reports
	 * the outcome instead of calling back, and treats a rejection and a throw
	 * alike -- a host may do either. */
	function moveOnce(verb) {
		let p;
		try {
			p = focus.move(verb);
		} catch (e) {
			return Promise.resolve(false);
		}
		if (p && typeof p.then === 'function') {
			return p.then(function () { return true; }, function () { return false; });
		}
		return Promise.resolve(true);
	}

	/* The sweep drives the lens for several seconds at a time, and Near and Far
	 * drive the same lens. Uncounted travel in the middle of a measurement
	 * invalidates both the ratio and the claim that the lens went back where it
	 * started, so for the duration the buttons are held down rather than
	 * trusted: disabled where they are visible, and refused in the handler in
	 * case anything reaches one another way (a keyboard, a stale pointer). */
	let motorBtns = [];
	let lensOwned = false;

	function ownLens(on) {
		lensOwned = on;
		motorBtns.forEach(function (b) { b.disabled = on; });
		if (on) moveRelease();
	}

	function holdToRun(btn, verb) {
		const press = function (ev) {
			if (ev && ev.button !== undefined && ev.button !== 0) return;
			if (lensOwned) return;
			/* One hold at a time, and a second pointer is ignored rather than
			 * taking over. Taking over meant releasing EITHER pointer stopped
			 * whatever was running, so the finger lifted was not necessarily
			 * the one that chose the direction. Ignoring the newcomer is the
			 * only resolution to that which cannot end with a lens still
			 * moving. */
			if (moveVerb) return;
			moveVerb = verb;
			movePointer = (ev && ev.pointerId !== undefined) ? ev.pointerId : null;
			moveGen++;
			/* Armed BEFORE the first ask. Arming them after meant a move that
			 * failed synchronously released a hold whose timers did not exist
			 * yet -- and then press installed them anyway, so the repeat ran on
			 * with moveVerb already cleared and the give-up had nothing left to
			 * stop. That is a lens running with its own brakes disarmed. */
			moveTimer = setInterval(moveAsk, (focus && focus.moveRepeatMs) || 250);
			moveGiveUp = setTimeout(moveRelease,
				(focus && focus.moveMaxMs) || MOVE_MAX_MS);
			moveAsk();
			if (ev && ev.preventDefault) ev.preventDefault();
		};
		btn.addEventListener('pointerdown', press);
		['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) {
			btn.addEventListener(n, moveReleaseFrom);
		});
		/* Keyboard is not a hold: a key repeat is the OS's, at its own rate, and
		 * space fires click. One press, one nudge, which is also the only way
		 * this control is reachable without a pointer. */
		btn.addEventListener('keydown', function (ev) {
			if (ev.key !== 'Enter' && ev.key !== ' ') return;
			/* An auto-repeat is the operating system's, at whatever rate it was
			 * configured with, and treating one as a fresh press turns a held
			 * key into a burst of nudges at a cadence this side never chose. */
			if (ev.repeat) return;
			if (lensOwned) return;
			ev.preventDefault();
			moveSend(verb, null);
		});
	}

	/*
	 * Tuning the filter the focus reading comes from.
	 *
	 * Deliberately NOT a frequency-response plot. How the gains and shifts map
	 * onto filter sections is not in any software the vendor ships -- it was
	 * looked for in their library and in the ISP kernel source and is in
	 * neither, because it is in the silicon. A curve drawn here would be an
	 * invention presented as a measurement.
	 *
	 * What IS measurable is on screen already. The grid is live, so a
	 * coefficient change shows up in the zones within a poll, and the panel's
	 * held best is the number to beat. That is the whole loop: change it,
	 * watch it, keep it if the peak got sharper.
	 *
	 * One bank, not four. The camera measures focus through the second
	 * horizontal filter -- the others are a differently tuned companion and
	 * the vertical pair, which between them contribute a sixth of the reading.
	 * Offering all four would suggest they are equally worth turning.
	 */
	/* Bumped by every filter write and every teardown. An apply is a round trip
	 * to a camera, and the panel that asked can be gone before the answer comes
	 * -- another tab, a destroyed editor, or simply a second attempt. A late
	 * answer under an old number is dropped rather than arming a countdown
	 * nobody can see, restarting a poll nobody is watching, or overwriting the
	 * one set of hold handles with a second. */
	let filterGen = 0;
	let filterBusy = false;

	/*
	 * How sharply the filter peaks, rather than how big a number it makes.
	 *
	 * This exists because the obvious way to read the panel is wrong. Turning
	 * on the third filter section more than doubles the value on a focused
	 * scene -- and makes the filter worse, because that section reads higher as
	 * the picture BLURS. Anyone tuning by "make the number go up" ends up with
	 * a camera that focuses badly and a reading that says it is doing well.
	 *
	 * What separates a good filter from a big one is the RATIO between focus
	 * and not-focus, and nothing on a still scene can show that. So the lens is
	 * walked away from where it sits, the value read at each step, and the
	 * spread reported. A filter worth keeping falls away steeply; one that is
	 * merely loud barely moves.
	 *
	 * One direction, and back. A sweep through focus and out the other side
	 * would measure more, but it has to leave the lens where it found it -- an
	 * operator who asked for a measurement did not ask to have their focus
	 * moved -- and every extra step is another chance for the return to fall
	 * short of where it started.
	 */
	const SWEEP_STEPS = 8;
	const SWEEP_SETTLE_MS = 700;
	let sweepGen = 0;
	/* A sweep in flight when the editor is torn down still has a return walk to
	 * finish -- the lens is real and must go back -- but what it must NOT do is
	 * restart the poll afterwards. destroy() stops the poll and empties the
	 * root without changing `mode`, so a finally that asks only "are we still in
	 * Focus?" answers yes for a panel that no longer exists and reads the
	 * camera for as long as the page is open. */
	let sweepClosed = false;
	/* Non-null while a sweep owns the lens, INCLUDING its return walk. Aborting
	 * a sweep bumps the generation, which stops it measuring; it cannot stop it
	 * walking back, and for those few seconds there is still a sweep sending
	 * `near`. A second sweep starting then sends `far` against it, and neither
	 * the reading nor the final position means anything. */
	let sweepBusy = null;

	function sweepStop() { sweepGen++; }

	function runSweep(say, onStep) {
		const prior = sweepBusy;
		/* The generation this was ASKED under. A sweep queued behind another's
		 * walk back can be cancelled before it ever starts -- the operator left
		 * Focus again while it waited -- and starting then would drive the lens
		 * for a panel nobody is looking at. */
		const at = sweepGen;
		const p = (async function () {
			if (prior) { try { await prior; } catch (e) { /* not ours to report */ } }
			if (sweepGen !== at) return null;
			return sweepRun(say, onStep);
		})();
		sweepBusy = p;
		const clear = function () { if (sweepBusy === p) sweepBusy = null; };
		p.then(clear, clear);
		return p;
	}

	async function sweepRun(say, onStep) {
		const gen = ++sweepGen;
		const mine = () => gen === sweepGen;
		const vals = [];
		let out = 0, failed = null, lost = 0;
		/* The poll is stopped for the duration: it and the sweep would be
		 * asking the same camera for the same grid at once, and its answers
		 * would land in the panel out of step with where the lens actually is.
		 * The manual controls go with it -- see ownLens. */
		stopFocusPoll();
		ownLens(true);
		try {
			for (let i = 0; i <= SWEEP_STEPS; i++) {
				if (!mine()) break;
				try {
					const s = await readGrid();
					if (s.peak !== null) vals.push(s.peak);
				} catch (e) {
					failed = e && e.message ? e.message : String(e);
					break;
				}
				if (!mine()) break;
				onStep(i, SWEEP_STEPS * 2);
				if (i === SWEEP_STEPS) break;
				/* Counted only if it actually happened. A refused move that was
				 * counted anyway is a step handed back that was never taken,
				 * which walks the lens PAST where the operator left it. */
				if (!(await moveOnce('far'))) {
					failed = 'the camera would not move the lens';
					break;
				}
				out++;
				await pause(SWEEP_SETTLE_MS);
			}
		} finally {
			/* Every step taken is a step given back, and NOT conditional on the
			 * sweep still being the current one. Abandoning the lens where an
			 * abort found it is worse than never measuring: the operator's
			 * focus is gone and nothing said so. Stopping, leaving the tab, a
			 * camera that stopped answering and a thrown error all arrive
			 * here. */
			for (let i = 0; i < out; i++) {
				/* A refused step does not stop the walk: the next one may well
				 * be taken, and stopping early strands the lens further out
				 * than carrying on can. It is counted, and said out loud at the
				 * end -- claiming the lens is back when a step was refused is
				 * the one outcome worse than saying nothing. */
				if (!(await moveOnce('near'))) lost++;
				await pause(SWEEP_SETTLE_MS);
				onStep(SWEEP_STEPS + i + 1, SWEEP_STEPS * 2);
			}
			await moveOnce('stop');
			ownLens(false);
			/* The panel is useless without its live grid, and a camera left
			 * un-polled looks broken -- but only for a panel that still exists.
			 * `mode` alone does not answer that: destroy() leaves it as it
			 * found it. */
			if (mode === 'focus' && !sweepClosed) startFocusPoll();
		}
		const back = lost
			? ' The lens may not be back where it started: the camera refused ' +
				lost + ' of the ' + out + ' steps back.'
			: '';
		if (failed) return { failed: failed + '.' + back, lost: lost };
		if (!mine()) return { stopped: true, lost: lost, back: back };
		if (!vals.length) return { failed: 'nothing measurable along the sweep.' + back, lost: lost };
		const hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals);
		return { hi: hi, lo: lo, ratio: lo > 0 ? hi / lo : null, n: vals.length,
			lost: lost, back: back };
	}


	function pause(ms) {
		return new Promise(function (r) { setTimeout(r, ms); });
	}

	function buildFilterDesigner(panel) {
		const box = el('div', 're-panel');
		box.style.marginTop = '10px';
		box.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Filter</h3><span class="re-rule"></span>',
		}));
		box.append(Object.assign(el('p', 're-note'), {
			textContent: 'What the camera counts as detail. Change it, watch the ' +
				'squares, and keep it if the sharpest zone reads higher than it did.',
		}));

		const status = el('div');
		/* Named so a reader -- or a test -- can tell this panel's message from
		 * the grid's own above it; both are notices and both can be warnings. */
		status.dataset.act = 'af-status';
		box.append(status);
		const rows = el('div');
		box.append(rows);

		/* The ranges are the camera's register fields, and the panel refuses
		 * out of range rather than letting the camera refuse silently: these
		 * are written into a few bits each and nothing downstream checks. */
		const FIELDS = [
			{ k: 'gain', label: 'Gains', n: 7, lo: -511, hi: 511, first: [0, 255],
			  hint: 'An input scale, then three pairs — one per section.' },
			{ k: 'shift', label: 'Shifts', n: 4, lo: 0, hi: 7,
			  hint: 'How far each stage divides its result down.' },
			{ k: 'coring', label: 'Coring', n: 3, lo: 0, hi: 2047, slope: [1, 15],
			  hint: 'Threshold, slope, limit. A high threshold throws away the ' +
				'small detail that coming into focus produces.' },
		];
		const inputs = {};
		let enables = [];

		const mkRow = (f) => {
			const row = el('div');
			row.style.cssText = 'margin-top:9px';
			row.append(Object.assign(el('div', 're-cap'), { textContent: f.label }));
			const line = el('div');
			line.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap;margin-top:4px';
			inputs[f.k] = [];
			for (let i = 0; i < f.n; i++) {
				const inp = el('input', 're-in');
				inp.type = 'number';
				inp.dataset.act = 'af-' + f.k + '-' + i;
				inp.style.cssText = 'width:64px';
				/* Per-slot bounds where a slot differs from its neighbours: the
				 * first gain is an unsigned input scale, not a coefficient, and
				 * the coring slope is four bits where the two beside it are
				 * eleven. One range over the row would let a number through
				 * that the camera cannot hold. */
				const lo = (f.first && i === 0) ? f.first[0]
					: (f.slope && i === f.slope[0]) ? 0 : f.lo;
				const hi = (f.first && i === 0) ? f.first[1]
					: (f.slope && i === f.slope[0]) ? f.slope[1] : f.hi;
				inp.min = String(lo);
				inp.max = String(hi);
				inputs[f.k].push(inp);
				line.append(inp);
			}
			row.append(line);
			row.append(Object.assign(el('span', 'hint'), { textContent: f.hint }));
			return row;
		};
		FIELDS.forEach((f) => rows.append(mkRow(f)));

		/* The section switches, which are the one control whose effect the
		 * measurements are unambiguous about: the third section reads HIGHER
		 * as the picture blurs, so a camera focusing worse with it on is not a
		 * mystery. Named rather than numbered for that reason. */
		const enRow = el('div');
		enRow.style.cssText = 'margin-top:9px';
		enRow.append(Object.assign(el('div', 're-cap'), { textContent: 'Sections' }));
		const enLine = el('div');
		enLine.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin-top:4px';
		enables = [0, 1, 2].map((i) => {
			const lab = el('label');
			lab.style.cssText = 'display:flex;gap:5px;align-items:center';
			const cb = el('input');
			cb.type = 'checkbox';
			cb.dataset.act = 'af-enable-' + i;
			lab.append(cb, Object.assign(el('span'), { textContent: String(i + 1) }));
			enLine.append(lab);
			return cb;
		});
		enRow.append(enLine);
		enRow.append(Object.assign(el('span', 'hint'), {
			textContent: 'Section 3 reads higher as the picture blurs, so leaving ' +
				'it off is most of why this filter tracks focus at all.',
		}));
		rows.append(enRow);

		const acts = el('div');
		acts.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap';
		const send = el('button', 're-btn re-pri', '');
		send.dataset.act = 'af-apply';
		send.textContent = 'Try it';
		send.disabled = true;
		const back = el('button', 're-btn', '');
		back.dataset.act = 'af-reload';
		back.textContent = 'Read from camera';
		acts.append(send, back);

		/* Only where the lens can be driven. Measuring how sharply a filter
		 * peaks means moving the focus, and a camera focused by hand cannot be
		 * asked to do that from here. */
		let measure = null, stop = null;
		if (typeof focus.move === 'function') {
			measure = el('button', 're-btn', '');
			measure.dataset.act = 'af-measure';
			measure.textContent = 'Measure it';
			stop = el('button', 're-btn', '');
			stop.dataset.act = 'af-measure-stop';
			stop.textContent = 'Stop';
			stop.hidden = true;
			acts.append(measure, stop);
		}
		box.append(acts);

		const say = (msg, warn) => {
			status.replaceChildren();
			if (!msg) return;
			const n = el('div', 're-notice' + (warn ? ' re-warn' : ''), warn ? ICON.warn : null);
			n.append(Object.assign(el('div'), { textContent: msg }));
			status.append(n);
		};

		const fill = (f) => {
			FIELDS.forEach((spec) => {
				const v = (f && f[spec.k]) || [];
				inputs[spec.k].forEach((inp, i) => {
					inp.value = typeof v[i] === 'number' ? String(v[i]) : '';
				});
			});
			const en = (f && f.enable) || [];
			enables.forEach((cb, i) => { cb.checked = !!en[i]; });
		};

		/* Read back rather than assumed. The camera may be running a sensor
		 * profile's filter rather than the compiled-in one, and a panel that
		 * opened on the defaults would offer to "keep" a filter the operator
		 * never chose. */
		const load = () => {
			/* Refused while a write is in flight or a trial is waiting. Reading
			 * would re-enable the button under an apply that has not answered,
			 * and a second apply then overwrites the one set of hold handles --
			 * two trials, one countdown, and whichever revert lands last wins. */
			/* Not holdSettling. Reading writes nothing, and refusing it here
			 * left the button disabled with nothing to re-enable it once the
			 * revert landed -- a panel stuck until it was reloaded. The write
			 * itself is refused by busyHolding(), which is where it belongs. */
			if (filterBusy || holdEnd) {
				say('Finish with the last change first.', true);
				return Promise.resolve();
			}
			send.disabled = true;
			say('Reading the camera…');
			const gen = filterGen;
			return focus.filters().then((f) => {
				if (gen !== filterGen) return;
				fill(f);
				say('');
				send.disabled = false;
			}).catch((e) => {
				if (gen !== filterGen) return;
				say('Could not read the filter: ' + (e && e.message ? e.message : e), true);
			});
		};
		back.addEventListener('click', load);

		const gather = () => {
			const out = { enable: enables.map((cb) => (cb.checked ? 1 : 0)) };
			for (const spec of FIELDS) {
				const vals = [];
				for (const inp of inputs[spec.k]) {
					const raw = inp.value.trim();
					if (raw === '') return { bad: spec.label + ' is not filled in.' };
					const v = Number(raw);
					if (!Number.isFinite(v) || Math.floor(v) !== v)
						return { bad: spec.label + ' takes whole numbers.' };
					const lo = Number(inp.min), hi = Number(inp.max);
					if (v < lo || v > hi)
						return { bad: spec.label + ': ' + v + ' is outside ' + lo +
							' to ' + hi + ', which is what the camera can hold.' };
					vals.push(v);
				}
				out[spec.k] = vals;
			}
			return { filters: out };
		};

		send.addEventListener('click', () => {
			if (filterBusy) return;
			if (busyHolding(status)) return;
			const got = gather();
			if (got.bad) { say(got.bad, true); return; }
			send.disabled = true;
			filterBusy = true;
			say('Applying…');
			const gen = ++filterGen;
			/* Called inside the chain, so a host that reports failure by
			 * THROWING is caught by the same .catch as one that rejects. Called
			 * outside it, a synchronous throw escapes the click handler with the
			 * button disabled and "Applying…" on screen for good. */
			new Promise((res) => res(focus.applyFilters(got.filters))).then(() => {
				filterBusy = false;
				/* The panel that asked may be gone -- another tab, a destroyed
				 * editor, a second attempt. Arming a countdown nobody can see
				 * leaves a camera that reverts on its own with nothing on
				 * screen having said it would. */
				if (gen !== filterGen) return;
				say('');
				/* The held best is from the old filter and cannot be compared
				 * with what this one reads -- different filters count detail
				 * differently, so the number to beat has to start again. */
				focusHold = null; focusBest = null;
				renderFocus();
				startFocusPoll();
				armHold(status, send, Math.max(5, focus.holdSeconds || 30),
					'Applied to the camera.', {
						revert: () => focus.revertFilters(),
						keep: focus.keepFilters
							? () => focus.keepFilters(got.filters) : undefined,
					});
			}).catch((e) => {
				filterBusy = false;
				if (gen !== filterGen) return;
				say('The camera refused it: ' + (e && e.message ? e.message : e), true);
				send.disabled = false;
			});
		});

		if (measure) {
			const busy = (on) => {
				measure.hidden = on;
				stop.hidden = !on;
				send.disabled = on;
				back.disabled = on;
			};
			stop.addEventListener('click', function () { sweepStop(); });
			measure.addEventListener('click', function () {
				if (busyHolding(status)) return;
				busy(true);
				runSweep(say, function (i, n) {
					say('Walking the lens and reading as it goes — ' + i + ' of ' + n +
						'. It will be put back where it started.');
				}).then(function (r) {
					busy(false);
					/* Cancelled before it ever started, behind another sweep's
					 * walk back. Nothing was measured and nothing was moved, so
					 * there is nothing to report either. */
					if (!r) { say(''); return; }
					if (r.stopped) {
						say(r.lost
							? 'Stopped.' + r.back
							: 'Stopped. The lens is back where it started.', !!r.lost);
						return;
					}
					if (r.failed) { say('Could not measure it: ' + r.failed, true); return; }
					/* The ratio, not the peak. A filter that reads loudly
					 * everywhere is worse than a quiet one that falls away,
					 * and the peak alone cannot tell them apart -- which is
					 * exactly the mistake this button exists to prevent. */
					say((r.ratio === null
						? 'Highest ' + r.hi + ', lowest ' + r.lo + ' across the sweep.'
						: 'Falls to 1/' + r.ratio.toFixed(1) + ' of its peak across the ' +
							'sweep (' + r.hi + ' down to ' + r.lo + '). A filter worth ' +
							'keeping falls away steeply; a loud one barely moves.') + r.back,
						!!r.lost);
				}).catch(function (e) {
					busy(false);
					say('Could not measure it: ' + (e && e.message ? e.message : e), true);
				});
			});
		}

		load();
		panel.append(box);
	}

	function buildFocus() {
		insp.replaceChildren();
		/* The panel is rebuilt from scratch on every entry, so the buttons the
		 * last one made are detached and must not be kept -- disabling a node
		 * nobody can see is a leak that also hides a bug. */
		motorBtns = [];
		const panel = el('div', 're-panel');
		panel.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Focus</h3><span class="re-rule"></span>',
		}));
		/* Says what to actually DO, and that differs: a camera with a motor is
		 * focused from this panel, one without is focused at the camera. Telling
		 * someone to turn a lens they could drive from here, or to hold a button
		 * that is not on screen, is worse than saying nothing. */
		const drive = focus && typeof focus.move === 'function'
			? 'Hold Near or Far until the bright patch is where you want it sharp.'
			: 'Turn the lens until the bright patch is where you want it sharp.';
		panel.append(Object.assign(el('p', 're-note'), {
			textContent: 'Each square is one of the camera\'s focus zones, brightest where ' +
				'the picture has the most detail. ' + drive + ' The picture behind is the ' +
				'frame you captured — the squares are live.',
		}));
		focusStatus = el('div');
		panel.append(focusStatus);

		const row = el('div');
		row.style.cssText = 'display:flex;gap:8px;margin-top:9px;flex-wrap:wrap';

		/* Only where there is a motor to drive. Same rule the Capture button and
		 * the Plates tab follow: a control that can never work is worse than
		 * none, and most cameras focus by hand. */
		if (focus && typeof focus.move === 'function') {
			[['near', 'Near'], ['far', 'Far']].forEach(function (pair) {
				const b = el('button', 're-btn', '');
				b.dataset.act = 'focus-' + pair[0];
				b.textContent = pair[1];
				b.disabled = lensOwned;
				holdToRun(b, pair[0]);
				motorBtns.push(b);
				row.append(b);
			});
		}

		const reset = el('button', 're-btn', '');
		reset.dataset.act = 'focus-reset';
		reset.textContent = 'Reset the best';
		/* A held peak from before the lens moved, or from another scene, is a
		 * target that can never be beaten and reads as "you are getting worse". */
		reset.addEventListener('click', () => {
			/* Restarted, not merely cleared and re-read: a read still in flight
			 * would otherwise land afterwards and push the very peak that was
			 * just discarded back into a fresh hold. */
			focusHold = null; focusBest = null;
			renderFocus();
			startFocusPoll();
		});
		row.append(reset);
		panel.append(row);
		/* revertFilters as well as the other two: it is what the clock and a
		 * mode change call, and a panel that could apply but not put back would
		 * arm a countdown it cannot honour. keepFilters stays optional -- a
		 * host that can only try is still useful -- and the countdown says so
		 * rather than promising a restart will remember. */
		if (focus && typeof focus.filters === 'function' &&
			typeof focus.applyFilters === 'function' &&
			typeof focus.revertFilters === 'function') {
			buildFilterDesigner(panel);
		}
		insp.append(panel);

		renderFocus();
		startFocusPoll();
	}

	/* Zones are drawn as a fraction of the frame, not from pixel coordinates:
	 * the camera divides the whole frame evenly and reports only the shape, so
	 * the mapping is arithmetic. A camera that cropped its AF window would need
	 * the grid's own boundaries, and this would be wrong -- but it would be
	 * wrong visibly, the grid sitting over part of the picture. */
	function drawFocusMarks() {
		focusMarks.replaceChildren();
		if (mode !== 'focus' || !focusSum || !state.info) return;
		const W = state.info.width, H = state.info.height;
		const s = focusSum;
		const shade = normalise(s, focusBest ? focusBest.bestOverall : null);
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('class', 're-chart-svg');
		for (let i = 0; i < s.fv.length; i++) {
			const r = (i / s.cols) | 0, c = i % s.cols;
			const a = stageCoords((c * W) / s.cols, (r * H) / s.rows);
			const b = stageCoords(((c + 1) * W) / s.cols, ((r + 1) * H) / s.rows);
			if (!a || !b) continue;
			const cell = document.createElementNS(NS, 'rect');
			cell.setAttribute('x', a.x);
			cell.setAttribute('y', a.y);
			cell.setAttribute('width', Math.max(0, b.x - a.x));
			cell.setAttribute('height', Math.max(0, b.y - a.y));
			/* A zone that measured nothing is outlined and left unfilled. Any
			 * fill would put it on the same scale as the zones that did, which
			 * is the one thing the three states must never look like. */
			if (shade[i] === null) {
				cell.setAttribute('class', 're-fz re-fz-none');
			} else {
				cell.setAttribute('class', 're-fz');
				cell.setAttribute('fill-opacity', (0.08 + 0.62 * shade[i]).toFixed(3));
			}
			svg.append(cell);
		}
		if (s.peakAt) {
			const r = s.peakAt.row, c = s.peakAt.col;
			const a = stageCoords((c * W) / s.cols, (r * H) / s.rows);
			const b = stageCoords(((c + 1) * W) / s.cols, ((r + 1) * H) / s.rows);
			if (a && b) {
				const pk = document.createElementNS(NS, 'rect');
				pk.setAttribute('x', a.x);
				pk.setAttribute('y', a.y);
				pk.setAttribute('width', Math.max(0, b.x - a.x));
				pk.setAttribute('height', Math.max(0, b.y - a.y));
				pk.setAttribute('class', 're-fz-peak');
				svg.append(pk);
			}
		}
		focusMarks.append(svg);
	}

	function setMode(m) {
		mode = m;
		chart.hidden = m !== 'calibrate';
		marks.hidden = m !== 'diagnose';
		plateMarks.hidden = m !== 'plates';
		focusMarks.hidden = m !== 'focus';
		/* Unconditional now that two panels can arm one. Nobody confirms a
		 * change they can no longer see, so a mode change ends it the way the
		 * clock would have: put back. buildCalibrate() does the same on its own
		 * way in, which is harmless and keeps that panel's rebuild honest. */
		abandonHold();
		/* A poll that outlived its tab would keep a camera answering for a
		 * panel nobody is looking at. */
		if (m !== 'focus') { stopFocusPoll(); moveRelease(); sweepStop(); focusStatus = null; }
		/* Anything a filter write has outstanding belonged to the panel that is
		 * going. Its answer must not come back and arm a trial here. */
		filterGen++;
		if (m === 'plates') {
			buildPlates();
		} else if (m === 'calibrate') {
			if (!corners) { corners = defaultCorners(); solved = null; }
			buildCalibrate();
		} else if (m === 'focus') {
			buildFocus();
		} else if (m === 'diagnose') {
			buildDiagnose();
		} else if (state.info) {
			buildInspector();
		}
		drawChart();
		drawMarks();
		drawPlateMarks();
		drawFocusMarks();
	}

	/* ---- inspector ---- */
	const histBox = el('div', 're-hist');
	const histPanel = el('div', 're-panel');
	histPanel.append(Object.assign(el('div', 're-shead'), {
		innerHTML: '<h3 class="re-cap">Histogram</h3><span class="re-rule"></span>',
	}), histBox);

	const zoomEl = el('span', 're-mono', '—');
	const dimEl = el('span', '', '—');
	const metaEl = el('span', '', '');
	foot.append(zoomEl, dimEl, el('span', 're-rule'), metaEl);

	function buildInspector() {
		const i = state.info;
		insp.innerHTML = '';
		insp.append(histPanel);

		// RAW
		const raw = el('div', 're-panel');
		raw.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Raw</h3><span class="re-rule"></span>' +
				'<span class="re-note re-mono">from file</span>',
		}));
		const cfaSeg = segmented(CFA_NAMES.map((label, value) => ({ label, value })),
			state.cfa, (v) => { state.cfa = v; invalidateScan(); commit(); });
		cfaSeg.style.marginBottom = '9px';
		raw.append(cfaSeg);
		raw.append(new Row('Black', {
			min: 0, max: Math.max(1, Math.round(i.white * 0.25)), value: i.black,
			onInput: (v) => { state.black = v; preview(); },
			onCommit: (v) => { state.black = v; commit(); },
		}).node);
		raw.append(new Row('White', {
			min: Math.round(i.white * 0.25), max: (1 << i.bits) - 1, value: i.white,
			onInput: (v) => { state.white = v; preview(); },
			onCommit: (v) => { state.white = v; commit(); },
		}).node);
		insp.append(raw);

		// DEMOSAIC
		const dm = el('div', 're-panel');
		dm.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Demosaic</h3><span class="re-rule"></span>',
		}));
		dm.append(segmented(DEMOSAIC.map(([label, value, title]) => ({ label, value, title })),
			DEMOSAIC.findIndex(([, v]) => v === state.demosaic),
			(v) => { state.demosaic = v; commit(); }));
		// Demosaic does not enter a scan, so it alone does not invalidate one.
		insp.append(dm);

		// WHITE BALANCE — the gains the engine really applies, not a temperature
		// model it does not have.
		const wb = el('div', 're-panel');
		wb.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">White balance</h3><span class="re-rule"></span>' +
				`<span class="re-note re-mono">${i.hasForward ? 'as shot' : 'no profile'}</span>`,
		}));
		const mk = (name, idx) => new Row(name, {
			min: 0.2, max: 3, step: 0.001, value: i.neutral[idx],
			fmt: (v) => (+v).toFixed(3),
			onInput: (v) => { state.neutral[idx] = v; preview(); },
			onCommit: (v) => { state.neutral[idx] = v; commit(); },
		});
		wbRows = [mk('Red', 0), null, mk('Blue', 2)];
		wb.append(wbRows[0].node, wbRows[2].node);

		const pick = el('button', 're-btn re-sm', ICON.dropper);
		pick.dataset.act = 'pick-neutral';
		pick.append(Object.assign(el('span'), { textContent: 'Pick a neutral' }));
		pick.style.cssText = 'margin-top:8px';
		pick.addEventListener('click', () => armPicker(!picking));
		wb.append(pick);
		pickBtn = pick;

		wbNote = Object.assign(el('p', 're-note'), {
			textContent: 'As shot is the gain the camera’s own AWB had settled on. ' +
				'Pick a neutral to set it from something in the frame that should be grey.',
			style: 'margin:7px 0 0',
		});
		wb.append(wbNote);
		insp.append(wb);

		// TONE
		const tone = el('div', 're-panel');
		tone.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Tone</h3><span class="re-rule"></span>',
		}));
		tone.append(new Row('Exposure', {
			min: -3, max: 3, step: 0.05, value: 0,
			fmt: (v) => (v > 0 ? '+' : '') + (+v).toFixed(2),
			onInput: (v) => { state.gain = Math.pow(2, v); preview(); },
			onCommit: (v) => { state.gain = Math.pow(2, v); commit(); },
		}).node);
		insp.append(tone);

		// BAYER PROBE — two survivors, and why the last step is the operator's.
		if (state.probe) {
			const p = el('div', 're-panel');
			const best = state.probe.ranked[0].score;
			p.append(Object.assign(el('div', 're-shead'), {
				innerHTML: '<h3 class="re-cap">Bayer probe</h3><span class="re-rule"></span>',
			}));
			const list = el('div');
			list.style.cssText = 'display:grid;grid-template-columns:auto 1fr auto;gap:5px 9px;align-items:center';
			state.probe.ranked.forEach((r) => {
				const keep = r.score > best * 0.99;
				list.insertAdjacentHTML('beforeend',
					`<span class="re-cap" style="color:${keep ? '#e6e8ee' : '#5b606c'}">${r.name}</span>` +
					`<span style="height:4px;border-radius:2px;background:rgba(230,232,238,.10)">` +
					`<i style="display:block;height:100%;border-radius:2px;width:${(r.score * 100).toFixed(0)}%;` +
					`background:${keep ? '#5c70e8' : '#4a4f5c'}"></i></span>` +
					`<span class="re-mono" style="font-size:11px;color:${keep ? '#b6b9c2' : '#5b606c'}">` +
					`${r.score.toFixed(4)}</span>`);
			});
			p.append(list);
			if (state.probe.ambiguous) {
				p.insertAdjacentHTML('beforeend',
					'<p class="re-note" style="margin:8px 0 0">' +
					state.probe.survivors.map((s) => s.name).join(' and ') +
					' fit the data equally well — they differ only in which corner is red, ' +
					'and no measurement of one frame decides that. Switch between them above ' +
					'and pick the one that looks right.</p>');
			}
			insp.append(p);
		}
	}

	/* ---- open ---- */
	async function openBytes(bytes, label) {
		try {
			busy.hidden = false;
			// Copy rather than hand over bytes.buffer: a subarray or a pooled
			// buffer would otherwise send the neighbouring bytes as part of the
			// frame, and transferring would detach a buffer the caller still
			// owns. A few MB costs a couple of milliseconds.
			const exact = bytes.slice();
			// A second copy, kept here: the one above is transferred into the
			// worker and this side's view of it is detached the moment it goes.
			const exactCopy = bytes.slice();
			const r = await call('open', { bytes: exact.buffer }, [exact.buffer]);
			state.info = r.info;
			state.probe = r.probe;
			Object.assign(state, {
				cfa: r.info.cfa, black: r.info.black, white: r.info.white,
				neutral: r.info.neutral.slice(), gain: 1,
			});
			state.bytes = exactCopy;
			state.name = label;
			/* Every frame that actually opens gets a number. A capture that
			 * fails leaves the previous frame on the stage, so the guided run
			 * has no other way to tell "a new frame arrived" from "the old one
			 * is still here" -- and scanning the old one twice would have it
			 * agreeing with itself. */
			opened++;
			state.openId = opened;
			// The chart and the scan both belonged to the frame that has just
			// been replaced.
			corners = null;
			chartTried = false;
			solved = null;
			diag = null;
			// The focus grid belonged to it too. Left alone, the previous
			// scene's zones would be drawn over this frame -- at this frame's
			// dimensions, so not even where they were measured -- and shaded
			// against a peak held from a lens position that no longer exists.
			resetFocusState();
			saveBtn.disabled = false;
			nameEl.textContent = label;
			sensorChip.hidden = false;
			// UniqueCameraModel comes out of the file, so anyone who can hand
			// over a DNG chooses these bytes. Built as nodes, never as markup.
			sensorChip.replaceChildren(
				Object.assign(el('span', 're-chip-k'), { textContent: 'sensor' }),
				Object.assign(el('span', 're-mono'),
					{ textContent: r.info.model || 'unknown' }));
			dimEl.textContent = `${r.info.width} × ${r.info.height}`;
			metaEl.textContent = `${r.info.bits}-bit · ${r.info.cfaName}` +
				(r.info.iso ? ` · ISO ${r.info.iso}` : '') +
				(r.info.exposure ? ` · ${(r.info.exposure * 1000).toFixed(1)} ms` : '');
			// setMode rather than buildInspector: opening a frame while
			// Calibrate is selected used to draw Develop's controls under
			// Calibrate's heading and leave the old frame's corners floating
			// over the new picture, inert.
			setMode(mode);
			await commit();
		} catch (e) {
			fail(e.message);
		} finally {
			busy.hidden = true;
		}
	}

	for (const ev of ['dragenter', 'dragover'])
		stage.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('re-over'); });
	for (const ev of ['dragleave', 'drop'])
		stage.addEventListener(ev, () => drop.classList.remove('re-over'));
	stage.addEventListener('drop', async (e) => {
		e.preventDefault();
		const f = e.dataTransfer.files[0];
		if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
	});

	fitBtn.addEventListener('click', () => {
		state.fit = true; fitBtn.classList.add('on'); oneBtn.classList.remove('on');
		stage.classList.add('re-fit'); commit();
	});
	oneBtn.addEventListener('click', () => {
		state.fit = false; oneBtn.classList.add('on'); fitBtn.classList.remove('on');
		stage.classList.remove('re-fit'); render(1);
	});

	const ready = startWorker().catch((e) => {
		abandonAll(e.message);
		fail('The editor could not start: ' + e.message);
		throw e;
	});
	// Nothing else is waiting on it, and an unhandled rejection is noise on top
	// of a message the page is already showing.
	ready.catch(() => {});

	/*
	 * Ask for the first frame without being told to.
	 *
	 * A host that mounted this with somewhere to capture from has already said
	 * what it wants; making the operator press Capture on an empty stage first
	 * is a question that answers itself. Kicked off here rather than after the
	 * stylesheet so the two waits overlap -- the frame is several megabytes off
	 * the camera and the module is coming from a CDN, and doing them one after
	 * the other doubles the time to first picture for no reason.
	 *
	 * hostOpened is the guard: a host that mounts WITH a capture provider and
	 * then opens a frame of its own would otherwise have this one land on top
	 * of it.
	 */
	if (capture && autoCapture && !hostOpened && !state.info && !state.busy) {
		/*
		 * Not gated on the worker booting.
		 *
		 * capture() is the host's own fetch -- several megabytes off the
		 * camera -- and the engine is needed only to decode what comes back.
		 * Waiting for the worker first put the two in series: module, wasm,
		 * THEN the transfer. Started here they overlap.
		 */
		takeFrame(true);
	}

	return {
		root,
		open: async (bytes, label) => {
			if (dead) throw new Error(dead);
			hostOpened = true;
			await ready;
			return openBytes(bytes, label);
		},
		destroy() {
			ro?.disconnect();
			window.removeEventListener('resize', onResize);
			window.removeEventListener('blur', onLetGo);
			window.removeEventListener('pointerup', onPointerLetGo);
			window.removeEventListener('pointercancel', onPointerLetGo);
			document.removeEventListener('visibilitychange', onLetGo);
			// A countdown that outlived its editor would revert a camera whose
			// operator had closed the page and moved on.
			stopHold();
			stopFocusPoll();
			moveRelease();
			sweepStop();
			// The walk back still has to happen -- the lens is real -- but
			// nothing after it may touch a panel that is being removed.
			sweepClosed = true;
			filterGen++;
			abandonAll('the editor was closed');
			worker?.terminate();
			worker = null;
			if (styles) releaseStylesheet();
			root.innerHTML = '';
			// Destroyed before the stylesheet arrived, the root would otherwise
			// be handed back to the host still invisible.
			root.style.visibility = '';
			root.classList.remove('re-root');
		},
	};
}
