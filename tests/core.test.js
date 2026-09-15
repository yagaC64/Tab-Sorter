import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SETTINGS, normalizeSettings, matchesFixedRule, githubInfo, planWindow, buildSnapshot } from '../extension/core.js';

const tab = (id, title, url = 'https://example.com', extra = {}) => ({ id, index: id, title, url, pinned: false, groupId: -1, ...extra });

test('settings use independent defaults and reject invalid rules at the core boundary', () => {
  const normalized = normalizeSettings();
  assert.deepEqual(normalized, DEFAULT_SETTINGS);
  normalized.fixedRules[0].label = 'Changed';
  assert.equal(DEFAULT_SETTINGS.fixedRules[0].label, 'Gmail');
  assert.deepEqual(normalizeSettings({ fixedRules: [] }).fixedRules, []);
  assert.throws(() => normalizeSettings({ fixedRules: [{ label: '', pattern: 'example.com' }] }), /needs a label/);
  assert.throws(() => normalizeSettings({ fixedRules: [{ label: 'Site', pattern: '' }] }), /host pattern/);
  assert.throws(() => normalizeSettings({ fixedRules: Array(31).fill({ label: 'Site', pattern: 'example.com' }) }), /at most 30/);
  assert.throws(() => normalizeSettings({ autoSort: 'false' }), /true or false/);
});

test('fixed matching respects host boundaries, HTTP URLs, optional path prefixes, and rule validation', () => {
  assert.equal(matchesFixedRule('https://mail.google.com/mail/u/0', 'mail.google.com'), true);
  assert.equal(matchesFixedRule('https://mail.google.com.evil.example/', 'mail.google.com'), false);
  assert.equal(matchesFixedRule('https://evil.example/mail.google.com', 'mail.google.com'), false);
  assert.equal(matchesFixedRule('https://team.slack.com/client', '*.slack.com'), true);
  assert.equal(matchesFixedRule('https://slack.com/', '*.slack.com'), true);
  assert.equal(matchesFixedRule('https://notslack.com/', '*.slack.com'), false);
  assert.equal(matchesFixedRule('https://github.com/team/repo/issues/1', 'https://github.com/team/repo'), true);
  assert.equal(matchesFixedRule('https://github.com/team/elsewhere', 'github.com/team/repo'), false);
  assert.equal(matchesFixedRule('chrome://mail.google.com/', 'mail.google.com'), false);
  assert.equal(matchesFixedRule('not a URL', 'mail.google.com'), false);
  for (const pattern of ['foo.*.com', 'example.com?x=1', 'user@example.com', 'example.com/**', 'javascript:alert(1)']) {
    assert.throws(() => matchesFixedRule('https://example.com', pattern));
  }
});

test('GitHub parsing identifies exact repositories and rejects site pages or lookalike hosts', () => {
  assert.deepEqual(githubInfo('https://github.com/Example/Project/issues/12?x=1'), {
    owner: 'Example', repo: 'Project', key: 'example/project', label: 'Example/Project', kind: 'issue', number: 12,
  });
  assert.equal(githubInfo('https://github.com/github/docs/pull/42').kind, 'pr');
  assert.equal(githubInfo('https://github.com/example/project/tree/main').kind, 'repo');
  for (const url of ['https://github.com/settings/profile', 'https://github.com/orgs/example', 'https://github.com/example', 'https://github.com.evil.test/a/b', 'https://github.com/a/b%2Fc', 'not a URL']) {
    assert.equal(githubInfo(url), null);
  }
});

