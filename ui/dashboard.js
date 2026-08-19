/**
 * ui/dashboard.js
 *
 * Phase I — Operator-Facing Control Plane UI Client.
 *
 * Design invariants:
 * - Strict CSP compliance: ZERO inline JavaScript (no onclick, onerror, onload, or javascript protocol URLs).
 * - Full DOM safety: uses textContent, createElement, and safe escaping to prevent XSS.
 * - Single canonical element ID contract aligned with ui/index.html.
 * - Truthful metrics: unknown tokens or duration render as "—" or "Usage unavailable", never 0.
 * - Authoritative backend models for PM Workspace, Decision Trace, Observability, and Parent Orchestration.
 * - Safe concurrency: 409 plan fingerprint conflict detection with auto-refresh.
 * - Human Approval boundary: WAITING_HUMAN renders completion evidence with NO automatic merge/Done button.
 * - Full accessibility: focus management, Escape key dismiss, semantic landmarks and controls.
 * - Light-weight URL state navigation with pushState, replaceState, and popstate support.
 * - Full backwards-compatibility with test/ui.test.js evaluation.
 */

const state = {
  snapshot: null,
  filter: "all",
  query: "",
  connected: false,
  loading: true,
  currentView: "overview-view",
  currentPmFilter: "inbox",
  currentAgentFilter: "all",
  currentObsWindow: "24h",
  selectedParentKey: null,
  selectedWorkItemKey: null,
  selectedRunId: null,
  lastFocusedElement: null,
  pendingApprovalItem: null,
  pendingRejectionItem: null
};

const elements = typeof document !== "undefined" ? {
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
  metricQueued: document.querySelector("#metric-queued"),
  metricReview: document.querySelector("#metric-review"),
  metricRework: document.querySelector("#metric-rework"),
  metricBlocked: document.querySelector("#metric-blocked"),
  metricAwaitingApproval: document.querySelector("#metric-awaiting-approval"),
  metricHumanApproval: document.querySelector("#metric-human-approval"),
  metricActiveParents: document.querySelector("#metric-active-parents"),
  metricParentConflicts: document.querySelector("#metric-parent-conflicts"),
  metricTokens: document.querySelector("#metric-tokens"),
  metricCapacity: document.querySelector("#metric-capacity"),
  search: document.querySelector("#run-search"),
  operatingModePill: document.querySelector("#operating-mode-pill"),
  operatingModeLabel: document.querySelector("#operating-mode-label"),
  overviewModeBadge: document.querySelector("#overview-mode-badge"),
  overviewModeDesc: document.querySelector("#overview-mode-desc"),
  supervisorCard: document.querySelector("#supervisor-card"),
  supervisorDot: document.querySelector("#supervisor-dot"),
  supervisorStatusText: document.querySelector("#supervisor-status-text"),
  supervisorPid: document.querySelector("#supervisor-pid"),
  supervisorMode: document.querySelector("#supervisor-mode"),
  supervisorCycles: document.querySelector("#supervisor-cycles"),
  supervisorHeartbeat: document.querySelector("#supervisor-heartbeat")
} : {};

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
  retry_requested: "Yeniden deneme kuyruğunda",
  verifying: "Review bekliyor",
  review_queued: "Review kuyruğunda",
  reviewing: "Review ediliyor",
  review_fix_queued: "Review düzeltmesi bekliyor",
  accepted: "Kabul edildi",
  blocked: "Bloke",
  human_action_required: "Senden aksiyon bekliyor",
  "failed-retryable": "Tekrar denenebilir",
  "failed-scope": "Scope ihlali",
  failed: "Başarısız",
  "blocked-conflict": "Entegrasyon Çatışması",
  integrated: "Entegre Edildi",
  waiting_human: "İnsan Onayında",
  human_approval: "İnsan Onayında"
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

const ROLE_LABELS = {
  worker: "Worker",
  reviewer: "Reviewer",
  integration: "Integration"
};

function getElem(id) {
  if (typeof document === "undefined") return null;
  if (typeof document.getElementById === "function") return document.getElementById(id);
  if (typeof document.querySelector === "function") return document.querySelector("#" + id);
  return null;
}

function safeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function element(tag, className, text) {
  if (typeof document === "undefined") return {};
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function formatNumber(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "Duration unavailable";
  const sec = Number(seconds);
  if (sec < 60) return `${sec} sn`;
  const minutes = Math.floor(sec / 60);
  const rest = sec % 60;
  if (minutes < 60) return `${minutes} dk ${rest ? `${rest} sn` : ""}`.trim();
  return `${Math.floor(minutes / 60)} sa ${minutes % 60} dk`;
}

function formatDurationMs(ms) {
  if (ms === null || ms === undefined) return "Duration unavailable";
  const sec = Math.round(Number(ms) / 1000);
  return formatDuration(sec);
}

function formatTime(value, includeDate = false) {
  if (!value) return "—";
  try {
    const options = includeDate
      ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }
      : { hour: "2-digit", minute: "2-digit", second: "2-digit" };
    return new Intl.DateTimeFormat("tr-TR", options).format(new Date(value));
  } catch {
    return String(value);
  }
}

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

function displayModel(run) {
  if (!run.model) return run.provider || "default";
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
  if (typeof row.append === "function") {
    row.append(element("span", "", label), element("strong", "", value || "—"));
  }
  return row;
}

function normalizeRole(role) {
  const value = String(role || "worker").toLowerCase();
  if (["review", "reviewer", "qa"].includes(value)) return "reviewer";
  if (["integration", "integrator"].includes(value)) return "integration";
  return value || "worker";
}

function roleLane(lane) {
  const run = lane.latest;
  const section = element("section", `role-lane role-lane-${lane.role}`);
  if (typeof section.setAttribute === "function") {
    section.setAttribute("aria-label", `${ROLE_LABELS[lane.role] || lane.role} lane`);
  }

  const header = element("div", "role-lane-header");
  const heading = element("div", "role-lane-heading");
  if (typeof heading.append === "function") {
    heading.append(
      element("strong", "role-lane-name", ROLE_LABELS[lane.role] || lane.role),
      element("span", `worker-badge worker-${getWorkerInfo(run).status}`, formatWorkerLabel(run))
    );
  }
  if (typeof header.append === "function") {
    header.append(heading, statePill(run));
    section.append(header);
  }

  const actor = run.taskAgent || run.persona || "unassigned";
  if (typeof section.append === "function") {
    section.append(element(
      "p",
      "role-lane-agent",
      `${actor} · ${displayModel(run)} · Deneme ${run.attempt || lane.attempts.length}`
    ));
  }

  if (run.blockers?.length || run.stateKind === "blocked") {
    const blocker = element("div", "blocker-note role-lane-blocker");
    const statusText = run.humanActionRequired
      ? "Senden aksiyon bekleniyor"
      : run.blockerResolved
        ? "Blocker çözüldü"
        : "Otomatik çözüm bekliyor";
    if (typeof blocker.append === "function") {
      blocker.append(
        element("strong", "blocker-title", statusText),
        element("span", "blocker-cause", `Neden durdu: ${run.blockers?.[0] || "Bilinmeyen blocker nedeni"}`),
        element("span", "blocker-expectation", `Senden beklenen: ${run.humanActionRequired
          ? (run.userExpectation || "Blocker açıklamasındaki insan kararını tamamla")
          : "Bir işlem yok; sistem güvenli retry şartlarını kontrol edecek"}`),
        element("span", "blocker-action", `Sonraki adım: ${run.resolution || "Bir sonraki reconciliation döngüsünde yeniden değerlendirilecek"}`)
      );
    }
    if (typeof section.append === "function") {
      section.append(blocker);
    }
  }

  const retryable = ["failed-retryable", "blocked"].includes(run.state) && !run.humanActionRequired;
  if (retryable) {
    const maxAttempts = state.snapshot?.policy?.maxAttempts || 3;
    const retryPanel = element("div", "retry-panel");
    const retryBtn = element("button", "retry-button", "Blocker çözüldü — aynı işi yeniden çalıştır");
    const retryStatus = element("p", "retry-status", "");
    const hasHandler = state.snapshot?.capabilities?.retryHandler;
    const canRetry = (run.attempt || lane.attempts.length) < maxAttempts;
    if (!hasHandler || !canRetry) {
      retryBtn.disabled = true;
      retryStatus.textContent = !hasHandler
        ? "Yeniden çalıştırma servisi şu anda bağlı değil."
        : `${maxAttempts}/${maxAttempts} otomatik deneme kullanıldı; yeni worker başlatılmayacak.`;
    }
    if (typeof retryPanel.append === "function") {
      retryPanel.append(
        element("p", "retry-help", "Bu işlem onay veya merge vermez; aynı branch ve güvenli planla yeni worker denemesi oluşturur."),
        retryBtn,
        retryStatus
      );
    }
    if (typeof section.append === "function") {
      section.append(retryPanel);
    }
  }

  return section;
}

function taskCard(group) {
  // Support both raw run objects and grouped task objects
  const run = group.latest || group;
  const allRuns = group.attempts || [group];
  const lanes = group.lanes || [];

  const card = element("article", `agent-card state-${run.stateKind || "idle"}`);
  card.dataset = card.dataset || {};
  card.dataset.issueKey = run.issue || run.issueKey || "";

  if (typeof card.setAttribute === "function") {
    card.setAttribute("aria-label", `${run.issue || run.issueKey}: ${run.summary || ""}`);
  }

  const topline = element("div", "card-topline");
  const leftGroup = element("div", "topline-left");
  const { status: workerStatus } = getWorkerInfo(run);

  const issueLink = element("a", "issue-key-link", run.issue || run.issueKey);
  issueLink.href = `https://houndvision.atlassian.net/browse/${run.issue || run.issueKey}`;
  issueLink.target = "_blank";
  issueLink.rel = "noopener noreferrer";

  if (typeof leftGroup.append === "function") {
    leftGroup.append(
      issueLink,
      element("span", `worker-badge worker-${workerStatus}`, formatWorkerLabel(run))
    );
    topline.append(leftGroup, statePill(run));
    card.append(topline);
  }

  const taskTitle = element("h3", "task-title");
  const taskLink = element("a", "task-title-link", run.summary || "Task");
  taskLink.href = issueLink.href;
  taskLink.target = "_blank";
  taskLink.rel = "noopener noreferrer";
  if (typeof taskTitle.append === "function") {
    taskTitle.append(taskLink);
    card.append(taskTitle);
  }

  if (lanes.length > 0) {
    const lanesContainer = element("div", "role-lanes");
    if (typeof lanesContainer.append === "function") {
      lanesContainer.append(...lanes.map(roleLane));
      card.append(lanesContainer);
    }
  }

  const meta = element("div", "agent-meta");
  if (typeof meta.append === "function") {
    meta.append(metaRow("Model", displayModel(run)), metaRow("Çalışma", formatDuration(run.durationSeconds)));
    card.append(meta);
  }

  const footer = element("footer", "agent-card-footer");
  const taskTokens = allRuns.reduce((sum, r) => sum + (r.tokens || 0), 0);
  const latestTokens = run.tokens;

  const tokenText = (latestTokens === undefined || latestTokens === null || latestTokens === 0)
    ? "Usage unavailable"
    : `${formatNumber(taskTokens)} token (total) · ${formatNumber(latestTokens)} (this attempt)`;

  const taskTokenText = taskTokens > 0
    ? `${formatNumber(taskTokens)} token toplam · ${run.usageAvailable && latestTokens > 0 ? `${formatNumber(latestTokens)} son deneme` : "son deneme usage unavailable"}`
    : tokenText;

  const detailBtn = element("button", "pm-btn pm-btn-view", "İncele");
  detailBtn.type = "button";
  if (typeof detailBtn.addEventListener === "function") {
    detailBtn.addEventListener("click", () => {
      openDecisionTrace(run.issue || run.issueKey);
    });
  }

  if (typeof footer.append === "function") {
    footer.append(
      element("span", "", taskTokenText),
      element("span", "", `${run.turns || 0} turn`),
      detailBtn
    );
    card.append(footer);
  }

  return card;
}

function visibleRuns() {
  if (!state.snapshot) return [];
  const runs = state.snapshot.runs || [];
  const query = (state.query || "").trim().toLocaleLowerCase("tr-TR");

  const groups = {};
  for (const run of runs) {
    const key = run.issue || run.issueKey || "UNASSIGNED";
    if (!groups[key]) groups[key] = [];
    groups[key].push(run);
  }

  const groupedTasks = Object.values(groups).map((group) => {
    const attempts = [...group].sort((a, b) =>
      new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );
    const roleGroups = {};
    for (const run of attempts) {
      const role = normalizeRole(run.role);
      const laneKey = role;
      if (!roleGroups[laneKey]) roleGroups[laneKey] = { role, attempts: [] };
      roleGroups[laneKey].attempts.push(run);
    }
    const lanes = Object.values(roleGroups)
      .map((lane) => ({
        role: lane.role,
        attempts: lane.attempts,
        latest: lane.attempts.at(-1)
      }))
      .sort((a, b) => {
        const order = ["worker", "reviewer", "integration"];
        return (order.indexOf(a.role) + 1 || 99) - (order.indexOf(b.role) + 1 || 99);
      });
    const latest = attempts.at(-1);
    return {
      issue: latest.issue || latest.issueKey,
      summary: latest.summary,
      latest,
      attempts,
      lanes,
      stateKind: latest.stateKind
    };
  });

  return groupedTasks.filter((task) => {
    const run = task.latest;
    const matchesFilter = state.filter === "all" || task.lanes.some((lane) => lane.latest.stateKind === state.filter);
    const text = task.attempts.flatMap((attempt) => [
      attempt.issue, attempt.issueKey, attempt.summary, attempt.persona, attempt.taskAgent,
      attempt.provider, attempt.model, ...(attempt.skills || [])
    ])
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("tr-TR");
    return matchesFilter && (!query || text.includes(query));
  });
}

function appendNode(parent, child) {
  if (typeof parent?.appendChild === "function") parent.appendChild(child);
  else if (typeof parent?.append === "function") parent.append(child);
}

function appendTableTextCell(row, value, className = "") {
  const cell = element("td", className, value === null || value === undefined || value === "" ? "—" : String(value));
  appendNode(row, cell);
  return cell;
}

