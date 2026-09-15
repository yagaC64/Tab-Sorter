import { normalizeSettings } from './core.js';

const $ = id => document.getElementById(id);
let windowId;
let busy = false;

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function addRule(rule = { label: '', pattern: '' }) {
  const row = document.createElement('div');
  row.className = 'rule';
  for (const field of ['label', 'pattern']) {
    const input = document.createElement('input');
    input.className = field;
    input.value = rule[field];
    input.placeholder = field === 'label' ? 'Site name' : 'example.com/path';
    input.setAttribute('aria-label', field === 'label' ? 'Fixed site name' : 'Fixed site hostname and optional path');
    input.maxLength = field === 'label' ? 60 : 200;
    row.append(input);
  }
  const remove = document.createElement('button');
  remove.type = 'button'; remove.className = 'secondary small'; remove.textContent = '×';
  remove.setAttribute('aria-label', 'Remove this fixed site'); remove.onclick = () => row.remove();
  row.append(remove);
  const controls = document.createElement('div'); controls.className = 'rule-controls';
  for (const [text, direction] of [['← Earlier', -1], ['Later →', 1]]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'small secondary'; button.textContent = text;
    button.onclick = () => { if (direction < 0 && row.previousElementSibling) row.previousElementSibling.before(row); else if (direction > 0 && row.nextElementSibling) row.nextElementSibling.after(row); };
    controls.append(button);
  }
  row.append(controls); $('rules').append(row);
}

function readSettings() {
  return normalizeSettings({
    profileLabel: $('profile').value,
    groupGithub: $('group-github').checked,
    autoSort: $('auto-sort').checked,
    fixedRules: [...$('rules').children].map(row => ({ label: row.querySelector('.label').value, pattern: row.querySelector('.pattern').value }))
  });
}

async function saveSettings() {
  const config = readSettings();
  await chrome.storage.local.set({ settings: config, editor: $('editor').value, scope: $('scope').value });
  $('profile-summary').textContent = config.profileLabel || 'Set your profile label';
  return config;
}

async function run(action) {
  if (busy) return;
  busy = true;
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  $('saved-path').textContent = '';
  try {
    await saveSettings();
    status(action === 'sort' ? 'Sorting this window…' : 'Preparing your snapshot…');
    const reply = await chrome.runtime.sendMessage({ type: action === 'download' ? 'snapshot' : action, scope: $('scope').value, windowId, editor: $('editor').value });
    if (reply?.path) $('saved-path').textContent = `Saved: ${reply.path}`;
    if (!reply?.ok) throw new Error(reply?.error || 'The action did not complete. Please try again.');
    if (action === 'sort') {
      status(`Sorted ${reply.count} tabs. ${reply.repositories} repository groups; ${reply.fixed} fixed tabs.`);
    } else if (action === 'download') {
      await chrome.downloads.download({ url: `data:text/markdown;charset=utf-8,${encodeURIComponent(reply.markdown)}`, filename: reply.filename, saveAs: true, conflictAction: 'uniquify' });
      status('Save dialog opened. Chrome Downloads will show when the file is saved.');
    } else {
      status(reply.opened ? 'Snapshot saved and sent to your editor.' : 'Snapshot saved.');
    }
  } catch (error) {
    status(error.message || String(error), true);
  } finally {
    busy = false;
    for (const button of document.querySelectorAll('button')) button.disabled = false;
  }
}

$('sort').onclick = () => run('sort');
$('download').onclick = () => run('download');
$('export-editor').onclick = () => run('export-editor');
$('add-rule').onclick = () => addRule();
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  try { await saveSettings(); status('Preferences saved for this Chrome profile.'); }
  catch (error) { status(error.message, true); }
};

try {
  const [current, stored] = await Promise.all([chrome.windows.getCurrent(), chrome.storage.local.get(['settings', 'editor', 'scope'])]);
  windowId = current.id;
  const config = normalizeSettings(stored.settings || {});
  $('profile').value = config.profileLabel;
  $('profile-summary').textContent = config.profileLabel || 'Set your profile label';
  $('group-github').checked = config.groupGithub;
  $('auto-sort').checked = config.autoSort;
  $('editor').value = stored.editor || 'notepad-aurora';
  $('scope').value = stored.scope || 'all';
  config.fixedRules.forEach(addRule);
  if (!config.profileLabel) $('preferences').open = true;
  const prior = (await chrome.storage.session.get(`status-${windowId}`))[`status-${windowId}`];
  if (prior) status(prior.text, prior.error);
} catch (error) {
  status(error.message, true);
}
