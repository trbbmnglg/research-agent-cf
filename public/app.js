import { marked } from "https://cdn.jsdelivr.net/npm/marked/lib/marked.esm.js";

// =========================================================================== //
// Matrix digital rain
// =========================================================================== //
(function matrixRain() {
  const canvas = document.getElementById("matrix");
  const ctx = canvas.getContext("2d");
  const fs = 16;
  let cols, drops, last;
  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cols = Math.floor(canvas.width / fs);
    drops = Array.from({ length: cols }, () => Math.random() * -120);
    last = new Array(cols).fill("");
  }
  resize();
  window.addEventListener("resize", resize);
  const glyphs = "アイウエオカキクケコサシスセソタチツテトナニヌネノﾊﾋﾌﾍﾎ0123456789ABCDEF<>/|=+*#@$%&";
  function draw() {
    ctx.fillStyle = "rgba(4,7,10,0.10)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = fs + "px 'Share Tech Mono', monospace";
    for (let i = 0; i < cols; i++) {
      const ch = glyphs[(Math.random() * glyphs.length) | 0];
      const x = i * fs, y = (drops[i] | 0) * fs;
      ctx.fillStyle = "rgba(0,255,120,0.85)";
      ctx.fillText(last[i] || ch, x, y - fs);
      ctx.fillStyle = "#d8fff0";
      ctx.fillText(ch, x, y);
      last[i] = ch;
      if (y > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 0.85;
    }
    requestAnimationFrame(draw);
  }
  draw();
})();

// =========================================================================== //
// Matrix browser-tab title (decode effect) + animated matrix favicon
// =========================================================================== //
(function matrixTitle() {
  const target = "◢◤ AI NEWS AGENT ◢◤";
  const glyphs = "アイウエオカキクケコサシスセソタチツテト0123456789<>/|=+*#";
  const HOLD = 16;
  let i = 0;
  setInterval(() => {
    const reveal = Math.min(i, target.length);
    let out = "";
    for (let k = 0; k < target.length; k++) {
      const ch = target[k];
      out += k < reveal || !/[a-z0-9]/i.test(ch) ? ch : glyphs[(Math.random() * glyphs.length) | 0];
    }
    document.title = out;
    i = (i + 1) % (target.length + HOLD);
  }, 130);
})();

(function matrixFavicon() {
  const size = 32, fs = 8, cols = size / fs;
  const cv = document.createElement("canvas"); cv.width = size; cv.height = size;
  const ctx = cv.getContext("2d");
  const drops = Array.from({ length: cols }, () => Math.random() * -10);
  const glyphs = "01アイｱ<>=+#";
  let link = document.querySelector("link[rel~='icon']");
  if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
  setInterval(() => {
    ctx.fillStyle = "rgba(0,8,4,0.4)";
    ctx.fillRect(0, 0, size, size);
    ctx.font = fs + "px monospace";
    for (let c = 0; c < cols; c++) {
      const ch = glyphs[(Math.random() * glyphs.length) | 0];
      ctx.fillStyle = "rgba(0,255,120,0.7)";
      ctx.fillText(ch, c * fs, ((drops[c] | 0) - 1) * fs);
      ctx.fillStyle = "#caffe0";
      ctx.fillText(ch, c * fs, (drops[c] | 0) * fs);
      if (drops[c] * fs > size && Math.random() > 0.9) drops[c] = 0;
      drops[c] += 1;
    }
    link.href = cv.toDataURL("image/png");
  }, 220);
})();

// =========================================================================== //
// Neon cursor ring
// =========================================================================== //
(function cursorRing() {
  const ring = document.querySelector(".cursor-ring");
  let mx = innerWidth / 2, my = innerHeight / 2, rx = mx, ry = my;
  const hit = (el) => el && el.closest && el.closest('button,a,[role="button"],summary,input,label');
  addEventListener("mousemove", (e) => { mx = e.clientX; my = e.clientY; });
  document.addEventListener("mouseover", (e) => ring.classList.toggle("hot", !!hit(e.target)), true);
  (function follow() {
    rx += (mx - rx) * 0.18; ry += (my - ry) * 0.18;
    ring.style.transform = `translate3d(${rx}px,${ry}px,0)`;
    requestAnimationFrame(follow);
  })();
})();

