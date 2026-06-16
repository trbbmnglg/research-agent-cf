CREATE TABLE runs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at   TEXT    NOT NULL,
  topic    TEXT    NOT NULL,
  question TEXT    NOT NULL,
  provider TEXT    NOT NULL,
  model    TEXT    NOT NULL,
  answer   TEXT    NOT NULL,
  trigger  TEXT    NOT NULL DEFAULT 'cron'
);
CREATE INDEX idx_runs_run_at ON runs(run_at DESC);
CREATE INDEX idx_runs_topic  ON runs(topic);

CREATE TABLE docs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url       TEXT    NOT NULL,
  title     TEXT    NOT NULL,
  content   TEXT,
  pub_date  TEXT,
  relevance INTEGER,
  reason    TEXT,
  tag       TEXT
);
CREATE INDEX idx_docs_run_id ON docs(run_id);
CREATE INDEX idx_docs_url    ON docs(url);

CREATE TABLE reflect_passes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  iteration  INTEGER NOT NULL,
  sufficient INTEGER NOT NULL,
  gaps       TEXT,
  reasoning  TEXT,
  decision   TEXT
);
CREATE INDEX idx_reflect_run_id ON reflect_passes(run_id);
