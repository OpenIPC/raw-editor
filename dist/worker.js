/*
 * The engine, off the main thread.
 *
 * A full-frame develop is ~180 ms. On the main thread that is a visible freeze
 * every time a control is released, so the engine runs here and the page only
 * ever handles finished pixels.
 *
 * The module is fetched from a CDN, and a Worker cannot be constructed from a
 * cross-origin URL — the page works around that by fetching this file as text
 * and running it from a blob. A blob URL has no useful base, so the page
 * injects an absolute one as ENGINE_BASE before the import below resolves.
 */
const BASE = self.ENGINE_BASE || './';

let engine = null;

async function boot() {
	const { instantiate } = await import(BASE + 'engine.js');
	const r = await fetch(BASE + 'engine.wasm');
	if (!r.ok) throw new Error('engine.wasm: http ' + r.status);
	engine = await instantiate(await r.arrayBuffer());
}

const ready = boot().then(
	() => postMessage({ type: 'ready' }),
	(e) => postMessage({ type: 'fatal', message: e.message })
);

onmessage = async (ev) => {
	await ready;
	const { id, type, payload } = ev.data;
	if (!engine) return postMessage({ id, type: 'error', message: 'engine unavailable' });
	try {
		if (type === 'open') {
			const info = engine.open(new Uint8Array(payload.bytes));
			const probe = engine.probeCFA();
			postMessage({ id, type: 'opened', info, probe });
		} else if (type === 'sample') {
			const got = engine.samplePatch(payload.x, payload.y, payload.radius, payload);
			postMessage({ id, type: 'sampled', raw: got.raw, neutral: got.neutral });
		} else if (type === 'develop') {
			const out = engine.develop(payload);
			// The RGBA lives in wasm memory, which cannot be transferred; copy
			// it into a buffer of its own and hand that over instead.
			const copy = new Uint8ClampedArray(out.pixels);
			const hist = engine.histogram();
			postMessage({
				id, type: 'developed', width: out.width, height: out.height,
				pixels: copy,
				hist: { r: hist.r, g: hist.g, b: hist.b },
			}, [copy.buffer, hist.r.buffer, hist.g.buffer, hist.b.buffer]);
		}
	} catch (e) {
		postMessage({ id, type: 'error', message: e.message });
	}
};
