import assert from 'node:assert/strict';
import test from 'node:test';

let importNumber = 0;
const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); } });
const tab = (id, title, extra = {}) => ({ id, title, url: `https://example.com/${id}`, windowId: 1, index: id - 1, pinned: false, groupId: -1, ...extra });

// These tests exercise the production message handler and its failure boundaries.
// They do not model or claim Chromium's grouping/reordering API semantics.
async function workerFixture({ tabs = [], groups = [], config = {}, beforeQuery, nativeReply, nativeError } = {}) {
  const state = { tabs: structuredClone(tabs), groups: structuredClone(groups), queries: 0, mutations: [], saved: {} };
  const chrome = {
    runtime: {
      id: 'test-extension', onMessage: event(),
      sendNativeMessage: async (host, message) => {
        state.nativeRequest = { host, message };
        if (nativeError) throw nativeError;
        return nativeReply;
      },
    },
    storage: {
      local: { get: async () => ({ settings: config }) },
      session: { set: async value => Object.assign(state.saved, value) },
    },
    tabs: {
      query: async filter => {
        await beforeQuery?.(state, ++state.queries, filter);
        return structuredClone(state.tabs.filter(item =>
          (filter.windowId === undefined || item.windowId === filter.windowId) &&
          (filter.groupId === undefined || item.groupId === filter.groupId)));
      },
      move: async (id, { index }) => {
        state.mutations.push({ type: 'move', id, index });
        const current = state.tabs.findIndex(item => item.id === id);
        const [moving] = state.tabs.splice(current, 1);
        if (!moving) throw new Error('No tab with this id.');
        state.tabs.splice(index, 0, moving);
        state.tabs.forEach((item, offset) => { item.index = offset; });
        return structuredClone(moving);
      },
      group: async () => { throw new Error('Grouping semantics require the real-browser integration test.'); },
      ungroup: async ids => {
        state.mutations.push({ type: 'ungroup', ids });
        state.tabs.filter(item => ids.includes(item.id)).forEach(item => { item.groupId = -1; });
      },
      onCreated: event(), onUpdated: event(), onAttached: event(),
    },
    tabGroups: {
      query: async filter => structuredClone(state.groups.filter(item => filter.windowId === undefined || item.windowId === filter.windowId)),
      get: async id => structuredClone(state.groups.find(item => item.id === id)),
      update: async () => { throw new Error('Unexpected group mutation.'); },
      move: async () => { throw new Error('Group movement requires the real-browser integration test.'); },
    },
    windows: {
      getAll: async () => [{ id: 1, incognito: false }, { id: 2, incognito: true }],
      onRemoved: event(),
    },
  };
  globalThis.chrome = chrome;
  await import(`../extension/background.js?test=${++importNumber}`);
  return {
    state, chrome,
    request: (message, sender = { id: chrome.runtime.id }) => new Promise(resolve => {
      const retained = chrome.runtime.onMessage.listeners[0](message, sender, resolve);
      if (!retained) resolve(undefined);
    }),
  };
}

test('worker serializes overlapping sort requests and reports the actual final order', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fixture = await workerFixture({
    tabs: [tab(1, 'Zebra'), tab(2, 'Alpha')],
    beforeQuery: async (_state, count) => { if (count === 1) await gate; },
  });
  const first = fixture.request({ type: 'sort', windowId: 1 });
  const second = fixture.request({ type: 'sort', windowId: 1 });
  release();
  const replies = await Promise.all([first, second]);
  assert.equal(replies.every(reply => reply.ok && reply.count === 2), true);
  assert.deepEqual(fixture.state.tabs.map(item => item.id), [2, 1]);
  assert.equal(fixture.state.mutations.length, 1);
});

test('a closed tab aborts before mutation and a later explicit retry succeeds', async () => {
  const fixture = await workerFixture({
    tabs: [tab(1, 'Zebra'), tab(2, 'Alpha')],
    beforeQuery: (state, count) => { if (count === 2) state.tabs.pop(); },
  });
  const first = await fixture.request({ type: 'sort', windowId: 1 });
  assert.equal(first.ok, false);
  assert.match(first.error, /Tabs changed/);
  assert.deepEqual(fixture.state.mutations, []);
  const retry = await fixture.request({ type: 'sort', windowId: 1 });
  assert.equal(retry.ok, true);
  assert.equal(retry.count, 1);
});

