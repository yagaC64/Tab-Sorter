const DEFAULT_RULES = [
  { label: 'Gmail', pattern: 'mail.google.com' },
  { label: 'Calendar', pattern: 'calendar.google.com' },
  { label: 'Drive', pattern: 'drive.google.com' },
  { label: 'Slack', pattern: 'app.slack.com' },
];

export const DEFAULT_SETTINGS = Object.freeze({
  profileLabel: '',
  fixedRules: Object.freeze(DEFAULT_RULES.map((rule) => Object.freeze(rule))),
  groupGithub: true,
  autoSort: false,
});

const alphabet = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const reservedGithubRoutes = new Set([
  'about', 'account', 'apps', 'blog', 'business', 'codespaces', 'collections',
  'contact', 'customer-stories', 'enterprise', 'events', 'explore', 'features',
  'git-guides', 'issues', 'join', 'login', 'logout', 'marketplace', 'new',
  'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'readme',
  'search', 'security', 'sessions', 'settings', 'site', 'sponsors', 'stars',
  'topics', 'trending', 'users', 'watching',
]);

function parsePattern(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Each fixed site needs a host pattern.');
  }
  let pattern = input.trim().replace(/^https?:\/\//i, '');
  if (pattern.length > 500 || /[\s?#@\\]/.test(pattern)) {
    throw new Error('Use a host and optional path, such as github.com/team/repo.');
  }
  const slash = pattern.indexOf('/');
  let host = (slash < 0 ? pattern : pattern.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? '' : pattern.slice(slash);
  const wildcard = host.startsWith('*.');
  if (wildcard) host = host.slice(2);
  if (!host || host.length > 253 || host.includes('*') || path.includes('*') ||
      !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Use a valid host; a wildcard is allowed only at the start, such as *.slack.com.');
  }
  // URL parsing consistently encodes Unicode and spaces in path prefixes.
  let normalizedPath;
  try {
    normalizedPath = path ? new URL(`https://${host}${path}`).pathname : '';
  } catch {
    throw new Error('The fixed-site path is not a valid URL path.');
  }
  pattern = `${wildcard ? '*.' : ''}${host}${normalizedPath}`;
  return { host, path: normalizedPath, wildcard, pattern };
}

export function normalizeSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Settings must be an object.');
  }
  const rules = input.fixedRules ?? DEFAULT_SETTINGS.fixedRules;
  if (!Array.isArray(rules) || rules.length > 30) {
    throw new Error('Use at most 30 fixed-site rules.');
  }
  const fixedRules = rules.map((rule, index) => {
    if (!rule || typeof rule.label !== 'string' || !rule.label.trim()) {
      throw new Error(`Fixed site ${index + 1} needs a label.`);
    }
    const label = rule.label.trim();
    if (label.length > 80 || /[\u0000-\u001f\u007f]/.test(label)) {
      throw new Error(`Fixed site ${index + 1} needs a single-line label of at most 80 characters.`);
    }
    return { label, pattern: parsePattern(rule.pattern).pattern };
  });
  const profileLabel = input.profileLabel ?? '';
  if (typeof profileLabel !== 'string' || profileLabel.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(profileLabel)) {
    throw new Error('Use a single-line profile label of at most 80 characters.');
  }
  for (const key of ['groupGithub', 'autoSort']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      throw new Error(`${key} must be true or false.`);
    }
  }
  return {
    profileLabel: profileLabel.trim(),
    fixedRules,
    groupGithub: input.groupGithub ?? DEFAULT_SETTINGS.groupGithub,
    autoSort: input.autoSort ?? DEFAULT_SETTINGS.autoSort,
  };
}

function parseUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return new URL(value); } catch { return null; }
}

function matchesPattern(url, rule) {
  const parsed = parseUrl(url);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase();
  return (host === rule.host || (rule.wildcard && host.endsWith(`.${rule.host}`))) &&
    (!rule.path || parsed.pathname.startsWith(rule.path));
}

export function matchesFixedRule(url, pattern) {
  return matchesPattern(url, parsePattern(pattern));
}