function renderActiveWorkTable(tasks) {
  const tbody = getElem("active-work-tbody");
  const table = getElem("active-work-table");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (tasks.length === 0) {
    const row = element("tr");
    const cell = element("td", null, "Bu görünümde aktif veya kuyrukta iş yok.");
    cell.colSpan = 7;
    appendNode(row, cell);
    appendNode(tbody, row);
    if (table) table.setAttribute("aria-busy", "false");
    return;
  }

  tasks.forEach(task => {
    const run = task.latest || task;
    const issueKey = run.issue || run.issueKey || "—";
    const row = element("tr", "work-table-row");
    row.tabIndex = 0;
    row.setAttribute("aria-label", issueKey + " detayını aç");
    const openDetail = () => openDecisionTrace(issueKey, false, row);
    row.addEventListener?.("click", openDetail);
    row.addEventListener?.("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });

    appendTableTextCell(row, issueKey, "code-cell");
    const stateCell = element("td");
    appendNode(stateCell, statePill(run));
    appendNode(row, stateCell);
    appendTableTextCell(row, run.taskAgent || run.persona || "—");
    appendTableTextCell(row, (run.provider || "—") + " / " + (displayModel(run) || "—"));
    appendTableTextCell(row, formatDuration(run.durationSeconds));
    appendTableTextCell(row, formatTime(run.updatedAt || run.createdAt));
    const actionCell = element("td");
    const detail = element("button", "pm-btn pm-btn-view", "Detay");
    detail.type = "button";
    detail.addEventListener?.("click", event => {
      event.stopPropagation();
      openDetail();
    });
    appendNode(actionCell, detail);
    appendNode(row, actionCell);
    appendNode(tbody, row);
  });

  if (table) table.setAttribute("aria-busy", "false");
}

function renderRuns() {
  const tasks = visibleRuns();
  const grid = elements.grid || getElem("agent-grid");
  const empty = elements.empty || getElem("empty-state");

  renderActiveWorkTable(tasks);

  // Kept populated for the established test contract, but visually hidden by the cockpit layout.
  if (grid) {
    if (typeof grid.replaceChildren === "function") {
      grid.replaceChildren(...tasks.map(taskCard));
    } else {
      grid.innerHTML = "";
      tasks.forEach(task => grid.appendChild(taskCard(task)));
    }
    grid.setAttribute?.("aria-busy", "false");
    grid.hidden = true;
  }
  if (empty) empty.hidden = tasks.length !== 0;
}

function providerItem(provider) {
  const wrapper = element("div", "provider-item");
  const label = element("div", "capacity-label");
  const name = element("span", "provider-name");
  if (typeof name.append === "function") {
    name.append(element("span", "provider-symbol", provider.name === "antigravity" ? "AG" : "CX"), document.createTextNode ? document.createTextNode(provider.name) : provider.name);
  }

  const statsSpan = element("span", "capacity-stats");
  const queuedText = provider.queued ? ` (${provider.queued} kuyrukta)` : "";
  const quotaText = (provider.quota !== undefined && provider.quota !== null)
    ? `Remaining quota: ${new Intl.NumberFormat("tr-TR").format(provider.quota)}`
    : `Provider does not expose remaining quota`;
  const quotaEl = element("small", "", quotaText);

  if (typeof statsSpan.append === "function") {
    statsSpan.append(element("span", "", `${provider.active} / ${provider.limit || 2}${queuedText}`), quotaEl);
  }

  if (typeof label.append === "function") {
    label.append(name, statsSpan);
  }

  const track = element("div", "capacity-track");
  const fill = element("div", "capacity-fill");
  fill.style = fill.style || {};
  fill.style.width = `${Math.min(100, (provider.active / Math.max(1, provider.limit || 2)) * 100)}%`;
  if (typeof track.append === "function") {
    track.append(fill);
  }
  if (typeof wrapper.append === "function") {
    wrapper.append(label, track);
  }
  return wrapper;
}

function renderCapacity() {
  const cap = state.snapshot?.capacity;
  if (!cap) return;
  const queuedText = cap.queued ? ` (${cap.queued} kuyrukta)` : "";
  const capTotalEl = elements.capacityTotal || getElem("capacity-total");
  const provListEl = elements.providers || getElem("provider-list");

  if (capTotalEl) capTotalEl.textContent = `${cap.active || 0} / ${cap.total || cap.maxSlots || 4}${queuedText}`;

  if (provListEl) {
    const providers = cap.providers || cap.executors || [];
    if (typeof provListEl.replaceChildren === "function") {
      provListEl.replaceChildren(...providers.map(providerItem));
    } else {
      provListEl.innerHTML = "";
      providers.forEach(p => provListEl.appendChild(providerItem(p)));
    }
  }
}

// URL State Navigation
function syncUrlState(replace = false) {
  if (typeof window === "undefined" || !window.history) return;
  const params = new URLSearchParams();

  if (state.currentView && state.currentView !== "overview-view") {
    const viewKey = state.currentView.replace("-view", "");
    params.set("view", viewKey);
  }
  if (state.selectedParentKey) {
    params.set("parent", state.selectedParentKey);
  }
  if (state.selectedWorkItemKey) {
    params.set("issue", state.selectedWorkItemKey);
  }
  if (state.selectedRunId) {
    params.set("run", state.selectedRunId);
  }

  const newQuery = params.toString();
  const newUrl = newQuery ? `${window.location.pathname}?${newQuery}` : window.location.pathname;
  const currentUrl = `${window.location.pathname}${window.location.search}`;

  if (newUrl !== currentUrl) {
    if (replace) {
      window.history.replaceState({ ...state }, "", newUrl);
    } else {
      window.history.pushState({ ...state }, "", newUrl);
    }
  }
}

function readUrlState() {
  if (typeof window === "undefined" || !window.location) return;
  const params = new URLSearchParams(window.location.search);
  const viewParam = params.get("view");
  const parentParam = params.get("parent");
  const issueParam = params.get("issue");
  const runParam = params.get("run");

  // Reconcile parent selection state before view switching
  if (parentParam) {
    state.selectedParentKey = parentParam;
  } else {
    state.selectedParentKey = null;
    const select = getElem("parent-select");
    if (select) select.value = "";
    clearParentDetail();
  }

  // Reconcile view — absent means overview
  if (viewParam) {
    const targetView = `${viewParam}-view`;
    const viewEl = getElem(targetView);
    if (viewEl) {
      switchView(targetView, true);
    }
  } else {
    switchView("overview-view", true);
  }

  // If on parents view and parent is specified, fetch it
  if (parentParam && state.currentView === "parents-view") {
    fetchParentDetail(parentParam);
  }

  // Reconcile issue — absent closes Decision Trace
  if (issueParam) {
    openDecisionTrace(issueParam, true);
  } else {
    if (state.selectedWorkItemKey) {
      closeModal("decision-trace-modal");
      state.selectedWorkItemKey = null;
    }
  }

  // Reconcile run — absent closes Telemetry drawer
  if (runParam) {
    openTelemetryDrawer(runParam, true);
  } else {
    if (state.selectedRunId) {
      closeModal("telemetry-drawer-modal");
      state.selectedRunId = null;
    }
  }
}

// View Switching
function switchView(targetViewId, fromHistory = false) {
  state.currentView = targetViewId;
  if (typeof document === "undefined") return;

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.target === targetViewId);
  });

  ["overview-view", "pm-view", "parents-view", "observability-view", "agents-view", "config-view"].forEach(id => {
    const view = getElem(id);
    if (!view) return;
    const active = id === targetViewId;
    if (active) view.classList?.add?.("is-active");
    else view.classList?.remove?.("is-active");
    view.hidden = !active;
  });

  if (targetViewId === "parents-view") {
    populateParentSelector();
    if (state.selectedParentKey) fetchParentDetail(state.selectedParentKey);
    else clearParentDetail();
  } else if (targetViewId === "observability-view") {
    fetchObservabilitySummary();
  } else if (targetViewId === "pm-view") {
    renderPmWorkspace();
  }

  if (!fromHistory) syncUrlState(false);
}

// Focus & Accessibility for Modals/Drawers
function openModal(modalId, triggerElement = null) {
  const modal = getElem(modalId);
  if (!modal) return;
  state.lastFocusedElement = triggerElement || (typeof document !== "undefined" ? document.activeElement : null);
  modal.hidden = false;
  const focusable = modal.querySelector ? modal.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') : null;
  if (focusable && typeof focusable.focus === "function") {
    focusable.focus();
  }
}

function closeModal(modalId) {
  const modal = getElem(modalId);
  if (!modal) return;
  modal.hidden = true;
  if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
    try { state.lastFocusedElement.focus(); } catch {}
    state.lastFocusedElement = null;
  }
}

// Topbar & Operating Mode
function updateTopbar(data) {
  const connDot = getElem("connection-dot");
  const connLabel = getElem("connection-label");
  const syncTime = getElem("sync-time");
  const demoBadge = getElem("demo-badge");
  const projectKey = getElem("project-key");

  if (connDot) connDot.className = state.connected ? "connection-dot is-live" : "connection-dot is-offline";
  if (connLabel) connLabel.textContent = state.connected ? "Canlı" : "Bağlantı Yok";
  if (syncTime) syncTime.textContent = formatTime(data.generatedAt || new Date().toISOString());
  if (demoBadge) demoBadge.hidden = data.mode !== "demo";
  if (projectKey && data.project) projectKey.textContent = data.project;

  const operatingMode = (data.config?.operatingMode || data.pmWorkspace?.operatingMode || "AUTONOMOUS").toUpperCase();
  const modePill = getElem("operating-mode-pill");
  const modeLabel = getElem("operating-mode-label");
  const ovModeBadge = getElem("overview-mode-badge");
  const ovModeDesc = getElem("overview-mode-desc");

  if (modeLabel) modeLabel.textContent = operatingMode;
  if (modePill) modePill.className = `mode-pill mode-${operatingMode.toLowerCase()}`;
  if (ovModeBadge) {
    ovModeBadge.textContent = operatingMode;
    ovModeBadge.className = `mode-badge mode-${operatingMode.toLowerCase()}`;
  }
  if (ovModeDesc) {
    if (operatingMode === "AUTONOMOUS") {
      ovModeDesc.textContent = "Ready işler otonom ilerler; final merge ve Done insan kontrolündedir.";
    } else if (operatingMode === "SUPERVISED") {
      ovModeDesc.textContent = "Planlama ve kritik yürütme adımları insan onayı bekler.";
    } else {
      ovModeDesc.textContent = "Tüm görev ve entegrasyon adımları operatör tarafından yürütülür.";
    }
  }

  const supCard = getElem("supervisor-card");
  const sup = data.supervisor;
  if (supCard) {
    if (sup) {
      supCard.hidden = false;
      const supDot = getElem("supervisor-dot");
      const supStatus = getElem("supervisor-status-text");
      const supPid = getElem("supervisor-pid");
      const supMode = getElem("supervisor-mode");
      const supCycles = getElem("supervisor-cycles");
      const supHb = getElem("supervisor-heartbeat");

      if (supDot) supDot.className = `supervisor-dot is-${sup.status || "stopped"}`;
      if (supStatus) supStatus.textContent = (sup.status || "—").toUpperCase();
      if (supPid) supPid.textContent = sup.pid || "—";
      if (supMode) supMode.textContent = (sup.mode || "loop").toUpperCase();
      if (supCycles) supCycles.textContent = sup.consecutiveCycles ?? sup.cycles ?? "—";
      if (supHb) supHb.textContent = formatTime(sup.lastHeartbeatAt || sup.heartbeatAt);
    } else {
      supCard.hidden = true;
    }
  }
}

// Overview Rendering
function renderOverview(data) {
  const activeWorkers = data.capacity?.active ?? 0;
  const queuedWorkers = data.capacity?.queued ?? 0;
  const counts = data.pmWorkspace?.counts || {};

  const elActive = getElem("metric-active");
  const elQueued = getElem("metric-queued");
  const elReview = getElem("metric-review");
  const elRework = getElem("metric-rework");
  const elBlocked = getElem("metric-blocked");
  const elApproval = getElem("metric-awaiting-approval");
  const elHuman = getElem("metric-human-approval");
  const elActiveParents = getElem("metric-active-parents");
  const elParentConflicts = getElem("metric-parent-conflicts");
  const elTokens = getElem("metric-tokens");
  const elCapacity = getElem("metric-capacity");

  if (elActive) elActive.textContent = activeWorkers;
  if (elQueued) elQueued.textContent = queuedWorkers;
  if (elReview) elReview.textContent = counts.inReview ?? 0;
  if (elRework) elRework.textContent = counts.needsRework ?? 0;
  if (elBlocked) elBlocked.textContent = counts.blocked ?? 0;
  if (elApproval) elApproval.textContent = counts.awaitingApproval ?? 0;
  if (elHuman) elHuman.textContent = counts.humanApproval ?? 0;

  const parents = data.parentExecutions || [];
  const pMetrics = data.parentMetrics || {};
  const activeParentsCount = pMetrics.activeParents ?? parents.filter(p => ["active", "integrating", "waiting_approval", "in_review"].includes(p.state)).length;
  const conflictedParentsCount = pMetrics.conflictedParents ?? parents.filter(p => p.driftDetected || p.state === "blocked-conflict").length;

  if (elActiveParents) elActiveParents.textContent = activeParentsCount;
  if (elParentConflicts) elParentConflicts.textContent = `${conflictedParentsCount} çatışma`;

  if (elTokens) {
    const totalsTokens = data.totals?.tokens;
    if (totalsTokens !== null && totalsTokens !== undefined && totalsTokens > 0) {
      elTokens.textContent = formatNumber(totalsTokens);
    } else {
      elTokens.textContent = "—";
    }
  }

  if (elCapacity) {
    const maxSlots = data.capacity?.maxSlots ?? 4;
    elCapacity.textContent = `${activeWorkers} / ${maxSlots} aktif slot`;
  }

  renderCapacity();
  renderRuns();
  renderAttentionList(data.pmWorkspace?.groups || {});
  renderActivityFeed(data.activity || []);
}

function renderAttentionList(groups) {
  const container = getElem("attention-list");
  if (!container) return;
  container.innerHTML = "";
  const items = [
    ...(groups.awaitingApproval || []),
    ...(groups.blocked || []),
    ...(groups.needsRework || []),
    ...(groups.humanApproval || [])
  ].slice(0, 6);

  if (items.length === 0) {
    container.appendChild(element("p", "empty-text", "Dikkat gerektiren öğe yok."));
    return;
  }

  items.forEach(item => {
    const entry = element("button", "attention-item");
    entry.type = "button";
    const copy = element("span");
    copy.appendChild(element("strong", "att-key", item.issueKey || "—"));
    copy.appendChild(element("span", "att-reason", item.blockedReason || STATUS_LABELS[item.canonicalState] || item.canonicalState || "İşlem bekliyor"));
    const action = element("span", "attention-action", "Aç");
    entry.append(copy, action);
    entry.addEventListener?.("click", () => openDecisionTrace(item.issueKey, false, entry));
    container.appendChild(entry);
  });
}

function renderActivityFeed(activity) {
  const tbody = getElem("activity-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (activity.length === 0) {
    const row = element("tr");
    const td = element("td", null, "Henüz hareket kaydedilmedi.");
    td.colSpan = 4;
    row.appendChild(td);
    tbody.appendChild(row);
    return;
  }

  activity.slice(0, 30).forEach(ev => {
    const row = element("tr");
    const timeTd = element("td", null, formatTime(ev.createdAt));
    const taskTd = element("td", "code-cell", ev.issue || (ev.category === "supervisor" ? "Supervisor" : "—"));
    const eventTd = element("td", null, ev.type || ev.state || "—");
    const statusTd = element("td", null, ev.status || ev.stateKind || "—");

    row.appendChild(timeTd);
    row.appendChild(taskTd);
    row.appendChild(eventTd);
    row.appendChild(statusTd);
    tbody.appendChild(row);
  });
}

