import assert from 'node:assert/strict';
import test from 'node:test';
import { createTabManagerController } from '../extension/tab-manager.js';
import { createDuplicateController } from '../extension/duplicates.js';

const EXTENSION_ID = 'test-extension';
const tab = (id, extra = {}) => ({ id, title: `Tab ${id}`, url: `https://example.com/${id}`, index: id - 1, groupId: -1, pinned: false, active: false, status: 'complete', ...extra });
const window = (id, tabs, extra = {}) => ({ id, type: 'normal', incognito: false, focused: id === 1, tabs: tabs.map(item => ({ ...item, windowId: id })), ...extra });
const clone = value => structuredClone(value);

function fixture({ windows = [window(1, [tab(1), tab(2), tab(3)])], groups = [], beforeRead, remove, get } = {}) {
  const state = { windows: clone(windows), groups: clone(groups), saved: {}, reads: 0, removed: [] };
  const api = {
    runtime: { id: EXTENSION_ID },
    windows: { getAll: async options => {
      assert.deepEqual(options, { populate: true, windowTypes: ['normal'] });
      await beforeRead?.(state, ++state.reads);
      return clone(state.windows);
    } },
    tabGroups: { query: async options => { assert.deepEqual(options, {}); return clone(state.groups); } },
    storage: { session: {
      get: async key => ({ [key]: clone(state.saved[key]) }),
      set: async value => { Object.assign(state.saved, clone(value)); },
      remove: async key => { delete state.saved[key]; },
    } },
    tabs: {
      remove: async id => {
        assert.equal(state.saved.managedTabScan, undefined, 'consume the review before side effects');
        state.removed.push(id);
        if (remove && await remove(state, id) === false) return;
        for (const window of state.windows) {
          window.tabs = window.tabs.filter(tab => tab.id !== id);
          window.tabs.forEach((tab, index) => { tab.index = index; });
        }
      },
      get: async id => {
        await get?.(state, id);
        const current = state.windows.flatMap(window => window.tabs).find(tab => tab.id === id);
        if (!current) throw new Error(`No tab with id: ${id}.`);
        return clone(current);
      },
    },
  };
  return { state, api, controller: createTabManagerController(api) };
}

test('scan shows the current normal window first and exact strip order, excluding incognito and popup windows', async () => {
  const { controller, state } = fixture({ windows: [
    window(8, [tab(4, { index: 1 }), tab(3, { index: 0 })]),
    window(2, [tab(1)]), window(4, [tab(2)]),
    window(1, [tab(6)], { incognito: true }), window(3, [tab(7)], { type: 'popup' }),
  ] });
  const before = clone(state.windows);
  const result = await controller.scan(8);
  assert.deepEqual(result.windows.map(item => item.id), [8, 2, 4]);
  assert.deepEqual(result.windows[0].tabs.map(item => item.id), [3, 4]);
  assert.equal(result.windows[0].current, true);
  assert.equal(result.windows[1].current, false);
  assert.deepEqual(state.windows, before, 'scanning does not rearrange browser tabs');
  assert.deepEqual(state.removed, []);
  const fallback = await controller.scan();
  assert.equal(fallback.windows[0].id, 8);
  assert.equal(fallback.windows[0].current, true, 'a normal window remains expanded when Chrome is unfocused');
  assert.equal(fallback.windows.filter(item => item.current).length, 1);
});

test('stable internal, local-file, blank and other-extension pages are selectable; own pages and navigation stay visible but protected', async () => {
  const { controller } = fixture({ windows: [window(1, [
    tab(1, { url: 'chrome://settings/' }), tab(2, { url: 'file:///tmp/sample.md' }),
    tab(3, { url: 'about:blank' }), tab(4, { url: 'chrome-extension://other-extension/page.html' }),
    tab(5, { url: `chrome-extension://${EXTENSION_ID}/manage-tabs.html` }),
    tab(6, { url: `chrome-extension://${EXTENSION_ID}/duplicates.html?x=1` }),
    tab(7, { status: 'loading' }), tab(8, { pendingUrl: 'https://example.com/new' }),
    tab(9, { url: '' }), tab(10, { url: 'not a URL' }),
  ])] });
  const rows = (await controller.scan(1)).windows[0].tabs;
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.filter(row => row.selectable).map(row => row.id), [1, 2, 3, 4]);
  assert.match(rows[4].reason, /Tab Sorter page/);
  assert.match(rows[6].reason, /navigating/);
  assert.match(rows[8].reason, /address unavailable/);
});

test('shared groups, split views and unknown groups remain protected even with pinned-tab opt-in', async () => {
  const { controller } = fixture({
    windows: [window(1, [tab(1, { pinned: true }), tab(2, { groupId: 8 }), tab(3, { splitViewId: 0 }), tab(4, { groupId: 9 })])],
    groups: [{ id: 8, title: 'Shared work', shared: true }],
  });
  const rows = (await controller.scan(1, true)).windows[0].tabs;
  assert.deepEqual(rows.filter(row => row.selectable).map(row => row.id), [1]);
  assert.equal(rows[1].groupTitle, 'Shared work');
  assert.match(rows[1].reason, /Shared-group/);
  assert.match(rows[2].reason, /Split-view/);
  assert.match(rows[3].reason, /Group details unavailable/);
});

