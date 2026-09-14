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
};

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

export function mountEditor(root, { base = './', onExit } = {}) {
	root.classList.add('re-root');
	root.innerHTML = '';

	const state = { info: null, probe: null, cfa: 0, demosaic: 1, black: 0, white: 1023,
		neutral: [1, 1, 1], gain: 1, fit: true, busy: false };

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
		{ label: 'Calibrate', value: 'calibrate', disabled: true, title: 'Not in this version' },
	], 0, () => {}, { wide: false });
	top.append(backBtn, nameEl, sensorChip, el('span', 're-rule'), modeSeg, el('span', 're-rule'));
	if (onExit) backBtn.addEventListener('click', onExit); else backBtn.hidden = true;

	const stage = el('div', 're-stage re-fit');
	const canvas = el('canvas');
	canvas.hidden = true;
	const drop = el('div', 're-drop',
		'<div style="font-size:14px">Drop a .dng here</div>' +
		'<div class="re-note">or open one from the camera</div>');
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
	let worker = null, seq = 0;
	const pending = new Map();

	async function startWorker() {
		// A Worker cannot be constructed from a cross-origin URL, so the source
		// is fetched as text and run from a blob — and because a blob URL has no
		// useful base, the real one is injected ahead of it.
		const abs = new URL(base, location.href).href;
		const src = await (await fetch(abs + 'worker.js')).text();
		const blob = new Blob([`self.ENGINE_BASE=${JSON.stringify(abs)};\n${src}`],
			{ type: 'text/javascript' });
		worker = new Worker(URL.createObjectURL(blob), { type: 'module' });
		worker.onmessage = (ev) => {
			const m = ev.data;
			if (m.type === 'fatal') return fail(m.message);
			const p = pending.get(m.id);
			if (!p) return;
			pending.delete(m.id);
			m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m);
		};
	}
	const call = (type, payload, transfer = []) => new Promise((resolve, reject) => {
		const id = ++seq;
		pending.set(id, { resolve, reject });
		worker.postMessage({ id, type, payload }, transfer);
	});

	function fail(message) {
		drop.hidden = false;
		drop.innerHTML = `<div class="re-notice re-warn" style="max-width:520px">${ICON.warn}` +
			`<div>${message}</div></div>`;
	}

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
			histBox.innerHTML = histogramSVG(r.hist);
			zoomEl.textContent = state.fit ? 'Fit' : '100%';
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
		}).node;
		wb.append(mk('Red', 0), mk('Blue', 2));
		wb.append(Object.assign(el('p', 're-note'), {
			textContent: 'As shot is the gain the camera’s own AWB had settled on.',
			style: 'margin:7px 0 0',
		}));
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
			const r = await call('open', { bytes: bytes.buffer }, [bytes.buffer]);
			state.info = r.info;
			state.probe = r.probe;
			Object.assign(state, {
				cfa: r.info.cfa, black: r.info.black, white: r.info.white,
				neutral: r.info.neutral.slice(), gain: 1,
			});
			nameEl.textContent = label;
			sensorChip.hidden = false;
			sensorChip.innerHTML = '<span class="re-chip-k">sensor</span>' +
				`<span class="re-mono">${r.info.model || 'unknown'}</span>`;
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

	const ready = startWorker().catch((e) => fail('The editor could not start: ' + e.message));

	return {
		root,
		open: async (bytes, label) => { await ready; return openBytes(bytes, label); },
		destroy() { worker?.terminate(); root.innerHTML = ''; root.classList.remove('re-root'); },
	};
}
