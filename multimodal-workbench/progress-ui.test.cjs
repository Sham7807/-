'use strict';
// Offline progress dashboard tests against source index.html. HTTP(S) never leaves mocks.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const source = pathToFileURL(path.join(__dirname, 'index.html')).href;
const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const unexpected = [], errors = [], checks = [];
let httpCount = 0;
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
function json(body) { return { body }; }
function held(body) { return { body, gate: deferred(), started: deferred() }; }
async function setup(browser, kind = 'video') {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(10000);
  const plans = [], calls = [], pending = new Set();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__progressHistory = [];
    window.addEventListener('DOMContentLoaded', () => { const running = document.getElementById('running'); if (!running) return; new MutationObserver(() => {
      const id = name => document.getElementById(name);
      if (!id('progressDashboard')) return;
      window.__progressHistory.push({
        stage: id('progressStage').textContent, percent: id('progressBar').getAttribute('aria-valuenow'),
        batch: id('progressBatch').textContent, next: id('progressNextPoll').textContent,
        eta: id('progressEta').textContent, limit: id('progressLimit').textContent,
      });
    }).observe(running, { subtree: true, childList: true, attributes: true, characterData: true }); });
  });
  await page.route('**/*', async route => {
    const request = route.request();
    if (!/^https?:/.test(request.url())) return route.continue();
    httpCount++;
    const url = new URL(request.url());
    if (url.hostname !== 'relay.test') { unexpected.push(request.url()); return route.abort('blockedbyclient'); }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    calls.push({ method: request.method(), path: url.pathname, body: request.postData() });
    const plan = plans.shift();
    if (!plan) { unexpected.push(request.url()); return route.fulfill({ status: 500, headers, body: '{"error":{"message":"No mock planned"}}' }); }
    if (plan.gate) { pending.add(plan); plan.started.resolve(); await plan.gate.promise; pending.delete(plan); }
    await route.fulfill({ status: 200, headers, body: JSON.stringify(plan.body) }).catch(() => {});
  });
  await page.goto(source);
  await page.locator('#base').fill('https://relay.test/v1');
  await page.locator('#key').fill('progress-offline-key');
  if (kind !== 'text') await page.locator(`[data-kind="${kind}"]`).click();
  await page.locator('#model').fill(kind + '-progress-model');
  await page.locator('.advanced summary').click();
  if (kind === 'video') {
    await page.locator('#pollInterval').fill('1');
    await page.locator('#pollTimeout').fill('10');
  }
  return { page, plans, calls, close: async () => { for (const plan of pending) plan.gate.resolve(); await page.close(); } };
}
async function stop(fixture) {
  await fixture.page.locator('#stopBtn').click();
  await fixture.page.waitForFunction(() => !document.getElementById('runBtn').disabled);
  assert.equal(await fixture.page.locator('#running').isVisible(), false);
  assert.equal(fixture.calls.filter(call => call.method === 'POST').length, 1);
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  try {
    {
      const fixture = await setup(browser);
      const { page } = fixture;
      try {
        const first = held({ id: 'unknown-progress-task', status: 'queued' });
        const poll = held({ id: 'unknown-progress-task', status: 'in_progress' });
        fixture.plans.push(first, poll);
        await page.locator('#runBtn').click(); await first.started.promise;
        assert.equal(await page.locator('#progressDashboard').isVisible(), true);
        assert.equal(await page.locator('#progressBar').getAttribute('aria-valuenow'), null);
        assert.match(await page.locator('#progressPercent').innerText(), /渠道未提供百分比/);
        assert.equal(await page.locator('#progressEta').innerText(), '暂时无法估计');
        assert.match(await page.locator('#progressLimit').innerText(), /超时上限/);
        first.gate.resolve();
        await poll.started.promise;
        assert.equal(await page.locator('#progressBar').getAttribute('aria-valuenow'), null);
        assert.equal(await page.locator('#progressEta').innerText(), '暂时无法估计');
        assert.match(await page.locator('#progressLimit').innerText(), /等待上限，不是完成倒计时/);
        assert.match(await page.locator('#progressBatch').innerText(), /已查询 1 次/);
        assert.ok(await page.evaluate(() => window.__progressHistory.some(item => /下次查询/.test(item.next))));
        await stop(fixture);
        poll.gate.resolve();
        assert.equal(await page.locator('.status.stopped').count(), 1);
        assert.equal(await page.locator('#taskId').inputValue(), 'unknown-progress-task');
        const download = page.waitForEvent('download');
        await page.locator('#exportBtn').click(); await download;
        assert.equal(await page.locator('#running').isVisible(), false);
        await page.locator('#demoBtn').click();
        assert.equal(await page.locator('#progressDashboard').isVisible(), false);
        await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
        assert.equal(await page.locator('#progressDashboard').isVisible(), false);
        checks.push('unknown progress/ETA stay honest; polling limit, stop, export and demo are distinct');
      } finally { await fixture.close(); }
    }
    {
      const fixture = await setup(browser);
      const { page } = fixture;
      try {
        const later = held({ id: 'known-progress-task', status: 'in_progress', progress: 60 });
        fixture.plans.push(
          json({ id: 'known-progress-task', status: 'queued', queue_position: 3 }),
          json({ id: 'known-progress-task', status: 'in_progress', progress: '35%', remaining_seconds: 20 }),
          later,
        );
        await page.locator('#runBtn').click();
        await page.waitForFunction(() => document.getElementById('progressStage').textContent.includes('队列位置 3'));
        assert.equal(await page.locator('#progressBar').getAttribute('aria-valuenow'), null);
        await page.waitForFunction(() => document.getElementById('progressBar').getAttribute('aria-valuenow') === '35');
        assert.match(await page.locator('#progressPercent').innerText(), /35%.*渠道返回/);
        assert.equal(await page.locator('#progressFill').evaluate(element => element.style.width), '35%');
        assert.match(await page.locator('#progressEta').innerText(), /约 \d+ 秒/);
        assert.equal(await page.locator('#progressEtaSource').innerText(), '渠道预计时间，可能变化');
        await later.started.promise;
        assert.equal(await page.locator('#progressBar').getAttribute('aria-valuenow'), '35', 'polling does not advance a provider percentage by itself');
        assert.match(await page.locator('#progressBatch').innerText(), /已查询 2 次/);
        await stop(fixture);
        later.gate.resolve();
        checks.push('provider percentage, queue position and remaining time render without synthetic advancement');
      } finally { await fixture.close(); }
    }
    {
      const fixture = await setup(browser);
      const { page } = fixture;
      try {
        const first = held({ id: 'batch-one', status: 'completed', video_url: 'data:video/mp4;base64,AAAAAA==' });
        const second = held({ id: 'batch-two', status: 'queued' });
        fixture.plans.push(first, second);
        await page.locator('#batch').fill('batch-video-one,batch-video-two');
        await page.locator('#runBtn').click(); await first.started.promise;
        assert.match(await page.locator('#progressBatch').innerText(), /第 1 \/ 2 个模型/);
        await page.waitForFunction(() => /^已用 [3-9] 秒$/.test(document.getElementById('elapsed').textContent));
        first.gate.resolve(); await second.started.promise;
        assert.match(await page.locator('#progressBatch').innerText(), /第 2 \/ 2 个模型.*已完成 1 个/);
        assert.equal(await page.locator('#progressBar').getAttribute('aria-valuenow'), null);
        assert.equal(await page.locator('#progressEta').innerText(), '暂时无法估计');
        assert.match(await page.locator('#elapsed').innerText(), /已用 [01] 秒/, 'second model starts its own elapsed clock');
        assert.match(await page.locator('#progressLimit').innerText(), /请求距超时上限/);
        await page.locator('#stopBtn').click();
        await page.waitForFunction(() => !document.getElementById('runBtn').disabled);
        assert.equal(fixture.calls.filter(call => call.method === 'POST').length, 2);
        assert.equal(await page.locator('#running').isVisible(), false);
        second.gate.resolve();
        checks.push('batch transitions reset per-model elapsed, progress and ETA');
      } finally { await fixture.close(); }
    }
    assert.deepEqual(unexpected, [], 'all HTTP traffic must be planned mocks');
    assert.deepEqual(errors, [], 'no browser runtime errors');
    for (const check of checks) console.log('PASS: ' + check);
    console.log(`PASS: ${checks.length} progress dashboard groups; ${httpCount} mocked HTTP requests; no real network`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
