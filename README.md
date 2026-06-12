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
| LLM layer | LangChain.js `ChatOpenAI` (gpt-4o-mini) | `src/agent.ts` |
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
| `OPENAI_API_KEY` | <https://platform.openai.com/api-keys> (account needs billing/quota) |
| `TAVILY_API_KEY` | <https://app.tavily.com> — free tier, no card |

> The UI loads (and all the cyber effects work) even without keys; a research run
> needs both keys and available OpenAI quota.

### Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put TAVILY_API_KEY
npm run deploy
```

---

## Make it yours

- **Profile** — edit [`src/profile.ts`](src/profile.ts) (role, stack, interests, ignore).
  Every relevance score and "why this matters to you" line flows from it.
- **Models** — top of [`src/agent.ts`](src/agent.ts):
  ```ts
  const FAST_MODEL = "gpt-4o-mini";    // plan / score / reflect
  const WRITER_MODEL = "gpt-4o-mini";  // synthesize (bump to "gpt-4o" for richer prose)
  ```

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