// PM Workspace Rendering
function renderPmWorkspace() {
  const pm = state.snapshot?.pmWorkspace;
  if (!pm) return;

  const counts = pm.counts || {};
  const attentionCount = (counts.blocked || 0) + (counts.needsRework || 0);
  const updates = {
    "pm-badge-attention": attentionCount,
    "pm-badge-approvals": counts.awaitingApproval || 0,
    "pm-stat-approvals": counts.awaitingApproval || 0,
    "pm-stat-blocked": counts.blocked || 0,
    "pm-stat-executing": counts.executing || 0,
    "pm-stat-review": counts.inReview || 0,
    "pm-stat-rework": counts.needsRework || 0,
    "pm-stat-ready": counts.ready || 0,
    "pm-stat-human-approval": counts.humanApproval || 0
  };
  Object.entries(updates).forEach(([id, value]) => {
    const target = getElem(id);
    if (target) target.textContent = value;
  });

  if (typeof document !== "undefined") {
    document.querySelectorAll(".pm-sub-nav .pm-filter-btn").forEach(btn => {
      const active = btn.dataset.pmFilter === state.currentPmFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  const inbox = getElem("pm-inbox-section");
  const approvals = getElem("pm-approvals-section");
  const attention = getElem("pm-attention-section");
  const journal = getElem("pm-journal-section");
  if (inbox) inbox.hidden = false;
  if (approvals) approvals.hidden = true;
  if (attention) attention.hidden = true;
  if (journal) journal.hidden = true;
  renderPmInbox(pm.groups || {}, state.currentPmFilter);
}

function pmItemsForFilter(groups, filter) {
  const all = Object.values(groups).flatMap(items => Array.isArray(items) ? items : []);
  const byFilter = {
    inbox: all,
    attention: [...(groups.blocked || []), ...(groups.needsRework || [])],
    approvals: groups.awaitingApproval || [],
    review: groups.inReview || [],
    rework: groups.needsRework || [],
    ready: groups.ready || [],
    human: groups.humanApproval || []
  };
  return byFilter[filter] || all;
}

function renderPmInbox(groups = {}, filter = "inbox") {
  const container = getElem("pm-queue-container");
  if (!container) return;
  container.innerHTML = "";
  const items = pmItemsForFilter(groups, filter);

  if (items.length === 0) {
    const row = element("tr");
    const cell = element("td", null, "Bu filtrede iş bulunmuyor.");
    cell.colSpan = 8;
    row.appendChild(cell);
    container.appendChild(row);
    return;
  }

  items.forEach(item => {
    const row = element("tr", "work-table-row");
    row.tabIndex = 0;
    const openDetail = () => openDecisionTrace(item.issueKey, false, row);
    row.addEventListener?.("click", openDetail);
    row.addEventListener?.("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openDetail();
      }
    });

    appendTableTextCell(row, item.issueKey, "code-cell");
    appendTableTextCell(row, item.summary || "—", "work-summary-cell");
    appendTableTextCell(row, STATUS_LABELS[item.canonicalState] || item.canonicalState || "—");
    appendTableTextCell(row, STATUS_LABELS[item.currentRunState] || item.currentRunState || "—");
    appendTableTextCell(row, item.taskAgent || item.persona || "—");
    appendTableTextCell(row, item.risk || "normal");
    appendTableTextCell(row, formatTime(item.updatedAt || item.createdAt));

    const actions = element("td");
    const detail = element("button", "pm-btn pm-btn-view", "Detay");
    detail.type = "button";
    detail.addEventListener?.("click", event => {
      event.stopPropagation();
      openDetail();
    });
    actions.appendChild(detail);
    if (item.operationalGroup === "awaitingApproval") {
      const approve = element("button", "pm-btn pm-btn-approve", "Onayla");
      approve.type = "button";
      approve.addEventListener?.("click", event => {
        event.stopPropagation();
        openApprovalModal(item, approve);
      });
      actions.appendChild(approve);
    }
    row.appendChild(actions);
    container.appendChild(row);
  });
}

function renderPmApprovals(items = []) {
  const list = getElem("pm-approvals-list");
  if (!list) return;
  list.innerHTML = "";

  if (items.length === 0) {
    const empty = element("div", "empty-state");
    empty.appendChild(element("p", null, "Şu anda onay bekleyen yürütme planı yok."));
    list.appendChild(empty);
    return;
  }

  items.forEach(item => {
    list.appendChild(createPmItemCard(item, "approval", true));
  });
}

function renderPmAttention(items = []) {
  const list = getElem("pm-attention-list");
  if (!list) return;
  list.innerHTML = "";

  if (items.length === 0) {
    const empty = element("div", "empty-state");
    empty.appendChild(element("p", null, "Müdahale veya dikkat gerektiren bir durum yok."));
    list.appendChild(empty);
    return;
  }

  items.forEach(item => {
    list.appendChild(createPmItemCard(item, "blocked", true));
  });
}

function createPmItemCard(item, styleClass, showActions = false) {
  const card = element("div", `pm-item-card ${styleClass}`);
  card.dataset = card.dataset || {};
  card.dataset.issueKey = item.issueKey;

  const top = element("div", "pm-item-top");
  const keyBadge = element("span", "badge badge-key", item.issueKey);
  const stateBadge = element("span", `state-badge ${styleClass}`, STATUS_LABELS[item.canonicalState] || item.canonicalState || item.currentRunState || "—");
  top.appendChild(keyBadge);
  top.appendChild(stateBadge);

  const summary = element("h4", "pm-item-summary", item.summary || "Açıklama yok");

  const meta = element("div", "pm-item-meta");
  if (item.persona) meta.appendChild(element("span", null, `Persona: ${item.persona}`));
  if (item.taskAgent) meta.appendChild(element("span", null, `Agent: ${item.taskAgent}`));
  if (item.executorProvider) meta.appendChild(element("span", null, `${item.executorProvider} · ${item.executorModel || "default"}`));
  if (item.risk) meta.appendChild(element("span", "badge-risk", `Risk: ${item.risk}`));

  card.appendChild(top);
  card.appendChild(summary);
  card.appendChild(meta);

  if (item.blockedReason) {
    const blk = element("div", "pm-item-blocker", `🛑 ${item.blockedReason}`);
    card.appendChild(blk);
  }

  if (item.planFingerprint) {
    const fp = element("div", "pm-item-fp", `FP: ${item.planFingerprint.slice(0, 12)}...`);
    card.appendChild(fp);
  }

  const actions = element("div", "pm-item-actions");
  const viewBtn = element("button", "pm-btn pm-btn-view", "İncele");
  viewBtn.type = "button";
  if (typeof viewBtn.addEventListener === "function") {
    viewBtn.addEventListener("click", () => {
      openDecisionTrace(item.issueKey);
    });
  }
  actions.appendChild(viewBtn);

  if (item.operationalGroup === "awaitingApproval") {
    const approveBtn = element("button", "pm-btn pm-btn-approve", "✓ Onayla");
    approveBtn.type = "button";
    if (typeof approveBtn.addEventListener === "function") {
      approveBtn.addEventListener("click", () => {
        openApprovalModal(item, approveBtn);
      });
    }
    actions.appendChild(approveBtn);

    const rejectBtn = element("button", "pm-btn pm-btn-reject", "✕ Reddet");
    rejectBtn.type = "button";
    if (typeof rejectBtn.addEventListener === "function") {
      rejectBtn.addEventListener("click", () => {
        openRejectionModal(item, rejectBtn);
      });
    }
    actions.appendChild(rejectBtn);
  }

  card.appendChild(actions);
  return card;
}

function renderPmJournal() {
  const messagesEl = getElem("pm-messages");
  const decisionsEl = getElem("pm-decisions");
  const msgs = state.snapshot?.pmMessages || [];
  const decs = state.snapshot?.pmDecisions || [];

  if (messagesEl) {
    messagesEl.innerHTML = "";
    if (msgs.length === 0) {
      messagesEl.appendChild(element("p", "empty-text", "Henüz PM mesajı yok."));
    } else {
      msgs.slice(0, 30).forEach(m => {
        const block = element("div", `pm-msg ${m.sender === "user" ? "user-msg" : "system-msg"}`);
        const hdr = element("small", null, `${m.sender} · ${formatTime(m.createdAt)}`);
        const body = element("p", null, m.content || m.text || "");
        block.appendChild(hdr);
        block.appendChild(body);
        messagesEl.appendChild(block);
      });
    }
  }

  if (decisionsEl) {
    decisionsEl.innerHTML = "";
    if (decs.length === 0) {
      decisionsEl.appendChild(element("p", "empty-text", "Henüz kayıtlı karar yok."));
    } else {
      decs.slice(0, 30).forEach(d => {
        const item = element("div", "decision-item");
        const hdr = element("strong", null, `${d.issueKey || "GENEL"}: ${d.type}`);
        const time = element("small", null, formatTime(d.createdAt));
        item.appendChild(hdr);
        item.appendChild(time);
        if (d.payload) {
          const desc = element("p", null, typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload));
          item.appendChild(desc);
        }
        decisionsEl.appendChild(item);
      });
    }
  }
}

