// Cloudflare Worker entry point.
// - POST /api/research  -> runs the LangGraph agent, returns the briefing as JSON
// - everything else     -> served as a static file from /public (assets binding)
//
// `run_worker_first: ["/api/*"]` in wrangler.jsonc means this Worker is only
// invoked for /api/* routes; all other paths are served straight from /public.

import { runResearch, MODELS, type Provider, type Env as AgentEnv } from "./agent";

interface Env extends AgentEnv {
  ASSETS: Fetcher;
}

interface ResearchBody {
  question?: string;
  topic?: string;
  days?: number;
  maxIterations?: number;
  provider?: string;
  model?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Model picker data for the UI (single source of truth lives in agent.ts).
    if (url.pathname === "/api/models") {
      return Response.json(MODELS);
    }

    if (url.pathname === "/api/research") {
      if (request.method !== "POST") {
        return Response.json({ error: "Use POST" }, { status: 405 });
      }
      try {
        const body = (await request.json()) as ResearchBody;
        const provider: Provider = body.provider === "openai" ? "openai" : "anthropic";

        // provider-specific secret check
        const hasLlmKey = provider === "openai" ? !!env.OPENAI_API_KEY : !!env.ANTHROPIC_API_KEY;
        const keyName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
        if (!hasLlmKey || !env.TAVILY_API_KEY) {
          const missing = !hasLlmKey ? keyName : "TAVILY_API_KEY";
          return Response.json(
            { error: `Server missing ${missing}. Set it with \`wrangler secret put\` (or .dev.vars locally).` },
            { status: 500 },
          );
        }

        const topic = (body.topic || body.question || "").trim();
        const question = (body.question || body.topic || "").trim();
        if (!topic) return Response.json({ error: "Provide a topic or question." }, { status: 400 });

        const result = await runResearch(env, {
          question,
          topic,
          days: clampInt(body.days, 1, 30, 7),
          maxIterations: clampInt(body.maxIterations, 1, 5, 3),
          provider,
          model: typeof body.model === "string" ? body.model : undefined,
        });
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
