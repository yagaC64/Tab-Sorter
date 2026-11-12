import assert from 'node:assert/strict';
import test from 'node:test';
import { findDuplicateGroups, createDuplicateController } from '../extension/duplicates.js';

const URL_A = 'https://example.com/article';
const URL_B = 'https://example.com/other';
const tab = (id, extra = {}) => ({ id, title: `Tab ${id}`, url: URL_A, windowId: 1, index: id - 1, groupId: -1, pinned: false, active: false, status: 'complete', ...extra });
const window = (id, tabs, extra = {}) => ({ id, type: 'normal', incognito: false, focused: id === 1, tabs: tabs.map(item => ({ ...item, windowId: id })), ...extra });
const clone = value => structuredClone(value);

function fixture({ windows = [window(1, [tab(1), tab(2), tab(3)])], groups = [], beforeRead, remove, get } = {}) {
  const state = { windows: clone(windows), groups: clone(groups), saved: {}, reads: 0, removed: [] };
  const api = {
    windows: { getAll: async options => {
      assert.deepEqual(options, { populate: true, windowTypes: ['normal'] });
      await beforeRead?.(state, ++state.reads);
      return clone(state.windows);
    } },
    tabGroups: { query: async options => { assert.deepEqual(options, {}); return clone(state.groups); } },
    storage: { session: {
      get: async key => ({ [key]: clone(state.saved[key]) }),
      set: async values => { Object.assign(state.saved, clone(values)); },
      remove: async key => { delete state.saved[key]; },
    } },
    tabs: {
      remove: async id => {
        assert.equal(state.saved.duplicateScan, undefined, 'review must be consumed before the first removal');
        state.removed.push(id);
        if (remove && await remove(state, id) === false) return;
        state.windows.forEach(item => { item.tabs = item.tabs.filter(current => current.id !== id); });
      },
      get: async id => {
        await get?.(state, id);
        const current = state.windows.flatMap(item => item.tabs).find(item => item.id === id);
        if (!current) throw new Error(`No tab with id: ${id}.`);
        return clone(current);
      },
    },
  };
  return { state, api, controller: createDuplicateController(api) };
}

test('finder compares exact HTTP URLs including query strings and fragments', () => {
  const groups = findDuplicateGroups([window(1, [
    tab(1), tab(2), tab(3, { url: `${URL_A}?q=1` }), tab(4, { url: `${URL_A}#section` }),
    tab(5, { url: 'chrome://newtab/' }), tab(6, { url: 'chrome://newtab/' }),
    tab(7, { url: 'not a URL' }), tab(8, { url: 'not a URL' }),
    tab(9, { url: URL_A, pendingUrl: URL_B }), tab(10, { status: 'loading' }),
  ])]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].url, URL_A);
  assert.equal(groups[0].keeper.id, 1);
  assert.deepEqual(groups[0].candidates.map(item => item.id), [2]);
});

