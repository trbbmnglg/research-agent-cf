// D1 database helpers — all SQL lives here, index.ts stays SQL-free.

import type { Doc, ReflectRecord, Provider } from "./agent";

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //
export interface RunSummary {
  id: number;
  run_at: string;
  topic: string;
  question: string;
  provider: string;
  model: string;
  trigger: string;
  doc_count: number;
  image_url?: string;
}

export interface FullRun extends RunSummary {
  answer: string;
  docs: Doc[];
  history: ReflectRecord[];
}

export interface ListFilters {
  topic?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

// --------------------------------------------------------------------------- //
// Write
// --------------------------------------------------------------------------- //
export async function insertRun(
  db: D1Database,
  run: { answer: string; provider: Provider; model: string; runAt: string; topic: string; question: string },
  docs: Doc[],
  history: ReflectRecord[],
  trigger: "cron" | "manual",
): Promise<number> {
  const runStmt = db.prepare(
    `INSERT INTO runs (run_at, topic, question, provider, model, answer, trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(run.runAt, run.topic, run.question, run.provider, run.model, run.answer, trigger);

  const runResult = await runStmt.first<{ id: number }>();
  if (!runResult) throw new Error("Failed to insert run");
  const runId = runResult.id;

  const batch: D1PreparedStatement[] = [];

  for (const doc of docs) {
    batch.push(
      db.prepare(
        `INSERT INTO docs (run_id, url, title, content, pub_date, relevance, reason, tag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(runId, doc.url, doc.title, doc.content ?? null, doc.date ?? null, doc.relevance ?? null, doc.reason ?? null, doc.tag ?? null),
    );
  }

  for (const pass of history) {
    batch.push(
      db.prepare(
        `INSERT INTO reflect_passes (run_id, iteration, sufficient, gaps, reasoning, decision)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(runId, pass.iteration, pass.sufficient ? 1 : 0, JSON.stringify(pass.gaps ?? []), pass.reasoning ?? null, pass.decision ?? null),
    );
  }

  if (batch.length > 0) await db.batch(batch);
  return runId;
}

export async function updateRunImageUrl(db: D1Database, id: number, imageUrl: string): Promise<void> {
  await db.prepare(`UPDATE runs SET image_url = ? WHERE id = ?`).bind(imageUrl, id).run();
}

// --------------------------------------------------------------------------- //
// Read — single run
// --------------------------------------------------------------------------- //
export async function getRun(db: D1Database, id: number): Promise<FullRun | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.run_at, r.topic, r.question, r.provider, r.model, r.trigger, r.answer, r.image_url,
              (SELECT COUNT(*) FROM docs WHERE run_id = r.id) AS doc_count
       FROM runs r WHERE r.id = ?`,
    )
    .bind(id)
    .first<RunSummary & { answer: string }>();
  if (!row) return null;
  return attachDetails(db, row);
}

export async function getLatestRun(db: D1Database): Promise<FullRun | null> {
  const row = await db
    .prepare(
      `SELECT r.id, r.run_at, r.topic, r.question, r.provider, r.model, r.trigger, r.answer, r.image_url,
              (SELECT COUNT(*) FROM docs WHERE run_id = r.id) AS doc_count
       FROM runs r ORDER BY r.run_at DESC LIMIT 1`,
    )
    .first<RunSummary & { answer: string }>();
  if (!row) return null;
  return attachDetails(db, row);
}

async function attachDetails(
  db: D1Database,
  row: RunSummary & { answer: string },
): Promise<FullRun> {
  const [docsResult, passesResult] = await db.batch([
    db.prepare(`SELECT * FROM docs WHERE run_id = ? ORDER BY relevance DESC`).bind(row.id),
    db.prepare(`SELECT * FROM reflect_passes WHERE run_id = ? ORDER BY iteration ASC`).bind(row.id),
  ]);

  const docs: Doc[] = (docsResult.results as Array<{
    url: string; title: string; content: string; pub_date: string;
    relevance: number; reason: string; tag: string;
  }>).map((d) => ({
    url: d.url,
    title: d.title,
    content: d.content,
    date: d.pub_date,
    relevance: d.relevance,
    reason: d.reason,
    tag: d.tag as Doc["tag"],
  }));

  const history: ReflectRecord[] = (passesResult.results as Array<{
    iteration: number; sufficient: number; gaps: string; reasoning: string; decision: string;
  }>).map((p) => ({
    iteration: p.iteration,
    sufficient: p.sufficient === 1,
    gaps: JSON.parse(p.gaps || "[]") as string[],
    reasoning: p.reasoning,
    decision: p.decision,
  }));

  return { ...row, docs, history };
}

// --------------------------------------------------------------------------- //
// Read — cross-run intelligence (used by the agent to learn across runs)
// --------------------------------------------------------------------------- //

// Most recent run for a given topic — used to compute the dynamic lookback window.
export async function getLatestRunForTopic(
  db: D1Database,
  topic: string,
): Promise<{ run_at: string } | null> {
  return db
    .prepare(`SELECT run_at FROM runs WHERE topic LIKE ? ORDER BY run_at DESC LIMIT 1`)
    .bind(`%${topic}%`)
    .first<{ run_at: string }>();
}

// Unique gap strings from reflect_passes across recent runs on a topic.
// The plan node passes these to the LLM so the next run fills known blind spots.
export async function getRecentGaps(
  db: D1Database,
  topic: string,
  limit = 10,
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT rp.gaps FROM reflect_passes rp
       JOIN runs r ON rp.run_id = r.id
       WHERE r.topic LIKE ?
       ORDER BY r.run_at DESC, rp.iteration DESC
       LIMIT ?`,
    )
    .bind(`%${topic}%`, limit)
    .all<{ gaps: string }>();

  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of rows.results) {
    try {
      const parsed = JSON.parse(row.gaps || "[]") as string[];
      for (const gap of parsed) {
        const g = typeof gap === "string" ? gap.trim() : "";
        if (g && !seen.has(g)) { seen.add(g); result.push(g); }
      }
    } catch { /* ignore malformed */ }
  }
  return result.slice(0, 8);
}

// --------------------------------------------------------------------------- //
// Read — list
// --------------------------------------------------------------------------- //
export async function listRuns(db: D1Database, filters: ListFilters): Promise<RunSummary[]> {
  const conditions: string[] = [];
  const bindings: (string | number)[] = [];

  if (filters.topic) {
    conditions.push("topic LIKE ?");
    bindings.push(`%${filters.topic}%`);
  }
  if (filters.from) {
    conditions.push("run_at >= ?");
    bindings.push(filters.from);
  }
  if (filters.to) {
    conditions.push("run_at <= ?");
    bindings.push(filters.to + "T23:59:59Z");
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT r.id, r.run_at, r.topic, r.question, r.provider, r.model, r.trigger, r.image_url,
           (SELECT COUNT(*) FROM docs WHERE run_id = r.id) AS doc_count
    FROM runs r
    ${where}
    ORDER BY r.run_at DESC
    LIMIT ? OFFSET ?
  `;
  bindings.push(filters.limit, filters.offset);

  const result = await db.prepare(sql).bind(...bindings).all<RunSummary>();
  return result.results;
}
