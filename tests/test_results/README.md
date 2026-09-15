# Validation results

Keep concise, dated results here when they establish sorting, export, or installation behavior. Link reproducible checks and state any remaining browser or editor acceptance separately.

Use `YYYY-MM-DD-<scope>.md` with the UTC date, source revision or content digest, platform, commands, outcome, and remaining action. Use only the sections needed to understand the result. Tests against synthetic pages may be shared; real browsing history, local identities, and restricted diagnostics belong in the ignored `protected/` folder.

Current validation is recorded in [2026-09-15-tab-sorter.md](2026-09-15-tab-sorter.md). Run unit and protocol tests with `npm test`; the optional actual-browser run is `node tests/browser-smoke.mjs` with Playwright and Chromium available.