// =========================================================================== //
// Cyber sounds + generative background music (Web Audio, no files)
// =========================================================================== //
(function audio() {
  let actx = null;
  const ac = () => {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    return actx;
  };
  const tone = (freq, dur = 0.08, type = "square", gain = 0.05) => {
    const a = ac(), o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, a.currentTime);
    g.gain.linearRampToValueAtTime(gain, a.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g); g.connect(a.destination);
    o.start(); o.stop(a.currentTime + dur);
  };
  const sClick = () => { tone(660, 0.06, "square", 0.06); setTimeout(() => tone(990, 0.05, "square", 0.04), 28); };
  const sHover = () => tone(1250, 0.03, "sine", 0.022);
  const isHit = (el) => el && el.closest && el.closest('button,a,[role="button"],summary');

  let booted = false;
  const boot = () => { if (booted) return; booted = true; tone(220, 0.12, "sawtooth", 0.05); setTimeout(() => tone(880, 0.18, "sawtooth", 0.04), 90); };

  document.addEventListener("pointerdown", (e) => { boot(); if (isHit(e.target)) sClick(); }, true);
  let lastHover = null;
  document.addEventListener("mouseover", (e) => {
    const t = isHit(e.target);
    if (t && t !== lastHover) { lastHover = t; sHover(); }
    if (!t) lastHover = null;
  }, true);

  let music = null;
  const MVOL = 0.13;
  function buildMusic() {
    const a = ac();
    const master = a.createGain(); master.gain.value = 0; master.connect(a.destination);
    const delay = a.createDelay(); delay.delayTime.value = 0.33;
    const fb = a.createGain(); fb.gain.value = 0.34;
    delay.connect(fb); fb.connect(delay); delay.connect(master);
    const lp = a.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 420; lp.Q.value = 7; lp.connect(master);
    const d1 = a.createOscillator(); d1.type = "sawtooth"; d1.frequency.value = 55;
    const d2 = a.createOscillator(); d2.type = "sawtooth"; d2.frequency.value = 82.4; d2.detune.value = 7;
    const dg = a.createGain(); dg.gain.value = 0.12; d1.connect(dg); d2.connect(dg); dg.connect(lp);
    const lfo = a.createOscillator(); lfo.frequency.value = 0.05;
    const lfoG = a.createGain(); lfoG.gain.value = 260; lfo.connect(lfoG); lfoG.connect(lp.frequency);
    d1.start(); d2.start(); lfo.start();
    const scale = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
    const note = () => {
      const f = scale[(Math.random() * scale.length) | 0] * (Math.random() < 0.22 ? 2 : 1);
      const o = a.createOscillator(); o.type = "square"; o.frequency.value = f;
      const g = a.createGain(); g.gain.value = 0;
      o.connect(g); g.connect(delay); g.connect(master);
      const t = a.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      o.start(t); o.stop(t + 0.3);
    };
    setInterval(() => { if (music && music.on) note(); }, 260);
    music = { master, on: false };
  }
  function toggleMusic() {
    if (!music) buildMusic();
    ac();
    music.on = !music.on;
    const t = music.master.context.currentTime;
    music.master.gain.cancelScheduledValues(t);
    music.master.gain.setValueAtTime(music.master.gain.value, t);
    music.master.gain.linearRampToValueAtTime(music.on ? MVOL : 0, t + 0.6);
    return music.on;
  }
  const btn = document.getElementById("musicBtn");
  btn.addEventListener("click", () => {
    const on = toggleMusic();
    btn.innerHTML = on ? "&#9835; MUSIC: ON" : "&#9835; MUSIC: OFF";
    btn.classList.toggle("on", on);
  });
})();

