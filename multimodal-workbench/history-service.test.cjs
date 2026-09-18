'use strict';
// Real Python HTTP service + SQLite + browser; all model responses remain offline fixtures.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..'), python = process.env.PYTHON_BIN || 'python3';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8qkAAAAASUVORK5CYII=';
const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const password = 'offline-integration-password', apiKey = 'private-offline-channel-key';
let service, browser, temp, origin, env;
const errors = [], unexpected = [], calls = [];
async function port() { const s = net.createServer(); await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
async function until(check, label) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Timed out: ' + label); }
async function start() {
  service = spawn(python, ['integrations/server.py', '--port', new URL(origin).port], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; service.stdout.on('data', chunk => output += chunk); service.stderr.on('data', chunk => output += chunk);
  await until(async () => { if (service.exitCode != null) throw new Error(output); try { return (await fetch(origin + '/api/auth')).ok; } catch { return false; } }, 'service ready');
}
async function stop() { if (!service || service.exitCode != null) return; const child = service; await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGINT'); }); }
async function login(page) { await page.goto(origin + '/'); assert.match(page.url(), /\/login/); await page.locator('#username').fill('admin'); await page.locator('#password').fill(password); await page.locator('#loginSubmit').click(); await page.waitForURL(origin + '/'); await page.locator('#logoutButton').waitFor(); }
async function saved(page, count) { await page.waitForFunction(n => document.querySelectorAll('.result-card .history-save-status.is-saved').length === n, count); }
async function history(page, query = '') { return page.evaluate(async query => { const session = await (await fetch('/api/session')).json(); return (await fetch('/api/history' + query, { headers: { 'X-Workbench-Token': session.token } })).json(); }, query); }
(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-history-e2e-'));
  const authFile = path.join(temp, 'auth.json');
  const hash = spawnSync(python, ['-c', 'import sys;sys.path.insert(0,"integrations");from auth_history import hash_password;print(hash_password(sys.stdin.read()))'], { cwd: root, input: password, encoding: 'utf8' });
  assert.equal(hash.status, 0, hash.stderr); await fs.writeFile(authFile, JSON.stringify({ username: 'admin', password_hash: hash.stdout.trim() }), { mode: 0o600 });
  origin = 'http://127.0.0.1:' + await port(); env = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', WORKBENCH_AUTH_FILE: authFile, WORKBENCH_DB: path.join(temp, 'workbench.sqlite3'), WORKBENCH_REPORTS: path.join(temp, 'reports'), WORKBENCH_COOKIE_SECURE: '0' };
  await start();
  for (const route of ['/api/session', '/api/history', '/api/history/missing', '/engine.js']) assert.ok([401, 302, 303].includes((await fetch(origin + route, { redirect: 'manual' })).status), route + ' protected');
  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', error => errors.push(error.message));
  const wav = Buffer.alloc(44 + 4800); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4800, 40);
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin === origin || !/^https?:/.test(url.protocol)) return route.continue();
    if (url.hostname === 'media.test') return route.abort();
    if (url.hostname !== 'relay.test') { unexpected.push(req.url()); return route.abort(); }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    calls.push({ url: req.url(), method: req.method() });
    if (url.pathname === '/v1/images/generations') return route.fulfill({ headers, body: JSON.stringify({ data: [{ b64_json: png }] }) });
    if (url.pathname === '/v1/audio/speech') return route.fulfill({ headers: { ...headers, 'content-type': 'audio/wav' }, body: wav });
    if (url.pathname === '/v1/videos' && req.method() === 'POST') return route.fulfill({ status: 202, headers, body: JSON.stringify({ id: 'offline-video', status: 'queued' }) });
    if (url.pathname === '/v1/videos/offline-video') return route.fulfill({ headers, body: JSON.stringify({ id: 'offline-video', status: 'completed', video_url: 'https://media.test/video.mp4' }) });
    if (url.pathname === '/v1/models') return route.fulfill({ headers, body: '{"data":[{"id":"offline-model"}]}' });
    if (url.pathname === '/v1/chat/completions') {
      const body = JSON.parse(req.postData());
      if (body.stream) return route.fulfill({ headers: { ...headers, 'content-type': 'text/event-stream' }, body: 'data: {"choices":[{"delta":{"content":"391"}}]}\n\ndata: [DONE]\n\n' });
      return route.fulfill({ headers, body: JSON.stringify({ choices: [{ message: { content: '391; ' + apiKey + '; <img src=x onerror="window.untrusted=true">' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 10 } }) });
    }
    return route.fulfill({ status: 400, headers, body: '{"error":{"message":"offline unsupported request"}}' });
  });
  await login(page);
  const cookies = await page.context().cookies(); assert.ok(cookies.some(c => c.httpOnly && c.sameSite === 'Strict'), 'HTTP-only strict session');
  const unauthorizedWrite = await page.evaluate(async () => (await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status); assert.equal(unauthorizedWrite, 403);
  await page.locator('#base').fill('https://relay.test/v1'); await page.locator('#key').fill(apiKey); await page.locator('#model').fill('offline-text'); await page.locator('#prompt').fill('E2E 文本与注入显示检查'); await page.locator('#runBtn').click(); await saved(page, 1);
  await page.locator('[data-kind=image]').click(); await page.locator('#model').fill('offline-image'); await page.locator('#runBtn').click(); await saved(page, 2);
  await page.locator('[data-kind=audio]').click(); await page.locator('#model').fill('offline-audio'); await page.locator('#runBtn').click(); await saved(page, 3);
  await page.locator('[data-kind=video]').click(); await page.locator('#model').fill('offline-video'); await page.locator('.advanced summary').click(); await page.locator('#pollInterval').fill('1'); await page.locator('#runBtn').click(); await saved(page, 4);
  let records = await history(page); assert.equal(records.total, 4); assert.ok(!JSON.stringify(records).includes(apiKey));
  await page.locator('[data-kind=text]').click(); await page.locator('#legacyBtn').click(); const frame = page.frameLocator('#legacyFrame'); await frame.locator('#inBase').fill('https://relay.test'); await frame.locator('#inKey').fill(apiKey); await frame.locator('#inModel').fill('offline-general'); await frame.locator('input[value=quick]').check(); await frame.locator('#btnRun').click(); await page.locator('#generalHistorySaveStatus.is-saved').waitFor({ timeout: 25000 });
  await page.locator('#backBtn').click(); await page.locator('#prompt').fill('保存草稿，不应因回看历史而丢失'); await page.locator('#historyTab').click(); await page.locator('.history-record').first().waitFor(); assert.equal(await page.locator('.history-record').count(), 5);
  const output = path.join(__dirname, 'qa-login-history'); await fs.mkdir(output, { recursive: true }); await page.screenshot({ path: path.join(output, 'history-service-desktop.png'), fullPage: true });
  await page.locator('#historyKind').selectOption('image'); await page.waitForFunction(() => document.querySelectorAll('.history-record').length === 1); await page.locator('.history-record').click(); await page.waitForFunction(() => document.querySelector('.history-media img')?.naturalWidth > 0);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '下载测试记录 JSON' }).click(); const file = await download; const downloadPath = path.join(temp, 'download.json'); await file.saveAs(downloadPath); assert.ok(!String(await fs.readFile(downloadPath)).includes(apiKey)); await page.locator('#historyDetailClose').click();
  await page.locator('#historyKind').selectOption('audio'); await page.waitForFunction(() => document.querySelector('.history-record')?.dataset.kind === 'audio'); await page.locator('.history-record').click(); await page.waitForFunction(() => document.querySelector('.history-media audio')?.readyState >= 1); await page.locator('#historyDetailClose').click();
  await page.locator('#historyKind').selectOption(''); await page.locator('#historySearch').fill('E2E'); await page.waitForFunction(() => document.querySelectorAll('.history-record').length === 1 && document.querySelector('.history-record')?.dataset.kind === 'text'); await page.locator('.history-record').click(); await page.getByRole('heading', { name: '模型输出' }).waitFor(); assert.equal(await page.evaluate(() => window.untrusted), undefined); assert.ok(!(await page.locator('#historyDetailBody').innerText()).includes(apiKey)); await page.locator('#historyDetailClose').click();
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(output, 'history-service-mobile.png'), fullPage: true }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#workspaceTab').click(); assert.equal(await page.locator('#prompt').inputValue(), '保存草稿，不应因回看历史而丢失');
  const before = await history(page); await stop(); await start(); await page.reload(); if (page.url().includes('/login')) await login(page); const after = await history(page); assert.equal(after.total, before.total, 'SQLite survives service restart');
  await page.locator('#logoutButton').click(); await page.waitForURL(/\/login/); assert.equal((await page.request.get(origin + '/api/history')).status(), 401, 'logout revokes session');
  await page.locator('#username').fill('admin'); await page.locator('#password').fill('wrong-password'); await page.locator('#loginSubmit').click(); await page.locator('#loginMessage').waitFor(); assert.match(await page.locator('#loginMessage').innerText(), /不正确/);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  console.log('PASS: real login/cookie/CSRF, five capture types, SQLite restart, stored image/audio previews, search/filter/detail/download, XSS/key redaction, draft retention, mobile, logout. ' + calls.length + ' offline model fixture calls.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); await stop(); if (temp) await fs.rm(temp, { recursive: true, force: true }); });
