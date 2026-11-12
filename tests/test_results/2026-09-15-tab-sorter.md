# Tab Sorter sorting and Markdown export validation

Tab sorting, configurable fixed-site order, snapshot generation, and the native editor handoff passed their respective checks. Installing the extension in the intended Chrome profile and accepting its behavior on that profile's actual tabs remain the user setup step; the existing personal browser session was not reordered during development.

## Candidate and environment

- Date: 2026-09-15 UTC.
- Candidate: version 1.0.0, local working tree before the initial commit.
- Production source SHA-256: `5774cef0d1f94cf1bbef96a8b181022ba052b6554b657d0ae70f736d0ba16de6` (sorted relative paths plus file contents, separated by NUL bytes, covering `extension/`, both native Python files, and the installer launcher).
- Platform: macOS 26.6.2, arm64; Node 26.8.2; Python 3.14.7.
- Browser: Playwright 1.63.0 with Chromium / Chrome for Testing 153.0.8010.12 in disposable profiles.
- Storage classification: shareable summary; browser fixtures contain synthetic titles and URLs.

## Results

| Boundary | Evidence | Outcome |
| --- | --- | --- |
| Sorting and export logic | `npm test`: 11 core tests, 10 worker tests, 12 native-helper tests | 33 passed |
| Actual browser behavior | `tests/browser-smoke.mjs`, three consecutive completed runs | Pinned order, fixed order, numeric repository grouping, mixed groups, active-tab preservation, unchanged repeat sort, rule edits, automatic sorting, two-window snapshots, and saved preferences passed |
| Native helper protocol and storage | Framed subprocess tests, exclusive file creation, collision handling, fixed editor choices, origin checks, failure paths, and isolated install/uninstall | Passed; failed editor launch retains saved file path |
| Installed editor | A clearly labeled synthetic Markdown snapshot sent through the installed helper and visibly opened in NotepadAurora 0.12.1 | Passed; existing editor tabs remained present |
| Packaging and syntax | JavaScript syntax checks, native tests, private-note exclusion, and archive content checks | Passed |

The worker regression checks include tab closure, pin-order change, group membership/share changes, split-view entry, concurrent requests, and navigation during an active sort. Relevant guard-removal negative controls failed as intended. The browser test waits for completed automatic sorting before inspecting the final tab order; intermediate group membership is not its completion signal. Three browser runs are a bounded acceptance sample, not a long-term reliability claim.

## Remaining acceptance

Load the `extension/` folder into the intended Chrome profile, set its label, and exercise Sort plus Save & open in editor. The installed helper's contents and exact extension-origin registration were checked independently; an actual personal-profile extension-to-helper call remains unexercised until the extension is loaded there.

The headless browser checked snapshot content and the missing-helper recovery message. Native save/open was exercised separately against the installed editor; the interactive Chrome Save dialog still depends on the user's chosen location and confirmation.

## Repeat the checks

Run `npm test`. With Playwright and matching Chromium installed, run `node tests/browser-smoke.mjs`; set `PLAYWRIGHT_MODULE` to its module entrypoint if using an external installation. The browser test uses its own temporary profile and synthetic pages. The native tests isolate filesystem and registration changes. Actual editor display is a separate visible check.

This summary contains no real browsing history, private account labels, protected diagnostics, or credentials.
