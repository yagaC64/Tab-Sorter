# Tab Sorter

Tab Sorter is an open-source Chrome extension that alphabetizes open tabs, groups GitHub work by repository, keeps chosen sites at the right edge, reviews duplicate tabs for selective closing, and saves dated Markdown snapshots.

## Install in Chrome

Requires Chrome 120 or newer. The extension needs no build step or runtime package installation.

1. Keep this project folder in a permanent location.
2. In the Chrome profile you want to organize, enter `chrome://extensions` in the address bar and enable **Developer mode**.
3. Choose **Load unpacked**, then select this project's **extension** folder.
4. Open Chrome's Extensions menu and pin **Tab Sorter** to the toolbar.
5. Open Tab Sorter, expand **Preferences**, enter a **Chrome profile label** such as `Work` or `Personal`, and save preferences.

Repeat installation and labeling in each Chrome profile you use. Preferences stay local to that profile. Chrome's [identity API](https://developer.chrome.com/docs/extensions/reference/api/identity) exposes account information rather than the profile's friendly name; Tab Sorter uses your label and does not request account access.

### Update an existing installation

1. Replace or update the extension files in the same permanent project folder used for installation.
2. In each Chrome profile with Tab Sorter installed, open `chrome://extensions` and click **Reload** on Tab Sorter.
3. Reopen Tab Sorter to use the updated version. Existing preferences remain saved; do not uninstall and reinstall.

