# Personalized AI News Research Agent — Cloudflare Edition

A self-correcting AI news research agent that fetches recent AI news, scores every item against **your** profile ("why should *I* care?"), tags its substance, strips the hype, and writes a briefing — then **critiques its own draft and searches again** until coverage is solid.

Runs **daily** via a Cloudflare cron trigger. Results are stored in **Cloudflare D1** and browsable in the UI. The agent **learns from its own history** across runs.

Built edge-native: the agent runs as a **Cloudflare Worker** in TypeScript with **LangGraph.js**, and the cyberpunk UI is served as static assets from the same Worker.

---

## What makes it agentic

The graph is **not** a fixed pipeline. After drafting, a `reflect` node judges its own coverage, lists what's missing, and — if the draft is thin — loops back to plan **targeted** searches that fill those gaps, bounded by a hard pass cap.

```
plan → search → score → synthesize → reflect
  ▲                                     │
  └──────── gaps? loop ◄────────────────┤
                                        ▼
                          coverage good OR cap hit → END
```

Each item is tagged by substance: **Shipped** · **Announced** · **Research** · **Hype**.

### Cross-run learning (DB-powered)

Every run is persisted to Cloudflare D1. Before each new run the agent reads its own history:

| Feature | What it does |
| --- | --- |
| **Dynamic lookback window** | Cron runs compute how many days have passed since the last briefing on the same topic and set the search window exactly — no stale re-coverage, no new-content gaps. |
| **Gap carryover** | The reflect node records blind spots it found in each draft. The next run's plan node reads these and folds them into its initial queries, so the agent improves its search strategy across runs without any explicit training. |

---

## Architecture

| Layer | Tech | File |
| --- | --- | --- |
| Agent graph + reflect loop | LangGraph.js (`@langchain/langgraph`) | `src/agent.ts` |
| LLM layer | LangChain.js — `ChatAnthropic`; model picked in the UI | `src/agent.ts` |
| News search | Tavily REST (`/search`, topic=news) via `fetch` | `src/agent.ts` |
| Run storage | Cloudflare D1 (SQLite) — runs, docs, reflect passes | `src/db.ts` |
| Latest-run pointer | Cloudflare KV — stores only the latest run id | `src/index.ts` |
| Worker / routing | API routes + static asset fallback | `src/index.ts` |
| UI (cyberpunk) | Static HTML/CSS/JS, `<canvas>` + Web Audio | `public/` |
| Profile | Your role / stack / interests / ignore list | `src/profile.ts` |

`wrangler.jsonc` uses `run_worker_first: ["/api/*"]`, so the Worker only runs for API calls; everything else is served straight from `public/` by the assets binding.

### API surface

| Method | Route | What it does |
| --- | --- | --- |
| GET | `/api/latest` | Latest briefing (from KV pointer → D1) |
| GET | `/api/runs` | Paginated run list (`?topic=&from=&to=&limit=&offset=`) |
| GET | `/api/runs/:id` | Full run by id (answer + docs + reflect passes) |
| POST | `/api/run` | Password-protected manual trigger |
| GET | `/api/models` | Model list for the UI picker |

---

## Setup

```bash
npm install
```

### Cloudflare secrets

The app uses **server-side API keys** stored as Cloudflare secrets (not exposed to the browser):

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put MANUAL_PASSWORD   # gates the Run Now button
```

| Secret | Where to get it |
| --- | --- |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com> |
| `TAVILY_API_KEY` | <https://app.tavily.com> — free tier |
| `MANUAL_PASSWORD` | any passphrase you choose |

### Cloudflare D1

```bash
# Create the database (once)
npx wrangler d1 create research-agent-db

# Apply the schema
npx wrangler d1 migrations apply research-agent-db --remote
```

Paste the database id returned by `d1 create` into `wrangler.jsonc` under `d1_databases`.

### Local development

```bash
# Create .dev.vars with your secrets (gitignored)
cat > .dev.vars <<EOF
ANTHROPIC_API_KEY=sk-ant-...
TAVILY_API_KEY=tvly-...
MANUAL_PASSWORD=yourpassword
EOF

npm run dev   # wrangler dev -> http://localhost:8787
```

### Deploy

```bash
npm run deploy
```

---

## Make it yours

- **Profile** — edit [`src/profile.ts`](src/profile.ts) (role, stack, interests, ignore).
  Every relevance score and "why this matters to you" line flows from it.
- **Cron topic** — change `CRON_TOPIC` / `CRON_QUESTION` at the top of [`src/index.ts`](src/index.ts).
- **Model** — `CRON_MODEL` in `index.ts`; the UI picker list lives in `MODELS` in `agent.ts`.

---

## Project layout

```
research-agent-cf/
├── src/
│   ├── index.ts        # Worker: API routes + cron handler
│   ├── agent.ts        # LangGraph.js graph + nodes (the reflect loop)
│   ├── db.ts           # D1 helpers — all SQL lives here
│   └── profile.ts      # your editable profile
├── public/             # static cyberpunk UI (served by the assets binding)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── migrations/
│   └── 0001_init.sql   # D1 schema (runs, docs, reflect_passes)
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

- **Subrequests:** each run makes several LLM + Tavily calls. The Workers free plan caps subrequests at 50/request; the paid plan allows 1000. For very long multi-pass runs, consider Cloudflare **Workflows** / the **Agents SDK** (durable, streaming) — clean upgrade path; the nodes here are already isolated functions.
- **Tool use:** the agent currently calls Tavily directly via `fetch` inside the `search` node rather than through Claude's native tool-calling API. Adding tool use would let Claude decide *when* to search and *what* to search for mid-synthesis — the next natural evolution of the agentic loop. The LangChain layer already supports it; it would require restructuring `search` as a tool bound to the LLM rather than an explicit graph node.
- **Notice (cyberpunk UI):** Matrix rain, neon styling, click/hover SFX, the background-music toggle, and SVG tag badges are all synthesized client-side — no audio files, no copied logos.
