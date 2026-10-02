# Reel imports: version 1

This first slice of #124 imports already processed JSON. It adds no UI, browser
operations, provider calls or media downloads. Future producers (#125) should
target this contract instead of persisting their raw provider responses.

## Input

Send a JSON object to `POST /api/reels` with `Content-Type: application/json` and
an `Origin` matching the loopback server. Maximum input and normalized size:
10,000,000 UTF-8 bytes, with 1–1,000 items. `GET /api/reels` lists collections;
`GET /api/reels/<library-id>` reopens one. Invalid imports leave prior data intact.

The required envelope is `{ schemaVersion: 1, id, creator, posts }`. `id` is a
stable source collection ID; each post requires its own stable `id` and an
Instagram `url`. IDs are case-sensitive, 1–128 ASCII letters, digits, dots,
underscores, colons or hyphens, starting with a letter or digit. Creator handles
are normalized to lowercase. Collection `createdAt` and source `status` are
optional. Unsupported or missing schema versions fail closed.

A Creator Lab adapter can add `schemaVersion: 1` to its export after checking
these fields and mapping producer-specific states. Do not use filenames as IDs
or fill missing plays from views. Unversioned exports require this explicit
adapter step; the importer does not guess future producer formats.

Each post accepts:

- `creator`, `caption`, ISO `publishedAt`, `capturedAt` (or `scrapedAt`),
  `duration`, `plays`, `views`, `likes`, and `comments`.
- `transcript: { text, segments: [{ text, start, end }] }`. Times are seconds;
  missing times stay `null`. Negative, nonnumeric or reversed times are rejected.
- `analysis: { labels, anatomy }`. Labels use the eight dimensions and enums
  in `src/reels-contract.js`; every label has a confidence in `[0, 1]`. Anatomy
  segments add `value` (script role) and nullable `confidence` to a timed segment.
  Classification requires a nonempty transcript. Each segment array is limited
  to 200 entries; transcript and segment text to 48,000 characters, captions to
  12,000. Oversized or malformed text is rejected.
- `status`: absent, `pending`, `ready`, `unclassified`, `classified`,
  `no_audio`, `no_speech`, `excluded`, `failed`, or `error`.
  `excludedReason` also marks exclusion. Error and excluded rows cannot carry a
  classification. Raw errors and exclusion text are replaced with fixed notes.

All fixtures in `test/fixtures/reels-import-v1.json` are synthetic; their URLs
are validation examples, not fetched or asserted to be real posts.

## Normalized contract

`schemas/reels-v1.schema.json` describes the normalized, versioned collection.
The importer constructs an allowlist of fields: unknown properties, provider
payloads, media URLs, thumbnails, cookies and local paths are not retained.
Known credential patterns in selected text are redacted. Lines containing
recognized filesystem paths are omitted conservatively, including trailing text.
Pattern matching cannot identify every secret in arbitrary prose: producers
must export public content, never credentials embedded in captions/transcripts.

Only HTTPS `instagram.com` and `www.instagram.com` post/reel URLs are accepted;
credentials, custom ports, profile links and lookalike hosts are rejected. URLs
become `https://www.instagram.com/p/<shortcode>/` without query or fragment.
The source is validated locally; no URL or media is fetched during import.

Unknown, nonnumeric, negative or nonfinite metrics become `null`; zero remains
zero. Plays and views are independent. Invalid or absent dates become `null`.
States normalize to `classified`, `unclassified`, `excluded`, or `error`.
`needsReview` is derived from labels/anatomy: confidence below 0.65, an `unclear`
value, or missing anatomy confidence requires review. It is not evidence of
human approval and cannot be overridden by a raw `needsReview: false` field.

Library IDs hash the lowercase creator plus source collection ID. Item IDs
are preserved, independent of URL aliases and filenames. Identical duplicate
item IDs collapse; conflicting duplicates reject the whole import. Posts are
sorted by ID. Reimporting replaces that collection atomically, not appends to
it; items omitted from a replacement snapshot disappear. The last successful
atomic write wins. No import timestamp is injected, so identical inputs produce
identical normalized content. `sourceId` retains the original collection ID.

Storage is `reels/v1/<library-id>.json` below the isolated Jev Social state
directory (`~/.jev-social` by default, or `JEV_SOCIAL_HOME`). Storage inside this
checkout and symlinked state/library directories is rejected. Files are written
privately via a temporary file and atomic rename. Reads revalidate the schema
and identity, enforce the size limit, and skip malformed/unsafe entries.
Nothing is stored in or served from `public/`.

`filterReels` filters normalized posts by topic, hook (`mechanism`), structure,
confidence and review/status. Confidence thresholds apply to the selected
dimension and every active label filter. The function preserves null metrics
and does not infer engagement effects, causality, or popularity rankings.

## Verification

Run `npm run check` and `npm test`. Focused tests cover normalization, malformed
input, unsafe URLs, privacy, duplicate IDs, filtering, atomic replacement and
reopening a collection after stopping and recreating the HTTP server. Tests use
temporary state directories and no social accounts or model calls.
