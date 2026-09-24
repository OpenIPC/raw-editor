/*
 * Drive the built editor in a real browser.
 *
 * The engine smoke test passes with the interface entirely broken — three of
 * the bugs in this module's first version (a prompt left on top of the picture,
 * a preview scaled to a thumbnail, a canvas that would not grow) were invisible
 * to every check that did not open a browser. So this one does.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execSync, spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
	'.wasm': 'application/wasm', '.dng': 'application/octet-stream' };

function browser() {
	for (const b of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
		try { execSync(`command -v ${b}`, { stdio: 'ignore' }); return b; } catch {}
	}
	throw new Error('no chromium/chrome on PATH');
}

let reportResults;
const reported = new Promise((r) => { reportResults = r; });

const server = createServer(async (req, res) => {
	if (req.method === 'POST' && req.url === '/__results') {
		let body = '';
		for await (const c of req) body += c;
		res.writeHead(204).end();
		reportResults(body);
		return;
	}
	/*
	 * A chart frame, drawn to order.
	 *
	 * The fixture has no colour chart in it and is far too small to hold one,
	 * and committing a 5 MB photograph to test one button is not worth it. So
	 * the page asks for a chart at corners of its own choosing and checks what
	 * comes back against them -- which is a stronger test than a fixture
	 * anyway, since the right answer is known exactly rather than clicked.
	 */
	/* Frames with defects arranged as the test asks, so the panel's verdict
	 * can be checked against an arrangement known in advance. */
	/* A frame whose false positives are CLUSTERED and identical every time --
	 * the shape of scene detail. Distinct from __defects.dng, whose extra
	 * sites are scattered and differ per seed, which is the shape of noise. */
	if (req.url.startsWith('/__textured.dng')) {
		const q = new URL(req.url, 'http://x').searchParams;
		const { makeDefectFrame } = await import('./make-defects.mjs');
		res.writeHead(200, { 'content-type': 'application/octet-stream' });
		// mode 'clustered' puts every extra site in a few tight clumps, and a
		// FIXED seed keeps them in the same clumps from capture to capture --
		// so they survive any number of repeats, exactly as texture does.
		res.end(makeDefectFrame({ mode: 'clustered', n: Number(q.get('n') || 160),
			shared: 0, seed: 4242 }).bytes);
		return;
	}
	if (req.url.startsWith('/__defects.dng')) {
		const q = new URL(req.url, 'http://x').searchParams;
		const { makeDefectFrame } = await import('./make-defects.mjs');
		res.writeHead(200, { 'content-type': 'application/octet-stream' });
		/* `level` is the flat field the spikes sit on, and it is what decides
		 * whether the editor calls a frame covered: the default 300 of 4095 is
		 * a lit scene, and something near the floor is a capped lens. */
		/* width/height as well as n, because the engine stores at most 4096
		 * defects and 512x512 cannot be made to overflow it -- the spikes
		 * start landing on each other first. */
		res.end(makeDefectFrame({ mode: q.get('mode') || 'scattered',
			width: Number(q.get('w') || 512), height: Number(q.get('h') || 512),
			n: Number(q.get('n') || 120), shared: Number(q.get('shared') || 0),
			level: Number(q.get('level') || 300),
			seed: Number(q.get('seed') || 3) }).bytes);
		return;
	}
	if (req.url.startsWith('/__chart.dng')) {
		const q = new URL(req.url, 'http://x').searchParams;
		const corners = JSON.parse(q.get('corners'));
		const { makeChartFrame } = await import('./make-chart.mjs');
		res.writeHead(200, { 'content-type': 'application/octet-stream' });
		res.end(makeChartFrame({ corners }).bytes);
		return;
	}
	const p = join(ROOT, normalize(decodeURIComponent(req.url.split('?')[0])));
	try {
		const body = await readFile(p);
		res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
		res.end(body);
	} catch { res.writeHead(404).end('no'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
server.unref();
const port = server.address().port;

/* Spawned, not execSync'd: a synchronous child blocks node's event loop, and
 * the server above would then never answer the browser it is being run for.
 *
 * No --virtual-time-budget either. It fires every timer as fast as it can and
 * so beats the module's own fetches, reporting a startup failure that is purely
 * an artefact of the harness. The page says when it is finished instead. */
const child = spawn(browser(), [
	'--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
	'--window-size=1280,860',
	`http://localhost:${port}/tests/ui-check.html`,
], { stdio: 'ignore' });

let results;
try {
	results = JSON.parse(await Promise.race([
		reported,
		new Promise((_, rej) =>
			/* 60s once, and the suite reached 58 of them. That is not a budget
			 * any more, it is a coin toss on a slow machine -- and the failure
			 * it produces says "the page never reported", which reads like a
			 * hang rather than a clock running out. Raised with room to grow. */
			setTimeout(() => rej(new Error('the page never reported within 180s')), 180000)),
	]));
} catch (e) {
	console.error(e.message);
	child.kill('SIGKILL');
	server.close();
	process.exit(1);
} finally {
	child.kill('SIGKILL');
	server.close();
}

let bad = 0;
for (const r of results) {
	console.log(`${r.ok ? '  ok  ' : '  FAIL'} ${r.name}${r.detail && !r.ok ? ': ' + r.detail : ''}`);
	if (!r.ok) bad++;
}
console.log(bad ? `\n${bad} FAILED` : '\nall UI checks passed');
process.exit(bad ? 1 : 0);
