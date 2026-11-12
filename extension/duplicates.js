const SCAN_KEY = 'duplicateScan';
const SCAN_LIFETIME_MS = 15 * 60 * 1000;

function stableWebUrl(tab) {
  if (!tab || tab.pendingUrl || tab.status === 'loading' || typeof tab.url !== 'string') return null;
  try {
    const parsed = new URL(tab.url);
    return ['http:', 'https:'].includes(parsed.protocol) ? tab.url : null;
  } catch {
    return null;
  }
}

function protectionReason(tab, groups) {
  if (tab.pinned) return 'Pinned tab';
  if (Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0) return 'Split-view tab';
  if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
    const group = groups.get(tab.groupId);
    if (!group) return 'Group details unavailable';
    if (group.shared) return 'Shared-group tab';
  }
  return '';
}

function normalWindows(windows) {
  return windows.filter(window => window.type === 'normal' && !window.incognito).sort((a, b) => a.id - b.id);
}

function groupId(tab) {
  return tab.groupId ?? -1;
}

/** Exact URLs only: query parameters and fragments identify different pages. */
export function findDuplicateGroups(windows, groups = [], preferredWindowId, preferredTabId) {
  const eligibleWindows = normalWindows(windows);
  const preferred = eligibleWindows.find(window => window.id === preferredWindowId) || eligibleWindows.find(window => window.focused);
  const groupMap = new Map(groups.map(group => [group.id, group]));
  const byUrl = new Map();
  eligibleWindows.forEach((window, index) => {
    for (const tab of [...(window.tabs || [])].sort((a, b) => a.index - b.index || a.id - b.id)) {
      const url = stableWebUrl(tab);
      if (!url) continue;
      const entry = {
        id: tab.id, title: tab.title || url, url,
        windowId: window.id, windowLabel: `Window ${index + 1}`, index: tab.index,
        groupId: groupId(tab), active: Boolean(tab.active), reason: protectionReason(tab, groupMap),
      };
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(entry);
    }
  });
  const duplicates = [];
  for (const [url, tabs] of byUrl) {
    if (tabs.length < 2) continue;
    const protectedTabs = tabs.filter(tab => tab.reason);
    const keeper = protectedTabs[0] ||
      tabs.find(tab => tab.id === preferredTabId && tab.windowId === preferred?.id) ||
      tabs.find(tab => tab.active && tab.windowId === preferred?.id) ||
      tabs.find(tab => tab.active) || tabs[0];
    if (!keeper.reason) {
      keeper.reason = keeper.id === preferredTabId && keeper.windowId === preferred?.id ? 'Original active tab' :
        keeper.active && keeper.windowId === preferred?.id ? 'Active tab in this window' :
        keeper.active ? 'Active tab' : 'First tab';
    }
    duplicates.push({
      url, keeper,
      protectedTabs: protectedTabs.filter(tab => tab !== keeper),
      candidates: tabs.filter(tab => tab !== keeper && !protectedTabs.includes(tab)),
    });
  }
  return duplicates.sort((a, b) => a.url.localeCompare(b.url, 'en'));
}

function sameReviewedTab(current, reviewed) {
  return current && stableWebUrl(current) === reviewed.url &&
    current.windowId === reviewed.windowId && groupId(current) === reviewed.groupId;
}

function missingTab(error, id) {
  return new RegExp(`^(?:No tab with id: ${id}\\.?|Invalid tab ID: ${id}\\.?)$`, 'i').test(error?.message || '');
}

