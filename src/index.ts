// Cloudflare Worker entry point.
//
//  GET  /api/latest      → latest run from D1 (falls back to getLatestRun)
//  GET  /api/runs        → paginated run list (?topic=&from=&to=&limit=&offset=)
//  GET  /api/runs/:id    → full run by id
//  POST /api/run         → password-protected manual trigger; uses server-side keys
//  GET  /api/models      → model list for the UI picker
//  GET  /api/graph       → LangGraph Mermaid diagram string
//  *                     → served as static files from /public (assets binding)

import { runResearch, getGraphDiagram, MODELS, type Provider, type ProgressEvent } from "./agent";
import { insertRun, getRun, getLatestRun, listRuns, getLatestRunForTopic, getRecentGaps, updateRunImageUrl } from "./db";
import { PROMPTS } from "./prompts";

const CRON_TOPIC          = PROMPTS.cron.topic;
const CRON_QUESTION       = PROMPTS.cron.question;
const CRON_DAYS           = PROMPTS.cron.days;
const CRON_MAX_ITERATIONS = PROMPTS.cron.maxIterations;
const CRON_MODEL          = PROMPTS.cron.model;
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
  RESEND_API_KEY?: string;      // optional — enables email delivery via Resend
  NOTIFY_EMAIL?: string;        // recipient address for daily briefing emails
  NOTIFY_FROM?: string;         // verified sender address (e.g. briefings@yourdomain.com)
  AI: Ai;                       // Workers AI binding (kept; unused after DALL-E switch)
  OPENAI_API_KEY?: string;      // optional — enables gpt-image-2 thumbnail generation
  CF_AI_GATEWAY?: string;       // optional — CF AI Gateway base URL for OpenAI routing
  CF_AI_GATEWAY_KEY?: string;   // optional — gateway API key when gateway auth is enabled
}

// ── Email delivery (Resend REST API) ─────────────────────────────────────── //

function htmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Only allow http/https links — block javascript: and other schemes.
function safeHref(raw: string): string {
  try {
    const p = new URL(raw);
    return p.protocol === "https:" || p.protocol === "http:" ? raw : "#";
  } catch { return "#"; }
}

