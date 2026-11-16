import { closeAndConfirmTab } from './tab-close.js';

const SCAN_KEY = 'managedTabScan';
const SCAN_LIFETIME_MS = 15 * 60 * 1000;

function normalWindows(windows) {
  return windows.filter(window => window.type === 'normal' && !window.incognito);
}

function stableUrl(tab) {
  if (!tab || tab.pendingUrl || tab.status === 'loading' || typeof tab.url !== 'string' || !tab.url) return null;
  try { new URL(tab.url); return tab.url; } catch { return null; }
}

function protectionReason(tab, groups, extensionId, allowPinned) {
  if (tab.pendingUrl || tab.status === 'loading') return 'Tab is navigating';
  const url = stableUrl(tab);
  if (!url) return 'Tab address unavailable';
  const parsed = new URL(url);
  if (parsed.protocol === 'chrome-extension:' && parsed.hostname === extensionId) return 'Tab Sorter page';
  if (Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0) return 'Split-view tab';
  if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
    const group = groups.get(tab.groupId);
    if (!group) return 'Group details unavailable';
    if (group.shared) return 'Shared-group tab';
  }
  if (tab.pinned && !allowPinned) return 'Pinned tab; enable pinned-tab selection to close';
  return '';
}

function sameReviewedTab(current, reviewed) {
  return current && stableUrl(current) === reviewed.url && current.windowId === reviewed.windowId &&
    (current.groupId ?? -1) === reviewed.groupId && Boolean(current.pinned) === reviewed.pinned;
}

/** Review current tab-strip order without navigating, sorting, or selecting any tabs. */
export function createTabManagerController(api) {
  let operation = null;

  async function readState() {
    const [windows, groups] = await Promise.all([
      api.windows.getAll({ populate: true, windowTypes: ['normal'] }),
      api.tabGroups.query({}),
    ]);
    return { windows: normalWindows(windows), groups };
  }

  function begin(next) {
    if (operation) throw new Error(`A tab ${operation === 'close' ? 'close operation' : 'scan'} is already running. Wait for it to finish.`);
    operation = next;
  }

  async function scan(preferredWindowId, allowPinned = false) {
    begin('scan');
    try {
      if (typeof allowPinned !== 'boolean') throw new Error('Pinned-tab selection must be enabled explicitly.');
      const state = await readState();
      const preferred = state.windows.find(window => window.id === preferredWindowId) || state.windows.find(window => window.focused) || state.windows[0];
      state.windows.sort((a, b) => Number(b.id === preferred?.id) - Number(a.id === preferred?.id) || a.id - b.id);
      const groupMap = new Map(state.groups.map(group => [group.id, group]));
      const windows = state.windows.map((window, index) => {
        const label = `Window ${index + 1}`;
        return {
          id: window.id, label, current: window.id === preferred?.id,
          tabs: [...(window.tabs || [])].sort((a, b) => a.index - b.index || a.id - b.id).map(tab => {
            const reason = protectionReason(tab, groupMap, api.runtime.id, allowPinned);
            return {
              id: tab.id, title: tab.title || tab.url || tab.pendingUrl || 'Untitled tab', url: tab.url || '',
              windowId: window.id, windowLabel: label, index: tab.index, groupId: tab.groupId ?? -1,
              groupTitle: groupMap.get(tab.groupId)?.title || '', pinned: Boolean(tab.pinned), active: Boolean(tab.active),
              reason, selectable: !reason,
            };
          }),
        };
      });
      const scanId = crypto.randomUUID();
      await api.storage.session.set({ [SCAN_KEY]: { scanId, createdAt: Date.now(), allowPinned, windows } });
      return { scanId, windows };
    } finally {
      operation = null;
    }
  }

  async function close(scanId, tabIds) {
    begin('close');
    try {
      if (!Array.isArray(tabIds) || !tabIds.length || tabIds.some(id => !Number.isInteger(id) || id < 0) || new Set(tabIds).size !== tabIds.length) {
        throw new Error('Select one or more unique tabs to close.');
      }
      const saved = (await api.storage.session.get(SCAN_KEY))[SCAN_KEY];
      const now = Date.now();
      if (!saved || typeof scanId !== 'string' || saved.scanId !== scanId || !Number.isFinite(saved.createdAt) ||
          saved.createdAt > now || now - saved.createdAt >= SCAN_LIFETIME_MS ||
          typeof saved.allowPinned !== 'boolean' || !Array.isArray(saved.windows)) {
        throw new Error('This tab review has expired or was replaced. Refresh the list before closing tabs.');
      }
      const offered = new Map(saved.windows.flatMap(window => window.tabs.filter(tab => tab.selectable).map(tab => [tab.id, tab])));
      if (tabIds.some(id => !offered.has(id))) {
        throw new Error('The selection contains a tab that was not offered for closing. Refresh the list.');
      }
      // A consumed review cannot be replayed after a retry or service-worker restart.
      await api.storage.session.remove(SCAN_KEY);
      const result = { closed: [], skipped: [], failed: [] };
      // Closing active tabs last avoids activating another selected tab through our own removals.
      const closeOrder = [...tabIds].sort((a, b) => Number(offered.get(a).active) - Number(offered.get(b).active));
      for (const id of closeOrder) {
        const reviewed = offered.get(id);
        let current;
        let groupMap;
        try {
          const state = await readState();
          current = state.windows.flatMap(window => (window.tabs || []).map(tab => ({ ...tab, windowId: window.id }))).find(tab => tab.id === id);
          groupMap = new Map(state.groups.map(group => [group.id, group]));
        } catch {
          result.failed.push({ id, reason: 'Chrome could not refresh the tab state. Refresh the list and try again.' });
          continue;
        }
        if (!sameReviewedTab(current, reviewed)) {
          result.skipped.push({ id, reason: 'This tab changed, moved, or closed since the review.' });
          continue;
        }
        const protectedReason = protectionReason(current, groupMap, api.runtime.id, saved.allowPinned);
        if (protectedReason) {
          result.skipped.push({ id, reason: `${protectedReason}; this tab was kept.` });
          continue;
        }
        if (current.active && !reviewed.active) {
          result.skipped.push({ id, reason: 'This tab became active after the review and was kept.' });
          continue;
        }
        const removal = await closeAndConfirmTab(api, id);
        if (removal.closed) result.closed.push(id);
        else result.failed.push({ id, reason: removal.reason });
      }
      return result;
    } finally {
      operation = null;
    }
  }

  return { scan, close };
}
