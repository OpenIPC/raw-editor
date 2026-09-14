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
			setTimeout(() => rej(new Error('the page never reported within 60s')), 60000)),
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
