// Cloudflare Worker entry point.
// - POST /api/research  -> runs the LangGraph agent, returns the briefing as JSON
// - everything else     -> served as a static file from /public (assets binding)
//
// `run_worker_first: ["/api/*"]` in wrangler.jsonc means this Worker is only
// invoked for /api/* routes; all other paths are served straight from /public.

import { runResearch, MODELS, type Provider } from "./agent";

interface Env {
  ASSETS: Fetcher;
}

interface ResearchBody {
  question?: string;
  topic?: string;
  days?: number;
  maxIterations?: number;
  provider?: string;
  model?: string;
  apiKey?: string;
  tavilyKey?: string;
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

        // BYOK — keys come from the user's request, used in-memory only and never
        // stored, logged, or persisted. No server-side env fallback (so visitors
        // can't spend the owner's keys).
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        const tavilyKey = typeof body.tavilyKey === "string" ? body.tavilyKey.trim() : "";
        if (!apiKey) {
          return Response.json({ error: `Enter your ${provider === "openai" ? "OpenAI" : "Anthropic"} API key.` }, { status: 400 });
        }
        if (!tavilyKey) {
          return Response.json({ error: "Enter your Tavily API key." }, { status: 400 });
        }

        const topic = (body.topic || body.question || "").trim();
        const question = (body.question || body.topic || "").trim();
        if (!topic) return Response.json({ error: "Provide a topic or question." }, { status: 400 });

        const result = await runResearch({
          question,
          topic,
          days: clampInt(body.days, 1, 30, 7),
          maxIterations: clampInt(body.maxIterations, 1, 5, 3),
          provider,
          model: typeof body.model === "string" ? body.model : undefined,
          apiKey,
          tavilyKey,
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
