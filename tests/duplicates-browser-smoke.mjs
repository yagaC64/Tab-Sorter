// Uses an isolated Chromium profile and synthetic pages; never attaches to personal Chrome.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'tab-sorter-duplicates-'));
const extension = path.join(root, 'extension');
const browser = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [];
browser.on('page', page => page.on('pageerror', error => errors.push(error.message)));

async function waitUntil(probe, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

try {
  await browser.route('https://**/*', route => route.fulfill({
    contentType: 'text/html', body: '<title>Fixture</title><p>Synthetic duplicate review fixture</p>',
  }));
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  const tabs = () => worker.evaluate(() => chrome.tabs.query({}));
  async function fixture(url, title, pinned = false) {
    const page = await browser.newPage();
    await page.goto(url);
    await page.evaluate(title => { document.title = title; }, title);
    await waitUntil(async () => (await tabs()).some(tab => tab.title === title && tab.status === 'complete'), title);
    const tab = (await tabs()).find(tab => tab.title === title);
    if (pinned) await worker.evaluate(id => chrome.tabs.update(id, { pinned: true }), tab.id);
    return { ...tab, page };
  }
  const issueUrl = 'https://github.com/example/alpha/issues/12';
  const keep = await fixture(issueUrl, 'Issue 12 · original');
  const unchecked = await fixture(issueUrl, 'Issue 12 · keep this extra');
  const extra = await fixture(issueUrl, 'Issue 12 · another window');
  const pin = await fixture('https://mail.google.com/mail/u/0/', 'Inbox · pinned', true);
  const mailExtra = await fixture(pin.url, 'Inbox · extra');
  const query = await fixture(`${issueUrl}?view=all`, 'Issue 12 · query variation');
  const fragment = await fixture(`${issueUrl}#issuecomment-123`, 'Issue 12 · comment link');
  const unique = await fixture('https://example.com/notes', 'Unique notes');
  const other = await worker.evaluate(async id => {
    const window = await chrome.windows.create({ tabId: id, focused: false });
    await chrome.tabs.create({ windowId: window.id, url: 'about:blank', active: false });
    return window.id;
  }, extra.id);
  assert.notEqual(other, keep.windowId);

  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(async windowId => {
    const tab = await chrome.tabs.getCurrent();
    if (tab.windowId !== windowId) await chrome.tabs.move(tab.id, { windowId, index: -1 });
  }, keep.windowId);
  await popup.reload();
  await popup.waitForFunction(() => document.querySelectorAll('#rules .rule').length === 4);
  // Let fixture navigation settle before enabling automatic sorting.
  await pause(1200);
  await worker.evaluate(async id => {
    await chrome.storage.local.set({ settings: { autoSort: true } });
    await chrome.tabs.update(id, { active: true });
  }, keep.id);
  const beforeReview = await tabs();
  const reviewPromise = browser.waitForEvent('page');
  // Trigger the popup handler without activating this full-page test stand-in.
  await popup.getByRole('button', { name: 'Review duplicate tabs' }).evaluate(button => button.click());
  const review = await reviewPromise;
  await review.waitForURL(`chrome-extension://${extensionId}/duplicates.html?**`);
  assert.equal(new URL(review.url()).searchParams.get('windowId'), String(keep.windowId), 'Popup passes the source window');
  assert.equal(new URL(review.url()).searchParams.get('tabId'), String(keep.id), 'Popup passes the original active web tab');
  await review.waitForFunction(() => document.querySelector('#duplicate-groups').getAttribute('aria-busy') === 'false');
  await pause(1200); // Exceed the worker's automatic-sort debounce.
  const afterReview = await tabs();
  for (const windowId of new Set(beforeReview.map(tab => tab.windowId))) {
    const originalIds = beforeReview.filter(tab => tab.windowId === windowId).map(tab => tab.id);
    assert.deepEqual(afterReview.filter(tab => tab.windowId === windowId && originalIds.includes(tab.id)).map(tab => tab.id), originalIds, 'Review does not trigger automatic sorting');
  }
  await worker.evaluate(() => chrome.storage.local.set({ settings: { autoSort: false } }));
  const choices = review.locator('input[data-tab-id]');
  assert.equal(await choices.count(), 3, 'Three extra copies across two windows are offered');
  assert.deepEqual(await choices.evaluateAll(inputs => inputs.map(input => Number(input.dataset.tabId)).sort((a, b) => a - b)), [unchecked.id, extra.id, mailExtra.id].sort((a, b) => a - b));
  assert.equal(await choices.evaluateAll(inputs => inputs.every(input => input.checked)), true);
  assert.equal(await review.locator('.keep-badge').count(), 2, 'Original and pinned keepers are marked');
  assert.equal(await review.getByLabel('Select all available').isChecked(), true);
  await review.locator(`input[data-tab-id="${unchecked.id}"]`).uncheck();
  assert.equal(await review.locator('#select-all').evaluate(input => input.indeterminate), true);
  await review.getByLabel('Select all available').check();
  assert.equal(await choices.evaluateAll(inputs => inputs.every(input => input.checked)), true);
  await review.getByLabel('Select all available').uncheck();
  assert.equal(await choices.evaluateAll(inputs => inputs.every(input => !input.checked)), true);
  assert.equal(await review.locator('#close-selected').isDisabled(), true);
  await review.getByLabel('Select all available').check();
  assert.equal(await choices.evaluateAll(inputs => inputs.every(input => input.checked)), true);
  await review.locator(`input[data-tab-id="${unchecked.id}"]`).uncheck();
  await mkdir(path.join(root, 'output/playwright'), { recursive: true });
  await review.setViewportSize({ width: 1080, height: 900 });
  await review.screenshot({ path: path.join(root, 'output/playwright/duplicate-review.png'), fullPage: true });
  await review.setViewportSize({ width: 390, height: 844 });
  assert.equal(await review.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Narrow layout has no horizontal overflow');
  await review.screenshot({ path: path.join(root, 'output/playwright/duplicate-review-narrow.png'), fullPage: true });
  await review.setViewportSize({ width: 1080, height: 900 });
  const before = await tabs();
  await review.getByRole('button', { name: 'Close 2 selected tabs', exact: true }).click();
  await review.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('Closed '));
  assert.match(await review.locator('#result-summary').textContent(), /Closed 2\. Skipped 0\. Could not close 0\./);
  assert.match(await review.locator('#scan-summary').textContent(), /Review finished/);
  assert.equal(await review.locator('#close-selected').isDisabled(), true);
  const after = await tabs();
  const closedIds = [extra.id, mailExtra.id];
  assert.deepEqual(after.map(tab => tab.id).sort((a, b) => a - b), before.filter(tab => !closedIds.includes(tab.id)).map(tab => tab.id).sort((a, b) => a - b));
  for (const id of [keep.id, unchecked.id, pin.id, query.id, fragment.id, unique.id]) assert.ok(after.some(tab => tab.id === id));
  for (const windowId of new Set(before.map(tab => tab.windowId))) {
    assert.deepEqual(after.filter(tab => tab.windowId === windowId).map(tab => tab.id), before.filter(tab => tab.windowId === windowId && !closedIds.includes(tab.id)).map(tab => tab.id), 'Remaining tabs keep their relative order');
  }

  // A candidate navigating after review must not be closed under its old identity.
  await review.getByRole('button', { name: 'Scan again' }).click();
  await review.waitForFunction(() => document.querySelector('#duplicate-groups').getAttribute('aria-busy') === 'false');
  assert.equal(await choices.count(), 1);
  await unchecked.page.goto('https://example.com/new-work');
  await review.getByRole('button', { name: 'Close 1 selected tab', exact: true }).click();
  await review.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('Closed '));
  assert.match(await review.locator('#result-summary').textContent(), /Closed 0\. Skipped 1\. Could not close 0\./);
  assert.ok((await tabs()).some(tab => tab.id === unchecked.id && tab.url === 'https://example.com/new-work'));
  await review.getByRole('button', { name: 'Scan again' }).click();
  await review.waitForFunction(() => document.querySelector('#duplicate-groups').getAttribute('aria-busy') === 'false');
  assert.equal(await review.getByText('No duplicate web tabs found', { exact: true }).isVisible(), true);

  const secondPin = await fixture(pin.url, 'Inbox · second pin', true);
  await review.getByRole('button', { name: 'Scan again' }).click();
  await review.waitForFunction(() => document.querySelector('#duplicate-groups').getAttribute('aria-busy') === 'false');
  assert.equal(await choices.count(), 0, 'Protected-only groups have no selectable rows');
  assert.equal(await review.locator('.keep-badge').count(), 2);
  assert.equal(await review.getByLabel('Select all available').isDisabled(), true);
  assert.ok((await tabs()).some(tab => tab.id === secondPin.id && tab.pinned));

  // A newer review invalidates the old selection, even across two extension pages.
  const safeTitle = '<img src=x onerror="window.injected=true"> · literal tab title';
  const later = await fixture(issueUrl, safeTitle);
  await review.getByRole('button', { name: 'Scan again' }).click();
  await review.waitForFunction(() => document.querySelector('#duplicate-groups').getAttribute('aria-busy') === 'false');
  assert.equal(await review.getByText(safeTitle, { exact: true }).count(), 1);
  assert.equal(await review.locator('#duplicate-groups img').count(), 0, 'Titles render as text, never HTML');
  const newer = await popup.evaluate(windowId => chrome.runtime.sendMessage({ type: 'scan-duplicates', windowId }), keep.windowId);
  assert.equal(newer.ok, true);
  await review.getByRole('button', { name: 'Close 1 selected tab', exact: true }).click();
  await review.waitForFunction(() => !document.querySelector('#review-error').hidden);
  assert.match(await review.locator('#review-error').textContent(), /expired or was replaced/);
  assert.ok((await tabs()).some(tab => tab.id === later.id));

  // Losing the original keeper must leave the remaining copy open.
  await review.getByRole('button', { name: 'Scan again' }).click();
  await review.waitForFunction(() => document.querySelector('#duplicate-groups').getAttribute('aria-busy') === 'false');
  await worker.evaluate(id => chrome.tabs.remove(id), keep.id);
  await review.getByRole('button', { name: 'Close 1 selected tab', exact: true }).click();
  await review.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('Closed '));
  assert.match(await review.locator('#result-summary').textContent(), /Closed 0\. Skipped 1\. Could not close 0\./);
  assert.match(await review.locator('#result-details').textContent(), /kept copy changed or closed/);
  assert.ok((await tabs()).some(tab => tab.id === later.id));
  assert.deepEqual(errors, []);
  console.log('PASS: duplicate review entry, all-window discovery, exact addresses, default/individual/all selection, confirmed selective closure, unchanged tab order, pinned keepers, stale navigation, empty/protected-only states, replaced review, keeper loss, safe text rendering, and narrow layout.');
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