function briefingToHtml(md: string): string {
  // Strip emoji the LLM occasionally includes despite the prompt instruction.
  const clean = md
    .replace(/\p{Emoji_Presentation}/gu, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/ {2,}/g, " ");

  const TAG_BG: Record<string, string> = {
    Shipped: "#16a34a", Announced: "#d97706", Research: "#2563eb", Hype: "#dc2626",
  };
  const inline = (s: string): string => {
    let t = htmlEsc(s);
    t = t.replace(/\[\[(SHIPPED|ANNOUNCED|RESEARCH|HYPE)\]\]/gi, (_, tag) => {
      const label = tag.charAt(0).toUpperCase() + tag.slice(1).toLowerCase();
      const bg = TAG_BG[label] ?? "#6b7280";
      return `<span style="background:${bg};color:#fff;padding:1px 7px;border-radius:3px;font-size:11px;font-weight:600;letter-spacing:.3px">${label}</span>`;
    });
    t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Validate URL scheme before inserting into href to block javascript: injection.
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
      const href = htmlEsc(safeHref(url.replace(/&amp;/g, "&")));
      return `<a href="${href}" style="color:#0ea5e9;text-decoration:none">${text}</a>`;
    });
    return t;
  };

  const rows: string[] = [];
  let inList = false;
  const closeList = () => { if (inList) { rows.push("</ul>"); inList = false; } };

  for (const raw of clean.split("\n")) {
    const h2 = raw.match(/^## (.+)/);
    if (h2) { closeList(); rows.push(`<h2 style="margin:22px 0 6px;font-size:16px;color:#0f172a;border-bottom:1px solid #e2e8f0;padding-bottom:4px">${inline(h2[1])}</h2>`); continue; }
    const h3 = raw.match(/^### (.+)/);
    if (h3) { closeList(); rows.push(`<h3 style="margin:16px 0 4px;font-size:14px;color:#1e293b">${inline(h3[1])}</h3>`); continue; }
    const h1 = raw.match(/^# (.+)/);
    if (h1) { closeList(); rows.push(`<h1 style="margin:0 0 14px;font-size:19px;color:#0f172a">${inline(h1[1])}</h1>`); continue; }
    const bq = raw.match(/^> (.+)/);
    if (bq) { closeList(); rows.push(`<blockquote style="border-left:3px solid #0ea5e9;margin:10px 0;padding:8px 14px;background:#f0f9ff;color:#0369a1;border-radius:0 4px 4px 0">${inline(bq[1])}</blockquote>`); continue; }
    const li = raw.match(/^[*-] (.+)/);
    if (li) {
      if (!inList) { rows.push('<ul style="margin:8px 0;padding-left:20px">'); inList = true; }
      rows.push(`<li style="margin:3px 0">${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    if (!raw.trim()) { rows.push("<br>"); continue; }
    rows.push(`<p style="margin:5px 0;line-height:1.6">${inline(raw)}</p>`);
  }
  closeList();
  return rows.join("\n");
}

// ── Thumbnail generation (Workers AI — FLUX schnell binding) ─────────────── //
// Generates one banner thumbnail per article (up to 5), each sized to fit the
// news content width. Workers AI binding is exempt from HTTP wall-clock limits.
// Thumbnails generate AFTER research (so prompts use real article titles) in
// ctx.waitUntil; the client polls /api/runs/:id until image_url appears.

function parseSize(s: string): { width: number; height: number } {
  const [w, h] = s.toLowerCase().split("x").map(Number);
  const r16 = (n: number) => Math.round(n / 16) * 16;
  // FLUX schnell max dimension is 1344px (CF Workers AI limit).
  const clamp = (n: number) => Math.min(1344, Math.max(256, r16(n || 1024)));
  return { width: clamp(w), height: clamp(h) };
}

function buildArticlePrompt(articleTitle: string): string {
  const { style, text_overlay } = PROMPTS.thumbnail;
  const clean = articleTitle.split(" — ")[0].trim();
  const display = clean.length > 45 ? clean.slice(0, 45).trimEnd() + "…" : clean;
  const scene = `ultra-wide panoramic cyberpunk anime banner about: "${clean}". Neon-lit AI cityscape at night, holographic data streams, dramatic atmospheric lighting`;
  return `${scene}. ${style} ${text_overlay.replace("{title}", display)}`;
}

async function decodeAiResult(raw: unknown): Promise<Uint8Array> {
  if (raw instanceof ReadableStream) {
    return new Uint8Array(await new Response(raw).arrayBuffer());
  }
  const b64 = (raw as { image: string }).image;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Generates one thumbnail per article (up to 5) in parallel — stored as
// thumb:runId:0 … thumb:runId:4 in KV, URLs saved as JSON in image_url.
async function generateAndStoreThumbnails(
  env: Env, runId: number, docs: Array<{ title: string }>,
): Promise<void> {
  const targets = docs.slice(0, 5);
  const { width, height } = parseSize(PROMPTS.thumbnail.size);

  console.log(`[thumbnail] starting ${targets.length} thumbnails at ${width}x${height} for run ${runId}`);
  const results = await Promise.allSettled(
    targets.map(async (doc, i) => {
      console.log(`[thumbnail] generating ${i + 1}/${targets.length}: "${doc.title.slice(0, 40)}"`);
      const raw = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", {
        prompt: buildArticlePrompt(doc.title),
        steps: 4,
        width,
        height,
      });
      const bytes = await decodeAiResult(raw);
      await env.RESEARCH_KV.put(`thumb:${runId}:${i}`, bytes.buffer as ArrayBuffer);
      return `/api/runs/${runId}/thumb/${i}` as string;
    }),
  );

  const urls = results.map((r, i) => {
    if (r.status === "rejected") {
      console.error(`[thumbnail] doc ${i} failed:`, r.reason instanceof Error ? r.reason.message : r.reason);
      return null;
    }
    return r.value;
  });
  const succeeded = urls.filter(Boolean).length;
  if (succeeded > 0) {
    await updateRunImageUrl(env.RESEARCH_DB, runId, JSON.stringify(urls));
    console.log(`[thumbnail] stored ${succeeded}/${targets.length} for run ${runId}`);
  } else {
    console.error(`[thumbnail] all ${targets.length} thumbnails failed for run ${runId}`);
  }
}

function buildEmailHtml(
  topic: string, runAt: string, model: string, answer: string, docCount: number,
  thumbnailUrl?: string,
): string {
  const d = new Date(runAt);
  const date = d.toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }) + " UTC";
  const safeTopic = htmlEsc(topic);
  const safeModel = htmlEsc(model);
  // image_url may be a JSON array (per-article thumbnails) — use the first for email header.
  let firstThumb: string | undefined;
  if (thumbnailUrl) {
    try { firstThumb = (JSON.parse(thumbnailUrl) as (string|null)[])[0] ?? undefined; }
    catch { firstThumb = thumbnailUrl; }
  }
  const thumbTag = firstThumb
    ? `<img src="https://research-agent.robertbumanglagjr.com${htmlEsc(firstThumb)}" `+
      `style="width:100%;max-height:200px;object-fit:cover;border-radius:4px;margin:0 0 16px;display:block" alt="" />`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Briefing: ${safeTopic}</title></head>
<body style="margin:0;padding:20px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:680px;margin:0 auto">
  <div style="background:#04060a;border-radius:8px 8px 0 0;padding:22px 30px">
    <div style="font-size:10px;letter-spacing:3px;color:#00f0ff;opacity:.65;text-transform:uppercase">// Personalized Intelligence Feed</div>
    <div style="font-size:21px;font-weight:700;color:#00f0ff;margin-top:5px;letter-spacing:1px">AI NEWS AGENT</div>
  </div>
  <div style="background:#fff;padding:10px 30px 2px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
    <p style="margin:10px 0;font-size:13px;color:#64748b">
      <strong style="color:#0f172a">${safeTopic}</strong>
      &nbsp;&middot;&nbsp;${date}&nbsp;&middot;&nbsp;${time}
      &nbsp;&middot;&nbsp;<span style="color:#94a3b8">${safeModel}</span>
      &nbsp;&middot;&nbsp;${docCount} source${docCount === 1 ? "" : "s"}
    </p>
  </div>
  <div style="background:#fff;padding:4px 30px 28px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
    ${thumbTag}${briefingToHtml(answer)}
  </div>
  <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px;padding:14px 30px;text-align:center">
    <a href="https://research-agent.robertbumanglagjr.com" style="color:#0ea5e9;font-size:13px;text-decoration:none">
      Open full briefing in browser →
    </a>
  </div>
</div>
</body></html>`;
}

async function sendBriefingEmail(
  apiKey: string, to: string, from: string,
  topic: string, runAt: string, model: string, answer: string, docCount: number,
  thumbnailUrl?: string,
): Promise<void> {
  const dateShort = new Date(runAt).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  });
  const subject = `AI Briefing: ${topic} — ${dateShort}`;
  const html = buildEmailHtml(topic, runAt, model, answer, docCount, thumbnailUrl);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject, html }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body}`);
  }
  console.log(`[email] briefing sent to ${to}`);
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

  let result;
  try {
    result = await runResearch({
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
  } catch (e) {
    if (isAnthropicCreditError(e) && env.OPENAI_API_KEY) {
      console.warn("[runAndStore] Anthropic credit error — falling back to OpenAI gpt-4o-mini");
      result = await runResearch({
        question,
        topic,
        days: effectiveDays,
        maxIterations,
        provider: "openai" as Provider,
        model: MODELS.openai[0].id,
        apiKey: env.OPENAI_API_KEY,
        tavilyKey: env.TAVILY_API_KEY,
        priorGaps,
        onProgress,
      });
    } else {
      throw e;
    }
  }

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

// Anthropic returns HTTP 402 (billing_error) when credits are exhausted.
// LangChain surfaces this in the thrown Error's message.
function isAnthropicCreditError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("credit") ||
    msg.includes("billing") ||
    msg.includes("payment") ||
    msg.includes("402")
  );
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

    // ── /api/runs/:id/thumb/:n  (per-article banner) ─────────────────────── //
    const thumbNMatch = url.pathname.match(/^\/api\/runs\/(\d+)\/thumb\/(\d+)$/);
    if (thumbNMatch && request.method === "GET") {
      const data = await env.RESEARCH_KV.get(`thumb:${thumbNMatch[1]}:${thumbNMatch[2]}`, { type: "arrayBuffer" });
      if (!data) return new Response("Not found", { status: 404 });
      return new Response(data, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" },
      });
    }

    // ── /api/runs/:id/thumbnail  (legacy single-image endpoint) ───────────── //
    const thumbMatch = url.pathname.match(/^\/api\/runs\/(\d+)\/thumbnail$/);
    if (thumbMatch && request.method === "GET") {
      // Try new indexed key first, fall back to old key for backwards compat
      const data = await env.RESEARCH_KV.get(`thumb:${thumbMatch[1]}:0`, { type: "arrayBuffer" })
        ?? await env.RESEARCH_KV.get(`thumb:${thumbMatch[1]}`, { type: "arrayBuffer" });
      if (!data) return new Response("Not found", { status: 404 });
      return new Response(data, {
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" },
      });
    }

    // ── /api/cleanup (wipe all runs + thumbnails, password-protected) ───── //
    if (url.pathname === "/api/cleanup" && request.method === "POST") {
      let body: { password?: string };
      try { body = (await request.json()) as { password?: string }; }
      catch { return Response.json({ error: "Invalid JSON body." }, { status: 400 }); }
      if (!body.password || body.password !== env.MANUAL_PASSWORD) {
        return Response.json({ error: "Invalid access key." }, { status: 401 });
      }
      try {
        // Wipe D1 — CASCADE handles docs and reflect_passes automatically.
        await env.RESEARCH_DB.batch([
          env.RESEARCH_DB.prepare("DELETE FROM runs"),
          env.RESEARCH_DB.prepare(
            "DELETE FROM sqlite_sequence WHERE name IN ('runs','docs','reflect_passes')",
          ),
        ]);
        // Wipe KV thumbnails and latest_id pointer.
        let cursor: string | undefined;
        do {
          const page = await env.RESEARCH_KV.list({ prefix: "thumb:", ...(cursor ? { cursor } : {}) });
          await Promise.all(page.keys.map((k) => env.RESEARCH_KV.delete(k.name)));
          cursor = page.list_complete ? undefined : (page as { cursor?: string }).cursor;
        } while (cursor);
        await env.RESEARCH_KV.delete("latest_id");
        console.log("[cleanup] all runs and thumbnails deleted");
        return Response.json({ ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("[cleanup]", message);
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
      // ctx.waitUntil keeps the Worker alive even after the stream closes.
      // Thumbnail generates AFTER research so it can use actual headline context;
      // we close the stream first and generate in the background — client polls.
      ctx.waitUntil((async () => {
        const emit = (data: object): Promise<void> => {
          try { return writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
          catch { return Promise.resolve(); }
        };
        const close = async () => { try { await writer.close(); } catch {} };

        const timeout = setTimeout(() => {
          void Promise.race([
            emit({ type: "error", message: "Research timed out — try fewer passes or a shorter look-back." }),
            new Promise<void>((r) => setTimeout(r, 2_000)),
          ]).finally(close);
        }, 45_000);

        let storedId: number | undefined;
        let storedDocs: Array<{ title: string }> = [];

        try {
          const stored = await runAndStore(
            env, topic, question, days, maxIter, model, "manual",
            (event) => { void emit(event); },
          );
          storedId = stored.id;
          storedDocs = stored.docs.filter((d) => d.title);
          clearTimeout(timeout);

          // Emit thumbnail_start then result — client renders immediately and polls for thumbnails.
          await emit({ type: "thumbnail_start" });
          await emit({ type: "result", ...stored });
        } catch (e) {
          clearTimeout(timeout);
          await emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
        } finally {
          await close();
        }

        // Stream is closed — generate per-article thumbnails in background (parallel).
        // Workers AI binding is exempt from HTTP wall-clock limits; ~5s for all 5.
        if (storedId !== undefined && storedDocs.length > 0) {
          try {
            await generateAndStoreThumbnails(env, storedId, storedDocs);
          } catch (e) {
            console.error("[run] post-stream thumbnails failed (non-fatal):", e);
          }
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
      const result = await runAndStore(
        env, CRON_TOPIC, CRON_QUESTION, CRON_DAYS, CRON_MAX_ITERATIONS, CRON_MODEL, "cron",
      );
      console.log("[cron] daily research run complete");

      try {
        await generateAndStoreThumbnails(env, result.id, result.docs.filter((d) => d.title));
      } catch (e) {
        console.error("[cron] thumbnail generation failed (non-fatal):", e);
      }

      if (env.RESEND_API_KEY && env.NOTIFY_EMAIL && env.NOTIFY_FROM) {
        try {
          await sendBriefingEmail(
            env.RESEND_API_KEY, env.NOTIFY_EMAIL, env.NOTIFY_FROM,
            result.topic, result.runAt, result.model, result.answer, result.docs.length,
          );
        } catch (e) {
          console.error("[cron] email send failed (non-fatal):", e);
        }
      }
    } catch (e) {
      console.error("[cron] research run failed:", e);
    }
  },
};
