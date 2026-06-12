// Cloudflare Worker entry point.
// - POST /api/research  -> runs the LangGraph agent, returns the briefing as JSON
// - everything else     -> served as a static file from /public (assets binding)
//
// `run_worker_first: ["/api/*"]` in wrangler.jsonc means this Worker is only
// invoked for /api/* routes; all other paths are served straight from /public.

import { runResearch, type Env as AgentEnv } from "./agent";

interface Env extends AgentEnv {
  ASSETS: Fetcher;
}

interface ResearchBody {
  question?: string;
  topic?: string;
  days?: number;
  maxIterations?: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/research") {
      if (request.method !== "POST") {
        return Response.json({ error: "Use POST" }, { status: 405 });
      }
      if (!env.OPENAI_API_KEY || !env.TAVILY_API_KEY) {
        return Response.json(
          { error: "Server missing OPENAI_API_KEY / TAVILY_API_KEY. Set them with `wrangler secret put` (or .dev.vars locally)." },
          { status: 500 },
        );
      }
      try {
        const body = (await request.json()) as ResearchBody;
        const topic = (body.topic || body.question || "").trim();
        const question = (body.question || body.topic || "").trim();
        if (!topic) return Response.json({ error: "Provide a topic or question." }, { status: 400 });

        const days = clampInt(body.days, 1, 30, 7);
        const maxIterations = clampInt(body.maxIterations, 1, 5, 3);

        const result = await runResearch(env, { question, topic, days, maxIterations });
        return Response.json(result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    // Fallback (only reached for non-research /api/* paths). Static files for
    // everything else are served automatically by the assets binding.
    return env.ASSETS.fetch(request);
  },
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
