# Contributing to Jev Social

Thanks for helping make local social research faster, more reliable, and easier to inspect.

## Set up

You need Node.js 20+, a current [socai](https://github.com/socai-io/socai) CLI, and an OpenRouter key with access to Jev for live runs.

```bash
npm ci
cp .env.example .env
npm run check
npm test
```

The automated tests are offline and must not require social accounts, browser sessions, or paid model calls. Use your own accounts and browser profile for live validation, and follow each platform's terms and applicable law.

## Make a change

1. Open an issue first for substantial behavior or UI changes.
2. Keep pull requests focused on one problem.
3. Add or update tests for observable behavior.
4. Run `npm run check` and `npm test` before opening the pull request.
5. Describe any live browser validation separately from the offline test evidence.

Do not commit `.env`, API keys, browser data, downloaded media, run artifacts, or personal social-media data. UI text, documentation, issues, and pull requests should be in English.

## Useful areas

- normalize additional socai result shapes without exposing raw JSON
- improve preview selection and media fallbacks
- make streamed run events clearer without adding verbose logs
- add offline fixtures for platform-specific edge cases
- improve accessibility and reduced-motion behavior

By contributing, you agree that your contribution is licensed under this repository's MIT License.