// Work Item Decision Trace Drawer
async function openDecisionTrace(issueKey, fromHistory = false, triggerElement = null) {
  if (!issueKey) return;
  state.selectedWorkItemKey = issueKey;

  const modal = getElem("decision-trace-modal");
  const title = getElem("trace-drawer-title");
  const pill = getElem("trace-issue-pill");
  const summaryEl = getElem("trace-issue-summary");
  const body = getElem("trace-drawer-body");

  if (!modal || !body) return;

  if (pill) pill.textContent = issueKey;
  if (title) title.textContent = `Work Item Decision Trace · ${issueKey}`;
  if (summaryEl) summaryEl.textContent = "Detaylar yükleniyor...";
  body.innerHTML = '<div class="loading-spinner">Yükleniyor...</div>';

  openModal("decision-trace-modal", triggerElement);

  if (!fromHistory) {
    syncUrlState(false);
  }

  try {
    const res = await fetch(`/api/pm/work-items/${encodeURIComponent(issueKey)}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data = await res.json();
    renderDecisionTraceDetail(data);
  } catch (err) {
    body.innerHTML = `<div class="error-banner">Karar izi yüklenemedi: ${safeHtml(err.message)}</div>`;
  }
}

function renderDecisionTraceDetail(data) {
  const summaryEl = getElem("trace-issue-summary");
  const body = getElem("trace-drawer-body");
  if (!body) return;
  body.innerHTML = "";

  const wi = data.workItem || {};
  const orch = data.orchestratorDecision || {};
  const agentId = data.agentIdentity || {};
  const exec = data.execution || {};
  const rev = data.review || {};
  const human = data.humanControl || {};
  const blk = data.blockedInfo || {};
  const history = data.history || [];

  if (summaryEl) summaryEl.textContent = wi.summary || "Açıklama yok";

  // 1. Work Item Summary
  const wiSection = element("div", "trace-section");
  wiSection.appendChild(element("h3", "trace-section-title", "1. Work Item Özeti"));
  const wiGrid = element("div", "trace-grid");
  wiGrid.appendChild(createTraceCell("Key", wi.key));
  wiGrid.appendChild(createTraceCell("Kanonik Durum", wi.canonicalState));
  wiGrid.appendChild(createTraceCell("Kaynak Sağlayıcı", wi.sourceProvider || "jira"));
  wiGrid.appendChild(createTraceCell("Otonom İlerlenebilir", wi.autonomousEligible ? "Evet" : "Hayır"));
  wiSection.appendChild(wiGrid);
  body.appendChild(wiSection);

  // 2. Orchestration Decision
  const orchSection = element("div", "trace-section");
  orchSection.appendChild(element("h3", "trace-section-title", "2. Orkestrasyon ve Planlama Kararı"));
  const orchGrid = element("div", "trace-grid");
  orchGrid.appendChild(createTraceCell("Persona", orch.persona || "—"));
  orchGrid.appendChild(createTraceCell("Task Agent", orch.taskAgent || "—"));
  orchGrid.appendChild(createTraceCell("Risk", orch.risk || "normal"));
  orchGrid.appendChild(createTraceCell("Plan Parmak İzi", orch.planFingerprint ? orch.planFingerprint.slice(0, 16) + "..." : "—"));
  orchGrid.appendChild(createTraceCell("İzinli Yollar", Array.isArray(orch.allowedPaths) ? orch.allowedPaths.join(", ") : "—"));
  orchGrid.appendChild(createTraceCell("Bağımlılıklar", Array.isArray(orch.dependencies) && orch.dependencies.length ? orch.dependencies.join(", ") : "Bağımsız"));
  orchSection.appendChild(orchGrid);
  body.appendChild(orchSection);

  // 3. Agent Identity
  const aidSection = element("div", "trace-section");
  aidSection.appendChild(element("h3", "trace-section-title", "3. Agent Kimliği (Registry)"));
  const aidGrid = element("div", "trace-grid");
  aidGrid.appendChild(createTraceCell("Agent ID", agentId.agentId || orch.taskAgent || "—"));
  aidGrid.appendChild(createTraceCell("Agent Version", agentId.agentVersion ?? "—"));
  aidGrid.appendChild(createTraceCell("Agent Hash", agentId.agentHash ? String(agentId.agentHash).slice(0, 12) + "..." : "—"));
  aidGrid.appendChild(createTraceCell("Canlı Registry Durumu", agentId.liveRegistryStatus || "—"));
  aidGrid.appendChild(createTraceCell("Canlı Registry Version", agentId.liveRegistryVersion ?? "—"));
  aidGrid.appendChild(createTraceCell("Canlı Registry Hash", agentId.liveRegistryHash ? String(agentId.liveRegistryHash).slice(0, 12) + "..." : "—"));
  aidGrid.appendChild(createTraceCell("Sabitlenmiş Sürüm Güncel", agentId.isPinnedVersionCurrent === true ? "Evet" : (agentId.isPinnedVersionCurrent === false ? "Hayır" : "—")));
  aidSection.appendChild(aidGrid);
  body.appendChild(aidSection);

  // 4. Execution Engine & Worktree
  const execSection = element("div", "trace-section");
  execSection.appendChild(element("h3", "trace-section-title", "4. Yürütme Motoru ve Worktree"));
  const execGrid = element("div", "trace-grid");
  execGrid.appendChild(createTraceCell("Provider", exec.provider || "—"));
  execGrid.appendChild(createTraceCell("Model", exec.model || "—"));
  execGrid.appendChild(createTraceCell("Model Profile", exec.modelProfile || "—"));
  execGrid.appendChild(createTraceCell("Çalışma Durumu", exec.currentRunState || "—"));
  execGrid.appendChild(createTraceCell("Branch", exec.branch || "—"));
  execGrid.appendChild(createTraceCell("Worktree", exec.worktree || "—"));
  execGrid.appendChild(createTraceCell("Commit SHA", exec.commit || "—"));
  execGrid.appendChild(createTraceCell("Deneme", exec.attempt != null && exec.maxAttempts != null ? `${exec.attempt} / ${exec.maxAttempts}` : String(exec.attempt ?? "0")));
  execSection.appendChild(execGrid);
  body.appendChild(execSection);

  // 5. Reviewer & Findings
  const revSection = element("div", "trace-section");
  revSection.appendChild(element("h3", "trace-section-title", "5. Reviewer ve Doğrulama Bulguları"));
  const revGrid = element("div", "trace-grid");
  revGrid.appendChild(createTraceCell("Reviewer Agent", rev.reviewerTaskAgent || "—"));
  revGrid.appendChild(createTraceCell("Review Agent Version", rev.reviewAgentVersion ?? "—"));
  revGrid.appendChild(createTraceCell("Review Agent Hash", rev.reviewAgentHash ? String(rev.reviewAgentHash).slice(0, 12) + "..." : "—"));
  revGrid.appendChild(createTraceCell("Review Provider", rev.reviewProvider || "—"));
  revGrid.appendChild(createTraceCell("Review Model", rev.reviewModel || "—"));
  revGrid.appendChild(createTraceCell("Review Model Profile", rev.reviewModelProfile || "—"));
  revGrid.appendChild(createTraceCell("Verdict", rev.verdict || "Henüz verilmedi"));
  revGrid.appendChild(createTraceCell("İncelenen SHA", rev.latestImplementationSha || "—"));
  revSection.appendChild(revGrid);

  if (rev.structuredFindings && Array.isArray(rev.structuredFindings) && rev.structuredFindings.length > 0) {
    const findingsList = element("ul", "trace-findings-list");
    rev.structuredFindings.forEach(f => {
      const li = element("li", null, typeof f === "string" ? f : `${f.severity || "INFO"}: ${f.message || JSON.stringify(f)}`);
      findingsList.appendChild(li);
    });
    revSection.appendChild(findingsList);
  }
  body.appendChild(revSection);

  // 6. Human Control
  const humanSection = element("div", "trace-section");
  humanSection.appendChild(element("h3", "trace-section-title", "6. İnsan Kontrol ve Onay Kapısı"));
  const humanGrid = element("div", "trace-grid");
  humanGrid.appendChild(createTraceCell("Bekleyen Aksiyon", human.pendingAction || "Yok"));
  humanGrid.appendChild(createTraceCell("Onay Durumu", human.approvalState || "not_required"));
  humanGrid.appendChild(createTraceCell("Plan Parmak İzi", human.planFingerprint ? String(human.planFingerprint).slice(0, 16) + "..." : "—"));
  humanGrid.appendChild(createTraceCell("Çalışma Modu", human.operatingMode || "AUTONOMOUS"));
  humanSection.appendChild(humanGrid);
  body.appendChild(humanSection);

  // 7. Blocked Info
  if (blk.isBlocked) {
    const blkSection = element("div", "trace-section trace-blocked-box");
    blkSection.appendChild(element("h3", "trace-section-title", "🛑 Bloke Durumu ve Teşhis"));
    const blkGrid = element("div", "trace-grid");
    blkGrid.appendChild(createTraceCell("Gerekçe", blk.reason || "Bilinmiyor"));
    blkGrid.appendChild(createTraceCell("Tekrar Denenebilir", blk.canRetry ? "Evet" : "Hayır"));
    blkGrid.appendChild(createTraceCell("Onaylanabilir", blk.canApprove ? "Evet" : "Hayır"));
    blkSection.appendChild(blkGrid);
    body.appendChild(blkSection);
  }

  // 8. History Timeline — uses label/actor/details, not message/payload
  const histSection = element("div", "trace-section");
  histSection.appendChild(element("h3", "trace-section-title", "7. Denetlenebilir Olay Zaman Çizelgesi"));
  if (history.length === 0) {
    histSection.appendChild(element("p", "empty-text", "Zaman çizelgesi boş."));
  } else {
    const timeline = element("div", "trace-timeline");
    history.forEach(item => {
      const step = element("div", "timeline-step");
      const dot = element("span", "timeline-dot");
      const content = element("div", "timeline-content");
      const time = element("small", null, formatTime(item.timestamp || item.createdAt));
      const stage = element("strong", null, `${item.stage || item.state || "event"}: `);
      const label = item.label || item.message || "";
      let actorStr = "";
      if (item.actor) {
        if (typeof item.actor === "object") {
          const type = item.actor.type || item.actor.role || "";
          const id = item.actor.id || item.actor.name || item.actor.agentId || "";
          if (type && id) actorStr = ` [${type} · ${id}]`;
          else if (id) actorStr = ` [${id}]`;
          else if (type) actorStr = ` [${type}]`;
        } else {
          actorStr = ` [${item.actor}]`;
        }
      }
      let safeDetails = "";
      if (item.details) {
        if (typeof item.details === "string") {
          safeDetails = item.details;
        } else if (typeof item.details === "object") {
          const clean = { ...item.details };
          delete clean.rawPrompt;
          delete clean.prompt;
          delete clean.stdout;
          delete clean.stderr;
          delete clean.apiKey;
          delete clean.token;
          delete clean.secret;
          delete clean.raw;
          const s = JSON.stringify(clean);
          if (s !== "{}") safeDetails = s;
        }
      }
      const descText = [label, actorStr, safeDetails].filter(Boolean).join(" ") || "—";
      const desc = element("span", null, descText);
      content.appendChild(time);
      content.appendChild(stage);
      content.appendChild(desc);
      step.appendChild(dot);
      step.appendChild(content);
      timeline.appendChild(step);
    });
    histSection.appendChild(timeline);
  }
  body.appendChild(histSection);
}

function createTraceCell(label, value) {
  const cell = element("div", "trace-cell");
  cell.appendChild(element("span", "trace-cell-label", label));
  cell.appendChild(element("strong", "trace-cell-value", value !== null && value !== undefined && value !== "" ? String(value) : "—"));
  return cell;
}

// Approval & Rejection Modals
function openApprovalModal(item, triggerBtn = null) {
  state.pendingApprovalItem = item;
  const issueEl = getElem("app-modal-issue");
  const actionEl = getElem("app-modal-action");
  const agentEl = getElem("app-modal-agent");
  const riskEl = getElem("app-modal-risk");
  const provEl = getElem("app-modal-provider");
  const pathsEl = getElem("app-modal-paths");
  const fpEl = getElem("app-modal-fp");
  const statusEl = getElem("approval-modal-status");
  const confirmBtn = getElem("approval-modal-confirm-btn");
  const cancelBtn = getElem("approval-modal-cancel-btn");

  if (issueEl) issueEl.textContent = item.issueKey || "—";
  if (actionEl) actionEl.textContent = item.action || "implementation";
  if (agentEl) agentEl.textContent = item.taskAgent || item.persona || "—";
  if (riskEl) riskEl.textContent = item.risk || "normal";
  if (provEl) provEl.textContent = `${item.executorProvider || "default"} / ${item.executorModel || "default"}`;
  if (pathsEl) pathsEl.textContent = Array.isArray(item.allowedPaths) ? item.allowedPaths.join(", ") : "—";
  if (fpEl) fpEl.textContent = item.planFingerprint || "—";
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }

  if (confirmBtn) confirmBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = false;

  openModal("approval-modal", triggerBtn);
}

async function submitApproval() {
  const item = state.pendingApprovalItem;
  if (!item) return;

  const confirmBtn = getElem("approval-modal-confirm-btn");
  const cancelBtn = getElem("approval-modal-cancel-btn");
  const statusEl = getElem("approval-modal-status");

  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "modal-status-msg is-loading";
    statusEl.textContent = "Onay kaydediliyor...";
  }

  try {
    const res = await fetch(`/api/pm/work-items/${encodeURIComponent(item.issueKey)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: item.action || "implementation",
        planFingerprint: item.planFingerprint,
        attempt: item.reworkAttempt || 0,
        approver: "pm-operator"
      })
    });

    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (statusEl) {
        statusEl.className = "modal-status-msg is-error";
        statusEl.textContent = `409 Çakışma: Plan parmak izi değişmiş (${data.error || "Plan güncellendi"}). Çalışma alanı yenileniyor...`;
      }
      if (confirmBtn) confirmBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      await fetchSnapshot();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    }

    if (statusEl) {
      statusEl.className = "modal-status-msg is-success";
      statusEl.textContent = "✓ Onay başarıyla kaydedildi.";
    }

    setTimeout(() => {
      closeModal("approval-modal");
      state.pendingApprovalItem = null;
      fetchSnapshot();
    }, 700);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = `Hata: ${err.message}`;
    }
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

function openRejectionModal(item, triggerBtn = null) {
  state.pendingRejectionItem = item;
  const reasonInput = getElem("rejection-reason-input");
  const statusEl = getElem("rejection-modal-status");
  const confirmBtn = getElem("rejection-modal-confirm-btn");
  const cancelBtn = getElem("rejection-modal-cancel-btn");

  if (reasonInput) reasonInput.value = "";
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }
  if (confirmBtn) confirmBtn.disabled = false;
  if (cancelBtn) cancelBtn.disabled = false;

  openModal("rejection-modal", triggerBtn);
}

async function submitRejection() {
  const item = state.pendingRejectionItem;
  if (!item) return;

  const reasonInput = getElem("rejection-reason-input");
  const confirmBtn = getElem("rejection-modal-confirm-btn");
  const cancelBtn = getElem("rejection-modal-cancel-btn");
  const statusEl = getElem("rejection-modal-status");

  const reason = reasonInput ? reasonInput.value.trim() : "";
  if (!reason) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = "Lütfen bir reddetme gerekçesi belirtin.";
    }
    return;
  }

  if (confirmBtn) confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "modal-status-msg is-loading";
    statusEl.textContent = "Red işlemi kaydediliyor...";
  }

  try {
    const res = await fetch(`/api/pm/work-items/${encodeURIComponent(item.issueKey)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: item.action || "implementation",
        planFingerprint: item.planFingerprint,
        reason,
        approver: "pm-operator"
      })
    });

    if (res.status === 409) {
      const data = await res.json().catch(() => ({}));
      if (statusEl) {
        statusEl.className = "modal-status-msg is-error";
        statusEl.textContent = `409 Çakışma: Plan parmak izi değişmiş (${data.error || "Plan güncellendi"}). Çalışma alanı yenileniyor...`;
      }
      if (confirmBtn) confirmBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      await fetchSnapshot();
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}: ${res.statusText}`);
    }

    if (statusEl) {
      statusEl.className = "modal-status-msg is-success";
      statusEl.textContent = "✓ Reddedildi ve iş bloke edildi.";
    }

    setTimeout(() => {
      closeModal("rejection-modal");
      state.pendingRejectionItem = null;
      fetchSnapshot();
    }, 700);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = `Hata: ${err.message}`;
    }
    if (confirmBtn) confirmBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
  }
}

// Parent Orchestration & Child DAG
function clearParentDetail() {
  const keyBadge = getElem("parent-key-badge");
  const summaryText = getElem("parent-summary-text");
  const statePillEl = getElem("parent-state-pill");
  const baseSha = getElem("parent-base-sha");
  const intBranch = getElem("parent-int-branch");
  const intHeadSha = getElem("parent-int-head-sha");
  const graphFp = getElem("parent-graph-fp");
  const blockersBox = getElem("parent-blockers-container");
  const compCard = getElem("parent-human-approval-card");
  const container = getElem("parent-dag-container");
  const lane = getElem("parent-integration-lane");
  const findings = getElem("parent-review-findings");

  if (keyBadge) keyBadge.textContent = "—";
  if (summaryText) summaryText.textContent = "Lütfen bir parent epik seçin";
  if (statePillEl) {
    statePillEl.textContent = "—";
    statePillEl.className = "state-pill";
  }
  if (baseSha) baseSha.textContent = "—";
  if (intBranch) intBranch.textContent = "—";
  if (intHeadSha) intHeadSha.textContent = "—";
  if (graphFp) graphFp.textContent = "—";
  if (blockersBox) { blockersBox.hidden = true; blockersBox.innerHTML = ""; }
  if (compCard) compCard.hidden = true;
  if (container) container.innerHTML = '<div class="empty-state">Parent seçilmedi.</div>';
  if (lane) lane.innerHTML = '<div class="empty-state">Parent seçilmedi.</div>';
  if (findings) findings.innerHTML = "";
}

