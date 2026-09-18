'use strict';

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const script = fs.readFileSync(path.join(__dirname, 'choice-picker.js'), 'utf8');
  await page.goto('data:text/html,<input id="choice">');
  await page.addScriptTag({ content: script });
  await page.evaluate(() => ChoicePickers.attach(document.getElementById('choice'), {
    label: '渠道', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }]
  }));
  const input = page.locator('#choice');
  assert.equal(await input.evaluate(node => node.id), 'choice');
  assert.equal(await page.locator('.choice-picker').count(), 1);
  await page.locator('.choice-toggle').click();
  assert.equal(await page.locator('.choice-option').count(), 3);
  await page.locator('.choice-option').nth(0).click();
  assert.equal(await input.inputValue(), 'a');
  await page.locator('.choice-toggle').click();
  await page.locator('.choice-option').nth(1).click();
  await page.locator('.choice-toggle').click();
  await page.locator('.choice-option').nth(0).click();
  assert.equal(await input.inputValue(), 'a', 'A -> B -> A keeps all options available');
  await input.fill('custom text');
  assert.equal(await input.inputValue(), 'custom text');
  await page.locator('.choice-clear').click();
  assert.equal(await input.inputValue(), '');
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await input.press('Enter');
  assert.equal(await input.inputValue(), 'b');
  await input.press('ArrowDown');
  await input.press('Escape');
  assert.equal(await page.locator('.choice-menu').isVisible(), false);
  await page.locator('.choice-toggle').click();
  await page.locator('body').click({ position: { x: 500, y: 400 } });
  assert.equal(await page.locator('.choice-menu').isVisible(), false);
  await page.evaluate(() => { document.getElementById('choice').disabled = true; });
  await page.locator('.choice-toggle').click({ force: true });
  assert.equal(await page.locator('.choice-menu').isVisible(), false);
  await page.evaluate(() => {
    const fieldset = document.createElement('fieldset');
    fieldset.disabled = true;
    const second = document.createElement('input'); second.id = 'second';
    fieldset.appendChild(second); document.body.appendChild(fieldset);
    ChoicePickers.attach(second, { options: ['x', 'y'] });
  });
  await page.locator('#second').evaluate(node => node.nextElementSibling?.click());
  assert.equal(await page.locator('#second ~ .choice-menu').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: choice picker selection, custom text, clear, keyboard, outside click and disabled states');
  await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
