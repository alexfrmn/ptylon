import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const BASE_URL = process.env.WC_BASE_URL || 'http://127.0.0.1:8790';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const inputs = [];
const scriptResponses = [];
const sockets = [];
let n = 0;
let sidForTest = '';
page.on('response', r => { if (r.url().includes('/_next/static/') && r.url().endsWith('.js'))
    scriptResponses.push({ url: r.url(), status: r.status() }); });
// Load the deployed frontend; isolate every API and PTY interaction from user state.
await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    let body = { ok: true };
    if (path === '/api/auth')
        body = { authenticated: true, wsToken: 'isolated-browser-probe' };
    if (path === '/api/workspace')
        body = { state: null };
    if (path === '/api/recipes')
        body = { recipes: [] };
    route.fulfill({ json: body });
});
await page.routeWebSocket(/.*/, socket => {
    sockets.push(socket);
    socket.onMessage(raw => {
        const m = JSON.parse(String(raw));
        if (m.type === 'input')
            inputs.push(m);
        if (m.type === 'create') {
            const sid = `browser-probe-${++n}`;
            sidForTest = sid;
            socket.send(JSON.stringify({ type: 'created', sessionId: sid, _cid: m._cid }));
            setTimeout(() => socket.send(JSON.stringify({ type: 'output', sessionId: sid, data: '\x1b[?2004h\x1b[2J\x1b[HHistory text for selection\r\nPrevious answer\r\n\x1b[20;1H> ' })), 80);
        }
    });
    setTimeout(() => socket.send(JSON.stringify({ type: 'welcome', sessions: [], sessionsTrusted: true })), 100);
});
try {
    const res = await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    assert.equal(res.status(), 200);
    const skip = page.getByRole('button', { name: 'Skip all', exact: true });
    if (await skip.count())
        await skip.click();
    const screen = page.locator('.xterm-screen').first();
    await screen.waitFor();
    await page.waitForTimeout(250);
    const box = await screen.boundingBox();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copiedText = text; }, readText: async () => '' } }));
    inputs.length = 0;
    for (const y of [10, 100, box.height - 20])
        await page.mouse.click(box.x + 90, box.y + y);
    await page.waitForTimeout(100);
    assert.equal(inputs.length, 0, 'plain clicks leaked input');
    // Native drag selection is still available and sends no arrow sequences.
    await page.mouse.move(box.x + 2, box.y + 7);
    await page.mouse.down();
    await page.mouse.move(box.x + 150, box.y + 7, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    assert.equal(inputs.length, 0, 'selection leaked input');
    assert((await page.evaluate(() => window.__copiedText || '')).includes('History'), 'drag did not select terminal text');
    await page.mouse.click(box.x + 90, box.y + 100);
    const payload = 'Большой материал\n\tВторая часть\r\n' + 'Текст '.repeat(260) + '\n';
    await page.evaluate(text => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => text, writeText: async () => { } } }), payload);
    await page.mouse.click(box.x + 90, box.y + 100, { button: 'right' });
    await page.waitForTimeout(120);
    assert.equal(inputs.length, 1);
    sidForTest = inputs[0].sessionId;
    assert.equal(inputs[0].data, '\x1b[200~' + payload.replace(/\r?\n/g, '\r') + '\x1b[201~');
    await page.keyboard.type(' My comment');
    assert.equal(inputs.slice(1).map(m => m.data).join(''), ' My comment');
    inputs.length = 0;
    await page.keyboard.press('Escape');
    assert.deepEqual(inputs.map(m => m.data), ['\x1b']);
    assert(scriptResponses.length > 0 && scriptResponses.every(r => r.status === 200), 'deployed assets failed');
    // Simulate reconnect after the startup mode sequence has fallen out of scrollback.
    inputs.length = 0;
    const socket = sockets.at(-1);
    socket.send(JSON.stringify({ type: 'metadata', data: [{ sessionId: sidForTest, id: sidForTest, activeCommand: 'codex', updatedAt: Date.now() }] }));
    socket.send(JSON.stringify({ type: 'output', sessionId: sidForTest, data: '\x1b[?2004l' }));
    socket.send(JSON.stringify({ type: 'scrollback', sessionId: sidForTest, data: 'Older output without startup modes\r\n> ' }));
    await page.waitForTimeout(150);
    await page.mouse.click(box.x + 90, box.y + 100, { button: 'right' });
    await page.waitForTimeout(150);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].data, '\x1b[200~' + payload.replace(/\r?\n/g, '\r') + '\x1b[201~', 'Codex paste after truncated replay lost framing');
    // An ordinary shell/app with paste mode off must retain its own terminal mode.
    inputs.length = 0;
    socket.send(JSON.stringify({ type: 'metadata', data: [{ sessionId: sidForTest, id: sidForTest, activeCommand: 'cat', updatedAt: Date.now() }] }));
    socket.send(JSON.stringify({ type: 'output', sessionId: sidForTest, data: '\x1b[?2004l' }));
    await page.waitForTimeout(100);
    await page.mouse.click(box.x + 90, box.y + 100, { button: 'right' });
    await page.waitForTimeout(100);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].data, payload.replace(/\r?\n/g, '\r'), 'non-Codex mode was overridden');
    const report = { deployedUrl: BASE_URL, checks: ['deployed assets load', 'plain clicks send no keys', 'drag selection works', 'right click preserves one large bracketed paste', 'comment appended without Enter', 'Escape delivered exactly once', 'Codex paste recovers after truncated replay', 'non-Codex paste mode respected'], assets: scriptResponses.length, realApiWrites: 0, realPtyInputs: 0 };
    console.log(JSON.stringify(report));
}
finally {
    await browser.close();
}
