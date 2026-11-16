# Tab picker order and selective closure validation

Version 1.2.0 adds a full-page picker for crowded tab strips, with expandable windows and top-to-bottom rows matching Chrome's left-to-right tab order. All 71 automated checks and all three isolated Chromium suites passed. Installed-profile acceptance is NOT RUN for this candidate; existing unpacked installations require Reload to load the update.

## Candidate and environment

- Recorded: 2026-11-16T13:04:08Z.

- Candidate: version 1.2.0 working tree based on `9234b22ff3b502a26597629240b2297094e875cb`.
- Production source SHA-256: `3f9f12846e143f240e6a1f8f5da9681a61de8f322cbcabaebde2992ce86f8cd4` (sorted relative paths plus file contents, each separated by NUL bytes, covering `extension/`, both native Python files, and the installer launcher).
- Platform: macOS 27.0.1, arm64; Node 26.13.1; Python 3.15.2; Playwright 1.63.0; Chrome for Testing 153.0.8010.12.
- All browser fixtures and screenshots use synthetic tabs in disposable profiles. No personal browsing history is included.

## Results

| Boundary | Evidence | Result |
| --- | --- | --- |
| Logic, worker, and native helper | `npm test`: 11 core, 14 worker, 17 duplicate-review, 17 tab-manager, and 12 native-helper checks | 71 passed |
| Crowded tab picker | `node tests/tabs-browser-smoke.mjs` with 38 tabs across two windows | Current window first; exact index order; unchecked defaults; filter, collapse, and select-shown semantics; far-right selection; focus without reordering; escaped titles; 390px and 1080px layouts passed |
| Actual Chrome closure | Same picker browser suite | Exactly five chosen tabs closed, including all three in the second window; surviving tab order preserved; changed navigation skipped; pinned tab closed only after opt-in and selection |
| Close-operation lifecycle | Worker and controller regressions | Duplicate and picker closures cannot overlap; replaced/expired/replayed reviews reject; active-tab neighbor promotion does not skip a valid selection; external activation and changed tab identity remain protected |
| Existing behavior | `node tests/duplicates-browser-smoke.mjs` and `node tests/browser-smoke.mjs` | Duplicate closure, sorting, pinned/fixed order, repository/custom groups, automatic sorting, snapshots, and persisted preferences passed |
| Static checks | JavaScript syntax, manifest/package consistency, and `git diff --check` | Passed; extension identity and permission set unchanged |

The active-neighbor regression failed before the manager began removing originally inactive selections first. Negative controls for pinned protection and the shared close lock also failed on their intended assertions. Each real-browser suite completed against the relevant final implementation; these are bounded acceptance runs, not a long-term stability claim.

## Visual workflow

The picker preserves numbered strip order while exposing tabs beyond the visible strip. These screenshots show the initial layout, a selected far-right tab, and confirmed closure results:

- [Picker and expandable window list](assets/2026-11-16-tab-picker.png)
- [Far-right tab selection](assets/2026-11-16-tab-picker-rightmost.png)
- [Five closures confirmed](assets/2026-11-16-tab-picker-results.png)

## Operational boundary

The picker lists all normal windows in the current profile and protects shared groups, split view, loading/unknown-address tabs, and its own pages. Pinned tabs require explicit opt-in. Closing revalidates URL, window, group, pin/protection, and activity state. Chrome does not provide atomic check-and-close semantics, and matching addresses do not establish unchanged unsaved page state.

Native editor files are unchanged. No helper reinstall or additional permission is required. A personal-profile reload and interaction with the new picker remain separate acceptance from the isolated browser runs.
