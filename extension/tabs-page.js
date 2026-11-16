const $ = id => document.getElementById(id);
const sourceWindow = new URLSearchParams(location.search).get('windowId');
const windowId = /^\d+$/.test(sourceWindow || '') ? Number(sourceWindow) : undefined;
let review;
let busy = false;

const choices = () => [...document.querySelectorAll('input[data-tab-id]')];
const shownChoices = () => choices().filter(input => !input.closest('.tab-row').hidden && !input.closest('.tab-window').hidden && input.closest('.tab-window').open);

function showError(message = '') {
  $('review-error').textContent = message;
  $('review-error').hidden = !message;
}

function updateSelection() {
  const inputs = choices();
  const shown = shownChoices();
  const selected = inputs.filter(input => input.checked).length;
  const shownSelected = shown.filter(input => input.checked).length;
  $('select-shown').checked = shown.length > 0 && shownSelected === shown.length;
  $('select-shown').indeterminate = shownSelected > 0 && shownSelected < shown.length;
  $('select-shown').disabled = busy || !review || shown.length === 0;
  $('close-selected').disabled = busy || !review || selected === 0;
  $('close-selected').textContent = selected ? `Close ${selected} selected ${selected === 1 ? 'tab' : 'tabs'}` : 'Close selected tabs';
  $('selection-count').textContent = `${selected} ${selected === 1 ? 'tab' : 'tabs'} selected`;
  $('clear-selection').disabled = busy || selected === 0;
  $('refresh-tabs').disabled = busy;
  $('allow-pinned').disabled = busy;
  $('tab-search').disabled = busy || !review;
  for (const input of inputs) input.disabled = busy || !review;
  for (const button of document.querySelectorAll('.show-tab')) button.disabled = busy;
}

function clearSelection() {
  for (const input of choices()) input.checked = false;
  updateSelection();
}

function applyFilter() {
  clearSelection();
  const query = $('tab-search').value.trim().toLocaleLowerCase();
  let count = 0;
  for (const section of document.querySelectorAll('.tab-window')) {
    let matches = 0;
    for (const row of section.querySelectorAll('.tab-row')) {
      row.hidden = !row.dataset.search.includes(query);
      if (!row.hidden) matches++;
    }
    section.hidden = matches === 0;
    if (query && matches) section.open = true;
    section.querySelector('.window-count').textContent = `${matches} ${matches === 1 ? 'tab' : 'tabs'}`;
    count += matches;
  }
  $('scan-summary').textContent = query ? `${count} matching ${count === 1 ? 'tab' : 'tabs'}. Original tab-strip order is preserved.` : `${count} open ${count === 1 ? 'tab' : 'tabs'}. Top to bottom = left to right within each window.`;
  $('no-tabs').hidden = count > 0;
  $('no-tabs').textContent = query ? 'No tabs match this filter.' : 'No tabs to display. Refresh the list after opening a tab.';
  updateSelection();
}