test('finder spans normal windows in deterministic order but excludes incognito and popup windows', () => {
  const result = findDuplicateGroups([
    window(8, [tab(4)]), window(3, [tab(1), tab(2, { url: URL_B })]),
    window(1, [tab(5, { url: URL_B })], { incognito: true }),
    window(2, [tab(6, { url: URL_B })], { type: 'popup' }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].keeper.id, 1);
  assert.equal(result[0].keeper.windowLabel, 'Window 1');
  assert.equal(result[0].candidates[0].id, 4);
  assert.equal(result[0].candidates[0].windowLabel, 'Window 2');
});

test('original active tab, preferred-window active tab, then any active tab take keeper priority', () => {
  const windows = [window(1, [tab(1, { active: true })]), window(2, [tab(2, { active: true }), tab(3)])];
  assert.equal(findDuplicateGroups(windows, [], 2, 3)[0].keeper.id, 3);
  assert.equal(findDuplicateGroups(windows, [], 2)[0].keeper.id, 2);
  assert.equal(findDuplicateGroups(windows, [], 8)[0].keeper.id, 1);
  windows[0].focused = false;
  assert.equal(findDuplicateGroups(windows, [], 8)[0].keeper.id, 1);
});

test('pinned, shared, split-view and unknown-group tabs remain protected, including all-protected groups', () => {
  const windows = [window(1, [tab(1, { pinned: true }), tab(2, { groupId: 5 }), tab(3, { splitViewId: 0 }), tab(4, { groupId: 6 }), tab(5, { active: true })])];
  const groups = [{ id: 5, shared: true }];
  const result = findDuplicateGroups(windows, groups, 1, 5)[0];
  assert.equal(result.keeper.id, 1);
  assert.equal(result.keeper.reason, 'Pinned tab');
  assert.deepEqual(result.protectedTabs.map(item => item.id), [2, 3, 4]);
  assert.deepEqual(result.candidates.map(item => item.id), [5]);
  windows[0].tabs.pop();
  assert.deepEqual(findDuplicateGroups(windows, groups)[0].candidates, []);
});

test('controller selectively closes reviewed extras and leaves the original keeper and unselected tabs', async () => {
  const { controller, state } = fixture();
  const scan = await controller.scan(1);
  const result = await controller.close(scan.scanId, [3]);
  assert.deepEqual(result, { closed: [3], skipped: [], failed: [] });
  assert.deepEqual(state.windows[0].tabs.map(item => item.id), [1, 2]);
  await assert.rejects(controller.close(scan.scanId, [2]), /expired or was replaced/);
});

test('a newly constructed controller accepts the latest session review and closes all selected extras', async () => {
  const { controller, api, state } = fixture();
  const old = await controller.scan(1);
  const scan = await controller.scan(1);
  const restarted = createDuplicateController(api);
  await assert.rejects(restarted.close(old.scanId, [2]), /expired or was replaced/);
  const result = await restarted.close(scan.scanId, [2, 3]);
  assert.deepEqual(result, { closed: [2, 3], skipped: [], failed: [] });
  assert.deepEqual(state.windows[0].tabs.map(item => item.id), [1]);
});

test('invalid selections, keepers, and unknown IDs reject the whole request before any removal', async () => {
  const { controller, state } = fixture();
  const scan = await controller.scan(1);
  for (const selection of [[], [2, 2], ['2'], [2.5], [2, 1], [2, 99]]) {
    await assert.rejects(controller.close(scan.scanId, selection), /Select one or more|not offered/);
    assert.deepEqual(state.removed, []);
    assert.equal(state.saved.duplicateScan.scanId, scan.scanId);
  }
});

test('expired reviews and future timestamps refuse closure without consuming a valid-looking selection', async () => {
  const { controller, state } = fixture();
  const scan = await controller.scan(1);
  state.saved.duplicateScan.createdAt = Date.now() - 15 * 60 * 1000;
  await assert.rejects(controller.close(scan.scanId, [2]), /expired/);
  state.saved.duplicateScan.createdAt = Date.now() + 60_000;
  await assert.rejects(controller.close(scan.scanId, [2]), /expired/);
  assert.deepEqual(state.removed, []);
});

test('keeper deletion, navigation, movement, or regrouping skips its whole group without choosing a replacement', async () => {
  const mutations = [
    state => state.windows[0].tabs.shift(),
    state => { state.windows[0].tabs[0].url = URL_B; },
    state => { state.windows[0].tabs[0].status = 'loading'; },
    state => { state.windows[0].tabs[0].pendingUrl = URL_B; },
    state => { state.windows.push(window(2, [state.windows[0].tabs.shift()])); },
    state => { state.windows[0].tabs[0].groupId = 8; },
  ];
  for (const mutate of mutations) {
    const { controller, state } = fixture();
    const scan = await controller.scan(1);
    mutate(state);
    const result = await controller.close(scan.scanId, [2, 3]);
    assert.deepEqual(result.skipped.map(item => item.id), [2, 3]);
    assert.equal(result.skipped.every(item => /kept copy changed or closed/.test(item.reason)), true);
    assert.deepEqual(state.removed, []);
  }
});

test('candidate navigation, loading, pending navigation, regrouping, or movement skips only that candidate', async () => {
  const mutations = [
    state => { state.windows[0].tabs[1].url = `${URL_A}#changed`; },
    state => { state.windows[0].tabs[1].status = 'loading'; },
    state => { state.windows[0].tabs[1].pendingUrl = URL_B; },
    state => { state.windows[0].tabs[1].groupId = 5; },
    state => { state.windows.push(window(2, [state.windows[0].tabs.splice(1, 1)[0]])); },
  ];
  for (const mutate of mutations) {
    const { controller, state } = fixture();
    const scan = await controller.scan(1);
    mutate(state);
    const result = await controller.close(scan.scanId, [2, 3]);
    assert.deepEqual(result.closed, [3]);
    assert.deepEqual(result.skipped.map(item => item.id), [2]);
    assert.deepEqual(state.removed, [3]);
  }
});

test('candidate pinning, split view, sharing an existing group, or newly active state protects it', async () => {
  const variants = [
    { mutate: state => { state.windows[0].tabs[1].pinned = true; }, reason: /Pinned/ },
    { mutate: state => { state.windows[0].tabs[1].splitViewId = 2; }, reason: /Split-view/ },
    { mutate: state => { state.windows[0].tabs[1].active = true; }, reason: /became active/ },
    { grouped: true, mutate: state => { state.groups[0].shared = true; }, reason: /Shared-group/ },
  ];
  for (const variant of variants) {
    const { controller, state } = fixture({
      windows: [window(1, [tab(1), tab(2, { groupId: variant.grouped ? 5 : -1 }), tab(3)])],
      groups: variant.grouped ? [{ id: 5, shared: false }] : [],
    });
    const scan = await controller.scan(1);
    variant.mutate(state);
    const result = await controller.close(scan.scanId, [2]);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, variant.reason);
    assert.deepEqual(state.removed, []);
  }
});

