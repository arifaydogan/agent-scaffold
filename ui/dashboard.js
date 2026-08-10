const state = {
  snapshot: null,
  filter: "all",
  query: "",
  connected: false,
  loading: true
};

const elements = {
  grid: document.querySelector("#agent-grid"),
  empty: document.querySelector("#empty-state"),
  activity: document.querySelector("#activity-body"),
  providers: document.querySelector("#provider-list"),
  connectionDot: document.querySelector("#connection-dot"),
  connectionLabel: document.querySelector("#connection-label"),
  syncTime: document.querySelector("#sync-time"),
  error: document.querySelector("#error-banner"),
  demo: document.querySelector("#demo-badge"),
  project: document.querySelector("#project-key"),
  capacityTotal: document.querySelector("#capacity-total"),
  metricActive: document.querySelector("#metric-active"),
  metricReview: document.querySelector("#metric-review"),
  metricBlocked: document.querySelector("#metric-blocked"),
  metricTokens: document.querySelector("#metric-tokens"),
  metricCapacity: document.querySelector("#metric-capacity"),
  search: document.querySelector("#run-search")
};

const STATUS_LABELS = {
  discovered: "Keşfedildi",
  eligible: "Hazır",
  claimed: "Alındı",
  prepared: "Hazırlanıyor",
  queued: "Sıraya alındı",
  started: "Başlatıldı",
  model_selected: "Model seçildi",
  progress: "İşleniyor",
  executing: "Çalışıyor",
  verifying: "Review bekliyor",
  blocked: "Bloke",
  "failed-retryable": "Tekrar denenebilir",
  "failed-scope": "Scope ihlali",
  failed: "Başarısız"
};

const PERSONA_INITIALS = {
  "frontend-engineer": "FE",
  "backend-engineer": "BE",
  "cv-engineer": "CV",
  "data-engineer": "DE",
  "devops-engineer": "DO",
  "qa-engineer": "QA",
  "security-engineer": "SE",
  architect: "AR",
  "pm-analyst": "PM"
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function formatNumber(value) {
  return new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0);
}