function tabRow(tab) {
  const row = document.createElement('div'); row.className = 'tab-row';
  row.dataset.tabId = String(tab.id);
  row.dataset.search = `${tab.title || ''} ${tab.url || ''}`.toLocaleLowerCase();
  const index = document.createElement('span'); index.className = 'tab-index'; index.textContent = String(tab.index + 1);
  const label = document.createElement('label'); label.className = 'tab-choice';
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = false;
  checkbox.setAttribute('aria-label', `Select tab to close: ${tab.title || tab.url || 'Untitled tab'} — ${tab.windowLabel}`);
  if (tab.selectable) checkbox.dataset.tabId = String(tab.id);
  else checkbox.disabled = true;
  checkbox.onchange = updateSelection;
  const info = document.createElement('span'); info.className = 'tab-info';
  const title = document.createElement('span'); title.className = 'tab-title'; title.textContent = tab.title || tab.url || 'Untitled tab';
  const url = document.createElement('span'); url.className = 'tab-url'; url.textContent = tab.url || 'Address unavailable';
  const meta = document.createElement('span'); meta.className = 'tab-meta';
  meta.textContent = [tab.pinned ? 'Pinned' : '', tab.active ? 'Active' : '', tab.groupTitle ? `Group: ${tab.groupTitle}` : '', tab.reason].filter(Boolean).join(' · ');
  info.append(title, url, meta); label.append(checkbox, info);
  const show = document.createElement('button'); show.type = 'button'; show.className = 'show-tab secondary'; show.textContent = 'Show tab';
  show.setAttribute('aria-label', `Show tab: ${tab.title || tab.url || 'Untitled tab'} — ${tab.windowLabel}`);
  show.onclick = async () => {
    showError();
    try {
      const current = await chrome.tabs.get(tab.id);
      if (current.windowId !== tab.windowId || (current.url || current.pendingUrl || '') !== tab.url) throw new Error('This tab changed or moved. Refresh the list to locate it.');
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { showError('Could not show this tab. It may have changed, moved, or closed. Refresh the list.'); }
  };
  row.append(index, label, show); return row;
}

function render(windows) {
  $('tab-windows').replaceChildren();
  for (const win of windows) {
    const section = document.createElement('details'); section.className = 'tab-window'; section.dataset.windowId = String(win.id); section.open = win.current;
    const summary = document.createElement('summary');
    const name = document.createElement('span'); name.className = 'window-name'; name.textContent = `${win.label}${win.current ? ' · Current window' : ''}`;
    const count = document.createElement('span'); count.className = 'window-count';
    summary.append(name, count); section.append(summary);
    for (const tab of win.tabs) section.append(tabRow(tab));
    section.ontoggle = () => {
      if (!section.open) for (const input of section.querySelectorAll('input[data-tab-id]')) input.checked = false;
      updateSelection();
    };
    $('tab-windows').append(section);
  }
  const empty = document.createElement('p'); empty.id = 'no-tabs'; empty.className = 'empty-state'; empty.hidden = true; $('tab-windows').append(empty);
  applyFilter();
}

async function scan() {
  if (busy) return;
  busy = true; review = undefined; showError(); updateSelection();
  $('tab-windows').replaceChildren(); $('tab-windows').setAttribute('aria-busy', 'true');
  $('close-result').hidden = true; $('scan-summary').textContent = 'Reading open tabs…';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'scan-managed-tabs', windowId, allowPinned: $('allow-pinned').checked });
    if (!reply?.ok) throw new Error(reply?.error || 'Could not read the open tabs. Try refreshing the list.');
    review = reply; render(reply.windows);
  } catch (error) {
    $('scan-summary').textContent = 'The tab list could not be loaded.'; showError(error.message || String(error));
  } finally {
    busy = false; $('tab-windows').setAttribute('aria-busy', 'false'); updateSelection();
  }
}

$('tab-search').oninput = applyFilter;
$('allow-pinned').onchange = scan;
$('refresh-tabs').onclick = scan;
$('clear-selection').onclick = clearSelection;
$('select-shown').onchange = () => {
  for (const input of shownChoices()) input.checked = $('select-shown').checked;
  updateSelection();
};
$('close-selected').onclick = async () => {
  if (busy || !review) return;
  // Native details toggle events can arrive later than a click; use visible rows at the action boundary too.
  const ids = shownChoices().filter(input => input.checked).map(input => Number(input.dataset.tabId));
  if (!ids.length) return;
  const currentReview = review;
  busy = true; updateSelection(); showError();
  $('close-result').hidden = false; $('result-summary').textContent = 'Checking and closing selected tabs…'; $('result-details').replaceChildren();
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'close-managed-tabs', scanId: currentReview.scanId, tabIds: ids });
    if (!reply?.ok) throw new Error(reply?.error || 'Closing did not finish. Refresh the list to check your tabs.');
    $('result-summary').textContent = `Closed ${reply.closed.length}. Skipped ${reply.skipped.length}. Could not close ${reply.failed.length}. Refresh the list before choosing more tabs.`;
    const names = new Map(currentReview.windows.flatMap(win => win.tabs.map(tab => [tab.id, `${tab.title || tab.url} (${tab.windowLabel})`])));
    for (const item of [...reply.skipped, ...reply.failed]) {
      const row = document.createElement('li'); row.textContent = `${names.get(item.id) || 'Tab'}: ${item.reason}`; $('result-details').append(row);
    }
    for (const row of document.querySelectorAll('.tab-row')) if (reply.closed.includes(Number(row.dataset.tabId))) row.remove();
    for (const section of document.querySelectorAll('.tab-window')) {
      const remaining = [...section.querySelectorAll('.tab-row')].filter(row => !row.hidden).length;
      if (!section.querySelector('.tab-row')) section.remove();
      else section.querySelector('.window-count').textContent = `${remaining} listed`;
    }
  } catch (error) {
    $('result-summary').textContent = 'Close operation did not finish. Refresh the list to check your tabs.'; showError(error.message || String(error));
  } finally {
    review = undefined; busy = false; clearSelection();
    $('scan-summary').textContent = 'Selection finished. Refresh the list to see the current tab order.';
    $('close-result').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
};

await scan();