test('pinned selection requires an explicit scan opt-in and that stored review governs closure', async () => {
  const { controller, state } = fixture({ windows: [window(1, [tab(1, { pinned: true }), tab(2)])] });
  const ordinary = await controller.scan(1);
  assert.equal(ordinary.windows[0].tabs[0].selectable, false);
  await assert.rejects(controller.close(ordinary.scanId, [1]), /not offered/);
  await assert.rejects(controller.scan(1, 'true'), /enabled explicitly/);
  const optedIn = await controller.scan(1, true);
  assert.equal(state.saved.managedTabScan.allowPinned, true);
  assert.deepEqual(await controller.close(optedIn.scanId, [1]), { closed: [1], skipped: [], failed: [] });
  assert.deepEqual(state.windows[0].tabs.map(item => item.id), [2]);
});

test('explicit selected tabs close without any duplicate requirement and without self-induced index failures', async () => {
  const { controller, state } = fixture();
  const scan = await controller.scan(1);
  assert.deepEqual(await controller.close(scan.scanId, [1, 3]), { closed: [1, 3], skipped: [], failed: [] });
  assert.deepEqual(state.windows[0].tabs.map(item => item.id), [2]);
  assert.equal(state.windows[0].tabs[0].index, 0);
});

test('all selected ordinary tabs may close while the management page remains protected', async () => {
  const { controller, state } = fixture({ windows: [window(1, [tab(1), tab(2), tab(3, { url: `chrome-extension://${EXTENSION_ID}/manage-tabs.html` })])] });
  const scan = await controller.scan(1);
  assert.deepEqual(await controller.close(scan.scanId, [1, 2]), { closed: [1, 2], skipped: [], failed: [] });
  assert.deepEqual(state.windows[0].tabs.map(item => item.id), [3]);
});

test('closing all selected tabs defers originally active tabs so neighbor activation does not skip a selection', async () => {
  const { controller, state } = fixture({
    windows: [
      window(1, [tab(90, { url: `chrome-extension://${EXTENSION_ID}/tabs.html`, active: true })]),
      window(2, [tab(1, { active: true }), tab(2), tab(3)]),
    ],
    remove: (state, id) => {
      const owningWindow = state.windows.find(window => window.tabs.some(tab => tab.id === id));
      const closing = owningWindow.tabs.find(tab => tab.id === id);
      if (!closing.active) return;
      const neighbor = owningWindow.tabs.find(tab => tab.id !== id);
      if (neighbor) neighbor.active = true;
    },
  });
  const scan = await controller.scan(1);
  assert.deepEqual(scan.windows[1].tabs.map(tab => tab.id), [1, 2, 3], 'display order remains the browser strip order');
  assert.deepEqual(await controller.close(scan.scanId, [1, 2, 3]), { closed: [2, 3, 1], skipped: [], failed: [] });
  assert.deepEqual(state.removed, [2, 3, 1]);
  assert.deepEqual(state.windows[1].tabs, []);
  assert.deepEqual(state.windows[0].tabs.map(tab => tab.id), [90]);
});

test('unknown, protected, duplicate and noninteger selections reject before any closure', async () => {
  const { controller, state } = fixture({ windows: [window(1, [tab(1), tab(2, { pinned: true }), tab(3)])] });
  const scan = await controller.scan(1);
  for (const selection of [[], [1, 1], [1, 99], [1, 2], ['1'], [1.5]]) {
    await assert.rejects(controller.close(scan.scanId, selection), /Select one or more|not offered/);
    assert.deepEqual(state.removed, []);
    assert.equal(state.saved.managedTabScan.scanId, scan.scanId);
  }
});

test('reviews survive controller recreation but replaced, expired and consumed reviews cannot close tabs', async () => {
  const { controller, api, state } = fixture();
  const old = await controller.scan(1);
  const latest = await controller.scan(1);
  const restarted = createTabManagerController(api);
  await assert.rejects(restarted.close(old.scanId, [1]), /expired or was replaced/);
  state.saved.managedTabScan.createdAt = Date.now() - 15 * 60 * 1000;
  await assert.rejects(restarted.close(latest.scanId, [1]), /expired or was replaced/);
  const fresh = await restarted.scan(1);
  assert.deepEqual(await restarted.close(fresh.scanId, [1]), { closed: [1], skipped: [], failed: [] });
  await assert.rejects(createTabManagerController(api).close(fresh.scanId, [2]), /expired or was replaced/);
});

test('manager and duplicate review tokens occupy separate session keys', async () => {
  const { controller, api, state } = fixture({ windows: [window(1, [tab(1), tab(2, { url: 'https://example.com/1' })])] });
  const duplicate = await createDuplicateController(api).scan(1);
  const managed = await controller.scan(1);
  assert.equal(state.saved.duplicateScan.scanId, duplicate.scanId);
  assert.equal(state.saved.managedTabScan.scanId, managed.scanId);
  await controller.close(managed.scanId, [2]);
  assert.equal(state.saved.duplicateScan.scanId, duplicate.scanId);
});

