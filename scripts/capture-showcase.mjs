import { mkdir } from 'fs/promises';
import { resolve } from 'path';
import { chromium } from 'playwright';

const BASE_URL = process.env.WC_BASE_URL || 'http://127.0.0.1:8790';
const OUT_DIR = resolve(process.env.SHOWCASE_OUT_DIR || 'docs/images');
const PASSWORD = process.env.WC_AUTH_PASSWORD || 'showcase-password';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function authenticate(page) {
  const authenticated = await page.evaluate(async (password) => {
    const response = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return response.ok;
  }, PASSWORD);
  assert(authenticated, 'showcase authentication failed');
}

async function openWorkspace(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await authenticate(page);
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.getByText('Skip all', { exact: true }).click().catch(() => {});
  const newTerminal = page.locator('button[title="New Terminal (splits active pane)"]');
  await newTerminal.waitFor({ state: 'visible', timeout: 20_000 });
  await newTerminal.click();
  await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForFunction(() => /\bconnected\b/i.test(document.body.innerText), undefined, { timeout: 20_000 });
}

async function prepareTerminalScreenshot(page) {
  const terminals = page.locator('.xterm textarea');
  const count = await terminals.count();
  for (let index = 0; index < count; index += 1) {
    await terminals.nth(index).focus();
    await page.keyboard.type("export PS1='web@console:~/workspace$ '; clear");
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(400);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 1 });
  const page = await context.newPage();

  try {
    await openWorkspace(page);
    await prepareTerminalScreenshot(page);
    await page.locator('.xterm textarea').last().focus();
    await page.keyboard.type('printf "Persistent shells. Focused workspaces."');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(OUT_DIR, 'ptylon-workspace.png'), fullPage: true });

    await page.locator('button[title="Open theme gallery"]').click();
    await page.getByText('Theme Gallery', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: resolve(OUT_DIR, 'ptylon-theme-gallery.png'), fullPage: true });

    await page.setViewportSize({ width: 430, height: 920 });
    await page.screenshot({ path: resolve(OUT_DIR, 'ptylon-mobile.png'), fullPage: true });
    console.log(JSON.stringify({ baseUrl: BASE_URL, outDir: OUT_DIR, captures: 3 }));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