test('pins retain displayed order while fixed sites finish the strip in rule order', () => {
  const tabs = [
    tab(1, 'Pinned Z', 'https://example.com', { pinned: true, index: 0 }),
    tab(2, 'Pinned Gmail', 'https://mail.google.com', { pinned: true, index: 1 }),
    tab(3, 'Slack', 'https://app.slack.com', { index: 2 }),
    tab(4, 'Zebra', undefined, { index: 3 }),
    tab(5, 'Drive', 'https://drive.google.com', { index: 4 }),
    tab(6, 'Alpha', undefined, { index: 5 }),
    tab(7, 'Gmail', 'https://mail.google.com', { index: 6 }),
    tab(8, 'Calendar', 'https://calendar.google.com', { index: 7 }),
  ];
  const original = structuredClone(tabs);
  const plan = planWindow(tabs.toReversed());
  assert.deepEqual(plan.pinnedIds, [1, 2]);
  assert.deepEqual(plan.fixedIds, [7, 8, 5, 3]);
  assert.deepEqual(plan.orderedIds, [1, 2, 6, 4, 7, 8, 5, 3]);
  assert.deepEqual(tabs, original);
});

test('the first matching fixed rule wins and multiple matches retain displayed order', () => {
  const settings = { fixedRules: [{ label: 'Repository', pattern: 'github.com/team/repo' }, { label: 'GitHub', pattern: 'github.com' }] };
  const plan = planWindow([
    tab(1, 'Z', 'https://github.com/team/repo/issues/5'),
    tab(2, 'A', 'https://github.com/team/repo'),
    tab(3, 'B', 'https://github.com/team/other'),
  ], [], settings);
  assert.deepEqual(plan.blocks.map((block) => block.tabIds), [[1, 2], [3]]);
  assert.equal(plan.blocks.every((block) => block.kind === 'fixed'), true);
  assert.deepEqual(planWindow([], [], settings).orderedIds, []);
});

test('repository groups sort naturally, then repository pages, numbered issues, and numbered PRs', () => {
  const plan = planWindow([
    tab(1, 'PR 10', 'https://github.com/team/repo2/pull/10'),
    tab(2, 'Issue 10', 'https://github.com/team/repo2/issues/10'),
    tab(3, 'Issue 2', 'https://github.com/team/repo2/issues/2'),
    tab(4, 'PR 2', 'https://github.com/team/repo2/pull/2'),
    tab(5, 'Repo', 'https://github.com/team/repo2'),
    tab(6, 'Other repo', 'https://github.com/team/repo10/issues/1'),
    tab(7, 'Alpha', 'https://example.com'),
    tab(8, 'Files', 'https://github.com/team/repo2/tree/main'),
  ]);
  assert.deepEqual(plan.orderedIds, [7, 8, 5, 3, 2, 4, 1, 6]);
  assert.deepEqual(plan.blocks.map((block) => block.label), ['Alpha', 'team/repo2', 'team/repo10']);
});

test('mixed user groups remain units while pure GitHub groups regroup and fixed sites leave ordinary groups', () => {
  const groups = [{ id: 5, title: 'Research' }, { id: 6, title: 'Old repositories' }];
  const plan = planWindow([
    tab(1, 'Docs', 'https://example.com', { groupId: 5 }),
    tab(2, 'Issue', 'https://github.com/team/repo/issues/1', { groupId: 5 }),
    tab(3, 'Gmail', 'https://mail.google.com', { groupId: 5 }),
    tab(4, 'Second repo', 'https://github.com/team/second/pull/1', { groupId: 6 }),
    tab(5, 'First repo', 'https://github.com/team/first/issues/1', { groupId: 6 }),
  ], groups);
  assert.deepEqual(plan.blocks[0], { key: 'group:5', label: 'Research', tabIds: [1, 2], kind: 'existing-group', groupId: 5 });
  assert.deepEqual(plan.orderedIds, [1, 2, 5, 4, 3]);
  assert.deepEqual(plan.blocks.map((block) => block.kind), ['existing-group', 'github', 'github', 'fixed']);
});

