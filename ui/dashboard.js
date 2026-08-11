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
  search: document.querySelector("#run-search"),
  supervisorCard: document.querySelector("#supervisor-card"),
  supervisorDot: document.querySelector("#supervisor-dot"),
  supervisorStatusText: document.querySelector("#supervisor-status-text"),
  supervisorPid: document.querySelector("#supervisor-pid"),
  supervisorMode: document.querySelector("#supervisor-mode"),
  supervisorCycles: document.querySelector("#supervisor-cycles"),
  supervisorHeartbeat: document.querySelector("#supervisor-heartbeat")
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

function getWorkerInfo(run) {
  return { status: run.workerStatus || "finished", pid: run.workerPid };
}

function formatWorkerLabel(run) {
  const { status, pid } = getWorkerInfo(run);
  if (status === "queued") return "Kuyrukta";
  if (status === "running") {
    return pid ? `Çalışıyor · PID ${pid}` : "Çalışıyor";
  }
  return "Tamamlandı";
}

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
  
  if (run.worktree) values.push(`worktree · ${run.worktree}`);
  if (run.tests) values.push(`tests · ${run.tests.length} run`);
  if (run.commit) values.push(`commit · ${run.commit}`);
  if (run.pr) values.push(`pr · ${run.pr}`);
  if (run.providerCooldown) values.push(`cooldown · ${run.providerCooldown}`);
  if (run.workerPid) values.push(`PID · ${run.workerPid}`);
  if (run.lastHeartbeat) values.push(`heartbeat · ${formatTime(run.lastHeartbeat)}`);

  if (!values.length && !run.branch) return null;
  const details = element("details", "run-details");
  details.append(element("summary", "", "Teknik detaylar"));
  const list = element("ul");
  if (run.branch) list.append(element("li", "", `branch · ${run.branch}`));
  values.forEach((value) => list.append(element("li", "", value)));
  details.append(list);
  return details;
}

function taskCard(group) {
  const run = group.latest;
  const attempts = group.attempts;
  const card = element("article", `agent-card state-${run.stateKind}`);
  card.setAttribute("aria-label", `${run.issue}: ${run.summary}`);

  const topline = element("div", "card-topline");
  const leftGroup = element("div", "topline-left");
  const { status: workerStatus } = getWorkerInfo(run);
  
  const issueLink = element("a", "issue-key-link", run.issue);
  issueLink.href = `https://houndvision.atlassian.net/browse/${run.issue}`;
  issueLink.target = "_blank";
  issueLink.rel = "noopener noreferrer";
  
  leftGroup.append(
    issueLink,
    element("span", `worker-badge worker-${workerStatus}`, formatWorkerLabel(run))
  );
  topline.append(leftGroup, statePill(run));
  card.append(topline);

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

  if (run.blockers?.length || run.stateKind === "blocked") {
    const blocker = element("div", "blocker-note");
    blocker.style.display = "flex";
    blocker.style.flexDirection = "column";
    blocker.style.gap = "0.25rem";
    
    let statusText = run.state === "blocked" ? "İnsan eylemi bekleniyor" : "Çözülüyor";
    const titleRow = element("div", "blocker-title");
    titleRow.style.fontWeight = "bold";
    titleRow.append(element("span", "", "! "), element("span", "", statusText));
    
    blocker.append(
      titleRow,
      element("span", "blocker-cause", run.blockers?.[0] || "Bilinmeyen blocker nedeni"),
      element("span", "blocker-action", run.resolution || "Lütfen sorunu çözün veya manuel müdahale edin.")
    );
    card.append(blocker);
  }

  const details = detailsFor(run);
  if (details) card.append(details);

  if (attempts.length > 1) {
    const timeline = element("details", "attempts-timeline");
    timeline.style.marginTop = "0.5rem";
    timeline.style.fontSize = "0.85rem";
    timeline.append(element("summary", "", `${attempts.length} deneme (Geçmiş)`));
    const list = element("ul", "attempt-list");
    list.style.paddingLeft = "1rem";
    attempts.slice(0, -1).forEach((oldRun, idx) => {
      const li = element("li", "attempt-item");
      li.textContent = `Deneme ${idx + 1}: ${STATUS_LABELS[oldRun.state] || oldRun.state}`;
      if (oldRun.state === 'blocked' || oldRun.blockers?.length) {
        const link = element("span", "retry-link", ` → Deneme ${idx + 2} ile değiştirildi`);
        link.style.opacity = "0.7";
        link.style.marginLeft = "0.25rem";
        li.append(link);
      }
      list.append(li);
    });
    timeline.append(list);
    card.append(timeline);
  }

  const isTerminal = ["failed", "failed-retryable", "failed-scope", "blocked"].includes(run.state);
  const maxAttempts = state.snapshot.policy?.maxAttempts || 3;
  if (isTerminal) {
    const canRetry = (run.state === "failed-retryable" || run.state === "blocked") && attempts.length < maxAttempts;
    const hasHandler = state.snapshot.capabilities?.retryHandler;
    
    const retryBtn = element("button", "retry-button", "Retry Attempt");
    retryBtn.style.marginTop = "0.5rem";
    if (!hasHandler) {
      retryBtn.disabled = true;
      retryBtn.title = "No injected retry handler on server";
    } else if (!canRetry) {
      retryBtn.disabled = true;
      retryBtn.title = attempts.length >= maxAttempts ? "Attempt limit reached" : "Run not retryable";
    } else {
      retryBtn.onclick = () => {
        if (confirm("Are you sure you want to retry this task?")) {
           fetch(`/api/retry`, {
             method: "POST",
             headers: { "Content-Type": "application/json" },
             body: JSON.stringify({ runId: run.id, issueKey: run.issue })
           });
        }
      };
    }
    card.append(retryBtn);
  }

  const footer = element("footer", "agent-card-footer");
  const taskTokens = attempts.reduce((sum, r) => sum + (r.tokens || 0), 0);
  const latestTokens = run.tokens;
  
  const tokenText = (latestTokens === undefined || latestTokens === null || latestTokens === 0)
    ? "Usage unavailable" 
    : `${formatNumber(taskTokens)} token (total) · ${formatNumber(latestTokens)} (this attempt)`;
    
  footer.append(
    element("span", "", tokenText),
    element("span", "", `${run.turns || 0} turn`),
    element("span", "", run.locked ? "● locked" : "○ unlocked")
  );
  card.append(footer);
  return card;
}

