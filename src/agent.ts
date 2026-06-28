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
import { PROMPTS } from "./prompts";

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

const MAX_RESULTS_PER_QUERY = 3;
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

// Anthropic returns HTTP 400/402 with "credit balance is too low" when credits
// are exhausted. These errors must NOT be swallowed by node catch blocks —
// we re-throw them so the fallback in runAndStore can switch to OpenAI.
function isCreditsError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return msg.includes("credit") || msg.includes("billing") || msg.includes("payment");
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
      signal: AbortSignal.timeout(6_000),
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
    // Only pass `thinking` for models that support it (claude-4.6 / fable).
    // Passing thinking: disabled to Haiku/other non-thinking models causes 403.
    const adaptive = /-4-6|fable/.test(model);
    return new ChatAnthropic({
      apiKey,
      model,
      maxTokens,
      ...(adaptive ? { thinking: { type: "adaptive" as const }, temperature: 1 } : { temperature: 0 }),
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
      new SystemMessage(PROMPTS.agent.researcher.system),
      new HumanMessage(
        `Topic: ${state.topic}\nRequest: ${state.question}\n` +
        `Reader profile: ${JSON.stringify(state.profile)}${gapContext}`
      ),
    ];

    // Tool-calling loop: Claude decides how many searches to run.
    // One round is enough — Claude calls 2–4 queries in parallel. A second round
    // adds another full LLM + Tavily batch and regularly pushes past the 28s limit.
    const MAX_ROUNDS = 1;
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

      // If MAX_ROUNDS was reached with tool results still pending (Claude called tools
      // in every round), give it one final tool-free pass so it can acknowledge what
      // it found. Without this, the last round's results are collected but never
      // processed by the LLM, leaving a dangling ToolMessage at the end of history.
      const lastMsg = messages[messages.length - 1];
      if (lastMsg instanceof ToolMessage) {
        const ack = (await fastLlm.invoke(messages)) as AIMessage;
        messages.push(ack);
      }
    } catch (e) {
      if (isCreditsError(e)) throw e;
      console.error("[researcher] tool loop failed:", e);
    }

    return { docs: [...state.docs, ...newDocs] };
  }

  // 3. score — rate each NOT-yet-scored doc in parallel; drop the weak ones.
  async function score(state: State): Promise<Partial<State>> {
    const unscored = state.docs.filter((doc) => doc.relevance === undefined);
    onProgress?.({ type: "score_start", total: unscored.length });
    const system = PROMPTS.agent.score.system;
    const docs = state.docs;
    await Promise.all(
      docs
        .filter((doc) => doc.relevance === undefined)  // already filtered above for count
        .map(async (doc) => {
          const user =
            `Reader profile: ${JSON.stringify(state.profile)}\n\n` +
            `Article:\nTitle: ${doc.title}\nDate: ${doc.date}\nContent: ${doc.content}`;
          try {
            let scoreTimer: ReturnType<typeof setTimeout> | undefined;
            const raw = await Promise.race([
              ask(fastLlm, system, user),
              new Promise<never>((_, rej) => {
                scoreTimer = setTimeout(() => rej(new Error("score timeout")), 3_000);
              }),
            ]).finally(() => clearTimeout(scoreTimer));
            const v = extractJson<{ relevance?: number; reason?: string; tag?: string }>(raw);
            doc.relevance = Math.max(0, Math.min(10, Math.round(Number(v.relevance ?? 5))));
            doc.reason = String(v.reason ?? "").trim() || "(no reason)";
            doc.tag = normalizeTag(v.tag);
          } catch (e) {
            // Timed-out docs get relevance 0 (dropped by the floor filter).
            // Parse/network failures get 5 so the article still has a chance.
            const isTimeout = e instanceof Error && e.message === "score timeout";
            doc.relevance = isTimeout ? 0 : 5;
            doc.reason = isTimeout ? "(score timed out)" : "(unscored — could not parse model output)";
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
    const system = PROMPTS.agent.synthesize.system;
    const user =
      `Request: ${state.question}\nTopic: ${state.topic}\n` +
      `Reader profile: ${JSON.stringify(state.profile)}\n\n` +
      `Items (already ranked, highest first):\n${context}`;
    try {
      return { answer: await ask(writerLlm, system, user) };
    } catch (e) {
      if (isCreditsError(e)) throw e;
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
    const system = PROMPTS.agent.reflect.system;
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
      if (isCreditsError(e)) throw e;
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
  let base: string;
  try {
    // Build with placeholder keys — we only need the graph structure, never invoke.
    const compiled = buildGraph("anthropic", "claude-haiku-4-5-20251001", "sk-ant-placeholder", "placeholder");
    base = compiled.getGraph().drawMermaid();
  } catch {
    base = [
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
  // Append thumbnail as a post-research step (runs after the agent loop ends).
  const classDefIdx = base.search(/\n\s*classDef\b/);
  if (classDefIdx !== -1) {
    return (
      base.slice(0, classDefIdx) +
      "\n  thumbnail(thumbnail)" +
      "\n  __end__ --> thumbnail" +
      base.slice(classDefIdx) +
      "\n  class thumbnail last"
    );
  }
  return base + "\n  thumbnail(thumbnail)\n  __end__ --> thumbnail";
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
