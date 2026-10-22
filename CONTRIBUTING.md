# Contributing

H2S is a small browser-side housing assistant. Useful contributions include fixes for changed listing markup, clearer setup instructions, and reproducible regression cases.

## Local setup

Use Node.js 20.19 or newer. CI runs Node.js 22 and 24.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

No real Telegram token, H2S login, or live website access is needed for these commands. `linkedom` is a development dependency; the installed userscript does not load it. `"private": true` in package.json prevents accidental npm publishing and is unrelated to GitHub repository visibility.

## Changes and tests

- Keep the userscript self-contained and retain its name, namespace, and existing storage keys so upgrades preserve user settings and history.
- Cover changed parsing, configuration, notification, or recovery behavior with a small offline regression case. Prefer synthetic DOM fixtures containing only the relevant structure.
- Check a failed/partial scan never becomes a false “no listings” result and never clears notification history.
- Preserve website retry delays, challenge pauses, local locks, and the separation of local scan timing from network cooldowns.
- Describe the problem, resulting behavior, and what you actually tested in an English pull request. Distinguish offline tests from any manual live checks.

Do not contribute automatic booking/application/payment flows, verification bypasses, evasion of access restrictions, or direct H2S API harvesting. Do not run CI against the real website or send real Telegram messages from tests.

## Bug reports

Include the userscript version, browser/Tampermonkey versions, relevant non-sensitive settings, expected behavior, and the panel's error text. A minimal synthetic reproduction is preferable to a full page export. Remove tokens, chat IDs, cookies, account information, and private history before sharing anything.

The original Python Chromium runner and archived results document earlier work. They are not the current CI gate and may contain assumptions from the older release; do not treat its archived 35-pass report as current validation.

## Before making a repository public

Review all refs and repository surfaces, not only the latest working tree: prior commits, branches/tags, PR diffs/comments, issues, Actions logs/artifacts, and releases may retain old data. Rotate any exposed credential at its provider. Confirm redistribution rights for any third-party material. Adding an ignore rule or deleting a file in a new commit does not remove historical copies.

## Release workflow

The Tests workflow publishes **v1.4.0** only after both Node.js test jobs pass. A push to `refactor/make-public` with the literal **`[release]`** marker in its head commit message is an intentional publish instruction. A maintainer can alternatively run the workflow manually with `publish_release=true` on `main` or the preparation branch. Ordinary pushes and pull requests only run tests.

The publisher attaches the userscript, example configuration, and release notes. Only that job has `contents: write`; test jobs remain read-only. It never moves an existing tag, merges a PR, or changes repository visibility. Existing release/asset mismatches fail instead of silently replacing a published artifact. The publisher is fixed to v1.4.0, so review and update it deliberately for a later version.