Unpacked extensions do not receive automatically distributed updates. [Reload the extension](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#reload) so Chrome loads its updated manifest and service worker. Rerun **Install Editor Helper.command** only when native-helper files change; the duplicate-review update does not require a helper reinstall or new permissions.

## Organize your tabs

Choose **Sort this window** to arrange the current window:

- Chrome-pinned tabs retain their existing order on the left. Chrome keeps native pins in that area; to place a currently pinned site on the right, unpin it in Chrome first.
- Ordinary tabs sort alphabetically by title. GitHub repository groups sort by `owner/repository` alongside those tabs.
- Inside each repository group, repository pages come first, followed by issues and then pull requests. Item numbers sort numerically: `#2`, `#12`, `#100`.
- Fixed sites appear last, initially **Gmail → Calendar → Drive → Slack**. Matching tabs keep their relative order within each fixed-site rule. Missing sites are not opened, and duplicate tabs remain open.
- Existing mixed/custom groups move as units, keeping their remaining members in order. Fixed-site rules take precedence in non-shared groups, so a matching tab can move out of its old group to the right edge.
- Shared groups move as whole groups while retaining their members and internal order; their tabs are exempt from fixed-site rules. Existing groups containing only GitHub tabs can be reorganized into repository groups.

In **Preferences**, add, edit, remove, or reorder fixed sites using **Earlier** and **Later**. Patterns accept a hostname and optional path prefix, such as `mail.google.com`, `github.com/team/repository`, or `*.slack.com`. The first matching rule wins.

Sorting is manual by default. Enable **Re-sort after tabs open or navigate** for automatic sorting. Turn off **Create GitHub repository groups** to retain existing groups and sort ungrouped GitHub tabs without creating repository groups.

Exit Chrome split view before sorting. If tabs change during a sort, the extension reports the interruption; some tabs may already have moved. Let the window settle and choose **Sort this window** again. Rearrangement uses Chrome's [Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs) and [Tab Groups API](https://developer.chrome.com/docs/extensions/reference/api/tabGroups).

## Review duplicate tabs

In the popup, choose **Review duplicate tabs** to open a full review page. It scans normal windows in the current Chrome profile, excluding incognito windows, loading tabs, and non-web pages. Only exact HTTP/HTTPS addresses match: query strings and fragments after `#` remain significant.

- Each duplicate address shows a kept copy and any available extras. Pinned tabs, shared-group members, and split-view tabs are always kept. When no protected copy exists, Tab Sorter prefers the originally active tab, then another active copy, then the first copy.
- Available extras are checked by default. Uncheck individual tabs to keep them, or use **Select all available** to toggle the whole selection. Only the explicit **Close selected tabs** action closes tabs; scanning and sorting never close duplicates.
- Each selected tab and its original kept copy are checked again immediately before closing. Tabs that navigate, move, change groups, become protected, or become active after the scan are skipped. If the kept copy changes or disappears, its extras are skipped. Results distinguish confirmed closures, skipped tabs, and failures.

Matching addresses do not establish identical unsaved page state; review your work before closing. Chrome changes cannot be checked and closed atomically, so let the tabs settle while the action runs. Only the latest review in the profile is valid, and it expires after 15 minutes. After any close action, choose **Scan again** for a fresh review before closing more tabs.

## Save a Markdown snapshot

Choose **All windows in this Chrome profile** or **This window only**, then choose an export action. The all-windows option includes normal browser windows in the current profile; incognito windows are excluded. Export preserves the current tab order and does not require sorting first.

Each `.md` file includes tab titles and links, window sections, pin/group details, a date and time with timezone, and your profile label. The suggested filename includes the date, time, timezone offset, and label. Snapshots are local files containing your tab titles and URLs; share them intentionally.

**Save Markdown…** works on any operating system supported by Chrome. It opens Chrome's Save dialog with a ready-made filename; choose where to store the file and open it in your preferred viewer. Chrome Downloads reports when saving has completed. This uses the [Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads).

### Optional: open directly in a macOS editor

The optional helper requires macOS and Python 3. It saves snapshots in `~/Documents/Tab Sorter Snapshots` and sends them to your selected editor.

1. Double-click **Install Editor Helper.command** in the project folder. It derives the extension ID automatically and installs the local helper.
2. Reload Tab Sorter at `chrome://extensions`.
3. In Tab Sorter, choose **Notepad Aurora** or **System Markdown viewer**, then **Save & open in editor**.

The NotepadAurora option opens `/Applications/NotepadAurora.app`. If your editor is installed elsewhere, use **System Markdown viewer** with your preferred `.md` file association. The helper uses fixed application choices and does not accept custom commands.

Existing snapshots are never overwritten; repeated filenames receive a numeric suffix. If the editor cannot launch, the saved file remains and its path appears in Tab Sorter. “Sent to your editor” means macOS accepted the open request; it does not verify that the editor displayed the document.

The helper uses Chrome's [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) mechanism. It installs code in `~/Library/Application Support/Tab Sorter` and registers only this extension's ID under Chrome's user-level `NativeMessagingHosts` directory. If the helper is unavailable, **Save Markdown…** remains available.

## Permissions

| Permission | Purpose |
| --- | --- |
| `tabs` | Read tab titles and URLs for sorting, duplicate review, and snapshots. |
| `tabGroups` | Read, create, name, and move repository groups. |
| `storage` | Save per-profile preferences and operation status locally; keep the latest duplicate review in session storage. |
| `downloads` | Save generated Markdown through Chrome's Save dialog. |
| `nativeMessaging` | Contact the optional local editor helper when requested. |

Tab Sorter injects no page scripts and makes no network requests. It has no analytics, Google account access, or access to page contents.

## Development

Run the JavaScript and native-helper tests with Node.js and Python 3:

```sh
npm test
```

The optional browser smoke tests use Playwright with its Chromium browser installed. They create disposable browser profiles and synthetic tabs:

```sh
node tests/browser-smoke.mjs
node tests/duplicates-browser-smoke.mjs
```

If Playwright is installed outside this project, point to its module entrypoint:

```sh
PLAYWRIGHT_MODULE="<absolute-path-to-playwright>/index.mjs" node tests/browser-smoke.mjs
PLAYWRIGHT_MODULE="<absolute-path-to-playwright>/index.mjs" node tests/duplicates-browser-smoke.mjs
```

Tests using a mocked editor launch establish the save/message contract; actual editor display requires separate GUI verification. After editing extension files, reload the extension at `chrome://extensions`. After changing native-helper files, rerun the helper installer.

## Remove

Remove Tab Sorter at `chrome://extensions`. To remove the optional editor helper, run this command from the project folder:

```sh
python3 native/install.py --uninstall
```

Uninstalling the helper leaves saved Markdown snapshots in place.

## License

[MIT](LICENSE) © 2026 WD Martinez.
