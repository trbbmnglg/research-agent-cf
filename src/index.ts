// Cloudflare Worker entry point.
//
//  GET  /api/latest      → latest run from D1 (falls back to getLatestRun)
//  GET  /api/runs        → paginated run list (?topic=&from=&to=&limit=&offset=)
//  GET  /api/runs/:id    → full run by id
//  POST /api/run         → password-protected manual trigger; uses server-side keys
//  GET  /api/models      → model list for the UI picker
//  *                     → served as static files from /public (assets binding)

import { runResearch, getGraphDiagram, MODELS, type Provider, type ProgressEvent } from "./agent";
import { insertRun, getRun, getLatestRun, listRuns, getLatestRunForTopic, getRecentGaps } from "./db";

// Default parameters for the daily cron run — tuned to the owner's profile.
const CRON_TOPIC = "Agentic AI and LLM developments";
const CRON_QUESTION =
  "What's the latest in agentic AI, AI agents, LLM orchestration, and major AI model releases?";
const CRON_DAYS = 7;
const CRON_MAX_ITERATIONS = 2;
const CRON_MODEL = "claude-haiku-4-5-20251001";
const HISTORY_PAGE_SIZE = 20;

interface Env {
  ASSETS: Fetcher;
  RESEARCH_KV: KVNamespace;
  RESEARCH_DB: D1Database;
  ANTHROPIC_API_KEY: string;
  TAVILY_API_KEY: string;
  MANUAL_PASSWORD: string;
  LANGCHAIN_API_KEY?: string;   // optional — enables LangSmith tracing
  LANGCHAIN_PROJECT?: string;   // optional — defaults to "research-agent-cf"
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
  onProgress?: (event: ProgressEvent) => void,
) {
  // For cron runs, compute how many days have passed since the last run on this
  // topic so the search window exactly covers new content (capped at 14 days).
  let effectiveDays = days;
  if (trigger === "cron") {
    try {
      const last = await getLatestRunForTopic(env.RESEARCH_DB, topic);
      if (last) {
        const elapsed = Math.ceil((Date.now() - new Date(last.run_at).getTime()) / 86_400_000);
        effectiveDays = Math.min(14, Math.max(1, elapsed + 1));
        console.log(`[runAndStore] dynamic lookback: ${effectiveDays} days (last run: ${last.run_at})`);
      }
    } catch (e) {
      console.error("[runAndStore] getLatestRunForTopic failed, using default days:", e);
    }
  }

  // Wire LangSmith tracing when the secret is present.
  // process.env is a writable shim in Cloudflare Workers (nodejs_compat).
  if (env.LANGCHAIN_API_KEY) {
    process.env.LANGCHAIN_TRACING_V2 = "true";
    process.env.LANGCHAIN_API_KEY = env.LANGCHAIN_API_KEY;
    process.env.LANGCHAIN_PROJECT = env.LANGCHAIN_PROJECT ?? "research-agent-cf";
  }

  // Pull blind spots from previous runs on this topic so the plan node can
  // address them in its first-pass queries (cross-run learning).
  let priorGaps: string[] = [];
  try {
    priorGaps = await getRecentGaps(env.RESEARCH_DB, topic);
    if (priorGaps.length > 0) {
      console.log(`[runAndStore] ${priorGaps.length} prior gaps loaded for topic "${topic}"`);
    }
  } catch (e) {
    console.error("[runAndStore] getRecentGaps failed, continuing without:", e);
  }

  const result = await runResearch({
    question,
    topic,
    days: effectiveDays,
    maxIterations,
    provider: "anthropic" as Provider,
    model,
    apiKey: env.ANTHROPIC_API_KEY,
    tavilyKey: env.TAVILY_API_KEY,
    priorGaps,
    onProgress,
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── /api/models ──────────────────────────────────────────────────────── //
    if (url.pathname === "/api/models") {
      return Response.json(MODELS);
    }

    // ── /api/graph ───────────────────────────────────────────────────────── //
    if (url.pathname === "/api/graph") {
      return Response.json({ mermaid: getGraphDiagram() });
    }

    // ── /api/latest ──────────────────────────────────────────────────────── //
    if (url.pathname === "/api/latest" && request.method === "GET") {
      try {
        const latestId = await env.RESEARCH_KV.get("latest_id");
        const run = latestId
          ? await getRun(env.RESEARCH_DB, Number(latestId))
          : await getLatestRun(env.RESEARCH_DB);
        if (!run) return Response.json({ notFound: true }, { status: 404 });
        return Response.json(run, { headers: { "Cache-Control": "no-store" } });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[/api/latest]", message);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // ── /api/runs (list) ─────────────────────────────────────────────────── //
    if (url.pathname === "/api/runs" && request.method === "GET") {
      try {
        const topic = url.searchParams.get("topic") || undefined;
        const from  = url.searchParams.get("from")  || undefined;
        const to    = url.searchParams.get("to")    || undefined;
        const limit  = clampInt(url.searchParams.get("limit"),  1, 100, HISTORY_PAGE_SIZE);
        const offset = clampInt(url.searchParams.get("offset"), 0, 1e9, 0);
        const runs = await listRuns(env.RESEARCH_DB, { topic, from, to, limit, offset });
        return Response.json({ runs, limit, offset });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[/api/runs]", message);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // ── /api/runs/:id ─────────────────────────────────────────────────────  //
    const runIdMatch = url.pathname.match(/^\/api\/runs\/(\d+)$/);
    if (runIdMatch && request.method === "GET") {
      try {
        const run = await getRun(env.RESEARCH_DB, Number(runIdMatch[1]));
        if (!run) return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(run);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[/api/runs/:id]", message);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // ── /api/run (manual trigger — streams SSE progress events) ──────────  //
    if (url.pathname === "/api/run") {
      if (request.method !== "POST") {
        return Response.json({ error: "Use POST" }, { status: 405 });
      }

      let body: RunBody;
      try {
        body = (await request.json()) as RunBody;
      } catch {
        return Response.json({ error: "Invalid JSON body." }, { status: 400 });
      }
      if (!body.password || body.password !== env.MANUAL_PASSWORD) {
        return Response.json({ error: "Invalid access key." }, { status: 401 });
      }

      const topic    = (body.topic    || CRON_TOPIC).trim();
      const question = (body.question || body.topic || CRON_QUESTION).trim();
      const days     = clampInt(body.days,           1, 30, CRON_DAYS);
      const maxIter  = clampInt(body.maxIterations,  1,  5, CRON_MAX_ITERATIONS);
      const model    = resolveAnthropicModel(body.model);

      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer  = writable.getWriter();
      const encoder = new TextEncoder();

      // Fire-and-forget: stream progress events then the final result.
      // ctx.waitUntil keeps the Worker alive until the stream closes.
      ctx.waitUntil((async () => {
        const emit = (data: object): Promise<void> => {
          try { return writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
          catch { return Promise.resolve(); }
        };
        const close = async () => { try { await writer.close(); } catch {} };

        const timeout = setTimeout(() => {
          void emit({ type: "error", message: "Research timed out — try fewer passes or a shorter look-back." }).finally(close);
        }, 28_000);

        try {
          const stored = await runAndStore(
            env, topic, question, days, maxIter, model, "manual",
            (event) => { void emit(event); },
          );
          clearTimeout(timeout);
          await emit({ type: "result", ...stored });
        } catch (e) {
          clearTimeout(timeout);
          await emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          await close();
        }
      })());

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        },
      });
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