function visibleRuns() {
  if (!state.snapshot) return [];
  const query = state.query.trim().toLocaleLowerCase("tr-TR");
  
  const groups = {};
  for (const run of state.snapshot.runs) {
    if (!groups[run.issue]) groups[run.issue] = [];
    groups[run.issue].push(run);
  }
  
  const groupedTasks = Object.values(groups).map(group => {
    return {
      issue: group[0].issue,
      summary: group[0].summary,
      latest: group[group.length - 1],
      attempts: group,
      stateKind: group[group.length - 1].stateKind
    };
  });

  return groupedTasks.filter((task) => {
    const run = task.latest;
    const matchesFilter = state.filter === "all" || run.stateKind === state.filter;
    const text = [run.issue, run.summary, run.persona, run.provider, run.model, ...(run.skills || [])]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("tr-TR");
    return matchesFilter && (!query || text.includes(query));
  });
}

function renderRuns() {
  const tasks = visibleRuns();
  elements.grid.replaceChildren(...tasks.map(taskCard));
  elements.grid.setAttribute("aria-busy", "false");
  elements.grid.hidden = tasks.length === 0;
  elements.empty.hidden = tasks.length !== 0;
}

function providerItem(provider) {
  const wrapper = element("div", "provider-item");
  const label = element("div", "capacity-label");
  const name = element("span", "provider-name");
  name.append(element("span", "provider-symbol", provider.name === "antigravity" ? "AG" : "CX"), document.createTextNode(provider.name));
  
  const statsSpan = element("span", "capacity-stats");
  statsSpan.style.display = "flex";
  statsSpan.style.flexDirection = "column";
  statsSpan.style.alignItems = "flex-end";
  
  const queuedText = provider.queued ? ` (${provider.queued} kuyrukta)` : "";
  statsSpan.append(element("span", "", `${provider.active} / ${provider.limit}${queuedText}`));
  
  const quotaText = (provider.quota !== undefined && provider.quota !== null)
    ? `Remaining quota: ${formatNumber(provider.quota)}`
    : `Provider does not expose remaining quota`;
  const quotaEl = element("small", "", quotaText);
  quotaEl.style.fontSize = "0.65rem";
  quotaEl.style.opacity = "0.7";
  statsSpan.append(quotaEl);
  
  label.append(name, statsSpan);
  
  const track = element("div", "capacity-track");
  const fill = element("div", "capacity-fill");
  fill.style.width = `${Math.min(100, (provider.active / Math.max(1, provider.limit)) * 100)}%`;
  track.append(fill);
  wrapper.append(label, track);
  return wrapper;
}

