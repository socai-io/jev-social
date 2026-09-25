# Benchmark row contract

`schema.js` validates one privacy-safe row for the reproducible live benchmark proposed in [#32](https://github.com/socai-io/jev-social/issues/32). It does not run a browser, call Jev, or collect live measurements.

```js
import { validateBenchmarkRow } from "jev-social/benchmark/schema";

const row = validateBenchmarkRow(JSON.parse(input));
```

The contract records pinned runtime metadata, per-step Jev latency, aggregate browser and media time, evidence counts, and an explicit outcome. Run and task IDs must be generated UUIDv4 values. Model values are identifiers such as `typesafe/jev-1.13-20260917`, not paths or URLs. The validator rejects unknown fields, inconsistent totals, and credential-, account-, browser-, path-, or content-bearing field names at any depth.

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

Use `fixtures/valid-row.json` only as synthetic test data. Live collection, aggregation, the coverage rubric, and publication of benchmark results remain tracked in #32.
