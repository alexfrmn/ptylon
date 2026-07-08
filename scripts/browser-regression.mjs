import { spawn } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';

const BASE_URL = process.env.WC_BASE_URL || 'http://127.0.0.1:8790';
const WS_URL = process.env.WC_WS_URL || 'ws://127.0.0.1:8791';
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const OUT_DIR = process.env.WC_REGRESSION_OUT || `/tmp/web-console-browser-regression-${Date.now()}`;
const INPUT_MARKER = `WC_INPUT_${Date.now()}`;
const NOTICE_MARKER = `WC_NOTICE_${Date.now()}`;
const PROJECT_ROOT = process.cwd();
const PROJECT_ROOT_NAME = basename(PROJECT_ROOT);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function envValue(name) {
  if (name === 'AUTH_PASSWORD' && process.env.WC_AUTH_PASSWORD) return process.env.WC_AUTH_PASSWORD;
  if (name === 'WEB_CONSOLE_ADMIN_TOKEN' && process.env.WC_ADMIN_TOKEN) return process.env.WC_ADMIN_TOKEN;
  if (process.env[name]) return process.env[name];
  const text = await readFile('.env', 'utf8');
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  assert(line, `missing ${name}; set it in .env or as env var`);
  return line.slice(name.length + 1).replace(/^['"]|['"]$/g, '');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.console = [];
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}: ${JSON.stringify(msg.error.data || '')}`));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        this.console.push(msg.params.args?.map((arg) => arg.value ?? arg.description ?? '').join(' '));
      }
    });
  }

  async ready() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  call(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.ws.close();
  }
}

async function startChrome() {
  const profile = join(tmpdir(), `wc-regression-chrome-${Date.now()}`);
  const port = 9300 + Math.floor(Math.random() * 1000);
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1440,950',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  chrome.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  let wsUrl;
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        wsUrl = (await res.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert(wsUrl, `Chrome remote debugging did not start: ${stderr}`);
  const cdp = new Cdp(wsUrl);
  await cdp.ready();
  return { chrome, cdp };
}

async function newPage(cdp) {
  const target = await cdp.call('Target.createTarget', { url: 'about:blank' });
  const attached = await cdp.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.call('Page.enable', {}, sessionId);
  await cdp.call('Runtime.enable', {}, sessionId);
  await cdp.call('Input.setIgnoreInputEvents', { ignore: false }, sessionId);
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__wcSentInputs = [];
      const originalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function(data) {
        try {
          const msg = JSON.parse(data);
          if (msg && msg.type === 'input') window.__wcSentInputs.push(msg);
        } catch {}
        return originalSend.apply(this, arguments);
      };
    `,
  }, sessionId);
  return { targetId: target.targetId, sessionId };
}

async function evalJs(cdp, page, expression) {
  const res = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, page.sessionId);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'Runtime.evaluate failed');
  return res.result?.value;
}

async function waitFor(cdp, page, expression, label, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evalJs(cdp, page, expression).catch(() => false);
    if (value) return value;
    await delay(200);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function click(cdp, page, x, y) {
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, page.sessionId);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, page.sessionId);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, page.sessionId);
}

function terminalSessionIds(state) {
  const ids = [];
  for (const tab of state?.tabs || []) {
    if (tab.type === 'terminal' && tab.sessionId) ids.push(tab.sessionId);
  }
  for (const workspace of state?.workspaces || []) {
    for (const tab of workspace.tabs || []) {
      if (tab.type === 'terminal' && tab.sessionId) ids.push(tab.sessionId);
    }
  }
  return [...new Set(ids)];
}

async function killSessions(wsToken, sessionIds) {
  if (!wsToken || sessionIds.length === 0) return;
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(wsToken)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  for (const sessionId of sessionIds) {
    ws.send(JSON.stringify({ type: 'kill', sessionId }));
  }
  await delay(500);
  ws.close();
}

async function sendSessionInput(wsToken, sessionId, data) {
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(wsToken)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.send(JSON.stringify({ type: 'input', sessionId, data }));
  await delay(500);
  ws.close();
}

