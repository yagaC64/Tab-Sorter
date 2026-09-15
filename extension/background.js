import { normalizeSettings, planWindow, buildSnapshot } from './core.js';

const activeSorts = new Map();
const pendingSorts = new Map();
const settings = async () => normalizeSettings((await chrome.storage.local.get('settings')).settings || {});
const ordered = tabs => [...tabs].sort((a, b) => a.index - b.index);
const tabSignature = tabs => tabs.map(t => [t.id, t.windowId, t.pinned, t.url || t.pendingUrl || '', t.splitViewId ?? -1]).sort((a, b) => a[0] - b[0]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function windowState(windowId) {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({ windowId }), chrome.tabGroups.query({ windowId })]);
  return { id: windowId, tabs: ordered(tabs), groups };
}

async function sortWindow(windowId) {
  if (activeSorts.has(windowId)) return activeSorts.get(windowId);
  const task = performSort(windowId).finally(() => activeSorts.delete(windowId));
  activeSorts.set(windowId, task);
  return task;
}

async function performSort(windowId) {
  const original = await windowState(windowId);
  if (original.tabs.some(t => t.splitViewId !== undefined && t.splitViewId !== -1)) {
    throw new Error('Exit split view in this window before sorting, so paired tabs stay safe.');
  }
  const config = await settings();
  const plan = planWindow(original.tabs, original.groups, config);
  const signature = tabSignature(original.tabs);
  const expectedGroups = new Map(original.tabs.map(tab => [tab.id, tab.groupId]));
  const expectedShared = new Map(original.groups.map(group => [group.id, Boolean(group.shared)]));
  const assertStable = async () => {
    const { tabs, groups } = await windowState(windowId);
    if (!same(signature, tabSignature(tabs)) || !same(plan.pinnedIds, tabs.filter(t => t.pinned).map(t => t.id)) ||
        tabs.some(tab => expectedGroups.get(tab.id) !== tab.groupId) ||
        groups.some(group => expectedShared.get(group.id) !== Boolean(group.shared))) {
      throw new Error('Tabs changed while sorting. Some may already have moved; click Sort again when the window is settled.');
    }
    return tabs;
  };

  // Preserve custom groups as units; prepare repository groups before arranging the bar.
  const blocks = plan.blocks.map(block => ({ ...block }));
  const groupById = new Map(original.groups.map(group => [group.id, group]));
  for (const block of blocks) {
    const current = await assertStable();
    if (block.kind === 'existing-group') continue;
    const members = current.filter(tab => block.tabIds.includes(tab.id));
    if (block.kind === 'github') {
      const candidates = [...new Set(members.map(tab => tab.groupId))].filter(id => id >= 0 &&
        current.filter(tab => tab.groupId === id).every(tab => block.tabIds.includes(tab.id)));
      const oldId = candidates.sort((a, b) => members.filter(tab => tab.groupId === b).length - members.filter(tab => tab.groupId === a).length)[0];
      const reusable = oldId !== undefined;
      block.groupId = reusable
        ? (members.every(tab => tab.groupId === oldId) ? oldId : await chrome.tabs.group({ tabIds: block.tabIds, groupId: oldId }))
        : await chrome.tabs.group({ tabIds: block.tabIds, createProperties: { windowId } });
      for (const id of block.tabIds) expectedGroups.set(id, block.groupId);
      if (!reusable) expectedShared.set(block.groupId, false);
      const existing = groupById.get(block.groupId);
      await chrome.tabGroups.update(block.groupId, { title: block.label, color: existing?.color || 'blue' });
      const grouped = ordered(await chrome.tabs.query({ windowId, groupId: block.groupId }));
      for (let i = 0; i < block.tabIds.length; i++) {
        const tabs = await assertStable();
        if (tabs.find(tab => tab.id === block.tabIds[i])?.index !== grouped[0].index + i) {
          await chrome.tabs.move(block.tabIds[i], { index: grouped[0].index + i });
        }
      }
    } else {
      const groupedIds = members.filter(tab => tab.groupId >= 0).map(tab => tab.id);
      if (groupedIds.length) {
        await chrome.tabs.ungroup(groupedIds);
        for (const id of groupedIds) expectedGroups.set(id, -1);
      }
    }
  }

  let index = plan.pinnedIds.length;
  for (const block of blocks) {
    const current = await assertStable();
    const position = current.find(tab => tab.id === block.tabIds[0])?.index;
    if (block.groupId >= 0) {
      if (position !== index) await chrome.tabGroups.move(block.groupId, { index });
    } else {
      for (let offset = 0; offset < block.tabIds.length; offset++) {
        const tabs = await assertStable();
        if (tabs.find(tab => tab.id === block.tabIds[offset])?.index !== index + offset) {
          await chrome.tabs.move(block.tabIds[offset], { index: index + offset });
        }
      }
    }
    index += block.tabIds.length;
  }
  const actual = await assertStable();
  if (!same(actual.map(tab => tab.id), plan.orderedIds)) {
    throw new Error('Chrome did not finish the requested order. Stop dragging tabs, then click Sort again.');
  }
  const result = { count: actual.length, repositories: blocks.filter(b => b.kind === 'github').length, fixed: plan.fixedIds.length };
  await chrome.storage.session.set({ [`status-${windowId}`]: { text: `Sorted ${result.count} tabs. ${result.repositories} repository groups; ${result.fixed} fixed tabs.`, error: false, completedAt: Date.now() } });
  return result;
}

async function snapshot(scope, windowId) {
  const windows = scope === 'all' ? await chrome.windows.getAll({ windowTypes: ['normal'] }) : [{ id: windowId }];
  const states = await Promise.all(windows.filter(w => !w.incognito).map(w => windowState(w.id)));
  return buildSnapshot(states, await settings());
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    switch (message.type) {
      case 'sort': return { ok: true, ...(await sortWindow(message.windowId)) };
      case 'snapshot': return { ok: true, ...(await snapshot(message.scope, message.windowId)) };
      case 'export-editor': {
        const file = await snapshot(message.scope, message.windowId);
        try {
          return await chrome.runtime.sendNativeMessage('com.tabsorter.editor', { action: 'export', ...file, editor: message.editor === 'default' ? 'default' : 'notepad-aurora' });
        } catch {
          throw new Error('Editor helper is unavailable. Run “Install Editor Helper.command” from the project folder, or use Save Markdown instead.');
        }
      }
      default: throw new Error('Unknown action.');
    }
  })().then(respond, error => respond({ ok: false, error: error.message || String(error) }));
  return true;
});

function scheduleSort(windowId) {
  clearTimeout(pendingSorts.get(windowId));
  pendingSorts.set(windowId, setTimeout(async () => {
    pendingSorts.delete(windowId);
    try {
      if (activeSorts.has(windowId)) await activeSorts.get(windowId).catch(() => {});
      if ((await settings()).autoSort) await sortWindow(windowId);
    } catch (error) {
      await chrome.storage.session.set({ [`status-${windowId}`]: { text: error.message, error: true } });
    }
  }, 900));
}

chrome.tabs.onCreated.addListener(tab => scheduleSort(tab.windowId));
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.url || change.status === 'complete') scheduleSort(tab.windowId);
});
chrome.tabs.onAttached.addListener((_id, info) => scheduleSort(info.newWindowId));
chrome.windows.onRemoved.addListener(id => {
  clearTimeout(pendingSorts.get(id));
  pendingSorts.delete(id);
});
