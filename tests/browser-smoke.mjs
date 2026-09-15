// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright module entrypoint.
// Uses a disposable Chromium profile and synthetic pages; never attaches to personal Chrome.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'tab-sorter-browser-'));
const extension = path.join(root, 'extension');
const browser = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
const errors = [];
async function waitUntil(probe, description) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}
try {
  await browser.route('https://**/*', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: `<title>${url.searchParams.get('title') || url.pathname}</title><p>Synthetic Tab Sorter test fixture</p>` });
  });
  let worker = browser.serviceWorkers()[0];
  if (!worker) worker = await browser.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  const control = await browser.newPage();
  control.on('pageerror', error => errors.push(error.message));
  await control.goto(`chrome-extension://${extensionId}/popup.html`);
  console.log('Loaded extension', extensionId);
  const fixtures = [
    ['https://pinned.example/?title=Z%20Pinned', true],
    ['https://pinned.example/?title=A%20Pinned', true],
    ['https://app.slack.com/client/fixture', false],
    ['https://github.com/example/zebra/pull/20', false],
    ['https://github.com/example/alpha/issues/12', false],
    ['https://example.com/?title=Zebra%20regular', false],
    ['https://drive.google.com/drive/u/0/my-drive', false],
    ['https://github.com/example/alpha/pull/3', false],
    ['https://github.com/example/alpha/issues/2', false],
    ['https://mail.google.com/mail/u/0/', false],
    ['https://calendar.google.com/calendar/u/0/r', false],
    ['https://example.com/?title=Alpha%20regular', false],
    ['https://example.com/?title=Research%20notes', false],
    ['https://github.com/example/research/issues/5', false],
  ];
  for (const [url] of fixtures) {
    const fixture = await browser.newPage();
    await fixture.goto(url);
  }
  await control.bringToFront();
  const ids = await worker.evaluate(async fixtures => {
    const win = await chrome.windows.getLastFocused();
    const ids = [];
    for (const [url, pinned] of fixtures) {
      const tab = (await chrome.tabs.query({ windowId: win.id })).find(tab => tab.url === url);
      if (!tab) throw new Error(`Synthetic fixture not loaded: ${url}`);
      await chrome.tabs.update(tab.id, { pinned });
      ids.push(tab.id);
    }
    const mixed = await chrome.tabs.group({ tabIds: ids.slice(-2) });
    await chrome.tabGroups.update(mixed, { title: 'Research', color: 'orange', collapsed: true });
    // Start with an existing GitHub group whose members require reordering.
    const repo = await chrome.tabs.group({ tabIds: [ids[4], ids[7], ids[8]] });
    await chrome.tabGroups.update(repo, { title: 'Earlier name', color: 'purple' });
    return { ids, mixed, repo, windowId: win.id, activeId: (await chrome.tabs.query({ active: true, windowId: win.id }))[0].id };
  }, fixtures);
  await waitUntil(() => control.evaluate(async () => (await chrome.tabs.query({})).every(t => t.status === 'complete')), 'fixture navigation');
  await control.getByLabel('Chrome profile label').fill('QA profile');
  await control.getByRole('button', { name: 'Save preferences' }).click();
  await control.getByRole('button', { name: 'Sort this window' }).click();
  await control.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Sorted') || document.querySelector('#status').classList.contains('error'));
  const firstStatus = await control.locator('#status').textContent();
  console.log(firstStatus);
  assert.match(firstStatus, /^Sorted /);
  const state = await worker.evaluate(async () => ({ tabs: await chrome.tabs.query({}), groups: await chrome.tabGroups.query({}) }));
  const ordered = state.tabs.sort((a, b) => a.index - b.index);
  assert.deepEqual(ordered.filter(t => t.pinned).map(t => t.id), ids.ids.slice(0, 2));
  assert.deepEqual(ordered.slice(-4).map(t => new URL(t.url).hostname), ['mail.google.com', 'calendar.google.com', 'drive.google.com', 'app.slack.com']);
  const repo = state.groups.find(g => g.title === 'example/alpha');
  assert.ok(repo, 'A real Chrome repository group exists');
  assert.equal(repo.id, ids.repo, 'A reusable repository group keeps its identity');
  assert.deepEqual(ordered.filter(t => t.groupId === repo.id).map(t => new URL(t.url).pathname), ['/example/alpha/issues/2', '/example/alpha/issues/12', '/example/alpha/pull/3']);
  assert.equal(state.groups.find(g => g.id === ids.mixed).collapsed, true);
  assert.deepEqual(ordered.filter(t => t.groupId === ids.mixed).map(t => t.id), ids.ids.slice(-2));
  assert.equal(ordered.find(t => t.active).id, ids.activeId);
  const beforeRepeat = ordered.map(t => [t.id, t.groupId]);
  const repeat = await control.evaluate(windowId => chrome.runtime.sendMessage({ type: 'sort', windowId }), ids.windowId);
  assert.equal(repeat.ok, true, repeat.error);
  const afterRepeat = await worker.evaluate(async () => (await chrome.tabs.query({})).sort((a, b) => a.index - b.index).map(t => [t.id, t.groupId]));
  assert.deepEqual(afterRepeat, beforeRepeat, 'Sorting an unchanged window is stable');
  const snapshot = await control.evaluate(windowId => chrome.runtime.sendMessage({ type: 'snapshot', scope: 'all', windowId }), ids.windowId);
  assert.equal(snapshot.ok, true);
  assert.match(snapshot.markdown, /QA profile/);
  for (const [url] of fixtures) assert.ok(snapshot.markdown.includes(url), `Snapshot includes fixture ${url}`);
  assert.match(snapshot.filename, /\.md$/);
  assert.ok(!snapshot.filename.includes('/'));
  // Missing native helper must expose a recovery action rather than a success message.
  const missingHelper = await control.evaluate(windowId => chrome.runtime.sendMessage({ type: 'export-editor', scope: 'current', windowId }), ids.windowId);
  assert.equal(missingHelper.ok, false);
  assert.match(missingHelper.error, /helper|saved/i);
  // Changing the future fixed-site order must survive save and drive real browser moves.
  await control.locator('#preferences').evaluate(element => { element.open = true; });
  await control.getByRole('button', { name: 'Later →' }).first().click();
  await control.getByRole('button', { name: 'Save preferences' }).click();
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
  assert.deepEqual(saved.fixedRules.map(rule => rule.label), ['Calendar', 'Gmail', 'Drive', 'Slack']);
  await control.getByRole('button', { name: 'Sort this window' }).click();
  await control.waitForFunction(() => !document.querySelector('#sort').disabled);
  const reordered = await worker.evaluate(async () => (await chrome.tabs.query({})).sort((a, b) => a.index - b.index));
  assert.deepEqual(reordered.slice(-4).map(t => new URL(t.url).hostname), ['calendar.google.com', 'mail.google.com', 'drive.google.com', 'app.slack.com']);
  await control.getByLabel('Re-sort after tabs open or navigate').check();
  await control.getByRole('button', { name: 'Save preferences' }).click();
  const fresh = await browser.newPage();
  await fresh.goto('https://github.com/example/alpha/issues/4');
  const loadedAt = Date.now();
  await waitUntil(() => control.evaluate(async ({ windowId, loadedAt }) => {
    const receipt = (await chrome.storage.session.get(`status-${windowId}`))[`status-${windowId}`];
    return receipt?.completedAt >= loadedAt && receipt?.text.startsWith('Sorted 17 tabs.') && !receipt.error;
  }, { windowId: ids.windowId, loadedAt }), 'automatic sort completion after navigation');
  const autoTabs = await worker.evaluate(async () => (await chrome.tabs.query({})).sort((a, b) => a.index - b.index));
  assert.deepEqual(autoTabs.filter(t => t.groupId === repo.id).map(t => new URL(t.url).pathname), ['/example/alpha/issues/2', '/example/alpha/issues/4', '/example/alpha/issues/12', '/example/alpha/pull/3']);
  await control.getByLabel('Re-sort after tabs open or navigate').uncheck();
  await control.getByRole('button', { name: 'Save preferences' }).click();
  const other = await worker.evaluate(async () => chrome.windows.create({ url: 'about:blank', focused: false }));
  const multiple = await control.evaluate(windowId => chrome.runtime.sendMessage({ type: 'snapshot', scope: 'all', windowId }), ids.windowId);
  const single = await control.evaluate(windowId => chrome.runtime.sendMessage({ type: 'snapshot', scope: 'current', windowId }), ids.windowId);
  assert.match(multiple.markdown, /Windows: 2/);
  assert.match(single.markdown, /Windows: 1/);
  await worker.evaluate(windowId => chrome.windows.remove(windowId), other.id);
  await control.reload();
  await control.waitForFunction(() => document.querySelector('#profile').value === 'QA profile');
  assert.equal(await control.locator('#rules .label').first().inputValue(), 'Calendar', 'Preferences survive popup reload');
  await control.locator('#preferences').evaluate(element => { element.open = false; });
  await mkdir(path.join(root, 'output/playwright'), { recursive: true });
  await control.setViewportSize({ width: 440, height: 800 });
  await control.screenshot({ path: path.join(root, 'output/playwright/tab-sorter.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: real Chromium sort, pinned/fixed order, numeric GitHub grouping, mixed groups, active tab, repeated sort, export completeness, missing-helper recovery, rule reordering, automatic sorting, multiple windows, and persisted preferences.');
} finally {
  await browser.close();
  await rm(temporary, { recursive: true, force: true });
}
