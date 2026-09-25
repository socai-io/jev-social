# AGENTS.md

This repository contains Jev Social, a local Node.js application that lets Jev
choose bounded social-research operations and delegates browser execution to the
installed `socai CLI`. It supports read-only Instagram, TikTok, and LinkedIn
research, streams captured evidence to a loopback UI, and produces a
source-linked report.

These instructions apply to the entire repository.

## Setup

Use Node.js 20, matching `.nvmrc`, `package.json`, and CI.

```bash
nvm use
npm ci
```

Offline development and tests do not need credentials. A live run additionally
needs either an OpenRouter key that can access Jev or an explicit loopback
TypeSafe-compatible decision endpoint, a compatible `socai CLI`, and a browser
session that can access the selected platform.

Never commit `.env`, API keys, browser data, downloaded media, run artifacts,
or personal social-media data.

## Commands

```bash
npm run check                         # syntax-check the shipped JavaScript
npm test                              # run the complete offline test suite
npm run dev                           # local server with Node watch mode
npm start -- status                   # inspect local readiness
npm start -- serve --no-open          # serve the UI at 127.0.0.1:8766
npm start -- search "goal" --limit 4  # live research; requires local setup
```

Run both `npm run check` and `npm test` before submitting a change. The CI
workflow uses the same commands after `npm ci`.

## Architecture

- `bin/jev-social.js` is the CLI entry point for `serve`, `status`, `onboard`,
  and `search`.
- `src/app.js` owns the Jev decision loop, checkpoints, event stream, and final
  run shape.
- `src/decision-provider.js` selects OpenRouter or an explicit loopback System
  One endpoint, bounds the network response, and prevents credential forwarding.
- `src/classifier.js` builds platform choices and validates typed decision
  responses independently of the selected provider.
- `src/actions.js` builds the current finite action space from the goal,
  installed CLI capabilities, observed targets, and action history.
- `src/socai.js` probes the installed CLI, maps selected actions to arguments,
  runs the process, and normalizes progress and errors.
- `src/evidence.js` extracts, deduplicates, sanitizes, and reports captured
  evidence. Treat CLI and platform output as untrusted input.
- `src/runs.js` persists recoverable checkpoints below the isolated Jev Social
  state directory.
- `src/server.js` exposes the loopback HTTP/SSE surface and verified media
  previews. Do not broaden its network binding without explicit design review.
- `public/` is the local interactive UI. `site/` is the separate static project
  landing page deployed by GitHub Pages.
- `skills/jev-social/` is the distributable Agent Skill. Its runtime pin and
  safety boundary must stay aligned with the documented release.
- `test/` mirrors observable server, CLI, decision, evidence, and UI behavior.

## Non-negotiable boundaries

- Keep the product read-only. Do not add posting, liking, following, messaging,
  or other account-changing operations.
- Jev may select only from concrete choices built by the application. Never let
  a model generate shell commands, selectors, coordinates, arbitrary URLs, or
  executable browser instructions.
- Browser work stays inside `socai CLI`. Detect installed capabilities before a
  model call and fail visibly when a requested platform or operation is absent.
- Accept action targets only from captured results or explicit user URLs, and
  retain the platform-specific HTTPS allowlist checks.
- Download TikTok media only when the user's goal explicitly requests media
  download. Reading a video, caption, comments, or metadata is not consent to
  download the file.
- Preserve recoverable partial results for interruption, login/challenge gates,
  decision failure, CLI failure, and step limits. Never substitute mock success.
- Keep credentials, environment values, executable paths, run directories,
  local artifact paths, raw command arrays, and raw run JSON out of user-facing
  output.
- Treat search cards and opened detail records differently. Do not imply that a
  post or comment thread was read when only a search result was captured.
- Keep all product UI, documentation, issue, and pull-request text in English.

## Output contracts

The CLI sends human-readable progress to stderr and the final run object to
stdout. Preserve the meaning of these fields when changing the run loop:

- `status` and `stopReason` describe completion or the exact partial outcome;
- `result.items` contains sanitized evidence with validated source URLs;
- `actions` records what Jev selected and what was actually executed;
- `report` and `finalSocaiOutput` contain the readable evidence synthesis;
- `elapsedMs`, `jevElapsedMs`, and `socaiElapsedMs` remain separate timings.

The browser UI consumes streamed events before the final object arrives.
Evidence cards must remain visible while the report streams, and raw diagnostic
payloads must not replace the human-readable state.

## Testing guidance

- Automated tests must remain offline: no real social accounts, browser
  sessions, OpenRouter calls, paid model calls, or live `socai` commands.
- Inject clients, environment objects, process runners, clocks, and temporary
  state directories rather than depending on a developer machine.
- Add focused tests for every observable behavior change. Prefer the matching
  file in `test/`; use DOM fixtures for browser code and temporary directories
  for persistence or media tests.
- Test failure and partial-result paths as well as the successful path,
  especially aborts, malformed Jev responses, missing capabilities, unsafe
  URLs, login gates, empty evidence, and media validation.
- Do not weaken sanitization, source validation, or an existing assertion to
  make a test pass.

## Release and documentation consistency

Public no-clone commands are pinned to the current release. When changing the
package version or released runtime, update the package metadata, README, static
site, `site/llms.txt`, Agent Skill, and distribution tests together. Do not add
automatic-consent flags to package-runner commands.

Keep pull requests focused. Document live browser validation separately from
offline test evidence, and open an issue first for substantial behavior or UI
changes.
