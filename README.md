# 🧠 Personalized AI News Research Agent — Cloudflare Edition

A self-correcting AI news research agent that fetches recent AI news, scores
every item against **your** profile ("why should *I* care?"), tags its substance,
strips the hype, and writes a briefing — then **critiques its own draft and
searches again** until coverage is solid.

Built **edge-native**: the agent runs as a **Cloudflare Worker** in TypeScript
with **LangGraph.js**, and the cyberpunk UI is served as static assets from the
same Worker. (Ported from the original Python + Streamlit version.)

---

## What makes it agentic

The graph is **not** a fixed pipeline. After drafting, a `reflect` node judges its
own coverage, lists what's missing, and — if the draft is thin — loops back to
plan **targeted** searches that fill those gaps, bounded by a hard pass cap.

```
plan → search → score → synthesize → reflect
  ▲                                     │
  └──────── gaps? loop ◄────────────────┤
                                        ▼
                          coverage good OR cap hit → END
```

Each item is tagged by substance: **Shipped** · **Announced** · **Research** · **Hype**.

---

## Architecture

| Layer | Tech | File |
| --- | --- | --- |
| Agent graph + reflect loop | LangGraph.js (`@langchain/langgraph`) | `src/agent.ts` |
| LLM layer | LangChain.js — `ChatOpenAI` / `ChatAnthropic`; provider + model picked in the UI | `src/agent.ts` |
| News search | Tavily REST (`/search`, topic=news) via `fetch` | `src/agent.ts` |
| Worker / routing | `POST /api/research` + static assets | `src/index.ts` |
| UI (cyberpunk) | static HTML/CSS/JS, `<canvas>` + Web Audio | `public/` |
| Profile | your role/stack/interests/ignore | `src/profile.ts` |

`wrangler.jsonc` uses `run_worker_first: ["/api/*"]`, so the Worker only runs for
API calls; everything else is served straight from `public/` by the assets binding.

---

## Setup

```bash
npm install
```

### Local development

```bash
cp .dev.vars.example .dev.vars     # then edit .dev.vars with your keys
npm run dev                        # wrangler dev -> http://localhost:8787
```

`.dev.vars` holds your secrets for local runs:

| Key | Where to get it |
| --- | --- |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com> — needed if you pick the Claude engine |
| `OPENAI_API_KEY` | <https://platform.openai.com/api-keys> — needed if you pick the OpenAI engine |
| `TAVILY_API_KEY` | <https://app.tavily.com> — free tier, no card |

> Pick the **engine** (Claude or OpenAI) and **model** in the UI. You only need the
> API key for the provider you choose, plus `TAVILY_API_KEY` for search. The UI and
> all cyber effects load even without keys.

### Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY   # and/or OPENAI_API_KEY
npx wrangler secret put TAVILY_API_KEY
npm run deploy
```

---

## Make it yours

- **Profile** — edit [`src/profile.ts`](src/profile.ts) (role, stack, interests, ignore).
  Every relevance score and "why this matters to you" line flows from it.
- **Engine & model** — choose in the UI (Claude or OpenAI + a model, including
  **Claude Fable 5**). The selectable list lives in the `MODELS` map at the top of
  [`src/agent.ts`](src/agent.ts) and is served to the UI via `GET /api/models`.

---

## Project layout

```
research-agent-cf/
├── src/
│   ├── index.ts        # Worker: /api/research + serves static assets
│   ├── agent.ts        # LangGraph.js graph + nodes (the reflect loop)
│   └── profile.ts      # your editable profile
├── public/             # static cyberpunk UI (served by the assets binding)
│   ├── index.html
│   ├── styles.css
│   └── app.js          # matrix rain, sounds, cursor, music, fetch + render
├── wrangler.jsonc
├── tsconfig.json
└── package.json
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Local dev server (wrangler) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` |

---

## Notes

- **Subrequests:** each run makes several OpenAI + Tavily calls. The Workers free
  plan caps subrequests at 50/request; the paid plan allows 1000. For very long
  multi-pass runs, consider Cloudflare **Workflows** / the **Agents SDK** (durable,
  streaming) — clean upgrade path; the nodes here are already isolated functions.
- **Notice (cyberpunk UI):** Matrix rain, neon styling, click/hover SFX, the ♫
  background-music toggle, and SVG tag badges are all synthesized client-side — no
  audio files, no copied logos.
