const $ = id => document.getElementById(id);
const source = new URLSearchParams(location.search);
const parseId = key => /^\d+$/.test(source.get(key) || '') ? Number(source.get(key)) : undefined;
let review;
let busy = false;

function errorMessage(message = '') {
  $('review-error').textContent = message;
  $('review-error').hidden = !message;
}

function candidateInputs() {
  return [...document.querySelectorAll('input[data-tab-id]')];
}

function updateSelection() {
  const inputs = candidateInputs();
  const selected = inputs.filter(input => input.checked).length;
  $('select-all').checked = inputs.length > 0 && selected === inputs.length;
  $('select-all').indeterminate = selected > 0 && selected < inputs.length;
  $('select-all').disabled = busy || !review || inputs.length === 0;
  $('close-selected').disabled = busy || !review || selected === 0;
  $('close-selected').textContent = selected ? `Close ${selected} selected ${selected === 1 ? 'tab' : 'tabs'}` : 'Close selected tabs';
  $('selection-count').textContent = `${selected} ${selected === 1 ? 'tab' : 'tabs'} selected`;
  for (const input of inputs) input.disabled = busy || !review;
  $('rescan').disabled = busy;
}

function tabRow(tab, selectable) {
  const row = document.createElement(selectable ? 'label' : 'div');
  row.className = `duplicate-row${selectable ? ' selectable' : ''}`;
  if (selectable) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.tabId = String(tab.id);
    checkbox.setAttribute('aria-label', `Close extra copy: ${tab.title || tab.url} — ${tab.windowLabel}`);
    checkbox.onchange = updateSelection;
    row.append(checkbox);
  } else {
    const badge = document.createElement('span'); badge.className = 'keep-badge'; badge.textContent = 'KEEP'; row.append(badge);
  }
  const info = document.createElement('span'); info.className = 'duplicate-info';
  const title = document.createElement('span'); title.className = 'duplicate-title'; title.textContent = tab.title || tab.url;
  const meta = document.createElement('span'); meta.className = 'duplicate-meta';
  meta.textContent = [tab.windowLabel, `Tab ${tab.index + 1}`, tab.active ? 'Active' : '', selectable ? 'Extra copy' : tab.reason || 'Kept copy'].filter(Boolean).join(' · ');
  info.append(title, meta); row.append(info); return row;
}

function render(groups) {
  $('duplicate-groups').replaceChildren();
  const count = groups.reduce((sum, group) => sum + group.candidates.length, 0);
  $('scan-summary').textContent = `${count} extra ${count === 1 ? 'tab' : 'tabs'} available to close across ${groups.length} duplicate ${groups.length === 1 ? 'address' : 'addresses'}.`;
  if (!groups.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    const heading = document.createElement('h2'); heading.textContent = 'No duplicate web tabs found';
    const description = document.createElement('p'); description.textContent = 'Each scanned web address has one open copy. Scan again after your tabs finish loading.';
    empty.append(heading, description); $('duplicate-groups').append(empty);
  }
  for (const group of groups) {
    const card = document.createElement('article'); card.className = 'duplicate-card';
    const heading = document.createElement('div'); heading.className = 'duplicate-heading';
    const title = document.createElement('h3'); title.textContent = group.keeper.title || group.url;
    const url = document.createElement('p'); url.className = 'duplicate-url'; url.textContent = group.url;
    heading.append(title, url); card.append(heading, tabRow(group.keeper, false));
    for (const tab of group.protectedTabs) card.append(tabRow(tab, false));
    for (const tab of group.candidates) card.append(tabRow(tab, true));
    $('duplicate-groups').append(card);
  }
}

async function scan() {
  if (busy) return;
  busy = true; review = undefined; errorMessage(); updateSelection();
  $('close-result').hidden = true;
  $('duplicate-groups').replaceChildren();
  $('duplicate-groups').setAttribute('aria-busy', 'true');
  $('scan-summary').textContent = 'Finding duplicate tabs…';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'scan-duplicates', windowId: parseId('windowId'), tabId: parseId('tabId') });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not scan tabs. Please try again.');
    review = reply; render(reply.groups);
  } catch (error) {
    $('scan-summary').textContent = 'Scan did not complete.';
    errorMessage(error.message || String(error));
  } finally {
    busy = false; $('duplicate-groups').setAttribute('aria-busy', 'false'); updateSelection();
  }
}

$('select-all').onchange = () => {
  for (const input of candidateInputs()) input.checked = $('select-all').checked;
  updateSelection();
};
$('rescan').onclick = scan;
$('close-selected').onclick = async () => {
  if (busy || !review) return;
  const ids = candidateInputs().filter(input => input.checked).map(input => Number(input.dataset.tabId));
  if (!ids.length) return;
  const currentReview = review;
  busy = true; updateSelection(); errorMessage();
  $('close-result').hidden = false;
  $('result-summary').textContent = 'Checking and closing selected extras…';
  $('result-details').replaceChildren();
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'close-duplicates', scanId: currentReview.scanId, tabIds: ids });
    if (!reply?.ok) throw new Error(reply?.error || 'Closing did not complete. Scan again to check the current tabs.');
    const names = new Map(currentReview.groups.flatMap(group => group.candidates.map(tab => [tab.id, `${tab.title || tab.url} (${tab.windowLabel})`])));
    $('result-summary').textContent = `Closed ${reply.closed.length}. Skipped ${reply.skipped.length}. Could not close ${reply.failed.length}. Scan again for a fresh list.`;
    for (const item of [...reply.skipped, ...reply.failed]) {
      const row = document.createElement('li'); row.textContent = `${names.get(item.id) || 'Tab'}: ${item.reason}`; $('result-details').append(row);
    }
    for (const input of candidateInputs()) if (reply.closed.includes(Number(input.dataset.tabId))) input.closest('.duplicate-row').remove();
  } catch (error) {
    $('result-summary').textContent = 'Close operation did not finish. Scan again to review the current tabs.';
    errorMessage(error.message || String(error));
  } finally {
    for (const input of candidateInputs()) input.checked = false;
    review = undefined; busy = false; updateSelection();
    $('scan-summary').textContent = 'Review finished. Scan again to check the remaining tabs.';
    $('close-result').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

await scan();
