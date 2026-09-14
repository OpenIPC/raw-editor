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

import { solveFromPatches, patchCentres, CHART_COLS, CHART_ROWS } from './calibrate.js';

const CFA_NAMES = ['RGGB', 'GRBG', 'GBRG', 'BGGR'];
const DEMOSAIC = [
	['None', 0, 'the mosaic as recorded'],
	['Bilinear', 1, 'average the neighbours'],
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
let sheetEl = null, sheetRefs = 0;
function acquireStylesheet(base) {
	if (!sheetEl) {
		sheetEl = document.createElement('link');
		sheetEl.rel = 'stylesheet';
		sheetEl.href = new URL('editor.css', new URL(base, location.href)).href;
		sheetEl.dataset.rawEditor = '';
		document.head.append(sheetEl);
		sheetRefs = 0;
	}
	sheetRefs++;
}
function releaseStylesheet() {
	if (--sheetRefs > 0) return;
	sheetEl?.remove();
	sheetEl = null;
	sheetRefs = 0;
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
	/* How a solved matrix reaches the camera, and how it is taken back:
	 * { apply({colorMatrix, ccm, neutral}), revert(), holdSeconds }. Without
	 * one, Calibrate still measures and solves -- the numbers are useful on
	 * their own -- and simply offers nothing to write them with. */
	calibrate,
	/* How long to wait for the module to arrive and answer. The camera's own
	 * loader gives the CDN eight seconds; a test harness under a virtual clock
	 * needs a number well above whatever budget the browser is running on. */
	startupTimeoutMs = 15000,
} = {}) {
	root.classList.add('re-root');
	root.innerHTML = '';
	if (styles) acquireStylesheet(base);

	const state = { info: null, probe: null, cfa: 0, demosaic: 1, black: 0, white: 1023,
		neutral: [1, 1, 1], gain: 1, fit: true, busy: false,
		/* The file exactly as it arrived. Developing happens on a copy inside
		 * the worker, so this is what Download must hand back -- re-encoding
		 * what is on the canvas would save a preview, not the raw frame. */
		bytes: null, name: null };

	/* ---- chrome ---- */
	const top = el('div', 're-top');
	const backBtn = el('button', 're-btn re-sm', ICON.back);
	backBtn.title = 'Back';
	const nameEl = el('span', '', 'No frame');
	nameEl.style.cssText = 'font-size:13px;font-weight:500';
	const sensorChip = el('span', 're-chip');
	sensorChip.hidden = true;
	const modeSeg = segmented([
		{ label: 'Develop', value: 'develop' },
		{ label: 'Diagnose', value: 'diagnose', disabled: true, title: 'Not in this version' },
		{ label: 'Calibrate', value: 'calibrate' },
	], 0, (v) => setMode(v), { wide: false });
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
	async function takeFrame() {
		if (!capture || state.busy) return;
		state.busy = true;
		if (capBtn) capBtn.disabled = true;
		busy.textContent = 'capturing';
		busy.hidden = false;
		try {
			const got = await capture();
			await openBytes(got.bytes, got.name);
		} catch (e) {
			fail(e && e.message ? e.message : 'The frame could not be captured.');
		} finally {
			state.busy = false;
			if (capBtn) capBtn.disabled = false;
			busy.textContent = 'working';
			busy.hidden = true;
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
			canvas.width = r.width; canvas.height = r.height;
			canvas.getContext('2d').putImageData(new ImageData(r.pixels, r.width, r.height), 0, 0);
			if (mode !== 'calibrate') histBox.innerHTML = histogramSVG(r.hist);
			zoomEl.textContent = state.fit ? 'Fit' : '100%';
			// The canvas may have changed size, and the overlay is positioned
			// against it.
			drawChart();
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

	/* ---- calibrate -------------------------------------------------------
	 *
	 * Four corners dragged onto a colour chart, twenty-four patches read off
	 * the mosaic through them, and two matrices solved from the result. The
	 * solving lives in calibrate.js, which knows nothing about the DOM; this
	 * part is the corners, the numbers on screen, and the way back.
	 */
	let mode = 'develop';
	let corners = null;          /* in frame coordinates */
	let solved = null;
	const chart = el('div', 're-chart');
	chart.hidden = true;
	stage.append(chart);

	function defaultCorners() {
		const w = state.info?.width || 0, h = state.info?.height || 0;
		// A quad over the middle third, which is where someone holding a chart
		// up to a camera puts it.
		return [[w * 0.3, h * 0.35], [w * 0.7, h * 0.35],
			[w * 0.7, h * 0.72], [w * 0.3, h * 0.72]];
	}

	function drawChart() {
		chart.replaceChildren();
		if (mode !== 'calibrate' || !corners || !state.info) return;
		const pts = corners.map(([x, y]) => stageCoords(x, y));
		if (pts.some((p) => !p)) return;

		const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('class', 're-chart-svg');
		const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		poly.setAttribute('points', pts.map((p) => `${p.x},${p.y}`).join(' '));
		poly.setAttribute('class', 're-chart-quad');
		svg.append(poly);
		// The cells, so it is obvious before measuring whether the grid has
		// actually landed on the patches.
		let cells;
		try { cells = patchCentres(corners); } catch { cells = []; }
		for (const c of cells) {
			const at = stageCoords(c.x, c.y);
			if (!at) continue;
			const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			const t = viewTransform();
			dot.setAttribute('cx', at.x);
			dot.setAttribute('cy', at.y);
			dot.setAttribute('r', Math.max(2, (c.radius / (t?.step || 1)) * (t?.scale || 1)));
			dot.setAttribute('class', 're-chart-cell');
			svg.append(dot);
		}
		chart.append(svg);

		pts.forEach((p, i) => {
			const h = el('div', 're-chart-grip');
			h.style.left = p.x + 'px';
			h.style.top = p.y + 'px';
			h.title = ['top left', 'top right', 'bottom right', 'bottom left'][i];
			h.addEventListener('pointerdown', (ev) => {
				ev.preventDefault();
				h.setPointerCapture(ev.pointerId);
				const move = (e) => {
					const at = frameCoords(e);
					if (!at) return;
					corners[i] = [at.x, at.y];
					drawChart();
				};
				const up = () => {
					h.removeEventListener('pointermove', move);
					h.removeEventListener('pointerup', up);
				};
				h.addEventListener('pointermove', move);
				h.addEventListener('pointerup', up);
			});
			chart.append(h);
		});
	}

	async function measureChart() {
		if (!corners) return;
		const cells = patchCentres(corners);
		const patches = [];
		for (const c of cells) {
			const got = await call('sample', {
				x: c.x, y: c.y, radius: Math.max(4, Math.round(c.radius)),
				black: state.black, cfa: state.cfa,
			});
			patches.push(got.raw);
		}
		return solveFromPatches(patches);
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

	function stopHold() {
		if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
		if (holdTick) { clearInterval(holdTick); holdTick = null; }
	}

	function buildCalibrate() {
		insp.replaceChildren();
		const panel = el('div', 're-panel');
		panel.append(Object.assign(el('div', 're-shead'), {
			innerHTML: '<h3 class="re-cap">Colour chart</h3><span class="re-rule"></span>',
		}));
		panel.append(Object.assign(el('p', 're-note'), {
			textContent: 'Drag the four corners onto the corners of the chart — the dark ' +
				'skin patch at the top left, the black patch at the bottom right. The dots ' +
				'show where each patch will be read from.',
		}));
		const row = el('div');
		row.style.cssText = 'display:flex;gap:8px;margin-top:9px';
		const measure = el('button', 're-btn re-pri', '');
		measure.dataset.act = 'measure';
		measure.textContent = 'Measure the chart';
		const reset = el('button', 're-btn', '');
		reset.textContent = 'Reset corners';
		reset.addEventListener('click', () => { corners = defaultCorners(); drawChart(); });
		row.append(measure, reset);
		panel.append(row);
		insp.append(panel);

		const out = el('div', 're-panel');
		out.hidden = true;
		insp.append(out);

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
		fit.textContent = `Mean ΔE ${solved.fit.meanDeltaE.toFixed(1)}, worst ` +
			`${solved.fit.maxDeltaE.toFixed(1)}. Under 3 is a good fit for a 3×3; ` +
			'a spiky light — most LEDs — will not do better, whatever the chart.';
		out.append(fit);

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
	}

	async function applyToCamera(out, send) {
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

		/* From here the camera is carrying the new matrix and something must
		 * take it back. The countdown is the default; confirming is the
		 * exception, which is the right way round for a change that can make
		 * the picture unwatchable. */
		const bar = el('div', 're-notice re-warn', ICON.warn);
		bar.dataset.act = 'hold';
		const text = el('div');
		bar.append(text);
		out.append(bar);
		let left = hold;
		const paint = () => {
			text.textContent = `Applied to the camera. Putting it back in ${left}s ` +
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

		const finish = async (revert) => {
			stopHold();
			acts.remove();
			if (revert) {
				text.textContent = 'Putting it back…';
				try {
					await calibrate.revert();
					text.textContent = 'Put back. The camera is on what it had before.';
				} catch (e) {
					text.textContent = 'Could not put it back: ' + e.message;
				}
			} else {
				bar.classList.remove('re-warn');
				text.textContent = 'Kept. The camera will use this after a restart too.';
			}
			send.disabled = false;
		};
		keep.addEventListener('click', () => finish(false));
		back.addEventListener('click', () => finish(true));
		holdTick = setInterval(() => { left--; if (left > 0) paint(); }, 1000);
		holdTimer = setTimeout(() => finish(true), hold * 1000);
	}

	function setMode(m) {
		mode = m;
		if (m === 'calibrate') {
			if (!corners) corners = defaultCorners();
			chart.hidden = false;
			buildCalibrate();
		} else {
			chart.hidden = true;
			stopHold();
			if (state.info) buildInspector();
		}
		drawChart();
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
			state.cfa, (v) => { state.cfa = v; commit(); });
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
			corners = null;
			solved = null;
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
			buildInspector();
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

	return {
		root,
		open: async (bytes, label) => {
			if (dead) throw new Error(dead);
			await ready;
			return openBytes(bytes, label);
		},
		destroy() {
			// A countdown that outlived its editor would revert a camera whose
			// operator had closed the page and moved on.
			stopHold();
			abandonAll('the editor was closed');
			worker?.terminate();
			worker = null;
			if (styles) releaseStylesheet();
			root.innerHTML = '';
			root.classList.remove('re-root');
		},
	};
}
