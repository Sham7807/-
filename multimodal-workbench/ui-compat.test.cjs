'use strict';

// Offline UI regressions. All HTTP(S) requests are intercepted; no provider is contacted.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const indexUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
const base = 'https://relay.test/v1';
const key = 'offline-compat-key';
const calls = [];
const unexpectedRequests = [];
const pageErrors = [];
const passed = [];

function wav() {
  const bytes = Buffer.alloc(44 + 4800);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
const sampleWav = wav();
const jsonHeaders = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

async function newPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    if (!/^https?:/.test(request.url())) return route.continue();
    const url = new URL(request.url());
    const call = { url: request.url(), path: url.pathname, method: request.method(), body: request.postData(), headers: request.headers() };
    calls.push(call);
    if (url.hostname !== 'relay.test') {
      unexpectedRequests.push(request.url());
      return route.abort('blockedbyclient');
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: jsonHeaders });
    if (url.pathname === '/v1/audio/speech') return route.fulfill({ headers: { ...jsonHeaders, 'content-type': 'audio/wav' }, body: sampleWav });
    if (url.pathname === '/v1/chat/completions') return route.fulfill({ headers: jsonHeaders, body: JSON.stringify({
      choices: [{ message: { content: null, audio: { data: sampleWav.toString('base64'), transcript: '这是音频对话输出。' } } }],
    }) });
    if (/\/v1beta\/models\/[^/]+:generateContent$/.test(url.pathname)) return route.fulfill({ headers: jsonHeaders, body: JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000;channels=1', data: sampleWav.subarray(44).toString('base64') } }] } }],
    }) });
    if (url.pathname === '/v1/videos' && request.method() === 'POST') {
      if ((request.headers()['content-type'] || '').startsWith('application/json')) return route.fulfill({ status: 400, headers: jsonHeaders, body: JSON.stringify({
        error: { message: 'missing required field resolution' },
      }) });
      return route.fulfill({ status: 500, headers: jsonHeaders, body: JSON.stringify({
        error: { message: 'unmarshal generate request failed: invalid character in multipart body' },
      }) });
    }
    unexpectedRequests.push(request.url());
    return route.fulfill({ status: 400, headers: jsonHeaders, body: JSON.stringify({ error: { message: 'Unexpected mocked endpoint' } }) });
  });
  await page.goto(indexUrl);
  await page.locator('#preset option').first().waitFor({ state: 'attached' });
  await page.locator('#base').fill(base);
  await page.locator('#key').fill(key);
  return page;
}