test('a user changing pinned-tab order aborts without disturbing either pin', async () => {
  const fixture = await workerFixture({
    tabs: [tab(1, 'Pin Z', { pinned: true }), tab(2, 'Pin A', { pinned: true }), tab(3, 'Ordinary')],
    beforeQuery: (state, count) => {
      if (count === 2) {
        [state.tabs[0], state.tabs[1]] = [state.tabs[1], state.tabs[0]];
        state.tabs.forEach((item, index) => { item.index = index; });
      }
    },
  });
  const reply = await fixture.request({ type: 'sort', windowId: 1 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Tabs changed/);
  assert.deepEqual(fixture.state.mutations, []);
});

test('a user regrouping a fixed tab during sorting aborts before removing it from the new group', async () => {
  const fixture = await workerFixture({
    tabs: [tab(1, 'Gmail', { url: 'https://mail.google.com/' })],
    beforeQuery: (state, count) => {
      if (count === 2) {
        state.tabs[0].groupId = 8;
        state.groups.push({ id: 8, windowId: 1, title: 'Shared work', shared: true });
      }
    },
  });
  const reply = await fixture.request({ type: 'sort', windowId: 1 });
  assert.equal(reply.ok, false);
  assert.deepEqual(fixture.state.mutations, []);
  assert.equal(fixture.state.tabs[0].groupId, 8);
});

test('entering split view after the initial snapshot aborts before moving tabs', async () => {
  const fixture = await workerFixture({
    tabs: [tab(1, 'Zebra'), tab(2, 'Alpha')],
    beforeQuery: (state, count) => { if (count === 2) state.tabs.forEach(item => { item.splitViewId = 5; }); },
  });
  const reply = await fixture.request({ type: 'sort', windowId: 1 });
  assert.equal(reply.ok, false);
  assert.deepEqual(fixture.state.mutations, []);
});

test('sharing an existing group during sorting aborts even when membership is unchanged', async () => {
  const fixture = await workerFixture({
    tabs: [tab(1, 'Gmail', { url: 'https://mail.google.com/', groupId: 8 })],
    groups: [{ id: 8, windowId: 1, title: 'Work', shared: false }],
    beforeQuery: (state, count) => { if (count === 2) state.groups[0].shared = true; },
  });
  const reply = await fixture.request({ type: 'sort', windowId: 1 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Tabs changed/);
  assert.deepEqual(fixture.state.mutations, []);
  assert.equal(fixture.state.tabs[0].groupId, 8);
});

test('a navigation event during an active sort runs a fresh automatic sort after the stale attempt ends', async t => {
  const scheduled = [];
  t.mock.method(globalThis, 'setTimeout', callback => { scheduled.push(callback); return scheduled.length; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  let release;
  let markPaused;
  const gate = new Promise(resolve => { release = resolve; });
  const paused = new Promise(resolve => { markPaused = resolve; });
  const fixture = await workerFixture({
    tabs: [tab(1, 'Zebra'), tab(2, 'Alpha')],
    config: { autoSort: true },
    beforeQuery: async (_state, count) => {
      if (count === 2) { markPaused(); await gate; }
    },
  });
  const manual = fixture.request({ type: 'sort', windowId: 1 });
  await paused;
  fixture.state.tabs[0].url = 'https://example.com/new-page';
  fixture.chrome.tabs.onUpdated.listeners[0](1, { url: fixture.state.tabs[0].url }, fixture.state.tabs[0]);
  assert.equal(scheduled.length, 1);
  // Fire the debounce while the original operation still owns the window.
  const automatic = scheduled[0]();
  release();
  const [first] = await Promise.all([manual, automatic]);
  assert.equal(first.ok, false);
  assert.match(first.error, /Tabs changed/);
  assert.deepEqual(fixture.state.tabs.map(item => item.id), [2, 1]);
  assert.equal(fixture.state.saved['status-1'].error, false);
  assert.match(fixture.state.saved['status-1'].text, /Sorted 2 tabs/);
});

test('all-window snapshots exclude incognito tabs and retain the visible order', async () => {
  const fixture = await workerFixture({
    tabs: [tab(1, 'Zebra'), tab(2, 'Alpha'), tab(3, 'Private', { windowId: 2, incognito: true })],
    config: { profileLabel: 'Test profile' },
  });
  const reply = await fixture.request({ type: 'snapshot', scope: 'all', windowId: 1 });
  assert.equal(reply.ok, true);
  assert.match(reply.markdown, /Chrome profile label: Test profile/);
  assert.match(reply.markdown, /Windows: 1\n- Tabs: 2/);
  assert.ok(reply.markdown.indexOf('[Zebra]') < reply.markdown.indexOf('[Alpha]'));
  assert.equal(reply.markdown.includes('Private'), false);
  assert.deepEqual(fixture.state.mutations, []);
});

test('native export preserves the saved path when launching the editor fails', async () => {
  const expected = { ok: false, opened: false, path: '/test/snapshots/tabs.md', error: 'Editor could not open the saved snapshot.' };
  const fixture = await workerFixture({ tabs: [tab(1, 'Tab')], nativeReply: expected });
  const reply = await fixture.request({ type: 'export-editor', scope: 'current', windowId: 1, editor: 'notepad-aurora' });
  assert.deepEqual(reply, expected);
  assert.equal(fixture.state.nativeRequest.host, 'com.tabsorter.editor');
  assert.equal(fixture.state.nativeRequest.message.action, 'export');
  assert.match(fixture.state.nativeRequest.message.markdown, /Open tabs snapshot/);
});

test('missing native helper gives an actionable fallback and external senders are rejected', async () => {
  const fixture = await workerFixture({ tabs: [tab(1, 'Tab')], nativeError: new Error('Specified native messaging host not found.') });
  const denied = await fixture.request({ type: 'export-editor', windowId: 1 }, { id: 'another-extension' });
  assert.equal(denied, undefined);
  assert.equal(fixture.state.nativeRequest, undefined);
  const reply = await fixture.request({ type: 'export-editor', scope: 'current', windowId: 1 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Install Editor Helper\.command/);
  assert.match(reply.error, /Save Markdown/);
});