test('an originally active candidate can be explicitly closed while its pinned keeper remains', async () => {
  const { controller, state } = fixture({ windows: [window(1, [tab(1, { pinned: true }), tab(2, { active: true })])] });
  const scan = await controller.scan(1, 2);
  assert.equal(scan.groups[0].keeper.id, 1);
  assert.equal(scan.groups[0].candidates[0].active, true);
  assert.deepEqual(await controller.close(scan.scanId, [2]), { closed: [2], skipped: [], failed: [] });
  assert.deepEqual(state.windows[0].tabs.map(item => item.id), [1]);
});

test('a failed session consume prevents every tab removal', async () => {
  const { controller, api, state } = fixture();
  const scan = await controller.scan(1);
  api.storage.session.remove = async () => { throw new Error('Session storage unavailable'); };
  await assert.rejects(controller.close(scan.scanId, [2]), /Session storage unavailable/);
  assert.deepEqual(state.removed, []);
  assert.equal(state.saved.duplicateScan.scanId, scan.scanId);
});

test('remove failures and retained tabs are reported separately without overstating closure', async () => {
  const { controller, state } = fixture({
    windows: [window(1, [tab(1), tab(2), tab(3), tab(4)])],
    remove: (_state, id) => { if (id === 2) throw new Error('Cannot close tab'); if (id === 3) return false; },
  });
  const scan = await controller.scan(1);
  const result = await controller.close(scan.scanId, [2, 3, 4]);
  assert.deepEqual(result.closed, [4]);
  assert.deepEqual(result.failed.map(item => item.id), [2, 3]);
  assert.match(result.failed[1].reason, /remained open/);
  assert.deepEqual(state.windows[0].tabs.map(item => item.id), [1, 2, 3]);
});

test('an unrelated verification error does not count as proof a tab closed', async () => {
  const { controller } = fixture({ get: () => { throw new Error('Browser unavailable'); } });
  const scan = await controller.scan(1);
  const result = await controller.close(scan.scanId, [2]);
  assert.deepEqual(result.closed, []);
  assert.match(result.failed[0].reason, /did not confirm/);
});

test('each candidate is freshly checked and losing the keeper between removals stops the remaining group', async () => {
  const { controller, state } = fixture({
    remove: (state, id) => { if (id === 2) state.windows[0].tabs = state.windows[0].tabs.filter(item => item.id !== 1); },
  });
  const scan = await controller.scan(1);
  const result = await controller.close(scan.scanId, [2, 3]);
  assert.deepEqual(result.closed, [2]);
  assert.deepEqual(result.skipped.map(item => item.id), [3]);
  assert.deepEqual(state.removed, [2]);
});

test('concurrent closes and scans cannot overlap the active close operation', async () => {
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const paused = new Promise(resolve => { entered = resolve; });
  const { controller, state } = fixture({ remove: async () => { entered(); await gate; } });
  const scan = await controller.scan(1);
  const first = controller.close(scan.scanId, [2]);
  await paused;
  await assert.rejects(controller.close(scan.scanId, [3]), /already running/);
  await assert.rejects(controller.scan(1), /already running/);
  release();
  assert.deepEqual(await first, { closed: [2], skipped: [], failed: [] });
  assert.deepEqual(state.removed, [2]);
  assert.equal((await controller.scan(1)).groups[0].keeper.id, 1);
});
