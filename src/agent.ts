// The research agent: a self-correcting LangGraph.js graph.
//
//   plan -> search -> score -> synthesize -> reflect
//                                                |
//                       done? --yes--> END       |
//                         ^                       |
//                         |--no---- back to plan (re-plan on the gaps reflect found)
//
// The `reflect` node critiques the agent's own draft, decides whether coverage
// is sufficient, and — if not — hands `gaps` back to `plan` so the next pass
// writes TARGETED queries. The loop is hard-capped by maxIterations.

import { END, START, StateGraph, Annotation } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { PROFILE, type Profile } from "./profile";

// --------------------------------------------------------------------------- //
// Config
// --------------------------------------------------------------------------- //
const FAST_MODEL = "gpt-4o-mini"; // plan / score / reflect (many cheap calls)
const WRITER_MODEL = "gpt-4o-mini"; // synthesize (bump to "gpt-4o" for richer prose)
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

export interface ResearchParams {
  question: string;
  topic: string;
  days?: number;
  maxIterations?: number;
}

export interface Env {
  OPENAI_API_KEY: string;
  TAVILY_API_KEY: string;
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

async function ask(llm: ChatOpenAI, system: string, user: string): Promise<string> {
  const res = await llm.invoke([new SystemMessage(system), new HumanMessage(user)]);
  return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
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
  queries: Annotation<string[]>(),
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
function buildGraph(env: Env) {
  const fastLlm = new ChatOpenAI({ apiKey: env.OPENAI_API_KEY, model: FAST_MODEL, temperature: 0, maxTokens: 1024 });
  const writerLlm = new ChatOpenAI({ apiKey: env.OPENAI_API_KEY, model: WRITER_MODEL, temperature: 0, maxTokens: 3000 });

  // 1. plan — broad queries on the first pass; targeted gap-filling queries after.
  async function plan(state: State): Promise<Partial<State>> {
    const firstPass = state.iteration === 0 || state.gaps.length === 0;
    let system: string, user: string;
    if (firstPass) {
      system =
        "You plan web-news searches for a personalized AI briefing. Given a topic, " +
        "a request, and the reader's profile, write exactly 3 focused search queries " +
        "for RECENT AI news that matter to this reader. Cover different angles; prefer " +
        "concrete events. Reply with ONLY a JSON array of 3 strings.";
      user =
        `Topic: ${state.topic}\nRequest: ${state.question}\n` +
        `Reader profile: ${JSON.stringify(state.profile)}\n` +
        "Return a JSON array of exactly 3 query strings.";
    } else {
      system =
        "You refine searches to fill specific gaps in an AI news briefing. Given the " +
        "gaps a critic found, write 2-3 TARGETED search queries that surface exactly " +
        "the missing information. Be specific. Reply with ONLY a JSON array of strings.";
      user =
        `Topic: ${state.topic}\nOriginal request: ${state.question}\n` +
        `Reader profile: ${JSON.stringify(state.profile)}\n` +
        `Gaps to fill: ${JSON.stringify(state.gaps)}\n` +
        "Return a JSON array of 2-3 query strings.";
    }
    try {
      const raw = await ask(fastLlm, system, user);
      const parsed = extractJson<unknown[]>(raw);
      const queries = parsed.filter((q): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 3);
      if (queries.length === 0) throw new Error("empty");
      return { queries };
    } catch {
      return { queries: [state.topic || state.question] };
    }
  }

  // 2. search — run each query, APPEND new docs, dedupe by URL across passes.
  async function search(state: State): Promise<Partial<State>> {
    const seen = new Set(state.docs.map((d) => d.url));
    const newDocs: Doc[] = [];
    for (const q of state.queries) {
      const results = await tavilySearch(env.TAVILY_API_KEY, q, state.days);
      for (const r of results) {
        const url = r.url;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        newDocs.push({
          url,
          title: r.title || url,
          content: (r.content || "").slice(0, 1500),
          date: r.published_date || "",
        });
      }
    }
    return { docs: [...state.docs, ...newDocs] };
  }

  // 3. score — rate each NOT-yet-scored doc against the profile; drop the weak ones.
  async function score(state: State): Promise<Partial<State>> {
    const system =
      "You score one AI-news item for a specific reader and tag its substance.\n" +
      "relevance: 0-10 — how much THIS reader should care, given their role, stack, " +
      "and interests. Penalize anything matching their ignore list.\n" +
      "tag: exactly one of Shipped (generally available), Announced (previewed, not " +
      "usable yet), Research (paper/finding), Hype (speculation/marketing).\n" +
      'Reply with ONLY JSON: {"relevance": <int 0-10>, "reason": "<one line, why it ' +
      'matters to THIS reader>", "tag": "<Shipped|Announced|Research|Hype>"}';
    const docs = state.docs;
    for (const doc of docs) {
      if (doc.relevance !== undefined) continue; // scored on an earlier pass
      const user =
        `Reader profile: ${JSON.stringify(state.profile)}\n\n` +
        `Article:\nTitle: ${doc.title}\nDate: ${doc.date}\nContent: ${doc.content}`;
      try {
        const v = extractJson<{ relevance?: number; reason?: string; tag?: string }>(await ask(fastLlm, system, user));
        doc.relevance = Math.max(0, Math.min(10, Math.round(Number(v.relevance ?? 5))));
        doc.reason = String(v.reason ?? "").trim() || "(no reason)";
        doc.tag = normalizeTag(v.tag);
      } catch {
        doc.relevance = 5;
        doc.reason = "(unscored — could not parse model output)";
        doc.tag = "Announced";
      }
    }
    const kept = docs.filter((d) => (d.relevance ?? 0) >= RELEVANCE_FLOOR);
    kept.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    return { docs: kept };
  }

  // 4. synthesize — draft the briefing from kept docs (already ranked).
  async function synthesize(state: State): Promise<Partial<State>> {
    const docs = state.docs;
    if (docs.length === 0) {
      return { answer: "_No relevant items cleared the bar in this window. Try widening **look back (days)** or broadening the topic._" };
    }
    const context = docs
      .map(
        (d) =>
          `- [${d.relevance}/10] [[${(d.tag ?? "Announced").toUpperCase()}]] ${d.title} | ${d.date} | ${d.url}\n` +
          `  why-relevant: ${d.reason}\n  excerpt: ${d.content.slice(0, 400)}`,
      )
      .join("\n");
    const system =
      "You write a concise, personalized AI-news briefing in markdown.\n" +
      "Rules:\n" +
      "- Group items under short **bold thematic headers**.\n" +
      "- Within a group, keep the given order (most relevant first).\n" +
      "- Each item is one bullet that STARTS with its substance token, copied verbatim " +
      "from the input — exactly one of [[SHIPPED]] [[ANNOUNCED]] [[RESEARCH]] [[HYPE]] — " +
      "then the headline. Do not reword the token or replace it with emoji.\n" +
      "- Add a 'Why this matters to you:' line tied to the reader's role/stack/interests.\n" +
      "- Include the date and an inline markdown link to the source.\n" +
      "- Strip hype and marketing; be plain and useful. Do NOT invent facts beyond the excerpts.\n" +
      "- Start with a one-sentence TL;DR, then the grouped items.";
    const user =
      `Request: ${state.question}\nTopic: ${state.topic}\n` +
      `Reader profile: ${JSON.stringify(state.profile)}\n\n` +
      `Items (already ranked, highest first):\n${context}`;
    return { answer: await ask(writerLlm, system, user) };
  }

  // 5. reflect — THE agentic node: critique the draft, decide whether to loop.
  async function reflect(state: State): Promise<Partial<State>> {
    const iteration = state.iteration + 1;
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
    const record: ReflectRecord = {
      iteration, sufficient, gaps, reasoning,
      decision: sufficient ? "stop — coverage sufficient" : capped ? "stop — hit max passes" : "loop — re-plan on gaps",
    };
    return { iteration, done, gaps: done ? [] : gaps, history: [...state.history, record] };
  }

  const route = (state: State): "continue" | "end" => (state.done ? "end" : "continue");

  const graph = new StateGraph(StateAnnotation)
    .addNode("plan", plan)
    .addNode("search", search)
    .addNode("score", score)
    .addNode("synthesize", synthesize)
    .addNode("reflect", reflect)
    .addEdge(START, "plan")
    .addEdge("plan", "search")
    .addEdge("search", "score")
    .addEdge("score", "synthesize")
    .addEdge("synthesize", "reflect")
    .addConditionalEdges("reflect", route, { continue: "plan", end: END });

  return graph.compile();
}

// --------------------------------------------------------------------------- //
// Public entry point
// --------------------------------------------------------------------------- //
export async function runResearch(env: Env, params: ResearchParams) {
  const app = buildGraph(env);
  const initial: State = {
    question: params.question,
    topic: params.topic,
    days: params.days ?? 7,
    profile: PROFILE,
    queries: [],
    docs: [],
    answer: "",
    iteration: 0,
    maxIterations: params.maxIterations ?? 3,
    gaps: [],
    done: false,
    history: [],
  };
  const final = await app.invoke(initial, { recursionLimit: 50 });
  return { answer: final.answer, docs: final.docs, history: final.history };
}
