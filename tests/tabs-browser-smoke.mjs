// Real extension UI and Chrome APIs, confined to a disposable profile and synthetic tabs.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'tab-sorter-picker-'));
const extension = path.join(root, 'extension');
const browser = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
  headless: true, channel: 'chromium',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const errors = [];
browser.on('page', page => page.on('pageerror', error => errors.push(error.message)));
async function waitUntil(probe, description) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
try {
  await browser.route('https://**/*', route => route.fulfill({ contentType: 'text/html', body: '<title>Fixture</title><p>Synthetic tab picker fixture</p>' }));
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  const tabs = () => worker.evaluate(() => chrome.tabs.query({}));
  async function fixture(url, title, pinned = false) {
    const page = await browser.newPage(); await page.goto(url);
    await page.evaluate(title => { document.title = title; }, title);
    await waitUntil(async () => (await tabs()).some(tab => tab.title === title && tab.status === 'complete'), title);
    const tab = (await tabs()).find(tab => tab.title === title);
    if (pinned) await worker.evaluate(id => chrome.tabs.update(id, { pinned: true }), tab.id);
    return { ...tab, page };
  }
  const pin = await fixture('https://mail.google.com/mail/u/0/', 'Inbox · pinned', true);
  const regular = [];
  for (let i = 1; i <= 30; i++) regular.push(await fixture(`https://github.com/example/project/issues/${i}`, `Issue ${i} · ${i % 2 ? 'Zebra' : 'Alpha'}`));
  const literalTitle = '<b>Research notes</b> · literal title';
  const literal = await fixture('https://example.com/research', literalTitle);
  const otherA = await fixture('https://example.com/window-two-a', 'Other window · active');
  const otherB = await fixture('https://example.com/window-two-b', 'Other window · middle');
  const otherC = await fixture('https://example.com/window-two-c', 'Other window · rightmost');
  const otherWindowId = await worker.evaluate(async ids => {
    const window = await chrome.windows.create({ tabId: ids[0], focused: false });
    await chrome.tabs.move(ids.slice(1), { windowId: window.id, index: -1 });
    await chrome.tabs.update(ids[0], { active: true });
    return window.id;
  }, [otherA.id, otherB.id, otherC.id]);
  const popup = await browser.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(async windowId => {
    const tab = await chrome.tabs.getCurrent();
    if (tab.windowId !== windowId) await chrome.tabs.move(tab.id, { windowId, index: -1 });
  }, pin.windowId);
  await popup.reload(); await popup.waitForFunction(() => document.querySelectorAll('#rules .rule').length === 4);
  await pause(1200);
  await worker.evaluate(() => chrome.storage.local.set({ settings: { autoSort: true } }));
  const beforeOpen = await tabs();
  const pagePromise = browser.waitForEvent('page');
  await popup.getByRole('button', { name: 'Manage open tabs', exact: true }).click();
  const picker = await pagePromise;
  await picker.waitForURL(`chrome-extension://${extensionId}/tabs.html?**`);
  const ready = () => picker.waitForFunction(() => document.querySelector('#tab-windows').getAttribute('aria-busy') === 'false');
  await ready(); await pause(1200);
  const afterOpen = await tabs();
  for (const windowId of new Set(beforeOpen.map(tab => tab.windowId))) {
    const previousIds = beforeOpen.filter(tab => tab.windowId === windowId).map(tab => tab.id);
    assert.deepEqual(afterOpen.filter(tab => tab.windowId === windowId && previousIds.includes(tab.id)).map(tab => tab.id), previousIds, 'Opening picker does not trigger automatic sorting');
  }
  await worker.evaluate(() => chrome.storage.local.set({ settings: { autoSort: false } }));
  const pickerId = await picker.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  const mainSection = picker.locator(`.tab-window[data-window-id="${pin.windowId}"]`);
  const otherSection = picker.locator(`.tab-window[data-window-id="${otherWindowId}"]`);
  const check = id => picker.locator(`input[data-tab-id="${id}"]`);
  const row = id => picker.locator(`.tab-row[data-tab-id="${id}"]`);
  assert.equal(await picker.locator('.tab-window').first().getAttribute('data-window-id'), String(pin.windowId));
  assert.equal(await mainSection.evaluate(section => section.open), true);
  assert.equal(await otherSection.evaluate(section => section.open), false);
  assert.equal(await picker.locator('input[data-tab-id]:checked').count(), 0);
  assert.equal(await picker.locator('#close-selected').isDisabled(), true);
  assert.equal(await row(pin.id).locator('input').isDisabled(), true);
  assert.equal(await row(pickerId).locator('input').isDisabled(), true);
  for (const section of [mainSection, otherSection]) {
    const windowId = Number(await section.getAttribute('data-window-id'));
    assert.deepEqual(await section.locator('.tab-row').evaluateAll(rows => rows.map(row => Number(row.dataset.tabId))), afterOpen.filter(tab => tab.windowId === windowId).map(tab => tab.id), 'Top-to-bottom rows exactly match Chrome left-to-right order');
    assert.deepEqual(await section.locator('.tab-index').allTextContents(), afterOpen.filter(tab => tab.windowId === windowId).map(tab => String(tab.index + 1)));
  }
  assert.equal(await row(literal.id).locator('.tab-title').textContent(), literalTitle);
  assert.equal(await picker.locator('.tab-title b').count(), 0, 'Titles are rendered as text');
  await check(regular[1].id).check();
  await otherSection.locator('summary').click(); await check(otherB.id).check();
  await otherSection.locator('summary').click();
  await waitUntil(async () => !(await check(otherB.id).isChecked()), 'collapse clears that window selection');
  assert.equal(await check(regular[1].id).isChecked(), true, 'Collapsing another window preserves shown selections');
  await picker.getByLabel('Filter by title or address').fill('Issue 2');
  assert.equal(await picker.locator('input[data-tab-id]:checked').count(), 0, 'Search clears earlier selection');
  const filteredIds = regular.filter(tab => `${tab.title} ${tab.url}`.toLowerCase().includes('issue 2')).map(tab => tab.id);
  assert.deepEqual(await picker.locator('.tab-row:visible').evaluateAll(rows => rows.map(row => Number(row.dataset.tabId))), filteredIds, 'Filter preserves original order');
  await picker.getByLabel('Select shown tabs', { exact: true }).check();
  assert.deepEqual(await picker.locator('input[data-tab-id]:checked').evaluateAll(inputs => inputs.map(input => Number(input.dataset.tabId))), filteredIds);
  await picker.getByLabel('Filter by title or address').fill('no-such-tab-fixture');
  assert.equal(await picker.locator('#no-tabs').isVisible(), true);
  assert.equal(await picker.locator('#close-selected').isDisabled(), true);
  await picker.getByLabel('Filter by title or address').fill('');
  await picker.getByLabel('Select shown tabs', { exact: true }).check();
  assert.equal(await otherSection.locator('input[data-tab-id]:checked').count(), 0, 'Collapsed window is excluded from select-shown');
  await picker.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await row(regular[29].id).getByRole('button').click();
  await waitUntil(async () => (await tabs()).find(tab => tab.id === regular[29].id).active, 'Show tab activates the far-right tab');
  await picker.bringToFront();
  await waitUntil(async () => (await tabs()).find(tab => tab.id === pickerId).active, 'returning to picker');
  const afterShow = await tabs();
  assert.deepEqual(afterShow.map(tab => tab.id), afterOpen.map(tab => tab.id), 'Show tab does not reorder or open tabs');

  await picker.getByRole('button', { name: 'Refresh list', exact: true }).click(); await ready();
  await check(regular[4].id).check(); await check(regular[29].id).check();
  await otherSection.locator('summary').click();
  for (const id of [otherA.id, otherB.id, otherC.id]) await check(id).check();
  assert.equal(await picker.locator('#selection-count').textContent(), '5 tabs selected');
  await mkdir(path.join(root, 'output/playwright'), { recursive: true });
  await picker.setViewportSize({ width: 1080, height: 900 });
  await picker.evaluate(() => scrollTo(0, 0));
  await picker.screenshot({ path: path.join(root, 'output/playwright/tab-picker.png') });
  await row(regular[29].id).scrollIntoViewIfNeeded();
  await picker.screenshot({ path: path.join(root, 'output/playwright/tab-picker-rightmost.png') });
  await picker.setViewportSize({ width: 390, height: 844 });
  assert.equal(await picker.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await picker.evaluate(() => scrollTo(0, 0));
  await picker.screenshot({ path: path.join(root, 'output/playwright/tab-picker-narrow.png') });
  await picker.setViewportSize({ width: 1080, height: 900 });
  const beforeClose = await tabs();
  await picker.getByRole('button', { name: 'Close 5 selected tabs', exact: true }).click();
  await picker.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('Closed '));
  assert.match(await picker.locator('#result-summary').textContent(), /Closed 5\. Skipped 0\. Could not close 0\./, await picker.locator('#result-details').textContent());
  const closedIds = [regular[4].id, regular[29].id, otherA.id, otherB.id, otherC.id];
  assert.deepEqual((await tabs()).map(tab => tab.id), beforeClose.filter(tab => !closedIds.includes(tab.id)).map(tab => tab.id), 'Only selected tabs close; retained tabs keep their order');
  assert.equal((await worker.evaluate(() => chrome.windows.getAll({ windowTypes: ['normal'] }))).some(window => window.id === otherWindowId), false, 'Selecting all tabs can close that window without self-induced active-tab skips');
  assert.equal(await otherSection.count(), 0, 'A closed window has no stale picker section');
  assert.equal(await mainSection.locator('.window-count').textContent(), `${beforeClose.filter(tab => tab.windowId === pin.windowId).length - 2} listed`);
  assert.equal(await picker.locator('#close-selected').isDisabled(), true);
  await picker.evaluate(() => document.querySelector('#close-result').scrollIntoView({ block: 'end', behavior: 'instant' }));
  assert.equal(await picker.evaluate(() => document.querySelector('#close-result').getBoundingClientRect().bottom <= document.querySelector('.review-footer').getBoundingClientRect().top), true, 'Close results remain visible above the fixed action bar');
  await picker.screenshot({ path: path.join(root, 'output/playwright/tab-picker-results.png') });

  await picker.getByRole('button', { name: 'Refresh list', exact: true }).click(); await ready();
  await check(regular[6].id).check(); await regular[6].page.goto('https://example.com/changed-after-review');
  await picker.getByRole('button', { name: 'Close 1 selected tab', exact: true }).click();
  await picker.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('Closed '));
  assert.match(await picker.locator('#result-summary').textContent(), /Closed 0\. Skipped 1\. Could not close 0\./);
  assert.ok((await tabs()).some(tab => tab.id === regular[6].id));

  await picker.getByLabel('Allow selecting pinned tabs', { exact: true }).check(); await ready();
  assert.equal(await check(pin.id).isDisabled(), false);
  assert.equal(await check(pin.id).isChecked(), false, 'Opt-in never preselects a pinned tab');
  await check(pin.id).check();
  await picker.getByRole('button', { name: 'Close 1 selected tab', exact: true }).click();
  await picker.waitForFunction(() => document.querySelector('#result-summary').textContent.startsWith('Closed '));
  assert.match(await picker.locator('#result-summary').textContent(), /Closed 1\. Skipped 0\. Could not close 0\./);
  assert.equal((await tabs()).some(tab => tab.id === pin.id), false);
  assert.deepEqual(errors, []);
  console.log('PASS: crowded tab strip, exact row order, popup entry, no automatic sort, expansion/collapse, filter and shown-selection behavior, safe titles, focus without reordering, far-right selection, actual selective and whole-window closure, stale navigation, pinned opt-in, and narrow layout.');
} finally {
  await browser.close(); await rm(temporary, { recursive: true, force: true });
}