export function githubInfo(url) {
  const parsed = parseUrl(url);
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== 'github.com') return null;
  let parts;
  try { parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  const [owner, repo, section, item] = parts;
  if (!owner || !repo || reservedGithubRoutes.has(owner.toLowerCase()) ||
      !/^[a-z\d_.-]+$/i.test(owner) || !/^[a-z\d_.-]+$/i.test(repo) ||
      ['.', '..'].includes(owner) || ['.', '..'].includes(repo)) return null;
  const kind = section === 'issues' ? 'issue' : ['pull', 'pulls'].includes(section) ? 'pr' : 'repo';
  const number = kind !== 'repo' && /^\d+$/.test(item ?? '') ? Number(item) : null;
  return {
    owner, repo, key: `${owner}/${repo}`.toLowerCase(), label: `${owner}/${repo}`,
    kind, number,
  };
}

function displayedTabs(tabs = []) {
  return [...tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

function tabTitle(tab) {
  return tab.title?.trim() || tab.url || tab.pendingUrl || 'Untitled tab';
}

function tabUrl(tab) {
  return tab.url || tab.pendingUrl || '';
}

function compareGithubTabs(a, b) {
  const left = githubInfo(tabUrl(a));
  const right = githubInfo(tabUrl(b));
  const kindRank = { repo: 0, issue: 1, pr: 2 };
  return alphabet.compare(left.key, right.key) ||
    kindRank[left.kind] - kindRank[right.kind] ||
    (left.number ?? 0) - (right.number ?? 0) ||
    alphabet.compare(tabTitle(a), tabTitle(b)) ||
    (a.index ?? 0) - (b.index ?? 0);
}

/** Build a pure plan. Actual browser moves, concurrency checks, and receipts belong to the caller. */
export function planWindow(tabs, groups = [], input = DEFAULT_SETTINGS) {
  const settings = normalizeSettings(input);
  const current = displayedTabs(tabs);
  const groupMap = new Map(groups.map((group) => [group.id, group]));
  const compiledRules = settings.fixedRules.map((rule) => parsePattern(rule.pattern));
  const pinned = current.filter((tab) => tab.pinned);
  const movable = current.filter((tab) => !tab.pinned);
  const fixed = compiledRules.map(() => []);
  const ordinary = [];
  for (const tab of movable) {
    const shared = groupMap.get(tab.groupId)?.shared === true;
    const rule = shared ? -1 : compiledRules.findIndex((pattern) => matchesPattern(tabUrl(tab), pattern));
    if (rule >= 0) fixed[rule].push(tab);
    else ordinary.push(tab);
  }

  const members = new Map();
  for (const tab of ordinary) {
    if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
      if (!members.has(tab.groupId)) members.set(tab.groupId, []);
      members.get(tab.groupId).push(tab);
    }
  }
  const preservedGroups = new Set([...members].filter(([id, list]) =>
    groupMap.get(id)?.shared === true || !settings.groupGithub || list.some((tab) => !githubInfo(tabUrl(tab)))
  ).map(([id]) => id));
  const blocks = [];
  const seenGroups = new Set();
  const repos = new Map();
  const sortInfo = new Map();

  for (const tab of ordinary) {
    if (preservedGroups.has(tab.groupId)) {
      if (seenGroups.has(tab.groupId)) continue;
      seenGroups.add(tab.groupId);
      const list = members.get(tab.groupId);
      const label = groupMap.get(tab.groupId)?.title?.trim() || tabTitle(list[0]);
      const block = { key: `group:${tab.groupId}`, label, tabIds: list.map((member) => member.id), kind: 'existing-group', groupId: tab.groupId };
      blocks.push(block);
      sortInfo.set(block.key, { label, index: tab.index ?? 0 });
      continue;
    }
    const github = githubInfo(tabUrl(tab));
    if (github && settings.groupGithub) {
      if (!repos.has(github.key)) repos.set(github.key, { info: github, tabs: [] });
      repos.get(github.key).tabs.push(tab);
    } else {
      const block = { key: `tab:${tab.id}`, label: tabTitle(tab), tabIds: [tab.id], kind: 'tab' };
      blocks.push(block);
      sortInfo.set(block.key, { label: github?.key ?? block.label, index: tab.index ?? 0, github, tab });
    }
  }
  for (const [key, { info, tabs: repoTabs }] of repos) {
    const block = { key: `github:${key}`, label: info.label, tabIds: repoTabs.sort(compareGithubTabs).map((tab) => tab.id), kind: 'github' };
    blocks.push(block);
    sortInfo.set(block.key, { label: info.key, index: repoTabs[0].index ?? 0 });
  }
  blocks.sort((a, b) => {
    const left = sortInfo.get(a.key);
    const right = sortInfo.get(b.key);
    return alphabet.compare(left.label, right.label) ||
      (left.github && right.github ? compareGithubTabs(left.tab, right.tab) : 0) ||
      left.index - right.index;
  });
  const fixedIds = [];
  fixed.forEach((list, index) => {
    if (!list.length) return;
    const tabIds = list.map((tab) => tab.id);
    fixedIds.push(...tabIds);
    blocks.push({ key: `fixed:${index}`, label: settings.fixedRules[index].label, tabIds, kind: 'fixed' });
  });
  const pinnedIds = pinned.map((tab) => tab.id);
  return { pinnedIds, blocks, orderedIds: [...pinnedIds, ...blocks.flatMap((block) => block.tabIds)], fixedIds };
}

function safeText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#!|~]/g, '\\$&');
}

