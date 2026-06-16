// The research agent: a self-correcting LangGraph.js graph.
//
//   researcher (tool-calling) -> score -> synthesize -> reflect
//        ^                                                 |
//        |---- gaps? loop back ────────────────────────────┤
//                                                          ▼
//                                    coverage good OR cap hit -> END
//
// The `researcher` node binds a search_news tool to Claude and lets it decide
// what to search, how many queries to run, and when it has enough material.
// `reflect` critiques the draft and hands gaps back to `researcher` if coverage
// is thin, repeating until sufficient or the iteration cap is hit.
//
// The `reflect` node critiques the agent's own draft, decides whether coverage
// is sufficient, and — if not — hands `gaps` back to `plan` so the next pass
// writes TARGETED queries. The loop is hard-capped by maxIterations.

import { END, START, StateGraph, Annotation } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { PROFILE, type Profile } from "./profile";

// --------------------------------------------------------------------------- //
// Providers & models — the UI picks one per request. Search/fetch is handled by
// the agent via Tavily, so any capable chat model works as the reasoner.
// --------------------------------------------------------------------------- //
export type Provider = "openai" | "anthropic";

export const MODELS: Record<Provider, { id: string; label: string }[]> = {
  openai: [
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4o", label: "GPT-4o" },
    { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
  ],
};

const DEFAULTS: Record<Provider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20251001",
};

function resolveModel(provider: Provider, model?: string): string {
  const allowed = MODELS[provider].map((m) => m.id);
  return model && allowed.includes(model) ? model : DEFAULTS[provider];
}

const MAX_RESULTS_PER_QUERY = 5;
const RELEVANCE_FLOOR = 4;

// Soft preference — quality AI sources. If a query starves against these, the
// search step retries that one query WITHOUT the filter.
const QUALITY_DOMAINS = [
  "anthropic.com", "openai.com", "deepmind.google", "ai.meta.com",
  "mistral.ai", "huggingface.co", "arxiv.org", "simonwillison.net",
  "techcrunch.com", "theverge.com", "arstechnica.com", "venturebeat.com",
  "theinformation.com", "semianalysis.com", "langchain.com",
];

const VALID_TAGS = ["Shipped", "Announced", "Research", "Hype"] as const;
type Tag = (typeof VALID_TAGS)[number];

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //
export interface Doc {
  url: string;
  title: string;
  content: string;
  date: string;
  relevance?: number;
  reason?: string;
  tag?: Tag;
}

export interface ReflectRecord {
  iteration: number;
  sufficient: boolean;
  gaps: string[];
  reasoning: string;
  decision: string;
}

export type ProgressEvent =
  | { type: "researcher_start"; iteration: number }
  | { type: "tool_call"; query: string }
  | { type: "tool_result"; query: string; found: number }
  | { type: "score_start"; total: number }
  | { type: "score_done"; kept: number }
  | { type: "synthesize_start" }
  | { type: "reflect_start"; iteration: number }
  | { type: "reflect_done"; sufficient: boolean; gaps: string[] };

export interface ResearchParams {
  question: string;
  topic: string;
  days?: number;
  maxIterations?: number;
  provider?: Provider;
  model?: string;
  apiKey: string;
  tavilyKey: string;
  priorGaps?: string[];
  onProgress?: (event: ProgressEvent) => void;
}

// --------------------------------------------------------------------------- //
// Small helpers
// --------------------------------------------------------------------------- //
function extractJson<T = unknown>(text: string): T {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t) as T;
  } catch {
    /* fall through */
  }
  const m = t.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (m) return JSON.parse(m[1]) as T;
  throw new Error(`No JSON found in: ${text.slice(0, 160)}`);
}

function normalizeTag(tag: unknown): Tag {
  const t = String(tag ?? "").trim().toLowerCase();
  const hit = VALID_TAGS.find((v) => v.toLowerCase() === t);
  return hit ?? "Announced";
}