function populateParentSelector() {
  const select = getElem("parent-select");
  if (!select) return;

  const parents = state.snapshot?.parentExecutions || [];
  select.innerHTML = "";

  if (parents.length === 0) {
    const opt = element("option", null, "Kayıtlı parent epik bulunamadı");
    opt.value = "";
    select.appendChild(opt);
    return;
  }

  const defaultOpt = element("option", null, "-- Parent Epik Seçin --");
  defaultOpt.value = "";
  select.appendChild(defaultOpt);

  parents.forEach(p => {
    const pKey = p.parentKey || p.key;
    const opt = element("option", null, `${pKey}: ${p.summary || "Epik"}`);
    opt.value = pKey;
    if (state.selectedParentKey === pKey) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  if (state.selectedParentKey) {
    select.value = state.selectedParentKey;
  } else {
    select.value = "";
  }
}

async function fetchParentDetail(parentKey) {
  if (!parentKey) return;
  state.selectedParentKey = parentKey;

  const select = getElem("parent-select");
  if (select && select.value !== parentKey) {
    select.value = parentKey;
  }

  try {
    const res = await fetch(`/api/pm/parents/${encodeURIComponent(parentKey)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderParentDetail(data.parent || data);
  } catch (err) {
    const summaryText = getElem("parent-summary-text");
    if (summaryText) summaryText.textContent = `Parent yüklenemedi: ${err.message}`;
  }
}

function renderParentDetail(data) {
  const detail = (data && data.ok && data.parent) ? data.parent : (data || {});
  const parent = detail.parent || {};
  const stateVal = detail.state || "active";
  const children = detail.children || [];
  const blockedReasons = detail.blockedReasons || [];
  const isWaitingHuman = Boolean(detail.waitingHuman) || stateVal === "waiting_human" || stateVal === "human_approval";

  const keyBadge = getElem("parent-key-badge");
  const summaryText = getElem("parent-summary-text");
  const statePillEl = getElem("parent-state-pill");
  const baseSha = getElem("parent-base-sha");
  const intBranch = getElem("parent-int-branch");
  const intHeadSha = getElem("parent-int-head-sha");
  const graphFp = getElem("parent-graph-fp");
  const blockersBox = getElem("parent-blockers-container");

  if (keyBadge) keyBadge.textContent = parent.parentKey || parent.key || "—";
  if (summaryText) summaryText.textContent = parent.summary || "Parent Epik";
  if (statePillEl) {
    statePillEl.textContent = STATUS_LABELS[stateVal] || stateVal.toUpperCase();
    statePillEl.className = `state-pill ${stateVal}`;
  }
  if (baseSha) baseSha.textContent = detail.baseSha ? `${detail.baseRef || "develop"} @ ${detail.baseSha.slice(0, 8)}` : (detail.baseRef || "develop");
  if (intBranch) intBranch.textContent = detail.integrationBranch || "—";
  if (intHeadSha) intHeadSha.textContent = detail.integrationHeadSha ? detail.integrationHeadSha.slice(0, 8) : "—";
  if (graphFp) graphFp.textContent = detail.graphFingerprint ? detail.graphFingerprint.slice(0, 12) + "..." : "—";

  if (blockersBox) {
    if (blockedReasons.length > 0) {
      blockersBox.hidden = false;
      blockersBox.innerHTML = `<strong>🛑 Parent Blockerları:</strong><ul>${blockedReasons.map(r => `<li>${safeHtml(r)}</li>`).join("")}</ul>`;
    } else {
      blockersBox.hidden = true;
      blockersBox.innerHTML = "";
    }
  }

  const compCard = getElem("parent-human-approval-card");
  if (compCard) {
    if (isWaitingHuman) {
      compCard.hidden = false;
      const cFp = getElem("comp-graph-fp");
      const cBase = getElem("comp-base-sha");
      const cHead = getElem("comp-int-head");
      const cRev = getElem("comp-review-verdict");

      if (cFp) cFp.textContent = detail.graphFingerprint ? detail.graphFingerprint.slice(0, 12) + "..." : "—";
      if (cBase) cBase.textContent = detail.baseSha ? detail.baseSha.slice(0, 10) : "—";
      if (cHead) cHead.textContent = detail.integrationHeadSha ? detail.integrationHeadSha.slice(0, 10) : "—";
      if (cRev) cRev.textContent = detail.integrationReview?.verdict || "CLEAN";
    } else {
      compCard.hidden = true;
    }
  }

  renderChildDag(children);
  renderIntegrationLane(children, detail.integrationBranch);
  renderParentReviewFindings(detail);
}

function renderChildDag(children = []) {
  const container = getElem("parent-dag-container");
  const textFallback = getElem("parent-dag-text-fallback");
  if (!container) return;
  container.innerHTML = "";

  if (children.length === 0) {
    container.appendChild(element("div", "empty-state", "Bu parent epikte child task yok."));
    if (textFallback) textFallback.textContent = "Child task bulunamadı.";
    return;
  }

  if (textFallback) {
    const lines = children.map(c => {
      const deps = c.dependencies && c.dependencies.length > 0 ? ` (Bağımlı: ${c.dependencies.join(", ")})` : " (Bağımsız / Paralel)";
      return `• ${c.issueKey}: ${c.summary || "Task"} | Durum: ${c.runtimeState || c.orchestrationState || "eligible"} | Entegrasyon: ${c.integrationState || "not-queued"}${deps}`;
    });
    textFallback.textContent = lines.join("\n");
  }

  const independent = children.filter(c => !c.dependencies || c.dependencies.length === 0);
  const dependent = children.filter(c => c.dependencies && c.dependencies.length > 0);

  const wave1Box = element("div", "dag-wave");
  wave1Box.appendChild(element("h4", "dag-wave-title", "Dalga 1 (Paralel / Bağımsız Tasklar)"));
  const wave1Grid = element("div", "dag-nodes-grid");
  independent.forEach(c => wave1Grid.appendChild(createDagNode(c)));
  wave1Box.appendChild(wave1Grid);
  container.appendChild(wave1Box);

  if (dependent.length > 0) {
    const wave2Box = element("div", "dag-wave");
    wave2Box.appendChild(element("h4", "dag-wave-title", "Dalga 2+ (Sıralı / Bağımlı Tasklar)"));
    const wave2Grid = element("div", "dag-nodes-grid");
    dependent.forEach(c => wave2Grid.appendChild(createDagNode(c)));
    wave2Box.appendChild(wave2Grid);
    container.appendChild(wave2Box);
  }
}

function createDagNode(child) {
  const node = element("button", "dag-node-btn");
  node.type = "button";
  node.dataset = node.dataset || {};
  node.dataset.issueKey = child.issueKey;

  let stateClass = "state-ready";
  if (child.integrationState === "integrated") stateClass = "state-integrated";
  else if (child.runtimeState === "blocked" || child.runtimeState === "blocked-conflict") stateClass = "state-conflict";
  else if (child.runtimeState === "executing") stateClass = "state-executing";
  else if (child.runtimeState === "verifying" || child.reviewedSha) stateClass = "state-review";

  if (node.classList && typeof node.classList.add === "function") {
    node.classList.add(stateClass);
  }

  const top = element("div", "dag-node-top");
  const key = element("strong", "dag-node-key", child.issueKey);
  const badge = element("span", "badge-dag", child.integrationState === "integrated" ? "ENTEGRE" : (child.reviewedSha ? "REVIEWED" : (STATUS_LABELS[child.runtimeState] || child.runtimeState)));
  top.appendChild(key);
  top.appendChild(badge);

  const title = element("p", "dag-node-title", child.summary || "Task");

  const meta = element("div", "dag-node-meta");
  if (child.dependencies && child.dependencies.length > 0) {
    meta.appendChild(element("small", null, `← Bağımlı: ${child.dependencies.join(", ")} (${child.dependencyState})`));
  } else {
    meta.appendChild(element("small", null, "✓ Bağımsız / Paralel"));
  }
  if (child.childBaseSha) {
    meta.appendChild(element("small", "code-cell", `Base SHA: ${child.childBaseSha.slice(0, 8)}`));
  }

  node.appendChild(top);
  node.appendChild(title);
  node.appendChild(meta);

  if (typeof node.addEventListener === "function") {
    node.addEventListener("click", () => {
      openDecisionTrace(child.issueKey);
    });
  }

  return node;
}

function renderIntegrationLane(children = [], branchName) {
  const lane = getElem("parent-integration-lane");
  if (!lane) return;
  lane.innerHTML = "";

  if (children.length === 0) {
    lane.appendChild(element("div", "empty-state", "Entegrasyon kuyruğu boş."));
    return;
  }

  children.forEach((c, idx) => {
    const item = element("div", "integration-item");
    const num = element("span", "int-seq", String(idx + 1));
    const content = element("div", "int-content");
    const hdr = element("strong", null, `${c.issueKey} · ${c.summary || "Task"}`);

    const diffStatus = element("div", "int-badges");
    diffStatus.appendChild(element("span", `badge ${c.reviewedSha ? "badge-clean" : "badge-pending"}`, c.reviewedSha ? `Reviewed: ${c.reviewedSha.slice(0, 8)}` : "Review Bekliyor"));
    diffStatus.appendChild(element("span", `badge ${c.integratedSha ? "badge-integrated" : "badge-not-integrated"}`, c.integratedSha ? `Integrated: ${c.integratedSha.slice(0, 8)}` : "Henüz Entegre Edilmedi"));

    content.appendChild(hdr);
    content.appendChild(diffStatus);
    item.appendChild(num);
    item.appendChild(content);
    lane.appendChild(item);
  });
}

function renderParentReviewFindings(data) {
  const container = getElem("parent-review-findings");
  if (!container) return;
  container.innerHTML = "";

  const rev = data.integrationReview;
  const completion = data.completion || {};
  const verification = completion.verification || data.verification;

  if (!rev && !verification) {
    container.appendChild(element("p", "empty-text", "Tüm child tasklar entegre edildiğinde aggregate review ve repo doğrulaması burada görüntülenecektir."));
    return;
  }

  if (verification) {
    const verifBox = element("div", "finding-box");
    const verifLabel = verification.command || verification.check || "verification check";
    verifBox.appendChild(element("h4", null, `Verification (${verifLabel})`));
    const passed = verification.passed ?? verification.result;
    verifBox.appendChild(element("p", null, `Durum: ${passed ? "✓ Başarılı" : (passed === false ? "✕ Başarısız" : "Bilinmiyor")}`));
    if (verification.evidence) {
      const pre = element("pre", "code-block", String(verification.evidence).slice(0, 500));
      verifBox.appendChild(pre);
    } else if (verification.output) {
      const pre = element("pre", "code-block", String(verification.output).slice(0, 500));
      verifBox.appendChild(pre);
    }
    container.appendChild(verifBox);
  }

  if (rev) {
    const revBox = element("div", "finding-box");
    const reviewerName = rev.reviewerAgentId || rev.reviewer || "reviewer-agent";
    revBox.appendChild(element("h4", null, `Aggregate Integration Review (${reviewerName})`));

    const revMeta = element("div", "trace-grid");
    revMeta.appendChild(createTraceCell("Reviewer Agent", rev.reviewerAgentId || "—"));
    revMeta.appendChild(createTraceCell("Reviewer Version", rev.reviewerVersion ?? "—"));
    revMeta.appendChild(createTraceCell("Reviewer Hash", rev.reviewerHash ? String(rev.reviewerHash).slice(0, 12) + "..." : "—"));
    revMeta.appendChild(createTraceCell("Provider", rev.provider || "—"));
    revMeta.appendChild(createTraceCell("Model Profile", rev.modelProfile || "—"));
    revMeta.appendChild(createTraceCell("Verdict", rev.verdict || "CLEAN"));
    revBox.appendChild(revMeta);

    if (rev.findings && rev.findings.length > 0) {
      const ul = element("ul", null);
      rev.findings.forEach(f => ul.appendChild(element("li", null, typeof f === "string" ? f : JSON.stringify(f))));
      revBox.appendChild(ul);
    }
    container.appendChild(revBox);
  }

  // Render warnings if present
  const warnings = completion.warnings || data.warnings;
  if (warnings && Array.isArray(warnings) && warnings.length > 0) {
    const warnBox = element("div", "finding-box");
    warnBox.appendChild(element("h4", null, "⚠️ Uyarılar (Warnings)"));
    const warnList = element("ul", null);
    warnings.forEach(w => warnList.appendChild(element("li", null, typeof w === "string" ? w : JSON.stringify(w))));
    warnBox.appendChild(warnList);
    container.appendChild(warnBox);
  }
}

// Observability View
async function fetchObservabilitySummary() {
  const windowParam = state.currentObsWindow || "24h";
  try {
    const res = await fetch(`/api/observability/summary?window=${encodeURIComponent(windowParam)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderObservability(data);
  } catch (err) {
    const runsTbody = getElem("obs-runs-table-body");
    if (runsTbody) {
      runsTbody.innerHTML = `<tr><td colspan="8" class="error-banner">Gözlemlenebilirlik verisi alınamadı: ${safeHtml(err.message)}</td></tr>`;
    }
  }
}

function renderObservability(data) {
  const metrics = data.metrics || {};
  const providers = data.providers || [];
  const healthyProviders = providers.filter(provider => ["healthy", "available", "ok"].includes(String(provider.status || "").toLowerCase())).length;
  const activeEl = getElem("obs-active-workers");
  const healthEl = getElem("obs-active-parents");
  const tokensEl = getElem("obs-total-tokens");
  const failuresEl = getElem("obs-conflicts");
  if (activeEl) activeEl.textContent = String(metrics.activeRuns || 0) + " aktif / " + String(metrics.queuedRuns || 0) + " kuyruk";
  if (healthEl) healthEl.textContent = providers.length ? String(healthyProviders) + " / " + String(providers.length) : "—";
  if (tokensEl) tokensEl.textContent = metrics.totalUsage?.totalTokens === null || metrics.totalUsage?.totalTokens === undefined ? "—" : formatNumber(metrics.totalUsage.totalTokens);
  if (failuresEl) failuresEl.textContent = String(metrics.runsFailed || 0) + " başarısız";

  const liveGrid = getElem("obs-live-grid");
  if (liveGrid) {
    liveGrid.innerHTML = "";
    const runs = state.snapshot?.runs || [];
    const liveRuns = runs.filter(r => r.stateKind === "active" || r.stateKind === "review");

    if (liveRuns.length === 0) {
      liveGrid.appendChild(element("p", "empty-text", "Şu anda çalışan veya incelemede aktif işlem yok."));
    } else {
      liveRuns.forEach(run => {
        const card = element("div", "obs-live-card");
        const top = element("div", "obs-live-top");
        top.appendChild(element("strong", null, run.issue || run.issueKey));
        top.appendChild(element("span", `state-badge ${run.stateKind}`, STATUS_LABELS[run.state] || run.state));
        card.appendChild(top);
        card.appendChild(element("p", "obs-live-desc", `${run.persona || "persona"} · ${run.provider || "provider"}`));
        liveGrid.appendChild(card);
      });
    }
  }

  const provGrid = getElem("obs-providers-grid");
  if (provGrid) {
    provGrid.innerHTML = "";
    const providers = data.providers || [];
    if (providers.length === 0) {
      provGrid.appendChild(element("p", "empty-text", "Provider telemetri verisi bulunamadı."));
    } else {
      providers.forEach(p => {
        const card = element("div", "obs-provider-card");
        const hdr = element("div", "obs-prov-header");
        hdr.appendChild(element("h4", null, p.provider));
        const badge = element("span", `prov-status-badge ${p.status || "healthy"}`, p.status || "healthy");
        hdr.appendChild(badge);
        card.appendChild(hdr);

        const metrics = element("div", "obs-prov-metrics");
        metrics.appendChild(createTraceCell("Başarı Oranı", p.successRate !== null ? `${Math.round(p.successRate * 100)}%` : "—"));
        metrics.appendChild(createTraceCell("Ort. Süre", p.averageDurationMs !== null ? formatDurationMs(p.averageDurationMs) : "—"));
        metrics.appendChild(createTraceCell("Başarılı / Başarısız", `${p.recentSuccesses || 0} / ${p.recentFailures || 0}`));
        if (p.cooldownUntil) {
          metrics.appendChild(createTraceCell("Cooldown", formatTime(p.cooldownUntil)));
        }
        card.appendChild(metrics);
        provGrid.appendChild(card);
      });
    }
  }

  const tbody = getElem("obs-runs-table-body");
  if (tbody) {
    tbody.innerHTML = "";
    const runs = data.runs || [];
    if (runs.length === 0) {
      const row = element("tr");
      const td = element("td", null, "Seçilen zaman penceresinde yürütme kaydı yok.");
      td.colSpan = 8;
      row.appendChild(td);
      tbody.appendChild(row);
      return;
    }

    runs.forEach(run => {
      const row = element("tr");
      const issueTd = element("td", "code-cell", run.issueKey || "—");
      const roleTd = element("td", null, `${run.role || "impl"} / ${run.taskAgent || "agent"}`);
      const modelTd = element("td", null, `${run.provider || "—"} / ${run.model || "default"}`);
      const statusTd = element("td", null, STATUS_LABELS[run.state] || run.state || "—");

      const durTd = element("td", null);
      if (run.durationSeconds !== null && run.durationSeconds !== undefined) {
        durTd.textContent = formatDuration(run.durationSeconds);
      } else {
        durTd.textContent = "—";
      }

      const tokTd = element("td", null);
      if (run.usage && run.usage.available && run.usage.totalTokens !== null) {
        tokTd.textContent = `${formatNumber(run.usage.totalTokens)} tok`;
      } else if (run.tokens !== null && run.tokens !== undefined) {
        tokTd.textContent = `${formatNumber(run.tokens)} tok`;
      } else {
        tokTd.textContent = "—";
      }

      const dateTd = element("td", null, formatTime(run.createdAt || run.timestamp));

      const actionTd = element("td", null);
      const detailBtn = element("button", "pm-btn pm-btn-view", "Detay");
      detailBtn.type = "button";
      if (typeof detailBtn.addEventListener === "function") {
        detailBtn.addEventListener("click", () => {
          openTelemetryDrawer(run.runId || run.id);
        });
      }
      actionTd.appendChild(detailBtn);

      row.appendChild(issueTd);
      row.appendChild(roleTd);
      row.appendChild(modelTd);
      row.appendChild(statusTd);
      row.appendChild(durTd);
      row.appendChild(tokTd);
      row.appendChild(dateTd);
      row.appendChild(actionTd);
      tbody.appendChild(row);
    });
  }
}

// Telemetry Timeline Drawer
async function openTelemetryDrawer(runId, fromHistory = false) {
  if (!runId) return;
  state.selectedRunId = runId;

  const modal = getElem("telemetry-drawer-modal");
  const pill = getElem("telem-run-pill");
  const title = getElem("telem-drawer-title");
  const summaryEl = getElem("telem-run-summary");
  const body = getElem("telem-drawer-body");

  if (!modal || !body) return;

  if (pill) pill.textContent = runId;
  if (title) title.textContent = `Run Telemetry Timeline · ${runId}`;
  if (summaryEl) summaryEl.textContent = "Telemetri yükleniyor...";
  body.innerHTML = '<div class="loading-spinner">Yükleniyor...</div>';

  openModal("telemetry-drawer-modal");

  if (!fromHistory) {
    syncUrlState(false);
  }

  try {
    const res = await fetch(`/api/observability/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderTelemetryDrawerDetail(data);
  } catch (err) {
    body.innerHTML = `<div class="error-banner">Telemetri detayı yüklenemedi: ${safeHtml(err.message)}</div>`;
  }
}

function renderTelemetryDrawerDetail(data) {
  const summaryEl = getElem("telem-run-summary");
  const body = getElem("telem-drawer-body");
  if (!body) return;
  body.innerHTML = "";

  const id = data.identity || {};
  const st = data.state || {};
  const tm = data.timing || {};
  const usg = data.usage || {};
  const ci = data.codeIntelligence || {};
  const events = data.events || [];

  if (summaryEl) {
    summaryEl.textContent = `${id.issueKey || "Task"} · ${id.role || "impl"} (${st.current || "unknown"})`;
  }

  const idSection = element("div", "trace-section");
  idSection.appendChild(element("h3", "trace-section-title", "1. Run Kimliği ve Konfigürasyon"));
  const idGrid = element("div", "trace-grid");
  idGrid.appendChild(createTraceCell("Issue", id.issueKey));
  idGrid.appendChild(createTraceCell("Rol", id.role));
  idGrid.appendChild(createTraceCell("Persona / Agent", `${id.persona || "—"} / ${id.taskAgent || "—"}`));
  idGrid.appendChild(createTraceCell("Agent Version", id.agentVersion ?? "—"));
  idGrid.appendChild(createTraceCell("Provider / Model", `${id.provider || "—"} / ${id.model || "default"}`));
  idGrid.appendChild(createTraceCell("Deneme No", String(id.attempt ?? "0")));
  idSection.appendChild(idGrid);
  body.appendChild(idSection);

  const tokSection = element("div", "trace-section");
  tokSection.appendChild(element("h3", "trace-section-title", "2. Token Kullanımı ve Maliyet Ledgeri"));
  const tokGrid = element("div", "trace-grid");
  tokGrid.appendChild(createTraceCell("Input Tokens", usg.inputTokens !== null ? formatNumber(usg.inputTokens) : "Usage unavailable"));
  tokGrid.appendChild(createTraceCell("Output Tokens", usg.outputTokens !== null ? formatNumber(usg.outputTokens) : "Usage unavailable"));
  tokGrid.appendChild(createTraceCell("Cached Input Tokens", usg.cachedInputTokens !== null ? formatNumber(usg.cachedInputTokens) : "—"));
  tokGrid.appendChild(createTraceCell("Toplam Token", usg.totalTokens !== null ? formatNumber(usg.totalTokens) : "Usage unavailable"));
  tokGrid.appendChild(createTraceCell("Hesaplanan Maliyet", data.cost ? `$${data.cost.amount || 0}` : "Cost unavailable"));
  tokSection.appendChild(tokGrid);
  body.appendChild(tokSection);

  const timeSection = element("div", "trace-section");
  timeSection.appendChild(element("h3", "trace-section-title", "3. Yürütme Süreleri"));
  const timeGrid = element("div", "trace-grid");
  timeGrid.appendChild(createTraceCell("Kuyruk Süresi", tm.queuedDurationMs !== null && tm.queuedDurationMs !== undefined ? formatDurationMs(tm.queuedDurationMs) : "—"));
  timeGrid.appendChild(createTraceCell("Çalışma Süresi", tm.executionDurationMs !== null && tm.executionDurationMs !== undefined ? formatDurationMs(tm.executionDurationMs) : (tm.durationMs !== null ? formatDurationMs(tm.durationMs) : "Duration unavailable")));
  timeSection.appendChild(timeGrid);
  body.appendChild(timeSection);

  if (ci && (ci.symbolResolutions || ci.referencesFound)) {
    const ciSection = element("div", "trace-section");
    ciSection.appendChild(element("h3", "trace-section-title", "4. Code Intelligence Metrikleri"));
    const ciGrid = element("div", "trace-grid");
    ciGrid.appendChild(createTraceCell("Sembol Çözümlemeleri", String(ci.symbolResolutions || 0)));
    ciGrid.appendChild(createTraceCell("Referanslar", String(ci.referencesFound || 0)));
    ciSection.appendChild(ciGrid);
    body.appendChild(ciSection);
  }

  const evSection = element("div", "trace-section");
  evSection.appendChild(element("h3", "trace-section-title", "5. Sıralı Telemetri Olayları"));
  if (events.length === 0) {
    evSection.appendChild(element("p", "empty-text", "Olay kaydı yok."));
  } else {
    const list = element("div", "trace-timeline");
    events.forEach(ev => {
      const step = element("div", "timeline-step");
      const dot = element("span", `timeline-dot ${ev.stage || "progress"}`);
      const content = element("div", "timeline-content");
      content.appendChild(element("small", null, `${formatTime(ev.timestamp || ev.createdAt)} · Seq ${ev.sequence ?? 0}`));
      content.appendChild(element("strong", null, `${ev.stage || "event"} (${ev.status || "ok"})`));
      if (ev.usage && ev.usage.available) {
        content.appendChild(element("span", null, ` — ${formatNumber(ev.usage.totalTokens)} tokens`));
      }
      step.appendChild(dot);
      step.appendChild(content);
      list.appendChild(step);
    });
    evSection.appendChild(list);
  }
  body.appendChild(evSection);
}

// Agent Management View
function renderAgentRegistry() {
  const host = getElem("agent-definitions");
  const usageEl = getElem("usage-events");
  if (!host) return;
  host.innerHTML = "";

  if (typeof document !== "undefined") {
    document.querySelectorAll(".agent-filters .agent-filter-btn").forEach(btn => {
      const active = btn.dataset.agentFilter === state.currentAgentFilter;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
  }

  const definitions = state.snapshot?.agentDefinitions || [];
  const filtered = definitions.filter(agent => {
    if (state.currentAgentFilter === "all") return true;
    return agent.status === state.currentAgentFilter;
  });
  const usageEvents = state.snapshot?.usageEvents || [];

  if (filtered.length === 0) {
    host.appendChild(element("div", "empty-state", "Kayıtlı agent bulunamadı."));
  } else {
    const tableWrap = element("div", "table-wrap agent-table-wrap");
    const table = element("table");
    table.setAttribute("aria-label", "Agent kayıtları");
    const head = element("thead");
    head.innerHTML = "<tr><th>Agent</th><th>Rol</th><th>Sürüm</th><th>Durum</th><th>Executor</th><th>Reviewer</th><th>Son aktivite</th><th></th></tr>";
    const body = element("tbody");
    filtered.forEach(agent => body.appendChild(createAgentTableRow(agent, usageEvents)));
    table.append(head, body);
    tableWrap.appendChild(table);
    host.appendChild(tableWrap);
  }

  if (usageEl) {
    usageEl.innerHTML = "";
    const events = usageEvents.slice(0, 8);
    if (events.length === 0) {
      usageEl.appendChild(element("p", "empty-text", "Henüz kullanım telemetrisi kaydedilmedi."));
    } else {
      events.forEach(event => {
        const row = element("div", "usage-item");
        const identity = event.agentId || event.taskAgent || "agent";
        row.appendChild(element("strong", null, identity + " · " + (event.provider || "—") + "/" + (event.model || "—")));
        let tokenText = "usage unavailable";
        if (event.inputTokens !== undefined && event.inputTokens !== null && event.outputTokens !== undefined && event.outputTokens !== null) {
          tokenText = formatNumber(event.inputTokens) + " in / " + formatNumber(event.outputTokens) + " out (" + formatNumber(event.inputTokens + event.outputTokens) + " tot)";
        } else if (event.inputTokens !== undefined && event.inputTokens !== null) {
          tokenText = formatNumber(event.inputTokens) + " in";
        } else if (event.outputTokens !== undefined && event.outputTokens !== null) {
          tokenText = formatNumber(event.outputTokens) + " out";
        }
        const duration = event.durationMs === null || event.durationMs === undefined ? "—" : formatDurationMs(event.durationMs);
        row.appendChild(element("span", null, tokenText + " · Süre " + duration + " · " + formatTime(event.createdAt)));
        usageEl.appendChild(row);
      });
    }
  }
}

function createAgentTableRow(agent, usageEvents) {
  const row = element("tr", "work-table-row");
  row.tabIndex = 0;
  const latestUsage = usageEvents.find(event => event.agentId === agent.id || event.taskAgent === agent.id);
  const executor = agent.executor || {};
  const executorProvider = executor.provider || agent.executorProvider || "—";
  const executorModel = executor.model || agent.executorModel || "—";
  const executorProfile = executor.modelProfile || agent.executorModelProfile || agent.modelProfile || "—";
  const executorText = executorProvider + " / " + executorModel + " · " + executorProfile;
  const reviewer = (agent.reviewer && typeof agent.reviewer === "object" ? (agent.reviewer.agentId || agent.reviewer.name) : agent.reviewer) || agent.reviewerAssignment || agent.reviewerAgent || "—";
  const openDetail = () => openAgentDetailDrawer(agent, row);
  row.addEventListener?.("click", openDetail);
  row.addEventListener?.("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetail();
    }
  });
  appendTableTextCell(row, agent.displayName || agent.id, "agent-name-cell");
  appendTableTextCell(row, agent.role || "—");
  appendTableTextCell(row, "v" + (agent.version || agent.currentVersion || 1));
  appendTableTextCell(row, (agent.status || "enabled").toUpperCase());
  appendTableTextCell(row, executorText);
  appendTableTextCell(row, reviewer);
  appendTableTextCell(row, latestUsage ? formatTime(latestUsage.createdAt) : "—");
  const actions = element("td");
  const detail = element("button", "pm-btn pm-btn-view", "Detay");
  detail.type = "button";
  detail.addEventListener?.("click", event => { event.stopPropagation(); openDetail(); });
  actions.appendChild(detail);
  row.appendChild(actions);
  return row;
}

function openAgentDetailDrawer(agent, triggerBtn = null) {
  const pill = getElem("agent-detail-pill");
  const title = getElem("agent-detail-title");
  const summary = getElem("agent-detail-summary");
  const body = getElem("agent-detail-body");
  if (!body) return;
  if (pill) pill.textContent = agent.id || "—";
  if (title) title.textContent = (agent.displayName || agent.id || "Agent") + " · Detay";
  if (summary) summary.textContent = "Sabitlenmiş sürüm ve çalışma yapılandırması";
  body.innerHTML = "";

  const executor = agent.executor || {};
  const reviewer = agent.reviewer && typeof agent.reviewer === "object" ? agent.reviewer : { agentId: agent.reviewer || agent.reviewerAssignment || agent.reviewerAgent };
  const sections = [
    ["Kimlik", [["Rol", agent.role], ["Sürüm", "v" + (agent.version || agent.currentVersion || 1)], ["Durum", agent.status || "enabled"], ["Risk", agent.risk || "normal"]]],
    ["Yürütme", [["Provider", executor.provider || agent.executorProvider], ["Model", executor.model || agent.executorModel], ["Profil", executor.modelProfile || agent.executorModelProfile || agent.modelProfile], ["Eşzamanlılık", agent.maxConcurrency || 1]]],
    ["Review yapılandırması", [["Reviewer", reviewer.agentId || reviewer.name || "—"], ["Reviewer sürümü", reviewer.version || "—"], ["Reviewer hash", reviewer.hash || "—"]]],
    ["Kapsam", [["Beceriler", Array.isArray(agent.skills) ? agent.skills.join(", ") : "—"], ["İzinli yollar", Array.isArray(agent.allowedPaths) ? agent.allowedPaths.join(", ") : "—"], ["Definition hash", agent.definitionHash || "—"]]]
  ];
  sections.forEach(([heading, cells]) => {
    const section = element("section", "trace-section");
    section.appendChild(element("h3", "trace-section-title", heading));
    const grid = element("div", "trace-grid");
    cells.forEach(([label, value]) => grid.appendChild(createTraceCell(label, value)));
    section.appendChild(grid);
    body.appendChild(section);
  });

  const actions = element("div", "drawer-actions");
  const edit = element("button", "pm-btn pm-btn-view", "Yeni sürüm düzenle");
  edit.type = "button";
  edit.addEventListener?.("click", () => openAgentEditModal(agent, edit));
  const versions = element("button", "pm-btn pm-btn-view", "Sürüm geçmişi");
  versions.type = "button";
  versions.addEventListener?.("click", () => openAgentVersionsDrawer(agent.id, versions));
  actions.append(edit, versions);
  body.appendChild(actions);
  openModal("agent-detail-drawer", triggerBtn);
}

function createAgentCard(agent) {
  const card = element("div", `agent-def-card status-${agent.status || "enabled"}`);
  card.dataset = card.dataset || {};
  card.dataset.agentId = agent.id;

  const top = element("div", "agent-def-top");
  const titleBox = element("div", null);
  titleBox.appendChild(element("strong", "agent-def-name", agent.displayName || agent.id));
  titleBox.appendChild(element("span", "code-cell", ` (${agent.id}) v${agent.version || agent.currentVersion || 1}`));
  const badge = element("span", `badge badge-${agent.status || "enabled"}`, (agent.status || "enabled").toUpperCase());
  top.appendChild(titleBox);
  top.appendChild(badge);

  const executor = agent.executor || {};
  const executorProvider = executor.provider || agent.executorProvider;
  const executorModel = executor.model || agent.executorModel;
  const executorModelProfile = executor.modelProfile || agent.executorModelProfile || agent.modelProfile;
  const reviewer = (agent.reviewer && typeof agent.reviewer === "object" ? (agent.reviewer.agentId || agent.reviewer.name) : agent.reviewer) || agent.reviewerAssignment || agent.reviewerAgent;

  const meta = element("div", "agent-def-meta");
  meta.appendChild(createTraceCell("Rol", agent.role));
  meta.appendChild(createTraceCell("Default Persona", agent.defaultPersona || "—"));
  meta.appendChild(createTraceCell("Skills", Array.isArray(agent.skills) ? agent.skills.join(", ") : "—"));
  meta.appendChild(createTraceCell("Allowed Paths", Array.isArray(agent.allowedPaths) ? agent.allowedPaths.join(", ") : "—"));
  meta.appendChild(createTraceCell("Risk", agent.risk || "normal"));
  meta.appendChild(createTraceCell("Max Concurrency", String(agent.maxConcurrency || 1)));
  meta.appendChild(createTraceCell("Executor Provider", executorProvider || "—"));
  meta.appendChild(createTraceCell("Executor Model", executorModel || "—"));
  meta.appendChild(createTraceCell("Model Profile", executorModelProfile || "—"));
  meta.appendChild(createTraceCell("Reviewer", reviewer ? String(reviewer) : "—"));
  if (agent.definitionHash) {
    meta.appendChild(createTraceCell("Definition Hash", agent.definitionHash.slice(0, 12) + "..."));
  }

  const actions = element("div", "agent-def-actions");
  const editBtn = element("button", "pm-btn pm-btn-view", "✏️ Düzenle (v+1)");
  editBtn.type = "button";
  if (typeof editBtn.addEventListener === "function") {
    editBtn.addEventListener("click", () => {
      openAgentEditModal(agent, editBtn);
    });
  }
  actions.appendChild(editBtn);

  const verBtn = element("button", "pm-btn pm-btn-view", "📜 Versiyonlar");
  verBtn.type = "button";
  if (typeof verBtn.addEventListener === "function") {
    verBtn.addEventListener("click", () => {
      openAgentVersionsDrawer(agent.id, verBtn);
    });
  }
  actions.appendChild(verBtn);

  if (agent.status === "enabled") {
    const disBtn = element("button", "pm-btn pm-btn-reject", "Devre Dışı Bırak");
    disBtn.type = "button";
    if (typeof disBtn.addEventListener === "function") {
      disBtn.addEventListener("click", () => updateAgentStatus(agent.id, "disabled"));
    }
    actions.appendChild(disBtn);
  } else if (agent.status === "disabled") {
    const enBtn = element("button", "pm-btn pm-btn-approve", "Etkinleştir");
    enBtn.type = "button";
    if (typeof enBtn.addEventListener === "function") {
      enBtn.addEventListener("click", () => updateAgentStatus(agent.id, "enabled"));
    }
    actions.appendChild(enBtn);

    const archBtn = element("button", "pm-btn pm-btn-reject", "Arşivle");
    archBtn.type = "button";
    if (typeof archBtn.addEventListener === "function") {
      archBtn.addEventListener("click", () => updateAgentStatus(agent.id, "archived"));
    }
    actions.appendChild(archBtn);
  } else if (agent.status === "archived") {
    const enBtn = element("button", "pm-btn pm-btn-approve", "Yeniden Etkinleştir");
    enBtn.type = "button";
    if (typeof enBtn.addEventListener === "function") {
      enBtn.addEventListener("click", () => updateAgentStatus(agent.id, "enabled"));
    }
    actions.appendChild(enBtn);
  }

  card.appendChild(top);
  card.appendChild(meta);
  card.appendChild(actions);
  return card;
}

async function updateAgentStatus(agentId, newStatus) {
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: newStatus })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchSnapshot();
  } catch (err) {
    alert(`Agent durumu güncellenemedi: ${err.message}`);
  }
}

async function openAgentVersionsDrawer(agentId, triggerBtn = null) {
  const modal = getElem("agent-versions-drawer");
  const pill = getElem("agent-ver-pill");
  const title = getElem("agent-ver-title");
  const summaryEl = getElem("agent-ver-summary");
  const body = getElem("agent-ver-drawer-body");

  if (!modal || !body) return;

  if (pill) pill.textContent = agentId;
  if (title) title.textContent = `Agent Versiyon Geçmişi · ${agentId}`;
  if (summaryEl) summaryEl.textContent = "Versiyonlar yükleniyor...";
  body.innerHTML = '<div class="loading-spinner">Yükleniyor...</div>';

  openModal("agent-versions-drawer", triggerBtn);

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/versions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const versions = Array.isArray(data) ? data : (data.versions || []);

    body.innerHTML = "";
    if (summaryEl) summaryEl.textContent = `Toplam ${versions.length} immutable versiyon`;

    if (versions.length === 0) {
      body.appendChild(element("p", "empty-text", "Versiyon bulunamadı."));
      return;
    }

    versions.forEach(v => {
      const item = element("div", "version-card");
      const hdr = element("div", "version-header");
      hdr.appendChild(element("strong", null, `v${v.version}`));
      hdr.appendChild(element("small", null, formatTime(v.createdAt, true)));
      item.appendChild(hdr);

      const grid = element("div", "version-grid");
      grid.appendChild(createTraceCell("Definition Hash", v.definitionHash ? v.definitionHash.slice(0, 16) + "..." : "—"));
      grid.appendChild(createTraceCell("Rol", v.definition?.role || "—"));
      grid.appendChild(createTraceCell("Default Persona", v.definition?.defaultPersona || "—"));
      grid.appendChild(createTraceCell("Skills", Array.isArray(v.definition?.skills) ? v.definition.skills.join(", ") : "—"));
      grid.appendChild(createTraceCell("Allowed Paths", Array.isArray(v.definition?.allowedPaths) ? v.definition.allowedPaths.join(", ") : "—"));
      item.appendChild(grid);
      body.appendChild(item);
    });
  } catch (err) {
    body.innerHTML = `<div class="error-banner">Versiyonlar yüklenemedi: ${safeHtml(err.message)}</div>`;
  }
}

function openAgentEditModal(agent, triggerBtn = null) {
  const idInput = getElem("edit-agent-id");
  const nameInput = getElem("edit-agent-name");
  const roleSelect = getElem("edit-agent-role");
  const skillsInput = getElem("edit-agent-skills");
  const pathsInput = getElem("edit-agent-paths");
  const riskSelect = getElem("edit-agent-risk");
  const concInput = getElem("edit-agent-max-concurrency");
  const statusEl = getElem("agent-edit-status");

  if (idInput) idInput.value = agent.id;
  if (nameInput) nameInput.value = agent.displayName || agent.id;
  if (roleSelect) roleSelect.value = agent.role || "implementation";
  if (skillsInput) skillsInput.value = Array.isArray(agent.skills) ? agent.skills.join(", ") : "";
  if (pathsInput) pathsInput.value = Array.isArray(agent.allowedPaths) ? agent.allowedPaths.join(", ") : "";
  if (riskSelect) riskSelect.value = agent.risk || "normal";
  if (concInput) concInput.value = agent.maxConcurrency || 2;
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }

  openModal("agent-edit-modal", triggerBtn);
}

async function submitAgentEdit() {
  const idInput = getElem("edit-agent-id");
  const nameInput = getElem("edit-agent-name");
  const roleSelect = getElem("edit-agent-role");
  const skillsInput = getElem("edit-agent-skills");
  const pathsInput = getElem("edit-agent-paths");
  const riskSelect = getElem("edit-agent-risk");
  const concInput = getElem("edit-agent-max-concurrency");
  const statusEl = getElem("agent-edit-status");
  const submitBtn = getElem("agent-edit-submit-btn");

  const id = idInput ? idInput.value : "";
  if (!id) return;

  if (submitBtn) submitBtn.disabled = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "modal-status-msg is-loading";
    statusEl.textContent = "Yeni versiyon kaydediliyor...";
  }

  const payload = {
    displayName: nameInput ? nameInput.value.trim() : id,
    role: roleSelect ? roleSelect.value : "implementation",
    skills: skillsInput ? skillsInput.value.split(",").map(s => s.trim()).filter(Boolean) : [],
    allowedPaths: pathsInput ? pathsInput.value.split(",").map(p => p.trim()).filter(Boolean) : [],
    risk: riskSelect ? riskSelect.value : "normal",
    maxConcurrency: concInput ? Number(concInput.value) || 1 : 1
  };

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (statusEl) {
      statusEl.className = "modal-status-msg is-success";
      statusEl.textContent = "✓ Yeni immutable versiyon (v+1) başarıyla oluşturuldu.";
    }

    setTimeout(() => {
      closeModal("agent-edit-modal");
      fetchSnapshot();
    }, 700);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = `Hata: ${err.message}`;
    }
    if (submitBtn) submitBtn.disabled = false;
  }
}

function openAgentCreateModal(triggerBtn = null) {
  const form = getElem("agent-create-form");
  if (form && typeof form.reset === "function") form.reset();
  const statusEl = getElem("agent-create-status");
  if (statusEl) { statusEl.hidden = true; statusEl.textContent = ""; }
  const submitBtn = getElem("agent-create-submit-btn");
  if (submitBtn) submitBtn.disabled = false;

  openModal("agent-create-modal", triggerBtn);
}

async function submitAgentCreate() {
  const idInput = getElem("create-agent-id");
  const nameInput = getElem("create-agent-name");
  const roleSelect = getElem("create-agent-role");
  const skillsInput = getElem("create-agent-skills");
  const pathsInput = getElem("create-agent-paths");
  const riskSelect = getElem("create-agent-risk");
  const concInput = getElem("create-agent-max-concurrency");
  const statusEl = getElem("agent-create-status");
  const submitBtn = getElem("agent-create-submit-btn");

  const id = idInput ? idInput.value.trim() : "";
  const name = nameInput ? nameInput.value.trim() : "";
  if (!id || !name) {
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = "Agent ID ve Görünen İsim zorunludur.";
    }
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "modal-status-msg is-loading";
    statusEl.textContent = "Agent tanımlanıyor...";
  }

  const payload = {
    id,
    displayName: name,
    role: roleSelect ? roleSelect.value : "implementation",
    defaultPersona: "backend-engineer",
    skills: skillsInput ? skillsInput.value.split(",").map(s => s.trim()).filter(Boolean) : [],
    allowedPaths: pathsInput ? pathsInput.value.split(",").map(p => p.trim()).filter(Boolean) : [],
    risk: riskSelect ? riskSelect.value : "normal",
    maxConcurrency: concInput ? Number(concInput.value) || 1 : 1
  };

  try {
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    if (statusEl) {
      statusEl.className = "modal-status-msg is-success";
      statusEl.textContent = "✓ Agent başarıyla tanımlandı.";
    }

    setTimeout(() => {
      closeModal("agent-create-modal");
      fetchSnapshot();
    }, 700);
  } catch (err) {
    if (statusEl) {
      statusEl.className = "modal-status-msg is-error";
      statusEl.textContent = `Hata: ${err.message}`;
    }
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Provider Configuration View
function renderConfigView(data) {
  const mutationBadge = getElem("config-mutation-badge");
  const isMutable = Boolean(data.config?.mutationEnabled);
  if (mutationBadge) {
    mutationBadge.textContent = isMutable ? "Yapılandırılabilir" : "Salt okunur";
    mutationBadge.className = isMutable ? "badge badge-enabled" : "read-only-badge";
  }

  const host = typeof document === "undefined" ? null : document.querySelector(".config-providers-grid");
  if (!host) return;
  host.innerHTML = "";
  const providers = data.providers || {};
  const selections = data.config?.selections || {};
  const mutableFields = data.config?.mutableFields || [];
  const categories = [
    ["İş kaynağı", "workSource", providers.workSources || []],
    ["Orkestratör", "orchestrator", providers.orchestrators || []],
    ["Executor", "executor", providers.executors || []],
    ["Kod zekâsı", "codeIntelligence", providers.codeIntelligence || []],
    ["Kaynak kontrol", "sourceControl", providers.sourceControl || []]
  ];
  const rows = categories.flatMap(([category, fieldName, list]) => (Array.isArray(list) ? list : []).map(provider => ({
    category,
    fieldName,
    provider,
    selected: (typeof provider === "object" && provider.selected === true) || (typeof provider === "string" ? provider : provider.id || provider.name || provider.provider) === selections[fieldName],
    canMutate: isMutable && mutableFields.includes(fieldName) && fieldName !== "sourceControl"
  })));

  if (rows.length === 0) {
    host.appendChild(element("div", "empty-state", "Sağlayıcı bilgisi bulunamadı."));
    return;
  }

  const wrap = element("div", "panel table-wrap provider-table-wrap");
  const table = element("table");
  table.setAttribute("aria-label", "Sağlayıcı yapılandırması");
  const head = element("thead");
  head.innerHTML = "<tr><th>Sağlayıcı</th><th>Tip</th><th>Seçili</th><th>Durum</th><th>Model / profil</th><th>Değişiklik</th><th></th></tr>";
  const body = element("tbody");
  rows.forEach(info => body.appendChild(createProviderTableRow(info)));
  table.append(head, body);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

function providerName(provider) {
  return typeof provider === "string" ? provider : provider.id || provider.name || provider.provider || "—";
}

function createProviderTableRow(info) {
  const provider = info.provider;
  const object = typeof provider === "object" ? provider : {};
  const row = element("tr", "work-table-row");
  row.tabIndex = 0;
  const openDetail = () => openProviderDetailDrawer(info, row);
  row.addEventListener?.("click", openDetail);
  row.addEventListener?.("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetail();
    }
  });
  appendTableTextCell(row, providerName(provider), "code-cell");
  appendTableTextCell(row, info.category);
  appendTableTextCell(row, info.selected ? "Evet" : "—");
  appendTableTextCell(row, object.enabled === false ? "Devre dışı" : (object.health || object.status || "Kullanılabilir"));
  appendTableTextCell(row, object.model || object.modelProfile || object.profile || "—");
  appendTableTextCell(row, info.canMutate ? "Değiştirilebilir" : "Salt okunur");
  const actions = element("td");
  const detail = element("button", "pm-btn pm-btn-view", "Detay");
  detail.type = "button";
  detail.addEventListener?.("click", event => { event.stopPropagation(); openDetail(); });
  actions.appendChild(detail);
  if (info.canMutate && !info.selected && object.enabled !== false) {
    const select = element("button", "pm-btn pm-btn-approve", "Seç");
    select.type = "button";
    select.addEventListener?.("click", event => {
      event.stopPropagation();
      updateProviderSelection(info.fieldName, providerName(provider));
    });
    actions.appendChild(select);
  }
  row.appendChild(actions);
  return row;
}

function openProviderDetailDrawer(info, triggerBtn = null) {
  const provider = info.provider;
  const object = typeof provider === "object" ? provider : {};
  const name = providerName(provider);
  const pill = getElem("provider-detail-pill");
  const title = getElem("provider-detail-title");
  const summary = getElem("provider-detail-summary");
  const body = getElem("provider-detail-body");
  if (!body) return;
  if (pill) pill.textContent = name;
  if (title) title.textContent = name + " · Sağlayıcı detayı";
  if (summary) summary.textContent = info.category + " · " + (info.selected ? "seçili" : "alternatif");
  body.innerHTML = "";
  const section = element("section", "trace-section");
  section.appendChild(element("h3", "trace-section-title", "Çalışma yapılandırması"));
  const grid = element("div", "trace-grid");
  [["Tip", info.category], ["Seçili", info.selected ? "Evet" : "Hayır"], ["Etkin", object.enabled === false ? "Hayır" : "Evet"], ["Sağlık", object.health || object.status || "—"], ["Model", object.model || "—"], ["Profil", object.modelProfile || object.profile || "—"], ["Değişiklik", info.canMutate ? "Uygun" : "Salt okunur"], ["Kimlik", object.id || object.name || name]].forEach(([label, value]) => grid.appendChild(createTraceCell(label, value)));
  section.appendChild(grid);
  body.appendChild(section);
  if (info.canMutate && !info.selected && object.enabled !== false) {
    const actions = element("div", "drawer-actions");
    const select = element("button", "pm-btn pm-btn-approve", "Bu sağlayıcıyı seç");
    select.type = "button";
    select.addEventListener?.("click", () => updateProviderSelection(info.fieldName, name));
    actions.appendChild(select);
    body.appendChild(actions);
  }
  openModal("provider-detail-drawer", triggerBtn);
}

function renderProviderSection(prefix, fieldName, providerList = [], selectedName, canMutate) {
  const selBadge = getElem(`cfg-${prefix}-selected`);
  const list = getElem(`cfg-${prefix}-list`);

  if (selBadge) selBadge.textContent = selectedName || "Yok";
  if (!list) return;
  list.innerHTML = "";

  if (!Array.isArray(providerList) || providerList.length === 0) {
    list.appendChild(element("div", "config-option-item", "Sağlayıcı bilgisi bulunamadı"));
    return;
  }

  providerList.forEach(p => {
    const pName = typeof p === "string" ? p : (p.id || p.name || p.provider);
    const isSelected = (typeof p === "object" && p.selected === true) || pName === selectedName;

    const item = element("div", `config-option-item ${isSelected ? "is-selected" : ""}`);
    const nameSpan = element("strong", null, pName);
    item.appendChild(nameSpan);

    if (typeof p === "object" && p.type) {
      item.appendChild(element("span", "badge", p.type));
    }

    if (isSelected) {
      item.appendChild(element("span", "badge badge-enabled", "AKTİF"));
    } else if (typeof p === "object" && p.enabled === false) {
      item.appendChild(element("span", "badge", "Devre Dışı"));
    } else if (canMutate) {
      const selectBtn = element("button", "pm-btn pm-btn-view", "Seç");
      selectBtn.type = "button";
      if (typeof selectBtn.addEventListener === "function") {
        selectBtn.addEventListener("click", () => {
          updateProviderSelection(fieldName, pName);
        });
      }
      item.appendChild(selectBtn);
    } else {
      item.appendChild(element("span", "badge", "Pasif"));
    }

    list.appendChild(item);
  });
}

async function updateProviderSelection(field, value) {
  try {
    const res = await fetch("/api/config/providers", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value })
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    await fetchSnapshot();
  } catch (err) {
    alert(`Yapılandırma güncellenemedi: ${err.message}`);
  }
}

// Snapshot Fetch & Reconciliation
async function fetchSnapshot() {
  try {
    const res = await fetch("/api/snapshot");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.snapshot = data;
    state.connected = true;
    state.loading = false;

    const errBanner = getElem("error-banner");
    if (errBanner) errBanner.hidden = true;

    updateTopbar(data);
    renderOverview(data);
    renderPmWorkspace();
    renderConfigView(data);
    renderAgentRegistry();

    if (state.currentView === "parents-view") {
      populateParentSelector();
    }
  } catch (err) {
    state.connected = false;
    const errBanner = getElem("error-banner");
    if (errBanner) errBanner.hidden = false;
    const connDot = getElem("connection-dot");
    const connLabel = getElem("connection-label");
    if (connDot) connDot.className = "connection-dot is-offline";
    if (connLabel) connLabel.textContent = "Bağlantı Kesildi";
  }
}

// Global Event Listeners & Setup
function setupEventListeners() {
  if (typeof document === "undefined") return;

  const navButtons = document.querySelectorAll(".nav-item");
  navButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const targetView = btn.dataset.target;
      if (targetView) switchView(targetView, false);
      getElem("app-sidebar")?.classList.remove("is-open");
      getElem("sidebar-backdrop")?.classList.remove("is-visible");
      getElem("sidebar-toggle")?.setAttribute("aria-expanded", "false");
    });
  });

  const sidebarToggle = getElem("sidebar-toggle");
  const sidebar = getElem("app-sidebar");
  const sidebarBackdrop = getElem("sidebar-backdrop");
  sidebarToggle?.addEventListener("click", () => {
    const open = !sidebar?.classList.contains("is-open");
    sidebar?.classList.toggle("is-open", open);
    sidebarBackdrop?.classList.toggle("is-visible", open);
    sidebarToggle.setAttribute("aria-expanded", String(open));
  });
  sidebarBackdrop?.addEventListener("click", () => {
    sidebar?.classList.remove("is-open");
    sidebarBackdrop.classList.remove("is-visible");
    sidebarToggle?.setAttribute("aria-expanded", "false");
  });

  const pmFilterBtns = document.querySelectorAll(".pm-sub-nav .pm-filter-btn");
  pmFilterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      state.currentPmFilter = btn.dataset.pmFilter || "inbox";
      renderPmWorkspace();
    });
  });

  const pmStats = document.querySelectorAll(".pm-summary-bar .pm-stat");
  pmStats.forEach(stat => {
    stat.addEventListener("click", () => {
      const group = stat.dataset.group;
      if (group === "awaitingApproval") {
        state.currentPmFilter = "approvals";
      } else if (group === "blocked" || group === "needsRework") {
        state.currentPmFilter = "attention";
      } else {
        state.currentPmFilter = "inbox";
      }
      renderPmWorkspace();
    });
  });

  const pmForm = getElem("pm-form");
  if (pmForm) {
    pmForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = getElem("pm-input");
      if (!input || !input.value.trim()) return;
      const msg = input.value.trim();
      input.value = "";
      try {
        await fetch("/api/pm/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg })
        });
        await fetchSnapshot();
      } catch {}
    });
  }

  const fleetFilterBtns = document.querySelectorAll(".filter-bar .filter-btn");
  fleetFilterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      fleetFilterBtns.forEach(button => {
        button.classList.remove("is-active");
        button.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
      state.filter = btn.dataset.filter || "all";
      renderRuns();
    });
  });

  const searchInput = getElem("run-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.query = e.target.value;
      renderRuns();
    });
  }

  const parentSelect = getElem("parent-select");
  if (parentSelect) {
    parentSelect.addEventListener("change", (e) => {
      const pKey = e.target.value;
      if (pKey) {
        state.selectedParentKey = pKey;
        fetchParentDetail(pKey);
        syncUrlState(false);
      }
    });
  }

  const parentRefreshBtn = getElem("parent-refresh-btn");
  if (parentRefreshBtn) {
    parentRefreshBtn.addEventListener("click", () => {
      if (state.selectedParentKey) {
        fetchParentDetail(state.selectedParentKey);
      } else {
        populateParentSelector();
      }
    });
  }

  const obsWindowBtns = document.querySelectorAll(".obs-window-controls .window-btn");
  obsWindowBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      obsWindowBtns.forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.currentObsWindow = btn.dataset.window || "24h";
      fetchObservabilitySummary();
    });
  });

  const agentFilterBtns = document.querySelectorAll(".agent-filters .agent-filter-btn");
  agentFilterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      state.currentAgentFilter = btn.dataset.agentFilter || "all";
      renderAgentRegistry();
    });
  });

  const agentCreateBtn = getElem("agent-create-btn");
  if (agentCreateBtn) {
    agentCreateBtn.addEventListener("click", () => {
      openAgentCreateModal(agentCreateBtn);
    });
  }

  const agentCreateSubmitBtn = getElem("agent-create-submit-btn");
  if (agentCreateSubmitBtn) {
    agentCreateSubmitBtn.addEventListener("click", (e) => {
      e.preventDefault();
      submitAgentCreate();
    });
  }

  const agentCreateCancelBtn = getElem("agent-create-cancel-btn");
  const agentCreateCloseBtn = getElem("agent-create-close-btn");
  if (agentCreateCancelBtn) agentCreateCancelBtn.addEventListener("click", () => closeModal("agent-create-modal"));
  if (agentCreateCloseBtn) agentCreateCloseBtn.addEventListener("click", () => closeModal("agent-create-modal"));

  const agentEditSubmitBtn = getElem("agent-edit-submit-btn");
  if (agentEditSubmitBtn) {
    agentEditSubmitBtn.addEventListener("click", (e) => {
      e.preventDefault();
      submitAgentEdit();
    });
  }

  const agentEditCancelBtn = getElem("agent-edit-cancel-btn");
  const agentEditCloseBtn = getElem("agent-edit-close-btn");
  if (agentEditCancelBtn) agentEditCancelBtn.addEventListener("click", () => closeModal("agent-edit-modal"));
  if (agentEditCloseBtn) agentEditCloseBtn.addEventListener("click", () => closeModal("agent-edit-modal"));

  const agentVerCloseBtn = getElem("agent-ver-close-btn");
  if (agentVerCloseBtn) agentVerCloseBtn.addEventListener("click", () => closeModal("agent-versions-drawer"));
  const agentDetailCloseBtn = getElem("agent-detail-close-btn");
  if (agentDetailCloseBtn) agentDetailCloseBtn.addEventListener("click", () => closeModal("agent-detail-drawer"));
  const providerDetailCloseBtn = getElem("provider-detail-close-btn");
  if (providerDetailCloseBtn) providerDetailCloseBtn.addEventListener("click", () => closeModal("provider-detail-drawer"));

  const traceCloseBtn = getElem("trace-close-btn");
  if (traceCloseBtn) {
    traceCloseBtn.addEventListener("click", () => {
      closeModal("decision-trace-modal");
      state.selectedWorkItemKey = null;
      syncUrlState(false);
    });
  }

  const telemCloseBtn = getElem("telem-close-btn");
  if (telemCloseBtn) {
    telemCloseBtn.addEventListener("click", () => {
      closeModal("telemetry-drawer-modal");
      state.selectedRunId = null;
      syncUrlState(false);
    });
  }

  const appConfirmBtn = getElem("approval-modal-confirm-btn");
  const appCancelBtn = getElem("approval-modal-cancel-btn");
  const appCloseBtn = getElem("approval-modal-close-btn");
  if (appConfirmBtn) appConfirmBtn.addEventListener("click", submitApproval);
  if (appCancelBtn) appCancelBtn.addEventListener("click", () => closeModal("approval-modal"));
  if (appCloseBtn) appCloseBtn.addEventListener("click", () => closeModal("approval-modal"));

  const rejConfirmBtn = getElem("rejection-modal-confirm-btn");
  const rejCancelBtn = getElem("rejection-modal-cancel-btn");
  const rejCloseBtn = getElem("rejection-modal-close-btn");
  if (rejConfirmBtn) rejConfirmBtn.addEventListener("click", submitRejection);
  if (rejCancelBtn) rejCancelBtn.addEventListener("click", () => closeModal("rejection-modal"));
  if (rejCloseBtn) rejCloseBtn.addEventListener("click", () => closeModal("rejection-modal"));

  const modalBackdrops = document.querySelectorAll(".trace-modal-backdrop");
  modalBackdrops.forEach(backdrop => {
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        backdrop.hidden = true;
        if (backdrop.id === "decision-trace-modal") {
          state.selectedWorkItemKey = null;
          syncUrlState(false);
        } else if (backdrop.id === "telemetry-drawer-modal") {
          state.selectedRunId = null;
          syncUrlState(false);
        }
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.keyCode === 27) {
      getElem("app-sidebar")?.classList.remove("is-open");
      getElem("sidebar-backdrop")?.classList.remove("is-visible");
      getElem("sidebar-toggle")?.setAttribute("aria-expanded", "false");
      modalBackdrops.forEach(backdrop => {
        if (!backdrop.hidden) {
          backdrop.hidden = true;
          if (backdrop.id === "decision-trace-modal") {
            state.selectedWorkItemKey = null;
            syncUrlState(false);
          } else if (backdrop.id === "telemetry-drawer-modal") {
            state.selectedRunId = null;
            syncUrlState(false);
          }
        }
      });
      if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === "function") {
        try { state.lastFocusedElement.focus(); } catch {}
        state.lastFocusedElement = null;
      }
    }
  });

  if (typeof window !== "undefined") {
    window.addEventListener("popstate", () => {
      readUrlState();
    });
  }
}

// Initialization
async function init() {
  setupEventListeners();
  await fetchSnapshot();
  readUrlState();

  if (typeof setInterval === "function") {
    const timer = setInterval(() => {
      if (typeof document === "undefined" || !document.hidden) {
        fetchSnapshot();
      }
    }, 3000);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  }
}

if (typeof module === "undefined" && typeof document !== "undefined" && typeof document.addEventListener === "function") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    state,
    elements,
    STATUS_LABELS,
    PERSONA_INITIALS,
    ROLE_LABELS,
    safeHtml,
    element,
    getElem,
    formatNumber,
    formatDuration,
    formatDurationMs,
    formatTime,
    taskCard,
    roleLane,
    visibleRuns,
    renderRuns,
    renderCapacity,
    renderOverview,
    renderPmWorkspace,
    renderParentDetail,
    clearParentDetail,
    populateParentSelector,
    renderObservability,
    renderConfigView,
    renderAgentRegistry,
    createPmItemCard,
    renderProviderSection,
    renderDecisionTraceDetail,
    renderParentReviewFindings,
    switchView,
    openDecisionTrace,
    openTelemetryDrawer,
    openModal,
    closeModal,
    syncUrlState,
    readUrlState
  };
}
if (typeof window !== "undefined") {
  window.PaceControlPlane = {
    state,
    elements,
    renderRuns,
    renderCapacity,
    fetchSnapshot
  };
}
