# Run Jev Social with Simple Jev

[Simple Jev](https://github.com/featherless-ai/simple-jev) can serve a
Choice-capable model through the `/v1/systemone` contract that Jev Social uses.
This keeps typed decisions on a loopback server; `socai` and the signed-in local
Chrome session still perform the social-platform work.

## Compatibility snapshot

The following request-shape check was run on September 26, 2026 with:

- Jev Social `v0.1.8`, commit
  [`c411ae1`](https://github.com/socai-io/jev-social/commit/c411ae1532dd37ab94f8164f13552ed05f4c9ecc)
- Simple Jev commit
  [`c077d5d`](https://github.com/featherless-ai/simple-jev/commit/c077d5dfdb5c2c7dd24b17d5f556f07e0162dc1c)
- the public Simple Jev demo serving
  `featherless-ai/Qwen3.5-4B-classifier`

The unmodified Jev Social classifier and action chooser accepted all seven
responses through their normal strict validation:

| Case | Expected decision | Observed confidence | Decision time |
| --- | --- | ---: | ---: |
| Instagram goal | `instagram_search` | 0.995 | 1.463 s |
| TikTok goal | `tiktok_search` | 0.993 | 0.914 s |
| LinkedIn goal | `linkedin_search` | 0.995 | 1.085 s |
| Ambiguous two-platform goal | `unsupported` | 0.799 | 1.077 s |
| Empty evidence | Search first | 1.000 | 0.651 s |
| Search cards captured | Read a post | 0.968 | 0.932 s |
| Four post details captured | Finish | 0.997 | 1.056 s |

These are individual remote-demo observations, not a performance benchmark or
a claim about local latency. They verify the response shape and this small
decision matrix only. Browser duration, evidence quality, and wider task
accuracy still depend on the local model, hardware, prompt fit, live platform,
login state, and operations selected.

## Start a pinned local server

Simple Jev requires Python 3.12 or newer and a hardware-appropriate PyTorch
installation. The model downloads on first use and requires enough memory for
its weights, cache, and inference buffers. Review the upstream
[HF server guide](https://github.com/featherless-ai/simple-jev/blob/c077d5dfdb5c2c7dd24b17d5f556f07e0162dc1c/hf-server/README.md)
before choosing the device and precision.

```bash
git clone https://github.com/featherless-ai/simple-jev.git
cd simple-jev
git checkout c077d5dfdb5c2c7dd24b17d5f556f07e0162dc1c

python3 -m venv .venv
source .venv/bin/activate
# Install the PyTorch build appropriate for this machine first.
python -m pip install -e './hf-server'

python hf-server/hf_server.py \
  --model Qwen/Qwen3.5-4B \
  --revision 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a \
  --served-model-name simple-jev-qwen3.5-4b \
  --enforce-model-id \
  --device auto --dtype bfloat16 \
  --max-model-len 16384 \
  --max-choice-options 255 \
  --max-batch-size 4 --max-batch-tokens 16384 \
  --host 127.0.0.1 --port 8000
```

The pinned Hugging Face revision above was the public revision returned for
`Qwen/Qwen3.5-4B` when this guide was written. Change the device or precision
only as required by the local hardware, then verify readiness:

```bash
curl --fail http://127.0.0.1:8000/health
curl --fail http://127.0.0.1:8000/v1/models
```

## Point Jev Social at it

In another terminal:

```bash
export JEV_SOCIAL_SYSTEM_ONE_URL=http://127.0.0.1:8000/v1/systemone
export JEV_SOCIAL_SYSTEM_ONE_MODEL=simple-jev-qwen3.5-4b
export JEV_SOCIAL_SYSTEM_ONE_TIMEOUT_MS=120000
export OPENROUTER_REPORT_MODEL=off

npx github:socai-io/jev-social#v0.1.8 status
npx github:socai-io/jev-social#v0.1.8 search \
  "find emerging design creators on Instagram" \
  --platform instagram --limit 4
```

`OPENROUTER_REPORT_MODEL=off` keeps report generation on the deterministic
evidence path, so this setup does not require an OpenRouter key. Jev Social
accepts only the exact loopback `/v1/systemone` URL, rejects redirects and
oversized responses, validates every Choice against its current finite action
set, and stops rather than executing decisions below its action-confidence
threshold.

If the server returns `422`, first check the model ID, rendered context length,
and Choice limit. Jev Social does not silently truncate the state or candidate
set. A structurally valid response also does not prove good decisions for a new
model or prompt policy; repeat a representative decision matrix before relying
on a different checkpoint.