async function ask(llm: BaseChatModel, system: string, user: string): Promise<string> {
  const res = await llm.invoke([new SystemMessage(system), new HumanMessage(user)]);
  const c = res.content as unknown;
  if (typeof c === "string") return c;
  // Anthropic adaptive/extended thinking returns an array of content blocks —
  // keep only the text blocks (skip "thinking" blocks) so JSON parsing works.
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        typeof b === "string"
          ? b
          : b && typeof b === "object" && "text" in b
            ? String((b as { text?: unknown }).text ?? "")
            : "",
      )
      .join("");
  }
  return String(c);
}

interface TavilyResult { url?: string; title?: string; content?: string; published_date?: string; }

async function tavilySearch(apiKey: string, query: string, days: number): Promise<TavilyResult[]> {
  const call = async (useDomains: boolean): Promise<TavilyResult[]> => {
    const body: Record<string, unknown> = {
      query, topic: "news", days, max_results: MAX_RESULTS_PER_QUERY,
    };
    if (useDomains) body.include_domains = QUALITY_DOMAINS;
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { results?: TavilyResult[] };
    return data.results ?? [];
  };
  try {
    let results = await call(true);
    // soft preference: if the curated list starved this query, retry open
    if (results.length < 2) results = await call(false);
    return results;
  } catch (e) {
    console.error(`[search] query failed: ${query} -> ${e}`);
    return [];
  }
}

// --------------------------------------------------------------------------- //
// Graph state
// --------------------------------------------------------------------------- //
const StateAnnotation = Annotation.Root({
  question: Annotation<string>(),
  topic: Annotation<string>(),
  days: Annotation<number>(),
  profile: Annotation<Profile>(),
  docs: Annotation<Doc[]>(),
  answer: Annotation<string>(),
  iteration: Annotation<number>(),
  maxIterations: Annotation<number>(),
  gaps: Annotation<string[]>(),
  done: Annotation<boolean>(),
  history: Annotation<ReflectRecord[]>(),
});
type State = typeof StateAnnotation.State;

// --------------------------------------------------------------------------- //
// Graph factory — built per request so nodes can close over the LLM clients
// (Workers inject secrets via env, not process.env).
// --------------------------------------------------------------------------- //
function makeLlm(provider: Provider, model: string, apiKey: string, maxTokens: number): BaseChatModel {
  if (provider === "anthropic") {
    // Claude 4.6 / Fable use adaptive thinking and REJECT thinking.type.disabled.
    // Claude 4.5 (Haiku) doesn't support adaptive but accepts disabled (cheaper/faster).
    // `thinking` requires temperature: 1; disabled lets us pin a deterministic 0.
    const adaptive = /-4-6|fable/.test(model);
    return new ChatAnthropic({
      apiKey,
      model,
      maxTokens,
      thinking: adaptive ? { type: "adaptive" } : { type: "disabled" },
      temperature: adaptive ? 1 : 0,
    });
  }
  return new ChatOpenAI({ apiKey, model, temperature: 0, maxTokens });
}

