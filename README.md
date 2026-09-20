<img src="https://raw.githubusercontent.com/socai-io/jev-social/main/docs/banner.png" alt="Jev × socai" width="100%" />

# Jev for social media

**Jev is cool. Giving it access to your social media is cooler.**

[![GitHub stars](https://img.shields.io/github/stars/socai-io/jev-social?style=flat-square&label=stars)](https://github.com/socai-io/jev-social/stargazers)
[![tests](https://github.com/socai-io/jev-social/actions/workflows/test.yml/badge.svg)](https://github.com/socai-io/jev-social/actions/workflows/test.yml)
[![release](https://img.shields.io/github/v/release/socai-io/jev-social?style=flat-square&label=release)](https://github.com/socai-io/jev-social/releases/latest)
[![license](https://img.shields.io/github/license/socai-io/jev-social?style=flat-square&label=license)](LICENSE)

Jev chooses each next operation: search, open a particular post or profile, read comments, download a TikTok video, or finish. [socai](https://github.com/socai-io/socai) executes the selected CLI command in your real Chrome. Each result goes back to Jev before the next decision.

<p>
  <img src="https://raw.githubusercontent.com/socai-io/jev-social/main/docs/platforms/instagram.png" height="32" alt="Instagram">
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/socai-io/jev-social/main/docs/platforms/tiktok.png" height="32" alt="TikTok">
  &nbsp;&nbsp;
  <img src="https://raw.githubusercontent.com/socai-io/jev-social/main/docs/platforms/linkedin.svg" height="32" alt="LinkedIn">
</p>

[Live site](https://socai-io.github.io/jev-social/) · [socai](https://github.com/socai-io/socai) · [Discord](https://discord.gg/CpQdA7bwt8) · [Jev](https://typesafe.ai/)

![Earlier routing-only demo](https://raw.githubusercontent.com/socai-io/jev-social/main/docs/jev-social.gif)

The recording above shows the earlier routing-only prototype. Current runs include a history of every operation chosen by Jev.

## Why this pairing

Jev chooses from a changing list of concrete, read-only operations. The list includes exact targets discovered in previous results, so Jev decides which post to open and which socai command to run. socai handles the underlying navigation, clicks, scrolling, and extraction; Jev does not choose arbitrary DOM coordinates or generate shell commands.

```text
"find handmade art on Instagram"
        │
        ▼
   Jev chooses the platform
        │
        ▼
   Jev chooses an operation ◄──── observed results
        │                              ▲
        ├─ search                      │
        ├─ open a selected profile     │
        ├─ open a selected post        │
        ├─ read comments / download    │
        │         └──── socai CLI ─────┘
        └─ finish → cards · table · evidence report
```

https://github.com/user-attachments/assets/4849e0f3-87d5-4a0d-8e0b-2a58e3d0267a

This video also predates the per-operation Jev loop.

## Available operations

| Platform | Jev can select |
| --- | --- |
| Instagram | Search, open a profile and its post cards, open a specific post/reel and read comments, inspect page state |
| TikTok | Search, open an author, read a selected video and its comments, optionally download that video's media, inspect page state |
| LinkedIn | Search people/content/companies, read a selected profile/company/post, read experience or education, inspect page state |

Only commands exposed by the installed socai CLI are offered. Targets come from captured results or explicit URLs in the user's request. Unsupported, malformed, and low-confidence decisions do not execute. Previously attempted operations are removed from the next choice set.

The run stores each choice, confidence, command, observed result summary, and elapsed time. Login/access gates, decision failures, and step limits produce partial results rather than a success claim. Reports are compiled from captured text, comments, and source links; they do not hand browsing off to another agent or depend on `socai research`. Speed varies with the number of chosen operations and the live site.

## Run it

Node 20+, an OpenRouter key with Jev access, and a current [socai](https://github.com/socai-io/socai) CLI.

Fastest path — no repository clone required. Onboarding prompts for the key and offers to install the official socai CLI when it is missing:

```bash
npx --yes github:socai-io/jev-social onboard
npx --yes github:socai-io/jev-social
```

To work from a source checkout instead:

```bash
curl -fsSL https://github.com/socai-io/socai/releases/latest/download/install.sh | sh
git clone https://github.com/socai-io/jev-social.git
cd jev-social
npm install
cp .env.example .env   # OPENROUTER_API_KEY=…
npm start
```

Opens `http://127.0.0.1:8766`. Loopback only. Leave the platform on **Jev · auto**, type a goal, watch the timer.

```bash
npm start -- search "find emerging design creators on Instagram" --platform auto --limit 4
npm start -- search "find AI wearable trends on TikTok" --platform auto --limit 4
npm start -- search "find AI product managers in San Francisco on LinkedIn" --platform auto --limit 4
npm start -- search "find handmade art on Instagram and read the comments" --limit 4 --max-steps 12
```

`--limit` is the target result count and per-search/profile collection size (1–100). All captured records are retained, including intermediate profile cards. `--max-steps` bounds the decision loop (1–30, default 12); each selected operation or finish decision consumes one step. The HTTP search endpoints also accept `maxSteps`.

Or call socai directly:

```bash
socai instagram search "AI wearables" --num 10 --pretty
socai tiktok search "AI wearables" --num 10 --pretty
socai tiktok get-videos --video <url> --download-media --pretty
socai linkedin search "AI product managers" --num 10 --pretty
socai linkedin search "AI agents" --type content --num 10 --pretty
```

---

If this is useful, [star Jev Social](https://github.com/socai-io/jev-social/stargazers). The browser runtime lives in [socai](https://github.com/socai-io/socai); you can star it too or [join the Discord](https://discord.gg/CpQdA7bwt8).