test('shared groups are preserved even when their members match fixed rules or repositories', () => {
  const plan = planWindow([
    tab(1, 'Shared repo', 'https://github.com/team/repo/issues/1', { groupId: 9 }),
    tab(2, 'Shared Gmail', 'https://mail.google.com', { groupId: 9 }),
    tab(3, 'Other', 'https://example.com'),
  ], [{ id: 9, title: 'Shared work', shared: true }]);
  assert.deepEqual(plan.fixedIds, []);
  assert.deepEqual(plan.blocks.at(-1), { key: 'group:9', label: 'Shared work', tabIds: [1, 2], kind: 'existing-group', groupId: 9 });
});

test('turning GitHub grouping off keeps existing groups and still orders ungrouped repositories', () => {
  const plan = planWindow([
    tab(1, 'PR 10', 'https://github.com/team/repo/pull/10'),
    tab(2, 'PR 2', 'https://github.com/team/repo/pull/2'),
    tab(3, 'Issue', 'https://github.com/team/repo/issues/1'),
    tab(4, 'Z', 'https://github.com/team/other', { groupId: 8 }),
    tab(5, 'A', 'https://github.com/team/another', { groupId: 8 }),
  ], [{ id: 8, title: 'Archive' }], { groupGithub: false });
  assert.deepEqual(plan.orderedIds, [4, 5, 3, 2, 1]);
  assert.equal(plan.blocks.some((block) => block.kind === 'github'), false);
});

test('snapshot records current order and all windows with profile, timestamps, pins, and group names', () => {
  const snapshot = buildSnapshot([
    { tabs: [tab(2, 'Zebra', 'https://example.com/z', { index: 0, pinned: true }), tab(1, 'Alpha', 'https://example.com/a', { index: 1, groupId: 5, active: true })], groups: [{ id: 5, title: 'Research' }] },
    { tabs: [tab(3, 'New tab', 'chrome://newtab/')], incognito: true },
  ], { profileLabel: 'Test Work' }, new Date('2026-09-15T20:30:45.123Z'));
  assert.match(snapshot.markdown, /Chrome profile label: Test Work/);
  assert.match(snapshot.markdown, /2026-09-15T20:30:45\.123Z/);
  assert.match(snapshot.markdown, /Windows: 2\n- Tabs: 3/);
  assert.ok(snapshot.markdown.indexOf('[Zebra]') < snapshot.markdown.indexOf('[Alpha]'));
  assert.match(snapshot.markdown, /Pinned/);
  assert.match(snapshot.markdown, /Active; Group: Research/);
  assert.match(snapshot.markdown, /Window 2 \(Incognito\)/);
  assert.match(snapshot.filename, /^tabs-2026-09-15_\d{2}-\d{2}-\d{2}-123_UTC(?:plus|minus)\d{4}_Test-Work\.md$/);
});

test('snapshot escapes Markdown and HTML, blocks executable links, and names files safely', () => {
  const snapshot = buildSnapshot([{ tabs: [
    tab(1, 'Hello](javascript:evil)\n# Inject <script>x</script>', 'https://example.com/a_(b)?q=<img>'),
    tab(2, '[Bad](link)', 'javascript:alert(1)'),
    tab(3, 'Blank', ''),
    tab(4, 'Query', 'https://example.com/?a=1&copy;=2'),
  ], groups: [] }], { profileLabel: '../Test: <Work>' }, new Date('2026-09-15T20:30:45.000Z'));
  assert.equal(snapshot.markdown.includes('<script>'), false);
  assert.equal(snapshot.markdown.includes('\n# Inject'), false);
  assert.equal(snapshot.markdown.includes('](<javascript:'), false);
  assert.match(snapshot.markdown, /&lt;script&gt;/);
  assert.match(snapshot.markdown, /https:\/\/example.com\/a_\(b\)\?q=%3Cimg%3E/);
  assert.equal(/[/:<>]/.test(snapshot.filename), false);
  assert.match(snapshot.markdown, /URL unavailable/);
  assert.match(snapshot.markdown, /\?a=1&amp;copy;=2/);
  assert.match(buildSnapshot([], {}, new Date()).markdown, /Chrome profile label: Not set/);
});