function markdownLink(tab) {
  const title = safeText(tabTitle(tab));
  const rawUrl = tabUrl(tab);
  const parsed = parseUrl(rawUrl);
  const allowed = new Set(['http:', 'https:', 'file:', 'chrome:', 'chrome-extension:', 'about:']);
  if (!parsed || !allowed.has(parsed.protocol)) {
    return rawUrl ? `${title} — URL: ${safeText(rawUrl)}` : `${title} — URL unavailable`;
  }
  const target = parsed.href.replace(/[<>"\\\u0000-\u0020\u007f]/g, (character) => encodeURIComponent(character)).replace(/&/g, '&amp;');
  return `[${title}](<${target}>)`;
}

function timeParts(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('The snapshot date is invalid.');
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  const offsetMinutes = -date.getTimezoneOffset();
  const offset = `${offsetMinutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return { day, clock, offset, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || `UTC${offset}` };
}

function filenameLabel(label) {
  return label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\d_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'profile-not-set';
}

/** Export a snapshot of the supplied current tab order; this function never applies a sort. */
export function buildSnapshot(windows, input = DEFAULT_SETTINGS, date = new Date()) {
  const settings = normalizeSettings(input);
  const { day, clock, offset, zone } = timeParts(date);
  const tabCount = windows.reduce((count, window) => count + (window.tabs?.length ?? 0), 0);
  const profile = settings.profileLabel || 'Not set';
  const lines = [
    '# Open tabs snapshot', '',
    `- Captured: ${day} ${clock} ${safeText(zone)} (UTC${offset})`,
    `- UTC: ${date.toISOString()}`,
    `- Chrome profile label: ${safeText(profile)}`,
    `- Windows: ${windows.length}`,
    `- Tabs: ${tabCount}`, '',
  ];
  windows.forEach((window, index) => {
    const tabs = displayedTabs(window.tabs);
    const groupMap = new Map((window.groups ?? []).map((group) => [group.id, group]));
    lines.push(`## Window ${index + 1}${window.incognito ? ' (Incognito)' : ''}`, '');
    if (!tabs.length) lines.push('_No tabs._', '');
    tabs.forEach((tab) => {
      const details = [];
      if (tab.pinned) details.push('Pinned');
      if (tab.active) details.push('Active');
      if (Number.isInteger(tab.groupId) && tab.groupId >= 0) {
        const group = groupMap.get(tab.groupId);
        details.push(`Group: ${safeText(group?.title || 'Untitled group')}${group?.shared ? ' (shared)' : ''}`);
      }
      lines.push(`- ${markdownLink(tab)}${details.length ? ` — ${details.join('; ')}` : ''}`);
    });
    if (tabs.length) lines.push('');
  });
  const filename = `tabs-${day}_${clock.replace(/[:.]/g, '-')}_UTC${offset.replace('+', 'plus').replace('-', 'minus').replace(':', '')}_${filenameLabel(settings.profileLabel)}.md`;
  return { filename, markdown: `${lines.join('\n').trimEnd()}\n` };
}
