# Tab Sorter duplicate review validation

Version 1.1.0 adds a review page that selects eligible duplicate extras by default and closes only the user's chosen copies after fresh tab checks. All 51 automated checks and both isolated Chromium browser suites passed. Loading this update in an existing installed profile requires an extension reload; installed-profile acceptance remains NOT RUN for this version.

## Candidate and environment

- Recorded: 2026-11-12T16:07:28Z.
- Candidate: version 1.1.0 working tree based on `4c25a016aee7d144fba7f20e21b6c5025406be1d`.
- Production source SHA-256: `b03cfa1112ced02a8846bc3796007688496131d7eae10b96083e6e0941eda909` (sorted relative paths plus file contents, each separated by NUL bytes, covering `extension/`, both native Python files, and the installer launcher).
- Platform: macOS 27.0.1, arm64; Node 26.13.0; Python 3.13.5; Playwright 1.63.0; Chrome for Testing 153.0.8010.12.
- Browser fixtures use disposable profiles and synthetic titles and URLs. No personal browsing history is included.

## Results

| Boundary | Evidence | Result |
| --- | --- | --- |
| Logic, worker, and native helper | `npm test`: 11 core, 11 worker, 17 duplicate-review, and 12 native-helper checks | 51 passed |
| Review through actual tab closure | `node tests/duplicates-browser-smoke.mjs`, one completed run | Popup handler captures the original active web tab; exact addresses across two windows; default, individual, and select-all selection; only selected extras close; remaining order and pinned copies preserved |
| Changed session state | Same duplicate browser suite | A navigated candidate, replaced review, and missing keeper prevent closure; empty and protected-only results render correctly |
| Review usability | Same duplicate browser suite and synthetic screenshots | Titles render as text; 390px and 1080px layouts checked; opening review with automatic sorting enabled preserves existing order |
| Existing features | `node tests/browser-smoke.mjs`, one completed run | Sorting, pinned/fixed order, GitHub groups, custom groups, automatic sorting, Markdown content, multiple windows, missing-helper recovery, and saved preferences passed |
| Static checks | JavaScript syntax and `git diff --check` | Passed; extension ID and permission set unchanged |

Controller tests additionally cover expiration, worker recreation, invalid or replayed selections, shared groups, split view, newly active tabs, group/window changes, overlapping requests, and partial failures. A keeper-guard negative control failed on the intended assertion. Confirmed closure requires Chrome to report that the removed tab no longer exists; retained tabs and inconclusive failures are not counted as closed.

## Operational boundary

Duplicate matching uses complete HTTP/HTTPS addresses, including query strings and fragments. Matching URLs do not prove identical unsaved page state, and Chrome does not offer an atomic check-and-close operation. The extension rechecks each selected copy and its original keeper immediately before removal and reports skipped or failed actions separately.

The installed personal-profile update and toolbar interaction are NOT RUN for version 1.1.0. Reload Tab Sorter at `chrome://extensions`, reopen its popup, and choose **Review duplicate tabs**. Preferences persist; no uninstall, new permission, or editor-helper reinstall is required. The native editor UI was not retested because its code is unchanged.

## Repeat the checks

```sh
npm test
node tests/browser-smoke.mjs
node tests/duplicates-browser-smoke.mjs
```

The browser suites require Playwright and its matching Chromium browser. Set `PLAYWRIGHT_MODULE` to the module entrypoint when using an external installation. These runs establish the exercised behavior, not a long-term reliability trend.
