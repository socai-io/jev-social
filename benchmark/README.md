# Reproducible benchmark

The benchmark tools implement the collection and aggregation protocol tracked in [#24](https://github.com/socai-io/jev-social/issues/24). The strict row contract was delivered in [#32](https://github.com/socai-io/jev-social/issues/32). No live measurements or performance claims are included in the repository yet.

Three fixed public-research tasks live under `benchmark/tasks/`: one each for Instagram, TikTok, and LinkedIn. Do not edit a task between repetitions. Create a new task ID when the goal, result limit, or step budget changes.

## Collect a run

Use a compatible `socai CLI`, an accessible browser profile, and either OpenRouter Jev or an explicit loopback System One endpoint. Pin the exact values recorded in the row:

```bash
npm run --silent benchmark:run -- \
  --task benchmark/tasks/instagram.json \
  --jev-social-version 0.1.8 \
  --jev-social-commit abcdef0123456789abcdef0123456789abcdef01 \
  --jev-model typesafe/jev-1.13-20260917 \
  --socai-version 0.6.0 \
  --socai-commit 0123456789abcdef0123456789abcdef01234567 \
  --profile-mode existing \
  --region cn-east \
  --condition cold >> benchmark-rows.ndjson
```

After task, metadata, local configuration, and isolated state initialization succeed, the command writes exactly one validated NDJSON row to stdout for every research attempt. Stage names go to stderr. It never writes the goal, evidence text, source URLs, local paths, browser endpoints, account identifiers, or credentials into a row. Runtime failures and partial runs remain in the dataset. Invalid input or an initialization failure exits without a row.

An installed package also exposes the same collector as `jev-social-benchmark`. `SIGINT` and `SIGTERM` stop the active operation through its abort signal and preserve an `interrupted` row before the process exits.

Run each exact task/environment group at least ten times. A shell loop is acceptable because each invocation emits one row:

```bash
for run in $(seq 1 10); do
  npm run --silent benchmark:run -- \
    --task benchmark/tasks/instagram.json \
    --jev-social-version 0.1.8 \
    --jev-social-commit abcdef0123456789abcdef0123456789abcdef01 \
    --jev-model typesafe/jev-1.13-20260917 \
    --socai-version 0.6.0 \
    --socai-commit 0123456789abcdef0123456789abcdef01234567 \
    --profile-mode existing \
    --region cn-east \
    --condition warm >> benchmark-rows.ndjson
done
```

`cold` means the first run after restarting the browser/CLI research session and clearing only documented application caches. `warm` means an immediate repeat in the same browser profile without clearing caches. Never clear browser cookies, login state, or personal data for this benchmark. Record a stable, non-identifying region label and describe its meaning beside any published dataset.

The runner records the declared Jev Social version and commit, requires `socai --version` to return the declared version, and requires every successful decision response to report the immutable model supplied by `--jev-model`. Floating aliases such as `jev-latest` and `kev-latest` are rejected. Collect from the declared Jev Social and socai commits; their current runtime metadata does not expose a verifiable build commit, so the operator remains responsible for both commit pins. `--profile-mode` records the browser setup used for the run; it does not create or modify a browser profile.

Jev and browser-operation component timers use a monotonic clock, including failed attempts. For TikTok, `timing_ms.media` is the full elapsed time of each `socai` operation that requested a download. It can overlap `timing_ms.socai_browser` and is an upper bound on download-only work. Media counts and bytes include only recognized media files tied to the explicit download target and resolved below configured `socai` run roots; paths never enter the row.

## Generate the summary

```bash
npm run --silent benchmark:summarize -- --input benchmark-rows.ndjson > benchmark-summary.md
```

The generator validates every row before aggregation, rejects duplicate run IDs, groups only exact task, Jev Social runtime, and environment matches, uses nearest-rank p50/p95, and reports success, partial, failed, failure rate, evidence coverage, and non-success reasons. A schema-v2 summary is `READY` only when every included group has at least ten distinct rows. Legacy schema-v1 rows remain readable but can never satisfy the publication gate. Invalid rows fail the command instead of disappearing.

## Row contract

`schema.js` validates one privacy-safe row:

```js
import { validateBenchmarkRow } from "jev-social/benchmark/schema";

const row = validateBenchmarkRow(JSON.parse(input));
```

Schema v2 records the Jev Social version and commit alongside the pinned socai and model metadata, per-step Jev latency, aggregate browser and media time, evidence counts, and an explicit outcome. Run and task IDs must be generated UUIDv4 values. Model values are identifiers such as `typesafe/jev-1.13-20260917`, not paths or URLs. The validator rejects unknown fields, inconsistent totals, and credential-, account-, browser-, path-, or content-bearing field names at any depth. Schema v1 remains accepted only for reading historical rows and never becomes publication-ready.

Measure `started_at` and `ended_at` with the wall clock. Measure every `timing_ms` field with a monotonic clock; `total` is end-to-end latency, and media time may overlap browser time. Jev decisions and browser operations are sequential, so their combined time must fit `total` within the one-second clock tolerance. `jev_total` must equal the sum of `jev_step_latency_ms`, with one entry per attempted decision. The array may be empty for a preflight failure and may contain up to `max_steps + 1` entries: one routing decision plus the bounded action decisions.

Successful rows require at least one evidence record. Download counts and bytes must be zero together or positive together, and downloaded media is valid only for TikTok rows.

Use these stable terminal mappings:

| Stop reason | Failure category |
| --- | --- |
| `login_required`, `challenge_required`, `rate_limited` | `access_gate` |
| `capability_unavailable`, `browser_unavailable`, `media_unavailable` | `unavailable` |
| `decision_failed`, `cli_failed`, `network_error`, `report_failed` | `execution_error` |
| `step_limit` | `step_limit` |
| `empty_results` | `empty_results` |
| `interrupted` | `interrupted` |
| `unknown` | `unknown` |

Successful rows use `goal_satisfied` with a null failure category.

Use `fixtures/valid-row.json` only as synthetic test data. Publishing live rows and a dated comparison table still requires the full coverage and review gate in #24.