function buildGraph(
  provider: Provider,
  model: string,
  apiKey: string,
  tavilyKey: string,
  priorGaps: string[] = [],
  onProgress?: (event: ProgressEvent) => void,
) {
  // generous caps — adaptive/extended thinking tokens count against max_tokens
  const fastLlm = makeLlm(provider, model, apiKey, 2048);
  const writerLlm = makeLlm(provider, model, apiKey, 6000);

  // 1. researcher — tool-calling node: Claude decides what to search and when to stop.
  //    Replaces the old hardcoded plan → search pipeline.
  async function researcher(state: State): Promise<Partial<State>> {
    onProgress?.({ type: "researcher_start", iteration: state.iteration });
    const seenUrls = new Set(state.docs.map((d) => d.url));
    const newDocs: Doc[] = [];

    // The search tool — Claude calls this; we execute via Tavily, dedupe by URL.
    const searchTool = tool(
      async ({ query }: { query: string }): Promise<string> => {
        onProgress?.({ type: "tool_call", query });
        const results = await tavilySearch(tavilyKey, query, state.days);
        const fresh: Doc[] = [];
        for (const r of results) {
          if (!r.url || seenUrls.has(r.url)) continue;
          seenUrls.add(r.url);
          fresh.push({
            url: r.url,
            title: r.title || r.url,
            content: (r.content || "").slice(0, 1500),
            date: r.published_date || "",
          });
        }
        newDocs.push(...fresh);
        onProgress?.({ type: "tool_result", query, found: fresh.length });
        return fresh.length > 0
          ? `Found ${fresh.length} articles: ${fresh.map((d) => `"${d.title}" (${d.date})`).join(", ")}`
          : "No new articles found for this query.";
      },
      {
        name: "search_news",
        description:
          "Search for recent AI news articles on a specific angle. " +
          "Call this tool multiple times with different queries to cover the topic comprehensively.",
        schema: z.object({
          query: z.string().describe("A specific search query for recent AI news"),
        }),
      },
    );

    // bindTools is defined on ChatAnthropic/ChatOpenAI but typed as optional on BaseChatModel
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const llmWithTools = fastLlm.bindTools!([searchTool]);

    const isFirstPass = state.iteration === 0;
    const gapContext = isFirstPass && priorGaps.length > 0
      ? `\nKnown blind spots from previous runs on this topic (address at least one): ${JSON.stringify(priorGaps.slice(0, 5))}`
      : state.gaps.length > 0
      ? `\nGaps to fill from the previous draft's critique: ${JSON.stringify(state.gaps)}`
      : "";

    const messages: BaseMessage[] = [
      new SystemMessage(
        "You are a news research assistant gathering articles for a personalized AI briefing.\n" +
        "Use the search_news tool to find relevant articles. Call it 2–4 times with varied queries " +
        "to cover the topic from multiple angles (broad overview, specific sub-topics, key players).\n" +
        "Stop calling tools once you have gathered enough material."
      ),
      new HumanMessage(
        `Topic: ${state.topic}\nRequest: ${state.question}\n` +
        `Reader profile: ${JSON.stringify(state.profile)}${gapContext}`
      ),
    ];

    // Tool-calling loop: Claude decides how many searches to run.
    const MAX_ROUNDS = 2;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const response = (await llmWithTools.invoke(messages)) as AIMessage;
        messages.push(response);

        const toolCalls = response.tool_calls ?? [];
        if (toolCalls.length === 0) break;

        // Execute all tool calls in parallel (same pattern as before).
        const toolMsgs = await Promise.all(
          toolCalls.map(async (call) => {
            try {
              const result = await searchTool.invoke(call.args as { query: string });
              return new ToolMessage({ tool_call_id: call.id ?? "call", content: String(result) });
            } catch (e) {
              return new ToolMessage({
                tool_call_id: call.id ?? "call",
                content: `Search failed: ${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }),
        );
        messages.push(...toolMsgs);
      }
    } catch (e) {
      console.error("[researcher] tool loop failed:", e);
    }

    return { docs: [...state.docs, ...newDocs] };
  }

  // 3. score — rate each NOT-yet-scored doc in parallel; drop the weak ones.
  async function score(state: State): Promise<Partial<State>> {
    const unscored = state.docs.filter((doc) => doc.relevance === undefined);
    onProgress?.({ type: "score_start", total: unscored.length });
    const system =
      "You score one AI-news item for a specific reader and tag its substance.\n" +
      "relevance: 0-10 — how much THIS reader should care, given their role, stack, " +
      "and interests. Penalize anything matching their ignore list.\n" +
      "tag: exactly one of Shipped (generally available), Announced (previewed, not " +
      "usable yet), Research (paper/finding), Hype (speculation/marketing).\n" +
      'Reply with ONLY JSON: {"relevance": <int 0-10>, "reason": "<one line, why it ' +
      'matters to THIS reader>", "tag": "<Shipped|Announced|Research|Hype>"}';
    const docs = state.docs;
    await Promise.all(
      docs
        .filter((doc) => doc.relevance === undefined)  // already filtered above for count
        .map(async (doc) => {
          const user =
            `Reader profile: ${JSON.stringify(state.profile)}\n\n` +
            `Article:\nTitle: ${doc.title}\nDate: ${doc.date}\nContent: ${doc.content}`;
          try {
            const raw = await Promise.race([
              ask(fastLlm, system, user),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("score timeout")), 5_000)),
            ]);
            const v = extractJson<{ relevance?: number; reason?: string; tag?: string }>(raw);
            doc.relevance = Math.max(0, Math.min(10, Math.round(Number(v.relevance ?? 5))));
            doc.reason = String(v.reason ?? "").trim() || "(no reason)";
            doc.tag = normalizeTag(v.tag);
          } catch {
            doc.relevance = 5;
            doc.reason = "(unscored — could not parse model output)";
            doc.tag = "Announced";
          }
        }),
    );
    const kept = docs.filter((d) => (d.relevance ?? 0) >= RELEVANCE_FLOOR);
    kept.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    onProgress?.({ type: "score_done", kept: kept.length });
    return { docs: kept };
  }

  // 4. synthesize — draft the briefing from kept docs (already ranked).
  async function synthesize(state: State): Promise<Partial<State>> {
    onProgress?.({ type: "synthesize_start" });
    const docs = state.docs;
    if (docs.length === 0) {
      return { answer: "_No relevant items cleared the bar in this window. Try widening **look back (days)** or broadening the topic._" };
    }
    const context = docs
      .map(
        (d) =>
          `[[${(d.tag ?? "Announced").toUpperCase()}]] ${d.title}\n` +
          `  date: ${d.date}\n` +
          `  source_url: ${d.url}\n` +
          `  relevance: ${d.relevance}/10 — ${d.reason}\n` +
          `  excerpt: ${d.content.slice(0, 400)}`,
      )
      .join("\n\n");
    const system =
      "You write a concise, personalized AI-news briefing in markdown.\n" +
      "Rules:\n" +
      "- Do NOT use emoji anywhere — no emoji in headers, items, or body text.\n" +
      "- Group items under ## markdown headings (e.g. '## Agentic AI'). Use ## not bold text.\n" +
      "- Within a group, keep the given order (most relevant first).\n" +
      "- Each item follows this EXACT three-line structure:\n" +
      "    - [[TAG]] Headline — Source Name, Date\n" +
      "      Description. Why this matters to you: one sentence tied to reader role/stack.\n" +
      "      [→ source](source_url)\n" +
      "  Line 1: the [[TAG]] token then headline then source name and date. NO URL on this line.\n" +
      "  Line 2: description and why-it-matters. NO URL on this line.\n" +
      "  Line 3: the markdown link [→ source](source_url) — use the exact source_url from the input. NOTHING ELSE on this line.\n" +
      "- Strip hype and marketing; be plain and useful. Do NOT invent facts beyond the excerpts.\n" +
      "- Start with a one-sentence TL;DR, then the grouped items.";
    const user =
      `Request: ${state.question}\nTopic: ${state.topic}\n` +
      `Reader profile: ${JSON.stringify(state.profile)}\n\n` +
      `Items (already ranked, highest first):\n${context}`;
    try {
      return { answer: await ask(writerLlm, system, user) };
    } catch (e) {
      // fail safe: don't 500 the whole run if the writer call fails — show the
      // raw matches (which the UI lists under Sources) plus the error.
      const msg = e instanceof Error ? e.message : String(e);
      return { answer: `> ⚠ Couldn't generate the briefing (model error): ${msg}\n\nThe matched sources are listed under **Sources & scores** below.` };
    }
  }

  // 5. reflect — THE agentic node: critique the draft, decide whether to loop.
  async function reflect(state: State): Promise<Partial<State>> {
    const iteration = state.iteration + 1;
    onProgress?.({ type: "reflect_start", iteration });
    const system =
      "You are a strict editor judging whether an AI-news briefing fully answers the " +
      "reader's request given their profile. Identify concrete MISSING angles, " +
      "sub-topics, or recent developments the draft should have covered but didn't. " +
      "Be honest but don't invent needs.\n" +
      'Reply with ONLY JSON: {"sufficient": <true|false>, "gaps": ["specific missing ' +
      'angle", ...], "reasoning": "<one short paragraph>"}';
    const user =
      `Original request: ${state.question}\nTopic: ${state.topic}\n` +
      `Reader profile: ${JSON.stringify(state.profile)}\n\nBriefing draft:\n${state.answer}`;

    let sufficient = true, gaps: string[] = [], reasoning = "";
    try {
      const v = extractJson<{ sufficient?: boolean; gaps?: unknown[]; reasoning?: string }>(await ask(fastLlm, system, user));
      sufficient = Boolean(v.sufficient ?? true);
      gaps = (v.gaps ?? []).filter((g): g is string => typeof g === "string" && g.trim().length > 0);
      reasoning = String(v.reasoning ?? "").trim();
    } catch (e) {
      // fail safe: a malformed critique must NOT cause an infinite loop
      sufficient = true; gaps = []; reasoning = `(reflect parse failed, stopping: ${e})`;
    }
    const capped = iteration >= state.maxIterations;
    const done = sufficient || capped;
    onProgress?.({ type: "reflect_done", sufficient: done ? true : sufficient, gaps });
    const record: ReflectRecord = {
      iteration, sufficient, gaps, reasoning,
      decision: sufficient ? "stop — coverage sufficient" : capped ? "stop — hit max passes" : "loop — re-plan on gaps",
    };
    return { iteration, done, gaps: done ? [] : gaps, history: [...state.history, record] };
  }

  const route = (state: State): "continue" | "end" => (state.done ? "end" : "continue");

  const graph = new StateGraph(StateAnnotation)
    .addNode("researcher", researcher)
    .addNode("score", score)
    .addNode("synthesize", synthesize)
    .addNode("reflect", reflect)
    .addEdge(START, "researcher")
    .addEdge("researcher", "score")
    .addEdge("score", "synthesize")
    .addEdge("synthesize", "reflect")
    .addConditionalEdges("reflect", route, { continue: "researcher", end: END });

  return graph.compile();
}

// --------------------------------------------------------------------------- //
// Graph diagram — used by /api/graph to show the agentic loop in the UI.
// --------------------------------------------------------------------------- //
export function getGraphDiagram(): string {
  try {
    // Build with placeholder keys — we only need the graph structure, never invoke.
    const compiled = buildGraph("anthropic", "claude-haiku-4-5-20251001", "sk-ant-placeholder", "placeholder");
    return compiled.getGraph().drawMermaid();
  } catch {
    // Fallback if the build or drawMermaid throws
    return [
      "graph TD",
      "  __start__([Start]):::first",
      "  researcher(researcher)",
      "  score(score)",
      "  synthesize(synthesize)",
      "  reflect(reflect)",
      "  __end__([End]):::last",
      "  __start__ --> researcher",
      "  researcher --> score",
      "  score --> synthesize",
      "  synthesize --> reflect",
      "  reflect -.-> researcher",
      "  reflect -.-> __end__",
      "  classDef first fill-opacity:0",
      "  classDef last fill:#1a0533",
    ].join("\n");
  }
}

// --------------------------------------------------------------------------- //
// Public entry point
// --------------------------------------------------------------------------- //
export async function runResearch(params: ResearchParams) {
  const provider: Provider = params.provider === "openai" ? "openai" : "anthropic";
  const model = resolveModel(provider, params.model);
  const app = buildGraph(provider, model, params.apiKey, params.tavilyKey, params.priorGaps ?? [], params.onProgress);
  const initial: State = {
    question: params.question,
    topic: params.topic,
    days: params.days ?? 7,
    profile: PROFILE,
    docs: [],
    answer: "",
    iteration: 0,
    maxIterations: params.maxIterations ?? 3,
    gaps: [],
    done: false,
    history: [],
  };
  const final = await app.invoke(initial, { recursionLimit: 50 });
  return { answer: final.answer, docs: final.docs, history: final.history, provider, model };
}