// =========================================================================== //
// Substance-tag badges
// =========================================================================== //
const TAG_SLUG = { Shipped: "shipped", Announced: "announced", Research: "research", Hype: "hype" };
const tagChip = (tag) => `<span class="cyber-tag tag-${TAG_SLUG[tag] || "announced"}">${tag}</span>`;
const tagify = (text) =>
  text.replace(/\[\[(SHIPPED|ANNOUNCED|RESEARCH|HYPE)\]\]/gi, (_, t) =>
    tagChip(t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()),
  );
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function timeAgo(iso) {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Strip any emoji the LLM smuggles in despite the prompt instruction.
// Uses Unicode property escapes (supported in all modern V8 environments).
function stripEmoji(text) {
  return text
    .replace(/\p{Emoji_Presentation}/gu, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/ {2,}/g, " ");
}

// =========================================================================== //
// DOM refs + controls
// =========================================================================== //
const $ = (id) => document.getElementById(id);
const daysEl = $("days"), passesEl = $("passes"), modelEl = $("model");
const passwordEl = $("password");
const briefingEl = $("briefing"), statusEl = $("status");
const sourcesEl = $("sources"), sourcesBody = $("sourcesBody");
const reasoningEl = $("reasoning"), reasoningBody = $("reasoningBody");
const lastRunLabel = $("lastRunLabel");
const runPanel = $("runPanel");
const toggleBtn = $("toggleRunPanel");
const historyPanel = $("historyPanel");
const historyList = $("historyList");
const historyPagination = $("historyPagination");
let busy = false;
let pendingTopic = "", pendingQuestion = "";

// History state
const PAGE_SIZE = 20;
let histPage = 1;
let histFilters = { topic: "", from: "", to: "" };

daysEl.addEventListener("input", () => ($("daysVal").textContent = daysEl.value));
passesEl.addEventListener("input", () => ($("passVal").textContent = passesEl.value));

// Model picker — Anthropic only (server uses ANTHROPIC_API_KEY).
let MODELS = { anthropic: [{ id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" }] };
function populateModels() {
  modelEl.innerHTML = MODELS.anthropic.map((m) => `<option value="${m.id}">${m.label}</option>`).join("");
}
fetch("/api/models")
  .then((r) => r.json())
  .then((data) => { if (data && data.anthropic) MODELS = data; populateModels(); })
  .catch(() => populateModels());
populateModels();

// =========================================================================== //
// Panel toggles
// =========================================================================== //
toggleBtn.addEventListener("click", () => {
  const willShow = runPanel.hidden;
  runPanel.hidden = !willShow;
  toggleBtn.textContent = willShow ? "[ CANCEL ]" : "[ RUN NOW ]";
  if (willShow) { historyPanel.hidden = true; $("toggleHistoryPanel").textContent = "[ HISTORY ]"; passwordEl.focus(); }
});

$("toggleHistoryPanel").addEventListener("click", () => {
  const willShow = historyPanel.hidden;
  historyPanel.hidden = !willShow;
  $("toggleHistoryPanel").textContent = willShow ? "[ CLOSE ]" : "[ HISTORY ]";
  if (willShow) { runPanel.hidden = true; toggleBtn.textContent = "[ RUN NOW ]"; loadHistory(); }
});

// History filters
$("applyFilter").addEventListener("click", () => {
  histFilters = {
    topic: $("filterTopic").value.trim(),
    from:  $("filterFrom").value,
    to:    $("filterTo").value,
  };
  histPage = 1;
  loadHistory();
});
$("histPrev").addEventListener("click", () => { if (histPage > 1) { histPage--; loadHistory(); } });
$("histNext").addEventListener("click", () => { histPage++; loadHistory(); });

// =========================================================================== //
// Presets — fill topic field; auto-run if password is already entered
// =========================================================================== //
document.querySelectorAll(".preset").forEach((b) =>
  b.addEventListener("click", () => {
    pendingTopic = b.dataset.topic;
    pendingQuestion = b.dataset.question;
    $("freeform").value = b.dataset.question;
    if (passwordEl.value.trim()) {
      runManual(b.dataset.topic, b.dataset.question);
    } else {
      passwordEl.focus();
    }
  })
);

$("research").addEventListener("click", () => {
  const q = $("freeform").value.trim();
  const topic = pendingTopic || q;
  const question = pendingQuestion || q;
  pendingTopic = pendingQuestion = "";
  if (!q) { setStatus("Type a question above, or click a quick topic.", false); return; }
  runManual(topic, question);
});

// =========================================================================== //
// Helpers
// =========================================================================== //
function setStatus(msg, spinning) {
  statusEl.hidden = false;
  statusEl.classList.toggle("err", msg.startsWith("⚠"));
  statusEl.innerHTML = (spinning ? '<span class="spinner"></span>' : "") + esc(msg);
}

function setBusy(state) {
  busy = state;
  document.querySelectorAll(".btn").forEach((b) => (b.disabled = state));
}

// =========================================================================== //
// History
// =========================================================================== //
const TRIGGER_BADGE = {
  cron:   `<span class="hist-badge badge-cron">CRON</span>`,
  manual: `<span class="hist-badge badge-manual">MANUAL</span>`,
};

async function loadHistory() {
  historyList.innerHTML = `<div class="hist-loading"><span class="spinner"></span> Loading history…</div>`;
  historyPagination.hidden = true;
  const offset = (histPage - 1) * PAGE_SIZE;
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset });
  if (histFilters.topic) params.set("topic", histFilters.topic);
  if (histFilters.from)  params.set("from",  histFilters.from);
  if (histFilters.to)    params.set("to",    histFilters.to);
  try {
    const res = await fetch(`/api/runs?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const runs = data.runs || [];
    if (runs.length === 0) {
      historyList.innerHTML = `<p class="hist-empty">No runs found.</p>`;
      return;
    }
    historyList.innerHTML = runs.map((r) => `
      <div class="history-row" data-id="${r.id}">
        <div class="hist-meta">
          <span class="hist-date">${new Date(r.run_at).toLocaleString()}</span>
          ${TRIGGER_BADGE[r.trigger] || ""}
        </div>
        <div class="hist-topic">${esc(r.topic)}</div>
        <div class="hist-stats">${r.doc_count} sources · ${esc(r.model)}</div>
      </div>
    `).join("");
    historyList.querySelectorAll(".history-row").forEach((row) =>
      row.addEventListener("click", () => loadRunById(Number(row.dataset.id)))
    );
    historyPagination.hidden = false;
    $("histPage").textContent = `page ${histPage}`;
    $("histPrev").disabled = histPage <= 1;
    $("histNext").disabled = runs.length < PAGE_SIZE;
  } catch (e) {
    historyList.innerHTML = `<p class="hist-empty">⚠ ${esc(e?.message || e)}</p>`;
  }
}

async function loadRunById(id) {
  setStatus(`Loading run #${id}…`, true);
  briefingEl.hidden = true; sourcesEl.hidden = true; reasoningEl.hidden = true;
  historyPanel.hidden = true;
  $("toggleHistoryPanel").textContent = "[ HISTORY ]";
  try {
    const res = await fetch(`/api/runs/${id}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    renderWithMeta(data);
    statusEl.hidden = true;
  } catch (e) {
    setStatus("⚠ " + (e?.message || e), false);
  }
}

// =========================================================================== //
// Auto-load latest briefing on page load
// =========================================================================== //
async function loadLatest() {
  try {
    const res = await fetch("/api/latest");
    if (res.status === 404) {
      lastRunLabel.textContent = "// NO BRIEFING YET — CLICK RUN NOW TO FETCH THE FIRST ONE";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderWithMeta(data);
  } catch {
    lastRunLabel.textContent = "// COULD NOT LOAD LATEST BRIEFING";
  }
}
loadLatest();

// =========================================================================== //
// Manual run — password required
// =========================================================================== //
async function runManual(topic, question) {
  if (busy) return;
  const password = passwordEl.value.trim();
  if (!password) {
    setStatus("⚠ Enter your access key above.", false);
    passwordEl.focus();
    return;
  }
  setBusy(true);
  setStatus(`Researching "${topic}" — plan → search → score → synthesize → reflect…`, true);
  briefingEl.hidden = true; sourcesEl.hidden = true; reasoningEl.hidden = true;
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic, question,
        days: Number(daysEl.value),
        maxIterations: Number(passesEl.value),
        model: modelEl.value,
        password,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    renderWithMeta(data);
    statusEl.hidden = true;
    runPanel.hidden = true;
    toggleBtn.textContent = "[ RUN NOW ]";
  } catch (e) {
    setStatus("⚠ " + (e?.message || e), false);
  } finally {
    setBusy(false);
  }
}

// =========================================================================== //
// Render
// =========================================================================== //
function renderWithMeta(result) {
  if (result.runAt && result.topic) {
    lastRunLabel.textContent =
      `// LAST BRIEFING: ${result.topic.toUpperCase()} — ${timeAgo(result.runAt)}`;
  }
  render(result);
}

function render(result) {
  briefingEl.innerHTML = marked.parse(tagify(stripEmoji(result.answer || "_No briefing returned._")));
  briefingEl.hidden = false;

  const docs = result.docs || [];
  sourcesBody.innerHTML = docs.length
    ? docs.map((d) =>
        `<div class="src">${tagChip(d.tag || "Announced")} <b>${d.relevance}/10</b> — ` +
        `<a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a><br />` +
        `<span class="meta">${esc(d.date || "date n/a")}</span><br />${esc(d.reason)}</div>`,
      ).join("")
    : "<p>No sources cleared the relevance bar.</p>";
  sourcesEl.querySelector("summary").innerHTML =
    `<span class="ic ic-sources"></span> Sources &amp; scores — ${docs.length} kept`;
  sourcesEl.hidden = false;

  const history = result.history || [];
  reasoningBody.innerHTML = history.length
    ? history.map((r) =>
        `<div class="pass"><b>Pass ${r.iteration} → ${esc(r.decision)}</b><br />` +
        (r.reasoning ? `${esc(r.reasoning)}<br />` : "") +
        (r.gaps && r.gaps.length ? "Gaps identified:<br />" + r.gaps.map((g) => "• " + esc(g)).join("<br />") : "") +
        `</div>`,
      ).join("")
    : "<p>No reasoning recorded.</p>";
  reasoningEl.querySelector("summary").innerHTML =
    `<span class="ic ic-reasoning"></span> Agent reasoning — ${history.length} pass(es)`;
  reasoningEl.hidden = false;
}

// =========================================================================== //
// Agent graph (Mermaid — loaded on demand)
// =========================================================================== //
let graphLoaded = false;

$("toggleGraph").addEventListener("click", async () => {
  const container = $("graphContainer");
  const btn = $("toggleGraph");
  if (!container.hidden) {
    container.hidden = true;
    btn.textContent = "[ SHOW GRAPH ]";
    return;
  }
  container.hidden = false;
  btn.textContent = "[ HIDE GRAPH ]";
  if (graphLoaded) return;

  container.innerHTML = `<p class="graph-loading"><span class="spinner"></span> Rendering graph…</p>`;
  try {
    const [{ default: mermaid }, res] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"),
      fetch("/api/graph"),
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { mermaid: code } = await res.json();

    mermaid.initialize({
      startOnLoad: false,
      theme: "base",
      themeVariables: {
        primaryColor: "#0d1f33",
        primaryTextColor: "#00f0ff",
        primaryBorderColor: "#00f0ff",
        lineColor: "#00f0ff",
        secondaryColor: "#04070a",
        tertiaryColor: "#04070a",
        background: "#04070a",
        mainBkg: "#0d1f33",
        nodeBorder: "#00f0ff",
        clusterBkg: "#04070a",
        titleColor: "#00f0ff",
        edgeLabelBackground: "#04070a",
        fontFamily: "'Share Tech Mono', monospace",
      },
    });

    const { svg } = await mermaid.render("agent-graph-svg", code);
    container.innerHTML = svg;
    graphLoaded = true;
  } catch (e) {
    container.innerHTML = `<p class="graph-loading">⚠ ${esc(e?.message || e)}</p>`;
  }
});