/** Close only reviewed candidates, after immediate revalidation of each candidate and its original keeper. */
export function createDuplicateController(api) {
  let operation = null;

  async function readState() {
    const [windows, groups] = await Promise.all([
      api.windows.getAll({ populate: true, windowTypes: ['normal'] }),
      api.tabGroups.query({}),
    ]);
    return { windows, groups };
  }

  function begin(next) {
    if (operation) throw new Error(`A duplicate ${operation === 'close' ? 'close operation' : 'scan'} is already running. Wait for it to finish.`);
    operation = next;
  }

  async function scan(preferredWindowId, preferredTabId) {
    begin('scan');
    try {
      const { windows, groups: tabGroups } = await readState();
      const groups = findDuplicateGroups(windows, tabGroups, preferredWindowId, preferredTabId);
      const scanId = crypto.randomUUID();
      await api.storage.session.set({ [SCAN_KEY]: { scanId, createdAt: Date.now(), groups } });
      return { scanId, groups };
    } finally {
      operation = null;
    }
  }

  async function close(scanId, tabIds) {
    begin('close');
    try {
      if (!Array.isArray(tabIds) || !tabIds.length || tabIds.some(id => !Number.isInteger(id) || id < 0) || new Set(tabIds).size !== tabIds.length) {
        throw new Error('Select one or more unique duplicate tabs to close.');
      }
      const saved = (await api.storage.session.get(SCAN_KEY))[SCAN_KEY];
      if (!saved || typeof scanId !== 'string' || saved.scanId !== scanId ||
          !Number.isFinite(saved.createdAt) || saved.createdAt > Date.now() || Date.now() - saved.createdAt >= SCAN_LIFETIME_MS ||
          !Array.isArray(saved.groups)) {
        throw new Error('This duplicate review has expired or was replaced. Refresh the list before closing tabs.');
      }
      const offered = new Map(saved.groups.flatMap(group => group.candidates.map(candidate => [candidate.id, { candidate, keeper: group.keeper }])));
      if (tabIds.some(id => !offered.has(id))) {
        throw new Error('The selection contains a tab that was not offered for closing. Refresh the list.');
      }
      // Consume the review before side effects so worker restarts and retries cannot replay it.
      await api.storage.session.remove(SCAN_KEY);
      const result = { closed: [], skipped: [], failed: [] };
      const changedKeepers = new Set();
      for (const id of tabIds) {
        const { candidate, keeper } = offered.get(id);
        if (changedKeepers.has(keeper.id)) {
          result.skipped.push({ id, reason: 'The kept copy changed or closed. Refresh the list.' });
          continue;
        }
        let current;
        let groupMap;
        try {
          const state = await readState();
          const tabs = normalWindows(state.windows).flatMap(window => (window.tabs || []).map(tab => ({ ...tab, windowId: window.id })));
          const kept = tabs.find(tab => tab.id === keeper.id);
          if (!sameReviewedTab(kept, keeper)) {
            changedKeepers.add(keeper.id);
            result.skipped.push({ id, reason: 'The kept copy changed or closed. Refresh the list.' });
            continue;
          }
          current = tabs.find(tab => tab.id === id);
          groupMap = new Map(state.groups.map(group => [group.id, group]));
        } catch {
          result.failed.push({ id, reason: 'Chrome could not refresh the tab state. Refresh the list and try again.' });
          continue;
        }
        if (!sameReviewedTab(current, candidate)) {
          result.skipped.push({ id, reason: 'This tab changed, moved, or closed since the review.' });
          continue;
        }
        const protectedReason = protectionReason(current, groupMap);
        if (protectedReason) {
          result.skipped.push({ id, reason: `${protectedReason}; this tab was kept.` });
          continue;
        }
        if (current.active && !candidate.active) {
          result.skipped.push({ id, reason: 'This tab became active after the review and was kept.' });
          continue;
        }
        try {
          await api.tabs.remove(id);
        } catch {
          result.failed.push({ id, reason: 'Chrome could not close this tab. Review it and try again.' });
          continue;
        }
        try {
          await api.tabs.get(id);
          result.failed.push({ id, reason: 'This tab remained open; the page may have canceled closing.' });
        } catch (error) {
          if (missingTab(error, id)) result.closed.push(id);
          else result.failed.push({ id, reason: 'Chrome did not confirm whether this tab closed. Refresh the list.' });
        }
      }
      return result;
    } finally {
      operation = null;
    }
  }

  return { scan, close };
}
