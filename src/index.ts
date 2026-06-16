// Cloudflare Worker entry point.
//
//  GET  /api/latest      → latest run from D1 (falls back to getLatestRun)
//  GET  /api/runs        → paginated run list (?topic=&from=&to=&limit=&offset=)
//  GET  /api/runs/:id    → full run by id
//  POST /api/run         → password-protected manual trigger; uses server-side keys
//  GET  /api/models      → model list for the UI picker
//  *                     → served as static files from /public (assets binding)

import { runResearch, MODELS, type Provider } from "./agent";
import { insertRun, getRun, getLatestRun, listRuns } from "./db";

// Default parameters for the daily cron run — tuned to the owner's profile.
const CRON_TOPIC = "Agentic AI and LLM developments";
const CRON_QUESTION =
  "What's the latest in agentic AI, AI agents, LLM orchestration, and major AI model releases?";
const CRON_DAYS = 7;
const CRON_MAX_ITERATIONS = 3;
const CRON_MODEL = "claude-haiku-4-5-20251001";
const HISTORY_PAGE_SIZE = 20;

interface Env {
  ASSETS: Fetcher;
  RESEARCH_KV: KVNamespace;
  RESEARCH_DB: D1Database;
  ANTHROPIC_API_KEY: string;
  TAVILY_API_KEY: string;
  MANUAL_PASSWORD: string;
}

interface RunBody {
  password?: string;
  topic?: string;
  question?: string;
  days?: number;
  maxIterations?: number;
  model?: string;
}

async function runAndStore(
  env: Env,
  topic: string,
  question: string,
  days: number,
  maxIterations: number,
  model: string,
  trigger: "cron" | "manual",
) {
  const result = await runResearch({
    question,
    topic,
    days,
    maxIterations,
    provider: "anthropic" as Provider,
    model,
    apiKey: env.ANTHROPIC_API_KEY,
    tavilyKey: env.TAVILY_API_KEY,
  });

  const runAt = new Date().toISOString();
  const runId = await insertRun(
    env.RESEARCH_DB,
    { answer: result.answer, provider: result.provider, model: result.model, runAt, topic, question },
    result.docs,
    result.history,
    trigger,
  );

  // KV stores only the latest run id — cheap pointer, no data duplication.
  await env.RESEARCH_KV.put("latest_id", String(runId));

  return { ...result, runAt, topic, question, id: runId };
}

function resolveAnthropicModel(model: unknown): string {
  const allowed = MODELS.anthropic.map((m) => m.id);
  const m = typeof model === "string" ? model : "";
  return allowed.includes(m) ? m : CRON_MODEL;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── /api/models ──────────────────────────────────────────────────────── //
    if (url.pathname === "/api/models") {
      return Response.json(MODELS);
    }

    // ── /api/latest ──────────────────────────────────────────────────────── //
    if (url.pathname === "/api/latest" && request.method === "GET") {
      // Try KV pointer first (avoids a full table scan).
      const latestId = await env.RESEARCH_KV.get("latest_id");
      const run = latestId
        ? await getRun(env.RESEARCH_DB, Number(latestId))
        : await getLatestRun(env.RESEARCH_DB);
      if (!run) return Response.json({ notFound: true }, { status: 404 });
      return Response.json(run, { headers: { "Cache-Control": "no-store" } });
    }

    // ── /api/runs (list) ─────────────────────────────────────────────────── //
    if (url.pathname === "/api/runs" && request.method === "GET") {
      const topic = url.searchParams.get("topic") || undefined;
      const from  = url.searchParams.get("from")  || undefined;
      const to    = url.searchParams.get("to")    || undefined;
      const limit  = clampInt(url.searchParams.get("limit"),  1, 100, HISTORY_PAGE_SIZE);
      const offset = clampInt(url.searchParams.get("offset"), 0, 1e9, 0);
      const runs = await listRuns(env.RESEARCH_DB, { topic, from, to, limit, offset });
      return Response.json({ runs, limit, offset });
    }

    // ── /api/runs/:id ─────────────────────────────────────────────────────  //
    const runIdMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (runIdMatch && request.method === "GET") {
      const run = await getRun(env.RESEARCH_DB, Number(runIdMatch[1]));
      if (!run) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(run);
    }

    // ── /api/run (manual trigger) ─────────────────────────────────────────  //
    if (url.pathname === "/api/run") {
      if (request.method !== "POST") {
        return Response.json({ error: "Use POST" }, { status: 405 });
      }
      try {
        const body = (await request.json()) as RunBody;
        if (!body.password || body.password !== env.MANUAL_PASSWORD) {
          return Response.json({ error: "Invalid access key." }, { status: 401 });
        }
        const topic    = (body.topic    || CRON_TOPIC).trim();
        const question = (body.question || body.topic || CRON_QUESTION).trim();

        // Race against 25 s so we return a clean error before CF kills at 30 s.
        const stored = await Promise.race([
          runAndStore(
            env, topic, question,
            clampInt(body.days,           1, 30, CRON_DAYS),
            clampInt(body.maxIterations,  1,  5, CRON_MAX_ITERATIONS),
            resolveAnthropicModel(body.model),
            "manual",
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("Research timed out — try fewer passes or a shorter look-back.")),
              25_000,
            ),
          ),
        ]);
        return Response.json(stored);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log("[cron] starting daily research run");
    try {
      await runAndStore(env, CRON_TOPIC, CRON_QUESTION, CRON_DAYS, CRON_MAX_ITERATIONS, CRON_MODEL, "cron");
      console.log("[cron] daily research run complete");
    } catch (e) {
      console.error("[cron] research run failed:", e);
    }
  },
};
