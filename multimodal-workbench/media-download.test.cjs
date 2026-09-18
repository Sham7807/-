'use strict';

// Runs real Chrome download events against two local HTTP origins. No provider is contacted.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const source = fs.readFileSync(path.join(__dirname, 'media-download.js'), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8qkAAAAASUVORK5CYII=', 'base64');
const wav = Buffer.alloc(52);
wav.write('RIFF'); wav.writeUInt32LE(44, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8, 40);
const video = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]);
const requests = [];

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
}
function close(server) {
  server.closeAllConnections?.();
  return new Promise(resolve => server.close(resolve));
}

(async () => {
  const media = http.createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    if (req.url !== '/nocors') res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/slow') {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length + 100 });
      res.write(wav);
      return;
    }
    if (req.url === '/forbidden') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"expired"}'); return; }
    const cases = {
      '/image': ['image/png', png], '/nocors': ['image/png', png],
      '/audio': ['audio/wav', wav], '/video': ['video/mp4', video],
      '/empty': ['image/png', Buffer.alloc(0)],
      '/html': ['text/html', Buffer.from('<!doctype html><html><body>Sign in</body></html>')],
      '/json': ['application/json', Buffer.from('{"error":"failed"}')],
      '/hidden-json': ['image/png', Buffer.from('{"error":"failed"}')],
      '/hidden-html': ['application/octet-stream', Buffer.from('<html><body>Error</body></html>')],
    };
    const [type, bytes] = cases[req.url] || ['text/plain', Buffer.from('Not found')];
    res.writeHead(cases[req.url] ? 200 : 404, { 'Content-Type': type, 'Content-Length': bytes.length });
    res.end(bytes);
  });
  const pageServer = http.createServer((req, res) => {
    if (req.url === '/media-download.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(source); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><title>Media download regression</title><script src="/media-download.js"></script><p>本地下载测试</p>');
  });
  let browser;
  try {
    const mediaOrigin = await listen(media), appOrigin = await listen(pageServer);
    browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addCookies([{ name: 'channel-session', value: 'must-not-go-to-cdn', url: mediaOrigin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(appOrigin);
    await page.waitForFunction(() => !!window.MediaDownloads);
    let navigations = 0, popups = 0, downloadCount = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    page.on('popup', () => { popups++; });
    page.on('download', () => { downloadCount++; });

    async function succeeds(url, filename, kind, expectedName, bytes) {
      const event = page.waitForEvent('download');
      const result = await page.evaluate(async args => {
        const statuses = [];
        const result = await MediaDownloads.download({ ...args, onStatus: status => statuses.push(status) });
        return { ...result, statuses };
      }, { url, filename, kind });
      const item = await event;
      assert.equal(item.suggestedFilename(), expectedName);
      assert.equal(result.filename, expectedName);
      assert.equal(await item.failure(), null);
      const output = [];
      for await (const chunk of await item.createReadStream()) output.push(chunk);
      assert.deepEqual(Buffer.concat(output), bytes);
      assert.deepEqual(result.statuses.map(x => x.phase), ['fetching', 'saving', 'done']);
      assert.equal(result.statuses.at(-1).receivedBytes, bytes.length);
      assert.equal(await page.locator('a[download]').count(), 0, 'temporary anchor removed');
    }

    await succeeds(mediaOrigin + '/image', '错误扩展名.jpg', 'image', '错误扩展名.png', png);
    await succeeds(mediaOrigin + '/audio', 'sound.mp3', 'audio', 'sound.wav', wav);
    await succeeds(mediaOrigin + '/video', 'movie.webm', 'video', 'movie.mp4', video);
    await succeeds('data:image/png;base64,' + png.toString('base64'), 'inline.jpg', 'image', 'inline.png', png);
    const blobUrl = await page.evaluate(bytes => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' })), [...wav]);
    await succeeds(blobUrl, 'local.mp3', 'audio', 'local.wav', wav);
    await page.evaluate(url => URL.revokeObjectURL(url), blobUrl);

    async function fails(url, match, kind = 'image') {
      const previous = downloadCount;
      const result = await page.evaluate(async args => {
        const phases = [];
        try { await MediaDownloads.download({ ...args, filename: 'failed.png', onStatus: status => phases.push(status.phase) }); return { error: '', phases }; }
        catch (error) { return { error: error.message, phases }; }
      }, { url, kind });
      assert.match(result.error, match);
      assert.ok(!result.phases.includes('done'), 'failed request must not report success');
      assert.equal(downloadCount, previous, 'failed request must not trigger download');
    }
    await fails(mediaOrigin + '/nocors', /跨域下载（CORS）.*另存为/);
    await fails(mediaOrigin + '/forbidden', /HTTP 403/);
    await fails(mediaOrigin + '/empty', /空文件/);
    await fails(mediaOrigin + '/html', /不是媒体文件/);
    await fails(mediaOrigin + '/json', /不是媒体文件/);
    await fails(mediaOrigin + '/hidden-json', /HTML 或 JSON/);
    await fails(mediaOrigin + '/hidden-html', /HTML 或 JSON/);
    await fails(mediaOrigin + '/audio', /内容类型与结果不一致/);
    await fails('javascript:alert(1)', /地址类型不支持/);
    await fails('data:text/html,<html>bad</html>', /不是图片、音频或视频/);

    const cancelled = await page.evaluate(async url => {
      const controller = new AbortController();
      const phases = [];
      setTimeout(() => controller.abort(), 100);
      try { await MediaDownloads.download({ url, kind: 'audio', filename: 'cancel.wav', signal: controller.signal, onStatus: s => phases.push(s.phase) }); return { error: '', phases }; }
      catch (e) { return { error: e.message, phases }; }
    }, mediaOrigin + '/slow');
    assert.match(cancelled.error, /下载已取消/);
    assert.ok(!cancelled.phases.includes('done'));
    const previousRequests = requests.length;
    const earlyCancel = await page.evaluate(async url => {
      const controller = new AbortController(); controller.abort();
      try { await MediaDownloads.download({ url, signal: controller.signal }); return ''; }
      catch (e) { return e.message; }
    }, mediaOrigin + '/image');
    assert.match(earlyCancel, /下载已取消/);
    assert.equal(requests.length, previousRequests, 'pre-cancelled download must not fetch');
    const timeout = await page.evaluate(async url => {
      const nativeTimeout = window.setTimeout;
      window.setTimeout = (fn, delay, ...args) => nativeTimeout(fn, delay === 120000 ? 30 : delay, ...args);
      try { await MediaDownloads.download({ url, kind: 'audio' }); return ''; }
      catch (e) { return e.message; }
      finally { window.setTimeout = nativeTimeout; }
    }, mediaOrigin + '/slow');
    assert.match(timeout, /下载超时/);
    assert.equal(downloadCount, 5);
    assert.equal(navigations, 0, 'downloads never navigate the page');
    assert.equal(popups, 0, 'downloads never open a popup');
    assert.equal(page.url(), appOrigin + '/');
    for (const request of requests) {
      assert.equal(request.headers.authorization, undefined, 'CDN gets no Authorization');
      assert.equal(request.headers['x-api-key'], undefined, 'CDN gets no channel key');
      assert.equal(request.headers.cookie, undefined, 'CDN gets no cookies');
      assert.equal(request.headers.referer, undefined, 'CDN gets no referrer');
    }
    console.log('PASS: five real Chrome downloads (cross-origin image/audio/video, data, blob), correct filenames and bytes; no navigation/popup; CORS/HTTP/empty/HTML/JSON/type failures; cancellation/timeout; no CDN credentials/referrer.');
  } finally {
    await browser?.close();
    await Promise.all([close(media), close(pageServer)]);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
