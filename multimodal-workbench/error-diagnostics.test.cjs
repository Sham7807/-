'use strict';
// Covers the user-facing explanation shown when a request fails before an HTTP response.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(__dirname, 'index.html')).href);
  await page.route('https://relay.test/**', async route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    return route.abort('failed');
  });
  await page.locator('[data-kind="image"]').click();
  await page.locator('#base').fill('https://relay.test/v1');
  await page.locator('#key').fill('diagnostic-key');
  await page.locator('#model').fill('gpt-image-2');
  await page.locator('#runBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 1 && !document.getElementById('runBtn').disabled);
  const networkResult = page.locator('.result-card').first();
  assert.match(await networkResult.innerText(), /错误类型：浏览器网络请求失败/);
  assert.match(await networkResult.innerText(), /可能原因：/);
  assert.match(await networkResult.innerText(), /解决方法：/);

  await page.locator('#clearBtn').click();
  await page.locator('[data-kind="text"]').click();
  await page.locator('#model').fill('text-test');
  await page.route('https://http-error.test/**', async route => route.fulfill({
    status: 401,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify({ error: { type: 'invalid_api_key', message: 'invalid key' } })
  }));
  await page.locator('#base').fill('https://http-error.test/v1');
  await page.locator('#runBtn').click();
  await page.waitForFunction(() => document.querySelectorAll('.result-card').length === 1 && !document.getElementById('runBtn').disabled);
  const httpResult = page.locator('.result-card').first();
  assert.match(await httpResult.innerText(), /HTTP 401/);
  assert.match(await httpResult.innerText(), /鉴权失败/);
  assert.deepEqual(errors, []);
  console.log('PASS: Failed to fetch and HTTP 401 diagnostics are visible');
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