function formatDuration(seconds) {
  if (!seconds) return "0 sn";
  if (seconds < 60) return `${seconds} sn`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} dk ${rest ? `${rest} sn` : ""}`.trim();
  return `${Math.floor(minutes / 60)} sa ${minutes % 60} dk`;
}

function formatTime(value, includeDate = false) {
  if (!value) return "—";
  const options = includeDate
    ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit", second: "2-digit" };
  return new Intl.DateTimeFormat("tr-TR", options).format(new Date(value));
}

function displayModel(run) {
  if (!run.model) return run.provider;
  return run.model
    .replace("claude-", "")
    .replace("-thinking", " · thinking")
    .replace("gpt-oss-", "GPT-OSS ")
    .replace("-medium", " · medium")
    .trim();
}

function statePill(run) {
  const pill = element("span", `state-pill ${run.stateKind}`);
  pill.textContent = STATUS_LABELS[run.state] || run.state;
  return pill;
}

function metaRow(label, value) {
  const row = element("div", "agent-meta-row");
  row.append(element("span", "", label), element("strong", "", value || "—"));
  return row;
}

function detailsFor(run) {
  const values = [
    ...(run.allowedPaths || []).map((value) => `scope · ${value}`),
    ...(run.changedFiles || []).map((value) => `changed · ${value}`)
  ];
  if (!values.length && !run.branch) return null;
  const details = element("details", "run-details");
  details.append(element("summary", "", "Teknik detaylar"));
  const list = element("ul");
  if (run.branch) list.append(element("li", "", `branch · ${run.branch}`));
  values.forEach((value) => list.append(element("li", "", value)));
  details.append(list);
  return details;
}

function runCard(run) {
  const card = element("article", `agent-card state-${run.stateKind}`);
  card.setAttribute("aria-label", `${run.issue}: ${run.summary}`);

  const topline = element("div", "card-topline");
  topline.append(element("span", "issue-key", run.issue), statePill(run));
  card.append(topline);

  // Show taskAgent (executor role) as the primary avatar; persona is the orchestration role.
  const displayAgent = run.taskAgent || run.persona || "unassigned";
  const identity = element("div", "agent-identity");
  identity.append(element("span", "persona-avatar", PERSONA_INITIALS[displayAgent] || "AI"));
  const identityCopy = element("div");
  const agentLabel = run.persona && run.persona !== displayAgent
    ? `${displayAgent} (${run.persona})`
    : displayAgent;
  identityCopy.append(
    element("strong", "", agentLabel),
    element("small", "", `${run.provider} · ${run.risk === "high" ? "yüksek risk" : "normal risk"}`)
  );
  identity.append(identityCopy);
  card.append(identity);

  card.append(element("h3", "task-title", run.summary));
  const meta = element("div", "agent-meta");
  meta.append(metaRow("Model", displayModel(run)), metaRow("Çalışma", formatDuration(run.durationSeconds)));
  card.append(meta);

  // Show live progress text for streaming states.
  if (run.progressText && run.stateKind === "active") {
    const progressEl = element("p", "progress-text");
    progressEl.textContent = run.progressText;
    card.append(progressEl);
  }

  const skills = element("div", "skill-list");
  (run.skills || []).slice(0, 4).forEach((skill) => skills.append(element("span", "skill-chip", skill)));
  if ((run.skills || []).length > 4) skills.append(element("span", "skill-chip", `+${run.skills.length - 4}`));
  if (!run.skills?.length) skills.append(element("span", "skill-chip", "skill atanmamış"));
  card.append(skills);

  if (run.blockers?.length) {
    const blocker = element("div", "blocker-note");
    blocker.append(element("strong", "", "!"), element("span", "", run.blockers[0]));
    card.append(blocker);
  }

  const details = detailsFor(run);
  if (details) card.append(details);

  const footer = element("footer", "agent-card-footer");
  footer.append(
    element("span", "", `${formatNumber(run.tokens)} token`),
    element("span", "", `${run.turns || 0} turn`),
    element("span", "", run.locked ? "● locked" : "○ unlocked")
  );
  card.append(footer);
  return card;
}

function visibleRuns() {
  if (!state.snapshot) return [];
  const query = state.query.trim().toLocaleLowerCase("tr-TR");
  return state.snapshot.runs.filter((run) => {
    const matchesFilter = state.filter === "all" || run.stateKind === state.filter;
    const text = [run.issue, run.summary, run.persona, run.provider, run.model, ...(run.skills || [])]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("tr-TR");
    return matchesFilter && (!query || text.includes(query));
  });
}

function renderRuns() {
  const runs = visibleRuns();
  elements.grid.replaceChildren(...runs.map(runCard));
  elements.grid.setAttribute("aria-busy", "false");
  elements.grid.hidden = runs.length === 0;
  elements.empty.hidden = runs.length !== 0;
}

function providerItem(provider) {
  const wrapper = element("div", "provider-item");
  const label = element("div", "capacity-label");
  const name = element("span", "provider-name");
  name.append(element("span", "provider-symbol", provider.name === "antigravity" ? "AG" : "CX"), document.createTextNode(provider.name));
  label.append(name, element("span", "", `${provider.active} / ${provider.limit}`));
  const track = element("div", "capacity-track");
  const fill = element("div", "capacity-fill");
  fill.style.width = `${Math.min(100, (provider.active / Math.max(1, provider.limit)) * 100)}%`;
  track.append(fill);
  wrapper.append(label, track);
  return wrapper;
}

function renderCapacity() {
  const { capacity } = state.snapshot;
  elements.capacityTotal.textContent = `${capacity.active} / ${capacity.total} aktif`;
  elements.providers.replaceChildren(...capacity.providers.map(providerItem));
}

function renderActivity() {
  const rows = state.snapshot.activity.slice(0, 12).map((event) => {
    const row = document.createElement("tr");
    const time = element("td", "", formatTime(event.createdAt, true));
    const issue = element("td", "table-issue", event.issue);
    const action = element("td", "", STATUS_LABELS[event.state] || event.state);
    const status = element("td");
    status.append(element("span", `event-state ${event.stateKind}`, event.state));
    row.append(time, issue, action, status);
    return row;
  });
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = element("td", "", "Henüz runtime hareketi yok.");
    cell.colSpan = 4;
    row.append(cell);
    rows.push(row);
  }
  elements.activity.replaceChildren(...rows);
}

function renderSummary() {
  const { totals, capacity, project, mode, generatedAt } = state.snapshot;
  elements.metricActive.textContent = totals.active;
  elements.metricReview.textContent = totals.review;
  elements.metricBlocked.textContent = totals.blocked;
  elements.metricTokens.textContent = formatNumber(totals.tokens);
  elements.metricCapacity.textContent = `${capacity.active}/${capacity.total} worker slot kullanımda`;
  elements.project.textContent = project;
  elements.demo.hidden = mode !== "demo";
  elements.syncTime.textContent = formatTime(generatedAt);
}

function render() {
  if (!state.snapshot) return;
  renderSummary();
  renderCapacity();
  renderRuns();
  renderActivity();
}

function setConnection(connected) {
  state.connected = connected;
  elements.connectionDot.classList.toggle("is-live", connected);
  elements.connectionDot.classList.toggle("is-error", !connected && !state.loading);
  elements.connectionLabel.textContent = connected ? "Canlı" : state.loading ? "Bağlanıyor" : "Bağlantı kesildi";
  elements.error.hidden = connected || state.loading;
}

async function refresh() {
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
    state.snapshot = await response.json();
    state.loading = false;
    setConnection(true);
    render();
  } catch {
    state.loading = false;
    setConnection(false);
    if (!state.snapshot) {
      elements.grid.setAttribute("aria-busy", "false");
      elements.grid.hidden = true;
      elements.empty.hidden = false;
      elements.empty.querySelector("h3").textContent = "Runtime verisine ulaşılamıyor";
      elements.empty.querySelector("p").textContent = "Dashboard server bağlantısını kontrol edin.";
    }
  }
}

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    renderRuns();
  });
});

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value;
  renderRuns();
});

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 2500);