test('navigation, loading, disappearance, window movement, group and pin changes skip only stale selections', async () => {
  const mutations = [
    state => { state.windows[0].tabs[0].url += '#changed'; },
    state => { state.windows[0].tabs[0].status = 'loading'; },
    state => { state.windows[0].tabs[0].pendingUrl = 'https://example.com/new'; },
    state => { state.windows[0].tabs.shift(); },
    state => { state.windows.push(window(2, [state.windows[0].tabs.shift()])); },
    state => { state.windows[0].tabs[0].groupId = 5; },
    state => { state.windows[0].tabs[0].pinned = true; },
  ];
  for (const mutate of mutations) {
    const { controller, state } = fixture();
    const scan = await controller.scan(1, true);
    mutate(state);
    const result = await controller.close(scan.scanId, [1, 3]);
    assert.deepEqual(result.closed, [3]);
    assert.deepEqual(result.skipped.map(item => item.id), [1]);
    assert.deepEqual(state.removed, [3]);
  }
});

test('unpinning an opted-in pinned tab also invalidates its reviewed state', async () => {
  const { controller, state } = fixture({ windows: [window(1, [tab(1, { pinned: true })])] });
  const scan = await controller.scan(1, true);
  state.windows[0].tabs[0].pinned = false;
  const result = await controller.close(scan.scanId, [1]);
  assert.deepEqual(result.closed, []);
  assert.deepEqual(result.skipped.map(item => item.id), [1]);
});

test('new sharing, split view and activation are checked just before each removal', async () => {
  for (const change of ['shared', 'split', 'active', 'unknown-group']) {
    const { controller, state } = fixture({
      windows: [window(1, [tab(1, { groupId: 5 }), tab(2)])], groups: [{ id: 5, shared: false }],
      remove: (state, id) => {
        if (id !== 2) return;
        const next = state.windows[0].tabs.find(tab => tab.id === 1);
        if (change === 'shared') state.groups[0].shared = true;
        if (change === 'split') next.splitViewId = 2;
        if (change === 'active') next.active = true;
        if (change === 'unknown-group') state.groups = [];
      },
    });
    const scan = await controller.scan(1);
    const result = await controller.close(scan.scanId, [2, 1]);
    assert.deepEqual(result.closed, [2]);
    assert.deepEqual(result.skipped.map(item => item.id), [1]);
    assert.deepEqual(state.removed, [2]);
  }
});

test('an originally active selected tab can close', async () => {
  const { controller } = fixture({ windows: [window(1, [tab(1, { active: true }), tab(2)])] });
  const scan = await controller.scan(1);
  assert.deepEqual(await controller.close(scan.scanId, [1]), { closed: [1], skipped: [], failed: [] });
});

test('failed removal, retained tab and unrelated verification error never count as confirmed closures', async () => {
  const { controller, state } = fixture({
    windows: [window(1, [tab(1), tab(2), tab(3), tab(4)])],
    remove: (_state, id) => { if (id === 1) throw new Error('Cannot close'); if (id === 2) return false; },
    get: (_state, id) => { if (id === 3) throw new Error('Cannot verify'); },
  });
  const scan = await controller.scan(1);
  const result = await controller.close(scan.scanId, [1, 2, 3, 4]);
  assert.deepEqual(result.closed, [4]);
  assert.deepEqual(result.failed.map(item => item.id), [1, 2, 3]);
  assert.deepEqual(state.windows[0].tabs.map(item => item.id), [1, 2]);
});

test('refresh or session-consumption failure prevents unvalidated tab removals', async () => {
  const first = fixture({ beforeRead: (_state, count) => { if (count === 2) throw new Error('Unavailable'); } });
  const scan = await first.controller.scan(1);
  const result = await first.controller.close(scan.scanId, [1, 2]);
  assert.deepEqual(result.failed.map(item => item.id), [1]);
  assert.deepEqual(result.closed, [2]);
  assert.deepEqual(first.state.removed, [2]);
  const second = fixture();
  const fresh = await second.controller.scan(1);
  second.api.storage.session.remove = async () => { throw new Error('Cannot consume review'); };
  await assert.rejects(second.controller.close(fresh.scanId, [1]), /Cannot consume review/);
  assert.deepEqual(second.state.removed, []);
});

test('controller rejects overlapping scans and closures and accepts a fresh scan after completion', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const paused = new Promise(resolve => { entered = resolve; });
  const { controller, state } = fixture({ remove: async () => { entered(); await gate; } });
  const scan = await controller.scan(1);
  const closing = controller.close(scan.scanId, [1]);
  await paused;
  await assert.rejects(controller.close(scan.scanId, [2]), /already running/);
  await assert.rejects(controller.scan(1), /already running/);
  release();
  assert.deepEqual(await closing, { closed: [1], skipped: [], failed: [] });
  assert.deepEqual(state.removed, [1]);
  assert.equal((await controller.scan(1)).windows[0].tabs.length, 2);
});