async function sendSessionInputAndWaitForOutput(wsToken, sessionId, data, marker, timeoutMs = 10000) {
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(wsToken)}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`timeout waiting for terminal output ${marker}`)), timeoutMs);
      const attachCid = `regression-attach-${Date.now()}`;
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'attached' && msg.sessionId === sessionId && msg._cid === attachCid) {
          ws.send(JSON.stringify({ type: 'input', sessionId, data }));
          return;
        }
        if (msg.type === 'output' && msg.sessionId === sessionId && String(msg.data || '').includes(marker)) {
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 80, rows: 24, _cid: attachCid }));
    });
  } finally {
    ws.close();
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const password = await envValue('AUTH_PASSWORD');
  const adminToken = await envValue('WEB_CONSOLE_ADMIN_TOKEN').catch(() => envValue('JWT_SECRET'));
  const { chrome, cdp } = await startChrome();
  const report = { baseUrl: BASE_URL, outDir: OUT_DIR, checks: [] };
  let page = null;
  let wsToken = null;
  let originalWorkspace = null;
  let originalSessionIds = [];
  let baselineSessionIds = [];

  try {
    page = await newPage(cdp);
    await cdp.call('Page.navigate', { url: BASE_URL }, page.sessionId);
    await waitFor(cdp, page, `document.body && document.body.innerText.includes('Connect')`, 'login page');

    const authenticated = await evalJs(cdp, page, `
      fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ${JSON.stringify(password)} })
      }).then((r) => r.ok)
    `);
    assert(authenticated, 'auth POST failed');
    report.checks.push('manual login API accepted password');

    const authData = await evalJs(cdp, page, `fetch('/api/auth').then((r) => r.json())`);
    wsToken = authData?.wsToken;
    originalWorkspace = await evalJs(cdp, page, `fetch('/api/workspace').then((r) => r.json()).then((data) => data.state)`);
    originalSessionIds = terminalSessionIds(originalWorkspace);

    await cdp.call('Page.navigate', { url: BASE_URL }, page.sessionId);
    await waitFor(cdp, page, `Array.from(document.querySelectorAll('button')).some((button) => button.getAttribute('title') === 'New Terminal (splits active pane)')`, 'app shell');
    await evalJs(cdp, page, `Array.from(document.querySelectorAll('button')).find((button) => button.innerText.trim() === 'Skip all')?.click()`);
    await waitFor(cdp, page, `!Array.from(document.querySelectorAll('button')).some((button) => button.innerText.trim() === 'Skip all')`, 'onboarding dismissed');
    const stateBeforeTerminal = await evalJs(cdp, page, `JSON.parse(localStorage.getItem('web-console-workspace') || 'null')`);
    baselineSessionIds = [...new Set([...originalSessionIds, ...terminalSessionIds(stateBeforeTerminal)])];

    await evalJs(cdp, page, `(() => {
      const addTerminal = Array.from(document.querySelectorAll('button'))
        .find((button) => button.getAttribute('title') === 'New Terminal (splits active pane)');
      if (!addTerminal) return false;
      addTerminal.click();
      return true;
    })()`);
    try {
      await waitFor(cdp, page, `document.querySelector('.xterm')`, 'xterm created');
    } catch (error) {
      const debug = await evalJs(cdp, page, `(() => ({
        bodyText: document.body.innerText.slice(0, 4000),
        state: JSON.parse(localStorage.getItem('web-console-workspace') || 'null'),
        buttons: Array.from(document.querySelectorAll('button')).map((button) => ({ title: button.getAttribute('title'), text: button.innerText })),
        errors: window.__NEXT_DATA__ ? [] : ['missing next data']
      }))()`).catch((err) => ({ evalError: err.message }));
      await writeFile(join(OUT_DIR, 'xterm-create-debug.json'), JSON.stringify(debug, null, 2));
      throw error;
    }
    await waitFor(cdp, page, `/\\bconnected\\b/i.test(document.body.innerText)`, 'terminal connected');
    report.checks.push('terminal created and connected');

    const stateAfterTerminal = await waitFor(cdp, page, `(() => {
      const state = JSON.parse(localStorage.getItem('web-console-workspace') || 'null');
      if (!state) return false;
      const active = (state.tabs || []).find((tab) => tab.id === state.activeTabId);
      return active?.sessionId ? state : false;
    })()`, 'active terminal sessionId');
    const sessionIdsAfterTerminal = terminalSessionIds(stateAfterTerminal);
    const activeTab = (stateAfterTerminal.tabs || []).find((tab) => tab.id === stateAfterTerminal.activeTabId);
    const createdSessionIds = sessionIdsAfterTerminal.filter((id) => !baselineSessionIds.includes(id));
    const activeSessionId = activeTab?.sessionId && !baselineSessionIds.includes(activeTab.sessionId)
      ? activeTab.sessionId
      : createdSessionIds.at(-1) || activeTab?.sessionId || sessionIdsAfterTerminal.at(-1);
    assert(activeSessionId, 'no terminal sessionId found');

    const focusPoint = await evalJs(cdp, page, `(() => {
      const terms = Array.from(document.querySelectorAll('.xterm'))
        .map((candidate) => ({ candidate, textarea: candidate.querySelector('textarea') }))
        .filter(({ candidate, textarea }) => {
          const rect = candidate.getBoundingClientRect();
          return textarea && rect.width > 0 && rect.height > 0 && getComputedStyle(candidate).visibility !== 'hidden';
        })
        .sort((a, b) => b.textarea.getBoundingClientRect().top - a.textarea.getBoundingClientRect().top);
      const term = terms.at(-1)?.candidate;
      const screen = term?.querySelector('.xterm-screen') || term;
      const textarea = term?.querySelector('textarea');
      if (!screen || !textarea) return null;
      const rect = screen.getBoundingClientRect();
      textarea.focus();
      return { x: rect.left + 80, y: rect.top + 80 };
    })()`);
    assert(focusPoint, 'terminal focus point not found');
    await click(cdp, page, focusPoint.x, focusPoint.y);
    await delay(250);

    const longCommand = `printf "${INPUT_MARKER}_${'A'.repeat(220)}"\r`;
    await sendSessionInputAndWaitForOutput(wsToken, activeSessionId, longCommand, INPUT_MARKER);
    report.checks.push('terminal input echoed to browser');

    const sentInputCountBeforeCursorClick = await evalJs(cdp, page, `(window.__wcSentInputs || []).length`);
    const cursorClickPoint = await waitFor(cdp, page, `(() => {
      const terms = Array.from(document.querySelectorAll('.xterm'))
        .filter((candidate) => {
          const rect = candidate.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(candidate).visibility !== 'hidden';
        });
      const term = terms.find((candidate) => candidate.innerText.includes(${JSON.stringify(INPUT_MARKER)})) || terms.at(-1);
      const screen = term?.querySelector('.xterm-screen') || term;
      const viewport = term?.querySelector('.xterm-viewport') || screen;
      if (!screen || !viewport) return false;
      const screenRect = screen.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const cursorRect = term.querySelector('.xterm-cursor')?.getBoundingClientRect();
      if (cursorRect && cursorRect.width > 0 && cursorRect.height > 0) {
        const cellWidth = Math.max(6, cursorRect.width);
        const x = Math.max(screenRect.left + cellWidth, cursorRect.left - cellWidth * 8);
        const y = cursorRect.top + cursorRect.height / 2;
        if (x >= screenRect.left && x <= screenRect.right && y >= screenRect.top && y <= screenRect.bottom) return { x, y };
      }
      return { x: screenRect.left + Math.max(20, screenRect.width * 0.2), y: viewportRect.bottom - 20 };
    })()`, 'terminal cursor click target');
    await evalJs(cdp, page, `(() => {
      window.__wcClickProbe = [];
      const record = (event) => {
        const element = document.elementFromPoint(event.clientX, event.clientY);
        window.__wcClickProbe.push({
          type: event.type,
          x: event.clientX,
          y: event.clientY,
          button: event.button,
          target: event.target?.className || event.target?.tagName || '',
          targetInXterm: Boolean(event.target?.closest?.('.xterm')),
          element: element?.className || element?.tagName || '',
          elementInXterm: Boolean(element?.closest?.('.xterm')),
        });
      };
      document.addEventListener('mousedown', record, true);
      document.addEventListener('mouseup', record, true);
    })()`);
    await click(cdp, page, cursorClickPoint.x, cursorClickPoint.y);
    try {
      await waitFor(cdp, page, `(() => {
        const sent = (window.__wcSentInputs || []).slice(${sentInputCountBeforeCursorClick});
        return sent.some((msg) => msg.sessionId === ${JSON.stringify(activeSessionId)}
          && (String(msg.data || '').includes('\\u001b[C') || String(msg.data || '').includes('\\u001b[D')));
      })()`, 'click-to-cursor arrow input sent');
    } catch (error) {
      const debug = await evalJs(cdp, page, `(() => ({
        sentInputs: (window.__wcSentInputs || []).slice(${sentInputCountBeforeCursorClick}),
        clickProbe: window.__wcClickProbe || [],
        elementAtClick: (() => {
          const element = document.elementFromPoint(${cursorClickPoint.x}, ${cursorClickPoint.y});
          return {
            target: element?.className || element?.tagName || '',
            inXterm: Boolean(element?.closest?.('.xterm')),
            text: element?.innerText?.slice?.(0, 240) || ''
          };
        })(),
        cursorRects: Array.from(document.querySelectorAll('.xterm-cursor')).map((el) => {
          const rect = el.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }),
        xtermRects: Array.from(document.querySelectorAll('.xterm')).map((el) => {
          const rect = el.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, text: el.innerText.slice(0, 240) };
        })
      }))()`).catch((err) => ({ evalError: err.message }));
      await writeFile(join(OUT_DIR, 'click-to-cursor-debug.json'), JSON.stringify({ activeSessionId, cursorClickPoint, debug }, null, 2));
      throw error;
    }
    report.checks.push('click-to-cursor sends arrow-key input');

    await sendSessionInput(wsToken, activeSessionId, `\u0015cd ${shellQuote(PROJECT_ROOT)}\r`);
    await waitFor(cdp, page, `Array.from(document.querySelectorAll('[data-session-meta="${activeSessionId}"]')).some((el) => el.textContent.includes(${JSON.stringify(PROJECT_ROOT_NAME)}))`, 'session metadata surfaced');
    report.checks.push('terminal session metadata surfaced in browser');

    await sendSessionInput(wsToken, activeSessionId, `\u0015printf '\\033]777;notify;${NOTICE_MARKER};Needs attention\\007'\r`);
    try {
      await waitFor(cdp, page, `document.body.innerText.includes(${JSON.stringify(NOTICE_MARKER)})`, 'terminal notification surfaced');
    } catch (error) {
      const debug = await evalJs(cdp, page, `(() => ({
        marker: ${JSON.stringify(NOTICE_MARKER)},
        bodyText: document.body.innerText.slice(0, 4000),
        state: JSON.parse(localStorage.getItem('web-console-workspace') || 'null'),
        meta: Array.from(document.querySelectorAll('[data-session-meta]')).map((el) => ({ sessionId: el.getAttribute('data-session-meta'), text: el.textContent })),
        xtermRows: Array.from(document.querySelectorAll('.xterm-rows div')).slice(-16).map((row) => row.innerText)
      }))()`).catch((err) => ({ evalError: err.message }));
      await writeFile(join(OUT_DIR, 'notification-debug.json'), JSON.stringify({ activeSessionId, debug }, null, 2));
      throw error;
    }
    report.checks.push('terminal OSC notification surfaced in browser');

    const recipesResponse = await evalJs(cdp, page, `fetch('/api/recipes').then((r) => r.json())`);
    assert(Array.isArray(recipesResponse?.recipes) && recipesResponse.recipes.some((recipe) => recipe.name === 'Shell Pair'), 'recipes API did not return Shell Pair');
    report.checks.push('recipes API returned built-in recipes');

    const adminPing = await evalJs(cdp, page, `
      fetch('/api/admin/ping', { headers: { 'X-Web-Console-Admin-Token': ${JSON.stringify(adminToken)} } })
        .then((r) => r.ok)
    `);
    assert(adminPing, 'admin ping failed');
    report.checks.push('admin API accepted local token');

    await evalJs(cdp, page, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
    try {
      await waitFor(cdp, page, `Boolean(document.querySelector('input[placeholder="Run command or recipe"]'))`, 'command palette opened');
    } catch (error) {
      const debug = await evalJs(cdp, page, `(() => ({
        bodyText: document.body.innerText.slice(0, 4000),
        buttons: Array.from(document.querySelectorAll('button')).map((button) => ({ title: button.getAttribute('title'), text: button.innerText })),
        inputs: Array.from(document.querySelectorAll('input')).map((input) => ({ placeholder: input.getAttribute('placeholder'), value: input.value }))
      }))()`).catch((err) => ({ evalError: err.message }));
      await writeFile(join(OUT_DIR, 'palette-debug.json'), JSON.stringify(debug, null, 2));
      throw error;
    }
    await evalJs(cdp, page, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.innerText.includes('Shell Pair'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, page, `(() => {
      const state = JSON.parse(localStorage.getItem('web-console-workspace') || 'null');
      return (state?.workspaces || []).some((workspace) => workspace.name === 'Shell Pair');
    })()`, 'recipe workspace created');
    report.checks.push('command palette launched Shell Pair recipe');

    await evalJs(cdp, page, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(cdp, page, `Boolean(document.querySelector('input[placeholder="Run command or recipe"]'))`, 'command palette reopened for monitoring recipe');
    await evalJs(cdp, page, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.innerText.includes('Monitoring'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    const monitoringTabs = await waitFor(cdp, page, `(() => {
      const state = JSON.parse(localStorage.getItem('web-console-workspace') || 'null');
      if (!state || state.workspaces?.find((workspace) => workspace.id === state.activeWorkspaceId)?.name !== 'Monitoring') return false;
      const tabs = (state.tabs || []).filter((tab) => tab.type === 'terminal' && tab.sessionId);
      const expected = new Map([
        ['top', 'top -d 2'],
        ['logs', 'journalctl -f --no-pager -n 30'],
        ['net', 'ss -tlnp; echo "---"; ss -tnp | head -20'],
        ['disk', 'df -h; echo "---"; iostat -x 2 2>/dev/null || echo "iostat not installed, showing df -h loop"; watch -n 5 df -h'],
      ]);
      if (tabs.length !== expected.size) return false;
      return tabs.every((tab) => expected.get(tab.name) === tab.initCommand) ? tabs : false;
    })()`, 'monitoring recipe sessions created');
    assert(Array.isArray(monitoringTabs) && monitoringTabs.length === 4, 'monitoring recipe tabs missing');
    await evalJs(cdp, page, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(cdp, page, `Array.from(document.querySelectorAll('button[aria-label^="Actions for"]')).length > 0`, 'workspace actions button visible');
    report.checks.push('monitoring recipe starts all pane commands');
    report.checks.push('workspace actions are reachable without right click');

    await evalJs(cdp, page, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }))`);
    await waitFor(cdp, page, `Boolean(document.querySelector('input[placeholder="Run command or recipe"]'))`, 'command palette reopened for theme gallery');
    await evalJs(cdp, page, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.innerText.includes('Theme gallery'));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, page, `document.body.innerText.includes('Theme Gallery') && Boolean(document.querySelector('[data-theme-palette-option="paper-trail"]'))`, 'theme gallery opened');
    await evalJs(cdp, page, `document.querySelector('[data-theme-palette-option="paper-trail"]').click()`);
    await waitFor(cdp, page, `document.documentElement.getAttribute('data-theme-palette') === 'paper-trail' && localStorage.getItem('circadian-theme-palette') === 'paper-trail'`, 'theme palette applied');
    await waitFor(cdp, page, `fetch('/api/workspace').then((r) => r.json()).then((data) => data.state?.themeSettings?.paletteId === 'paper-trail').catch(() => false)`, 'theme palette synced to server state');
    await evalJs(cdp, page, `document.querySelector('[data-theme-palette-option="circadian"]').click()`);
    await waitFor(cdp, page, `document.documentElement.getAttribute('data-theme-palette') === 'circadian' && localStorage.getItem('circadian-theme-palette') === 'circadian'`, 'theme palette reset');
    await waitFor(cdp, page, `fetch('/api/workspace').then((r) => r.json()).then((data) => data.state?.themeSettings?.paletteId === 'circadian').catch(() => false)`, 'theme palette reset synced to server state');
    await evalJs(cdp, page, `document.querySelector('[data-theme-palette-option="paper-trail"]').click()`);
    await waitFor(cdp, page, `document.documentElement.getAttribute('data-theme-palette') === 'paper-trail'`, 'theme palette reapplied before auto');
    await evalJs(cdp, page, `Array.from(document.querySelectorAll('button')).find((candidate) => candidate.innerText.trim() === 'close')?.click()`);
    await evalJs(cdp, page, `Array.from(document.querySelectorAll('button')).find((candidate) => candidate.innerText.trim() === 'auto')?.click()`);
    await waitFor(cdp, page, `document.documentElement.getAttribute('data-theme-palette') === 'circadian' && document.documentElement.getAttribute('data-circadian-mode') === 'auto' && localStorage.getItem('circadian-theme-palette') === 'circadian' && localStorage.getItem('circadian-theme-mode') === 'auto'`, 'auto theme resets fixed palette');
    await waitFor(cdp, page, `fetch('/api/workspace').then((r) => r.json()).then((data) => data.state?.themeSettings?.paletteId === 'circadian' && data.state?.themeSettings?.mode === 'auto').catch(() => false)`, 'auto theme synced to server state');
    report.checks.push('theme gallery applies, syncs, resets curated palette, and auto restores circadian');

    const adminNoticeTitle = `WC_ADMIN_${Date.now()}`;
    const adminNotify = await evalJs(cdp, page, `
      fetch('/api/admin/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Web-Console-Admin-Token': ${JSON.stringify(adminToken)} },
        body: JSON.stringify({ title: ${JSON.stringify(adminNoticeTitle)}, body: 'admin notice' })
      }).then((r) => r.ok)
    `);
    assert(adminNotify, 'admin notify failed');
    await waitFor(cdp, page, `document.body.innerText.includes(${JSON.stringify(adminNoticeTitle)})`, 'admin notification surfaced');
    report.checks.push('admin notify surfaced in browser');

    await evalJs(cdp, page, `(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.getAttribute('title') === 'Browser Panel');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await waitFor(cdp, page, `(() => {
      const state = JSON.parse(localStorage.getItem('web-console-workspace') || 'null');
      return (state?.tabs || []).some((tab) => tab.type === 'browser' && tab.url);
    })()`, 'browser tab created');
    await waitFor(cdp, page, `Boolean(document.querySelector('[data-browser-surface="server"] img[alt^="Server browser"]'))`, 'server browser surface rendered');
    await waitFor(cdp, page, `(() => {
      const state = JSON.parse(localStorage.getItem('web-console-workspace') || 'null');
      return (state?.tabs || []).some((tab) => tab.type === 'browser' && tab.browserSessionId);
    })()`, 'browser tab bound to server session');
    await waitFor(cdp, page, `fetch('/api/workspace').then((r) => r.json()).then((data) => data.state?.themeSettings?.paletteId === 'circadian').catch(() => false)`, 'workspace autosave preserved theme settings');
    report.checks.push('server browser panel created and rendered');
    const browserTab = await evalJs(cdp, page, `(() => {
      const state = JSON.parse(localStorage.getItem('web-console-workspace') || 'null');
      return (state?.tabs || []).find((tab) => tab.type === 'browser' && tab.browserSessionId) || null;
    })()`);
    assert(browserTab?.browserSessionId, 'browser tab missing server session id');

    const surfaceMarker = `SURFACE_${Date.now()}`;
    const surfaceHtml = `<!doctype html>
      <html>
        <head><title>Surface Test</title></head>
        <body style="margin:0;font-family:monospace">
          <input id="surface-input" aria-label="surface-input" style="position:absolute;left:40px;top:40px;width:360px;height:40px;font-size:24px" autofocus>
          <div id="surface-output" style="position:absolute;left:40px;top:100px"></div>
          <script>
            const input = document.getElementById('surface-input');
            const output = document.getElementById('surface-output');
            input.addEventListener('input', () => { output.textContent = input.value; });
          </script>
        </body>
      </html>`;
    const surfaceUrl = `data:text/html;charset=utf-8,${encodeURIComponent(surfaceHtml)}`;
    const surfaceFrame = await evalJs(cdp, page, `
      fetch('/api/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'open',
          sessionId: ${JSON.stringify(browserTab.browserSessionId)},
          url: ${JSON.stringify(surfaceUrl)},
          width: 900,
          height: 600
        })
      }).then((r) => r.json())
    `);
    assert(surfaceFrame?.ok && surfaceFrame.frame?.sessionId === browserTab.browserSessionId, 'surface test navigation failed');
    assert(surfaceFrame.frame.canGoBack === true, 'server browser history did not expose back navigation');
    const framePulledIntoUi = await evalJs(cdp, page, `(() => {
      const button = Array.from(document.querySelectorAll('button')).find((candidate) => candidate.getAttribute('title') === 'Reload');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(framePulledIntoUi, 'surface frame reload button missing');
    await waitFor(cdp, page, `(() => {
      const img = document.querySelector('[data-browser-surface="server"] img');
      return Boolean(img && img.getAttribute('alt')?.includes('data:text/html'));
    })()`, 'surface data page rendered');
    const surfacePoint = await evalJs(cdp, page, `(() => {
      const surface = document.querySelector('[data-browser-surface="server"]');
      const img = surface?.querySelector('img');
      if (!surface || !img) return null;
      const rect = surface.getBoundingClientRect();
      const naturalWidth = img.naturalWidth || rect.width;
      const naturalHeight = img.naturalHeight || rect.height;
      return {
        x: rect.left + (220 / naturalWidth) * rect.width,
        y: rect.top + (60 / naturalHeight) * rect.height
      };
    })()`);
    assert(surfacePoint && Number.isFinite(surfacePoint.x) && Number.isFinite(surfacePoint.y), 'surface point calculation failed');
    await click(cdp, page, surfacePoint.x, surfacePoint.y);
    await delay(300);
    const dispatchedKeys = await evalJs(cdp, page, `(() => {
      const surface = document.querySelector('[data-browser-surface="server"]');
      if (!surface) return false;
      surface.focus();
      for (const ch of ${JSON.stringify(surfaceMarker)}) {
        surface.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
      }
      return true;
    })()`);
    assert(dispatchedKeys, 'surface key dispatch failed');
    const typedSnapshot = await waitFor(cdp, page, `
      fetch('/api/admin/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Web-Console-Admin-Token': ${JSON.stringify(adminToken)} },
        body: JSON.stringify({ action: 'snapshot', sessionId: ${JSON.stringify(browserTab.browserSessionId)} })
      }).then((r) => r.json()).then((data) => String(data?.snapshot?.text || '').includes(${JSON.stringify(surfaceMarker)}))
    `, 'server browser surface text input');
    assert(typedSnapshot, 'server browser surface did not receive typed marker');
    report.checks.push('server browser surface accepts click and typed input');

    const browserSnapshot = await evalJs(cdp, page, `
      fetch('/api/admin/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Web-Console-Admin-Token': ${JSON.stringify(adminToken)} },
        body: JSON.stringify({ action: 'snapshot', sessionId: ${JSON.stringify(browserTab.browserSessionId)} })
      }).then((r) => r.json())
    `);
    assert(browserSnapshot?.ok && browserSnapshot.snapshot?.sessionId, 'admin browser snapshot failed');
    assert(String(browserSnapshot.snapshot.text || '').includes(surfaceMarker) || String(browserSnapshot.snapshot.title || '').includes('Surface Test'), 'admin browser snapshot did not share the UI session');
    await evalJs(cdp, page, `
      fetch('/api/admin/browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Web-Console-Admin-Token': ${JSON.stringify(adminToken)} },
        body: JSON.stringify({ action: 'close', sessionId: ${JSON.stringify(browserTab.browserSessionId)} })
      }).then((r) => r.ok)
    `);
    report.checks.push('admin browser automation shares the UI session');

    const state = await evalJs(cdp, page, `JSON.parse(localStorage.getItem('web-console-workspace') || 'null')`);
    report.tabs = state?.tabs?.length ?? 0;
    await writeFile(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (page && wsToken) {
      try {
        const state = await evalJs(cdp, page, `JSON.parse(localStorage.getItem('web-console-workspace') || 'null')`);
        const createdSessionIds = terminalSessionIds(state).filter((id) => !baselineSessionIds.includes(id));
        await killSessions(wsToken, createdSessionIds);
        report.cleanedSessions = createdSessionIds.length;
        if (originalWorkspace) {
          await evalJs(cdp, page, `fetch('/api/workspace', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(${JSON.stringify(originalWorkspace)})
          }).then((r) => r.ok)`);
        }
      } catch {}
    }
    cdp.close();
    chrome.kill('SIGTERM');
  }
}

main().catch(async (error) => {
  await writeFile(join(OUT_DIR, 'error.txt'), `${error.stack || error.message}\n`);
  console.error(error.stack || error.message);
  process.exit(1);
});