function renderCapacity() {
  const { capacity } = state.snapshot;
  const queuedText = capacity.queued ? ` (${capacity.queued} kuyrukta)` : "";
  elements.capacityTotal.textContent = `${capacity.active} / ${capacity.total}${queuedText}`;
  elements.providers.replaceChildren(...capacity.providers.map(providerItem));
}

function renderSupervisor() {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  const supervisor = snapshot.supervisor || (snapshot.mode === "demo" ? {
    status: "running",
    pid: 1420,
    mode: "autonomous",
    startedAt: snapshot.generatedAt,
    lastHeartbeatAt: snapshot.generatedAt,
    cycleCount: 142,
    lastError: null,
    lastResult: null
  } : null);

  if (!supervisor || !elements.supervisorCard) {
    if (elements.supervisorCard) elements.supervisorCard.hidden = true;
    return;
  }

  elements.supervisorCard.hidden = false;

  let status = supervisor.status || "stopped";

  const STATUS_MAP = {
    running: { label: "Çalışıyor", class: "is-running" },
    stale: { label: "Stale", class: "is-stale" },
    stopped: { label: "Durduruldu", class: "is-stopped" },
    failed: { label: "Başarısız", class: "is-failed" }
  };

  const statusInfo = STATUS_MAP[status] || { label: status, class: "is-stopped" };

  elements.supervisorDot.className = `supervisor-dot ${statusInfo.class}`;
  elements.supervisorStatusText.textContent = statusInfo.label;
  elements.supervisorPid.textContent = supervisor.pid ?? "—";
  elements.supervisorMode.textContent = supervisor.mode || "—";
  elements.supervisorCycles.textContent = supervisor.cycleCount ?? 0;

  if (supervisor.lastHeartbeatAt) {
    const nowMs = snapshot.generatedAt ? new Date(snapshot.generatedAt).getTime() : Date.now();
    const hbMs = new Date(supervisor.lastHeartbeatAt).getTime();
    const diffSec = Math.max(0, Math.floor((nowMs - hbMs) / 1000));
    elements.supervisorHeartbeat.textContent = diffSec < 60 ? `${diffSec}sn önce` : formatTime(supervisor.lastHeartbeatAt);
  } else {
    elements.supervisorHeartbeat.textContent = "—";
  }
}

function renderActivity() {
  const rows = (state.snapshot.activity || []).slice(0, 12).map((event) => {
    const row = document.createElement("tr");
    const time = element("td", "", formatTime(event.createdAt, true));

    const isSupervisor = event.category === "supervisor" || !event.issue;
    const issueText = isSupervisor ? "Supervisor" : (event.issue || "—");
    const issueCell = element("td", "table-issue", issueText);

    const rawState = event.status || event.state || event.event || event.type || "—";
    const actionText = STATUS_LABELS[rawState] || rawState;
    const actionCell = element("td", "", actionText);

    const kindClass = event.stateKind || (
      ["active", "running", "start", "reclaim"].includes(rawState) ? "active" :
      ["verifying", "review"].includes(rawState) ? "review" :
      ["blocked", "failed", "failed-retryable", "failed-scope", "failure", "stale"].includes(rawState) ? "blocked" :
      "idle"
    );

    const statusCell = element("td");
    statusCell.append(element("span", `event-state ${kindClass}`, rawState));

    row.append(time, issueCell, actionCell, statusCell);
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
  elements.metricActive.textContent = capacity.active;
  elements.metricReview.textContent = totals.review;
  elements.metricBlocked.textContent = totals.blocked;
  elements.metricTokens.textContent = formatNumber(totals.tokens);
  const queuedText = capacity.queued ? ` (${capacity.queued} kuyrukta)` : "";
  elements.metricCapacity.textContent = `${capacity.active}/${capacity.total} worker slot kullanımda${queuedText}`;
  elements.project.textContent = project;
  elements.demo.hidden = mode !== "demo";
  elements.syncTime.textContent = formatTime(generatedAt);
}

function render() {
  if (!state.snapshot) return;
  renderSummary();
  renderSupervisor();
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