async function waitForResult(page, count) {
  await page.waitForFunction(expected => document.querySelectorAll('.result-card').length === expected && !document.getElementById('runBtn').disabled, count);
}
async function expectCredentials(page, model) {
  assert.equal(await page.locator('#base').inputValue(), base);
  assert.equal(await page.locator('#key').inputValue(), key);
  assert.equal(await page.locator('#model').inputValue(), model);
}
async function expectPlayableAudio(page) {
  const audio = page.locator('.result-card').first().locator('audio');
  assert.equal(await audio.count(), 1);
  await audio.evaluate(element => new Promise((resolve, reject) => {
    if (element.readyState >= 2) return resolve();
    const timeout = setTimeout(() => reject(new Error('Mock audio did not decode')), 5000);
    element.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
    element.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Mock audio decode failed')); }, { once: true });
    element.load();
  }));
  assert.equal(await audio.evaluate(element => element.error), null);
  assert.equal(await page.locator('.result-card').first().locator('.status.success').count(), 1);
}

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  try {
    const page = await newPage(browser);
    assert.match(await page.title(), /小小宇宙无敌/);
    assert.match(await page.locator('.brand').innerText(), /小小宇宙无敌/);
    assert.doesNotMatch(await page.locator('body').innerText(), /Relay\s*Lab/i);
    assert.equal(await page.locator('.kind-tabs [data-kind]').count(), 4);
    assert.equal(await page.locator('.kind-tabs > #textKindCard').count(), 1);
    assert.equal(await page.locator('#textKindCard [data-kind="text"]').count(), 1);
    assert.equal(await page.locator('#textKindCard #textModes').count(), 1);
    assert.equal(await page.locator('#textKindCard #legacyBtn').count(), 1);
    assert.equal(await page.locator('#textModes').isVisible(), true);
    assert.equal(await page.locator('#textModes #basicBtn').count(), 1);
    assert.equal(await page.locator('#textModes #legacyBtn').count(), 1);
    assert.equal(await page.locator('#basicView').isVisible(), true);
    const desktopCard = await page.locator('#textKindCard').boundingBox();
    const desktopModes = await page.locator('#textModes').boundingBox();
    assert.ok(desktopCard && desktopModes && desktopModes.y >= desktopCard.y && desktopModes.y + desktopModes.height <= desktopCard.y + desktopCard.height + 1, 'basic/deep controls are inside the text card, not a separate row below it');
    await page.locator('#model').fill('text-draft-preserved');
    await page.locator('#prompt').fill('Preserve my basic text prompt.');
    const beforeNavigation = calls.length;
    await page.locator('#legacyBtn').click();
    await page.frameLocator('#legacyFrame').locator('#inBase').waitFor();
    assert.equal(await page.locator('#basicView').isVisible(), false);
    assert.equal(await page.locator('#legacyView').isVisible(), true);
    assert.equal(await page.locator('.kind-tabs').isVisible(), true);
    assert.equal(await page.locator('#textModes').isVisible(), true);
    await page.locator('#basicBtn').click();
    assert.equal(await page.locator('#legacyView').isVisible(), false);
    assert.equal(await page.locator('#basicView').isVisible(), true);
    await expectCredentials(page, 'text-draft-preserved');
    assert.equal(await page.locator('#prompt').inputValue(), 'Preserve my basic text prompt.');
    await page.locator('#legacyBtn').click();
    await page.locator('#backBtn').click();
    assert.equal(await page.locator('#basicView').isVisible(), true);
    await expectCredentials(page, 'text-draft-preserved');
    for (const modality of ['image', 'video', 'audio']) {
      await page.locator('#legacyBtn').click();
      await page.locator(`[data-kind="${modality}"]`).click();
      assert.equal(await page.locator('#textModes').isVisible(), false);
      assert.equal(await page.locator('#legacyView').isVisible(), false);
      assert.equal(await page.locator('#basicView').isVisible(), true);
      await page.locator('[data-kind="text"]').click();
      assert.equal(await page.locator('#textModes').isVisible(), true);
      assert.equal(await page.locator('#basicView').isVisible(), true);
      await expectCredentials(page, 'text-draft-preserved');
      assert.equal(await page.locator('#prompt').inputValue(), 'Preserve my basic text prompt.');
    }
    assert.equal(calls.length, beforeNavigation, 'changing text submodes and model types never submits a request');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('#basicBtn').isVisible(), true);
    assert.equal(await page.locator('#legacyBtn').isVisible(), true);
    const basicBox = await page.locator('#basicBtn').boundingBox();
    const deepBox = await page.locator('#legacyBtn').boundingBox();
    assert.ok(basicBox && deepBox && basicBox.x >= 0 && basicBox.x + basicBox.width <= 391);
    assert.ok(deepBox.x >= 0 && deepBox.x + deepBox.width <= 391, 'text submodes fit the mobile viewport');
    const mobileCard = await page.locator('#textKindCard').boundingBox();
    assert.ok(basicBox.y >= mobileCard.y && deepBox.y + deepBox.height <= mobileCard.y + mobileCard.height + 1, 'mobile submodes remain inside their text model card');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1440, height: 1100 });
    passed.push('four top tabs with nested basic/deep text modes, draft preservation and mobile layout');

    const beforeAdvice = calls.length;
    await page.locator('[data-kind="video"]').click();
    assert.equal(await page.locator('#preset').inputValue(), 'relay-video-json');
    const imageModel = 'doubao-seedream-5-0-pro-260628';
    await page.locator('#model').fill(imageModel);
    assert.equal(await page.locator('#modelAdvice').isVisible(), true);
    assert.match(await page.locator('#modelAdviceText').innerText(), /Seedream.*图像/);
    await page.locator('#runBtn').click();
    await page.waitForFunction(() => !document.getElementById('runBtn').disabled && !document.getElementById('notice').hidden);
    assert.equal(calls.length, beforeAdvice, 'mismatched image model does not send any request');
    assert.equal(await page.locator('.result-card').count(), 0);
    await page.locator('#applyModelAdvice').click();
    assert.equal(await page.locator('[data-kind="image"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#preset').inputValue(), 'openai-image');
    await expectCredentials(page, imageModel);
    assert.equal(calls.length, beforeAdvice, 'applying a recommendation only changes the configuration');
    passed.push('video JSON default and Seedream mismatch prevention with one-click correction');

    await page.locator('[data-kind="audio"]').click();
    assert.equal(await page.locator('#preset').inputValue(), 'openai-speech');
    await page.locator('#model').fill('gpt-audio');
    assert.equal(await page.locator('#modelAdvice').isVisible(), true);
    assert.match(await page.locator('#modelAdviceText').innerText(), /Chat Completions.*Speech/);
    await page.locator('#applyModelAdvice').click();
    assert.equal(await page.locator('#preset').inputValue(), 'openai-audio-chat');
    assert.equal(await page.locator('#voice').inputValue(), 'alloy');
    assert.equal(await page.locator('#format').inputValue(), 'wav');
    await expectCredentials(page, 'gpt-audio');
    assert.equal(calls.length, beforeAdvice, 'audio correction also does not auto-submit');
    await page.locator('#runBtn').click();
    await waitForResult(page, 1);
    await expectPlayableAudio(page);
    const audioChatCall = calls.filter(call => call.method === 'POST').at(-1);
    assert.equal(audioChatCall.path, '/v1/chat/completions');
    assert.deepEqual(JSON.parse(audioChatCall.body).modalities, ['text', 'audio']);
    assert.deepEqual(JSON.parse(audioChatCall.body).audio, { voice: 'alloy', format: 'wav' });
    passed.push('audio-chat recommendation, payload and decoded audio player');

    await page.locator('#preset').selectOption('openai-speech');
    await page.locator('#model').fill('tts-1');
    await page.locator('#runBtn').click();
    await waitForResult(page, 2);
    await expectPlayableAudio(page);
    assert.equal(calls.filter(call => call.method === 'POST').at(-1).path, '/v1/audio/speech');
    passed.push('speech binary response produces a decoded audio player');

    await page.locator('#model').fill('gemini-2.5-flash-preview-tts');
    assert.equal(await page.locator('#modelAdvice').isVisible(), true);
    await page.locator('#applyModelAdvice').click();
    assert.equal(await page.locator('#preset').inputValue(), 'gemini-speech');
    assert.equal(await page.locator('#voice').inputValue(), 'Kore');
    await page.locator('#previewBtn').click();
    const preview = JSON.parse(await page.locator('#requestPreview').innerText());
    assert.deepEqual(preview.body.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(preview.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.doesNotMatch(JSON.stringify(preview), new RegExp(key));
    await page.locator('#closePreview').click();
    await page.locator('#runBtn').click();
    await waitForResult(page, 3);
    await expectPlayableAudio(page);
    assert.equal(calls.filter(call => call.method === 'POST').at(-1).headers['x-goog-api-key'], key);
    passed.push('Gemini TTS Kore/AUDIO preview and decoded PCM response');
    await page.close();

    const diagnosticPage = await newPage(browser);
    await diagnosticPage.locator('[data-kind="video"]').click();
    await diagnosticPage.locator('#preset').selectOption('openai-video');
    await diagnosticPage.locator('#model').fill('video-test-model');
    const beforeError = calls.length;
    await diagnosticPage.locator('#runBtn').click();
    await waitForResult(diagnosticPage, 1);
    assert.equal(calls.length, beforeError + 1);
    assert.match(calls.at(-1).headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(await diagnosticPage.locator('.result-error').innerText(), /unmarshal generate request failed/);
    assert.match(await diagnosticPage.locator('.diagnostic').innerText(), /JSON.*multipart/);
    await diagnosticPage.locator('.diagnostic button').click();
    assert.equal(await diagnosticPage.locator('#preset').inputValue(), 'relay-video-json');
    await expectCredentials(diagnosticPage, 'video-test-model');
    assert.equal(calls.length, beforeError + 1, 'diagnostic action does not retry generation');
    assert.equal(await diagnosticPage.locator('.result-card').count(), 1);
    await diagnosticPage.locator('#previewBtn').click();
    const correctedPreview = JSON.parse(await diagnosticPage.locator('#requestPreview').innerText());
    assert.equal(correctedPreview.headers['Content-Type'], 'application/json');
    assert.equal(typeof correctedPreview.body.seconds, 'string');
    assert.equal(calls.length, beforeError + 1);
    await diagnosticPage.close();
    passed.push('multipart decode error diagnoses JSON configuration without a second POST');

    const resolutionPage = await newPage(browser);
    await resolutionPage.locator('[data-kind="video"]').click();
    await resolutionPage.locator('#model').fill('video-resolution-model');
    assert.equal(await resolutionPage.locator('#preset').inputValue(), 'relay-video-json');
    assert.equal(await resolutionPage.locator('#resolution').isVisible(), true);
    assert.equal(await resolutionPage.locator('#resolution').inputValue(), '', 'resolution does not guess a channel default');
    assert.equal(await resolutionPage.locator('#resolution').getAttribute('list'), null);
    const resolutionPicker = resolutionPage.locator('.choice-picker').filter({ has: resolutionPage.locator('#resolution') });
    await resolutionPicker.locator('.choice-toggle').click();
    const resolutionOptions = await resolutionPicker.locator('.choice-option').evaluateAll(options => options.map(option => option.dataset.value));
    await resolutionPicker.locator('.choice-option[data-value="720p"]').click();
    await resolutionPicker.locator('.choice-toggle').click();
    await resolutionPicker.locator('.choice-option[data-value="1080p"]').click();
    assert.equal(await resolutionPage.locator('#resolution').inputValue(), '1080p');
    await resolutionPage.locator('#resolution').fill('');
    await resolutionPage.locator('#resolution').press('Escape');
    for (const value of ['480p', '720p', '1080p']) assert.ok(resolutionOptions.includes(value));
    const previewBody = async () => {
      await resolutionPage.locator('#previewBtn').click();
      const preview = JSON.parse(await resolutionPage.locator('#requestPreview').innerText());
      await resolutionPage.locator('#closePreview').click();
      return preview.body;
    };
    const beforeResolution = calls.length;
    for (const preset of ['relay-video-json', 'doubao-video', 'custom-video']) {
      await resolutionPage.locator('#preset').selectOption(preset);
      assert.equal(await resolutionPage.locator('#resolution').isVisible(), true);
      await resolutionPage.locator('#resolution').fill('720p');
      assert.equal((await previewBody()).resolution, '720p', preset);
    }
    await resolutionPage.locator('#preset').selectOption('relay-video-json');
    await resolutionPage.locator('#resolution').fill('provider-custom-resolution');
    assert.equal((await previewBody()).resolution, 'provider-custom-resolution');
    await resolutionPage.locator('.advanced summary').click();
    await resolutionPage.locator('#extra').fill('{"resolution":"1080p"}');
    assert.equal((await previewBody()).resolution, '1080p', 'advanced JSON intentionally overrides the visible resolution');
    await resolutionPage.locator('#extra').fill('{}');
    await resolutionPage.locator('#preset').selectOption('openai-video');
    assert.equal(await resolutionPage.locator('#resolution').isVisible(), false);
    await resolutionPage.locator('#size').fill('1280x720');
    const nativePreview = await previewBody();
    assert.equal(nativePreview.resolution, undefined);
    assert.equal(nativePreview.size, '1280x720');
    await resolutionPage.locator('#preset').selectOption('relay-video-json');
    await resolutionPage.locator('#resolution').fill('1080p');
    await resolutionPage.locator('[data-kind="image"]').click();
    await resolutionPage.locator('#model').fill('image-resolution-model');
    assert.equal(await resolutionPage.locator('#resolution').isVisible(), false);
    assert.equal((await previewBody()).resolution, undefined);
    await resolutionPage.locator('[data-kind="video"]').click();
    assert.equal(await resolutionPage.locator('#resolution').inputValue(), '1080p', 'switching modality preserves the video resolution draft');
    assert.equal(await resolutionPage.locator('#model').inputValue(), 'video-resolution-model');
    assert.equal(calls.length, beforeResolution, 'configuration and previews do not submit API requests');
    await resolutionPage.locator('#resolution').fill('');
    await resolutionPage.locator('#runBtn').click();
    await waitForResult(resolutionPage, 1);
    assert.equal(calls.length, beforeResolution + 1);
    assert.equal(JSON.parse(calls.at(-1).body).resolution, undefined);
    assert.match(await resolutionPage.locator('.result-error').innerText(), /400.*missing required field resolution/);
    assert.match(await resolutionPage.locator('.diagnostic').innerText(), /resolution|分辨率/);
    await resolutionPage.locator('[data-action="configure-resolution"]').click();
    assert.equal(await resolutionPage.locator('#preset').inputValue(), 'relay-video-json');
    assert.equal(await resolutionPage.locator('#resolution').evaluate(element => document.activeElement === element), true);
    await expectCredentials(resolutionPage, 'video-resolution-model');
    assert.equal(calls.length, beforeResolution + 1, 'missing-resolution action only focuses configuration and never resubmits');
    assert.equal(await resolutionPage.locator('.result-card').count(), 1);
    await resolutionPage.close();
    passed.push('explicit video resolution, JSON overrides, draft isolation and non-submitting 400 diagnostics');

    assert.deepEqual(unexpectedRequests, [], 'no unexpected external requests');
    assert.deepEqual(pageErrors, [], 'no browser runtime errors');
    for (const name of passed) console.log('PASS: ' + name);
    console.log(`PASS: ${passed.length} compatibility groups; ${calls.length} intercepted HTTP requests; no real provider requests`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
