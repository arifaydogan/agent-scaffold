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
  selectedParentKey: null
};

const elements = {
  grid: typeof document !== "undefined" ? document.querySelector("#agent-grid") : null,
  empty: typeof document !== "undefined" ? document.querySelector("#empty-state") : null,
  activity: typeof document !== "undefined" ? document.querySelector("#activity-body") : null,
  providers: typeof document !== "undefined" ? document.querySelector("#provider-list") : null,
  controlPlane: typeof document !== "undefined" ? document.querySelector("#control-plane-list") : null,
  capabilityCount: typeof document !== "undefined" ? document.querySelector("#capability-count") : null,
  connectionDot: typeof document !== "undefined" ? document.querySelector("#connection-dot") : null,
  connectionLabel: typeof document !== "undefined" ? document.querySelector("#connection-label") : null,
  syncTime: typeof document !== "undefined" ? document.querySelector("#sync-time") : null,
  error: typeof document !== "undefined" ? document.querySelector("#error-banner") : null,
  demo: typeof document !== "undefined" ? document.querySelector("#demo-badge") : null,
  project: typeof document !== "undefined" ? document.querySelector("#project-key") : null,
  capacityTotal: typeof document !== "undefined" ? document.querySelector("#capacity-total") : null,
  metricActive: typeof document !== "undefined" ? document.querySelector("#metric-active") : null,
  metricQueued: typeof document !== "undefined" ? document.querySelector("#metric-queued") : null,
  metricReview: typeof document !== "undefined" ? document.querySelector("#metric-review") : null,
  metricRework: typeof document !== "undefined" ? document.querySelector("#metric-rework") : null,
  metricBlocked: typeof document !== "undefined" ? document.querySelector("#metric-blocked") : null,
  metricAwaitingApproval: typeof document !== "undefined" ? document.querySelector("#metric-awaiting-approval") : null,
  metricHumanApproval: typeof document !== "undefined" ? document.querySelector("#metric-human-approval") : null,
  metricActiveParents: typeof document !== "undefined" ? document.querySelector("#metric-active-parents") : null,
  metricParentConflicts: typeof document !== "undefined" ? document.querySelector("#metric-parent-conflicts") : null,
  metricTokens: typeof document !== "undefined" ? document.querySelector("#metric-tokens") : null,
  metricCapacity: typeof document !== "undefined" ? document.querySelector("#metric-capacity") : null,
  search: typeof document !== "undefined" ? document.querySelector("#run-search") : null,
  operatingModePill: typeof document !== "undefined" ? document.querySelector("#operating-mode-pill") : null,
  operatingModeLabel: typeof document !== "undefined" ? document.querySelector("#operating-mode-label") : null,
  overviewModeTitle: typeof document !== "undefined" ? document.querySelector("#overview-mode-title") : null,
  overviewModeBadge: typeof document !== "undefined" ? document.querySelector("#overview-mode-badge") : null,
  overviewModeDesc: typeof document !== "undefined" ? document.querySelector("#overview-mode-desc") : null,
  supervisorCard: typeof document !== "undefined" ? document.querySelector("#supervisor-card") : null,
  supervisorDot: typeof document !== "undefined" ? document.querySelector("#supervisor-dot") : null,
  supervisorStatusText: typeof document !== "undefined" ? document.querySelector("#supervisor-status-text") : null,
  supervisorPid: typeof document !== "undefined" ? document.querySelector("#supervisor-pid") : null,
  supervisorMode: typeof document !== "undefined" ? document.querySelector("#supervisor-mode") : null,
  supervisorCycles: typeof document !== "undefined" ? document.querySelector("#supervisor-cycles") : null,
  supervisorHeartbeat: typeof document !== "undefined" ? document.querySelector("#supervisor-heartbeat") : null
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
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function getElem(id) {
  if (typeof document === "undefined") return null;
  if (typeof document.getElementById === "function") return document.getElementById(id);
  if (typeof document.querySelector === "function") return document.querySelector("#" + id);
  return null;
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
  if (!run.model) return run.provider || "—";
  return run.model
    .replace("claude-", "")
    .replace("-thinking", " · thinking")
    .replace("gpt-oss-", "GPT-OSS ")
    .replace("-medium", " · medium")
    .trim();
}

function statePill(run) {
  const pill = element("span", `state-pill ${run.stateKind || run.state}`);
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

const ROLE_LABELS = {
  worker: "Worker",
  reviewer: "Reviewer",
  integration: "Integration"
};

function normalizeRole(role) {
  const value = String(role || "worker").toLowerCase();
  if (["review", "reviewer", "qa"].includes(value)) return "reviewer";
  if (["integration", "integrator"].includes(value)) return "integration";
  return value || "worker";
}

function roleLane(lane) {
  const run = lane.latest;
  const section = element("section", `role-lane role-lane-${lane.role}`);
  section.setAttribute("aria-label", `${ROLE_LABELS[lane.role] || lane.role} lane`);

  const header = element("div", "role-lane-header");
  const heading = element("div", "role-lane-heading");
  heading.append(
    element("strong", "role-lane-name", ROLE_LABELS[lane.role] || lane.role),
    element("span", `worker-badge worker-${getWorkerInfo(run).status}`, formatWorkerLabel(run))
  );
  header.append(heading, statePill(run));
  section.append(header);

  const actor = run.taskAgent || run.persona || "unassigned";
  section.append(element(
    "p",
    "role-lane-agent",
    `${actor} · ${displayModel(run)} · Deneme ${run.attempt || lane.attempts.length}`
  ));

  if (run.blockers?.length || run.stateKind === "blocked") {
    const blocker = element("div", "blocker-note role-lane-blocker");
    const statusText = run.humanActionRequired
      ? "Senden aksiyon bekleniyor"
      : run.blockerResolved
        ? "Blocker çözüldü"
        : "Otomatik çözüm bekliyor";
    blocker.append(
      element("strong", "blocker-title", statusText),
      element("span", "blocker-cause", `Neden durdu: ${run.blockers?.[0] || "Bilinmeyen blocker nedeni"}`),
      element("span", "blocker-expectation", `Senden beklenen: ${run.humanActionRequired
        ? (run.userExpectation || "Blocker açıklamasındaki insan kararını tamamla")
        : "Bir işlem yok; sistem güvenli retry şartlarını kontrol edecek"}`),
      element("span", "blocker-action", `Sonraki adım: ${run.resolution || "Bir sonraki reconciliation döngüsünde yeniden değerlendirilecek"}`)
    );

    if (run.humanActionRequired) {
      const instruction = run.userExpectation || run.resolution || "Açıklanan insan aksiyonunu tamamla";
      const actionPanel = element("div", "human-action-panel");
      actionPanel.append(element(
        "p",
        "action-help",
        "Bu kayıt otomatik retry ile çözülemez. Onay metnini ana Codex sohbetine gönder; coordinator işlemi doğrulayıp statüyü güncelleyecek."
      ));
      const copyButton = element("button", "copy-action-button", "Onay metnini kopyala");
      const copyStatus = element("span", "copy-action-status", "");
      copyButton.onclick = async () => {
        try {
          const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : null;
          if (!clipboard?.writeText) throw new Error("clipboard unavailable");
          await clipboard.writeText(instruction);
          copyButton.textContent = "Kopyalandı";
          copyStatus.textContent = "Ana Codex sohbetine yapıştırıp gönder.";
        } catch {
          copyButton.disabled = true;
          copyStatus.textContent = `Kopyalama kullanılamıyor. Şu metni gönder: ${instruction}`;
        }
      };
      actionPanel.append(copyButton, copyStatus);
      blocker.append(actionPanel);
    }
    section.append(blocker);
  }

  if (lane.attempts.length > 1) {
    const timeline = element("details", "attempts-timeline");
    timeline.append(element("summary", "", `${lane.attempts.length} ${ROLE_LABELS[lane.role] || lane.role} denemesi`));
    const list = element("ul", "attempt-list");
    lane.attempts.forEach((attemptRun, index) => {
      const attemptTokens = attemptRun.usageAvailable && attemptRun.tokens > 0
        ? `${formatNumber(attemptRun.tokens)} token`
        : "Usage unavailable";
      list.append(element(
        "li",
        "attempt-item",
        `Deneme ${attemptRun.attempt || index + 1}: ${STATUS_LABELS[attemptRun.state] || attemptRun.state} - ${attemptTokens}`
      ));
    });
    timeline.append(list);
    section.append(timeline);
  }

  const retryable = ["failed-retryable", "blocked"].includes(run.state) && !run.humanActionRequired;
  if (retryable) {
    const maxAttempts = state.snapshot?.policy?.maxAttempts || 3;
    const retryPanel = element("div", "retry-panel");
    const retryBtn = element("button", "retry-button", "Blocker çözüldü — aynı işi yeniden çalıştır");
    const hasHandler = Boolean(state.snapshot?.capabilities?.retryHandler);
    const exhausted = (run.attempt || lane.attempts.length) >= maxAttempts;

    if (!hasHandler) {
      retryBtn.disabled = true;
      retryBtn.title = "Sunucuda aktif retry handler tanımlı değil";
    } else if (exhausted) {
      retryBtn.disabled = true;
      retryBtn.title = "Maksimum retry deneme limitine ulaşıldı";
    } else {
      retryBtn.onclick = async () => {
        const confirmed = typeof confirm === "function" ? confirm("Bu iş için yeniden deneme kaydı oluşturulsun mu?") : true;
        if (!confirmed) return;
        retryBtn.disabled = true;
        retryBtn.textContent = "Kuyruğa alınıyor…";
        try {
          const res = await fetch("/api/retry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: run.id, issueKey: run.issue })
          });
          if (!res.ok) throw new Error("Retry isteği reddedildi");
          retryBtn.textContent = "Yeniden deneme kuyruğunda";
          await refresh();
        } catch {
          retryBtn.disabled = false;
          retryBtn.textContent = "Tekrar dene";
          retryBtn.title = "Yeniden deneme isteği gönderilemedi";
        }
      };
    }
    retryPanel.append(retryBtn);
    section.append(retryPanel);
  }

  return section;
}

function taskCard(group) {
  const { latest: run, attempts, lanes } = group;
  const allRuns = attempts && attempts.length ? attempts : [run];

  const card = element("article", `agent-card state-${run.stateKind || run.state}`);
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

  const taskTitle = element("h3", "task-title");
  const taskLink = element("a", "task-title-link", run.summary);
  taskLink.href = issueLink.href;
  taskLink.target = "_blank";
  taskLink.rel = "noopener noreferrer";
  taskTitle.append(taskLink);
  card.append(taskTitle);

  const lanesContainer = element("div", "role-lanes");
  if (lanes && lanes.length > 0) {
    lanesContainer.append(...lanes.map(roleLane));
  }
  card.append(lanesContainer);

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

  if (!lanes?.length && (run.blockers?.length || run.stateKind === "blocked")) {
    const blocker = element("div", "blocker-note");
    blocker.style.display = "flex";
    blocker.style.flexDirection = "column";
    blocker.style.gap = "0.25rem";

    const statusText = run.humanActionRequired
      ? "Senden aksiyon bekleniyor"
      : run.state === "retry_requested"
        ? "Yeniden deneme kuyruğunda"
        : run.blockerResolved
          ? "Blocker çözüldü"
          : "Otomatik çözüm bekliyor";
    const userExpectation = run.humanActionRequired
      ? (run.userExpectation || "Blocker açıklamasındaki insan kararını tamamla")
      : "Senden beklenen bir işlem yok";
    const titleRow = element("div", "blocker-title");
    titleRow.style.fontWeight = "bold";
    titleRow.append(element("span", "", "! "), element("span", "", statusText));

    blocker.append(
      titleRow,
      element("span", "blocker-cause", run.blockers?.[0] || "Bilinmeyen blocker nedeni"),
      element("span", "blocker-action", run.resolution || "Bir sonraki reconciliation döngüsünde yeniden değerlendirilecek"),
      element("span", "blocker-expectation", userExpectation)
    );
    card.append(blocker);
  }

  const details = detailsFor(run);
  if (details) card.append(details);

  if (!lanes?.length && attempts?.length > 1) {
    const timeline = element("details", "attempts-timeline");
    timeline.style.marginTop = "0.5rem";
    timeline.style.fontSize = "0.85rem";
    timeline.append(element("summary", "", `${attempts.length} deneme (Geçmiş)`));
    const list = element("ul", "attempt-list");
    list.style.paddingLeft = "1rem";
    attempts.slice(0, -1).forEach((oldRun, idx) => {
      const li = element("li", "attempt-item");
      const attemptTokens = oldRun.usageAvailable && oldRun.tokens > 0
        ? `${formatNumber(oldRun.tokens)} token`
        : "Usage unavailable";
      li.textContent = `Deneme ${oldRun.attempt || idx + 1}: ${STATUS_LABELS[oldRun.state] || oldRun.state} - ${attemptTokens}`;
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

  const footer = element("footer", "agent-card-footer");
  const taskTokens = allRuns.reduce((sum, r) => sum + (r.tokens || 0), 0);
  const latestTokens = run.tokens;

  let taskTokenText = "Usage unavailable";
  if (latestTokens !== undefined && latestTokens !== null && latestTokens > 0) {
    taskTokenText = `${formatNumber(taskTokens)} token (total) · ${formatNumber(latestTokens)} (this attempt)`;
  }
  if (taskTokens > 0) {
    const latestUsagePart = run.usageAvailable && latestTokens > 0 ? `${formatNumber(latestTokens)} son deneme` : "son deneme usage unavailable";
    taskTokenText = `${formatNumber(taskTokens)} token toplam - ${latestUsagePart}`;
  }

  footer.append(
    element("span", "", taskTokenText),
    element("span", "", `${run.turns || 0} turn`),
    element("span", "", run.locked ? "● locked" : "○ unlocked")
  );
  card.append(footer);
  return card;
}

function visibleRuns() {
  if (!state.snapshot || !Array.isArray(state.snapshot.runs)) return [];
  const query = state.query ? state.query.trim().toLocaleLowerCase("tr-TR") : "";

  const groups = {};
  for (const run of state.snapshot.runs) {
    const key = run.issue || run.issueKey || "UNKNOWN";
    if (!groups[key]) groups[key] = [];
    groups[key].push({ ...run, issue: key });
  }

  const groupedTasks = Object.values(groups).map((group) => {
    const attempts = [...group].sort((a, b) =>
      new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );
    const byId = new Map(attempts.map((run) => [run.id, run]));
    const referencedParents = new Set(attempts.map((run) => run.retryOfRunId).filter(Boolean));
    const lineageRoot = (run) => {
      let current = run;
      const seen = new Set();
      while (current.retryOfRunId && !seen.has(current.id)) {
        seen.add(current.id);
        if (!byId.has(current.retryOfRunId)) return current.retryOfRunId;
        current = byId.get(current.retryOfRunId);
      }
      return referencedParents.has(current.id) ? current.id : "legacy";
    };
    const roleGroups = {};
    for (const run of attempts) {
      const role = normalizeRole(run.role);
      const laneKey = `${role}:${lineageRoot(run)}`;
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
      issue: latest.issue,
      summary: latest.summary,
      latest,
      attempts,
      lanes,
      stateKind: latest.stateKind || latest.state
    };
  });

  return groupedTasks.filter((task) => {
    const run = task.latest;
    const matchesFilter = state.filter === "all" || task.lanes.some((lane) => lane.latest.stateKind === state.filter || lane.latest.state === state.filter);
    const text = task.attempts.flatMap((attempt) => [
      attempt.issue, attempt.summary, attempt.persona, attempt.taskAgent,
      attempt.provider, attempt.model, ...(attempt.skills || [])
    ])
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("tr-TR");
    return matchesFilter && (!query || text.includes(query));
  });
}

function renderRuns() {
  const tasks = visibleRuns();
  if (elements.grid) {
    elements.grid.replaceChildren(...tasks.map(taskCard));
    elements.grid.setAttribute("aria-busy", "false");
    elements.grid.hidden = tasks.length === 0;
  }
  if (elements.empty) {
    elements.empty.hidden = tasks.length !== 0;
  }
}

function providerItem(provider) {
  const wrapper = element("div", "provider-item");
  const label = element("div", "capacity-label");
  const name = element("span", "provider-name");
  name.append(element("span", "provider-symbol", provider.name === "antigravity" ? "AG" : "CX"), document.createTextNode(provider.name || ""));

  const statsSpan = element("span", "capacity-stats");
  statsSpan.style.display = "flex";
  statsSpan.style.flexDirection = "column";
  statsSpan.style.alignItems = "flex-end";

  const queuedText = provider.queued ? ` (${provider.queued} kuyrukta)` : "";
  statsSpan.append(element("span", "", `${provider.active} / ${provider.limit}${queuedText}`));

  const quotaText = (provider.quota !== undefined && provider.quota !== null)
    ? `Remaining quota: ${new Intl.NumberFormat("tr-TR").format(provider.quota)}`
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
  if (!state.snapshot?.capacity) return;
  const { capacity } = state.snapshot;
  const queuedText = capacity.queued ? ` (${capacity.queued} kuyrukta)` : "";
  if (elements.capacityTotal) {
    elements.capacityTotal.textContent = `${capacity.active} / ${capacity.total}${queuedText}`;
  }
  if (elements.providers && Array.isArray(capacity.providers)) {
    elements.providers.replaceChildren(...capacity.providers.map(providerItem));
  }
}

function renderControlPlane() {
  if (!elements.controlPlane) return;
  const snapshot = state.snapshot;
  const selections = snapshot.config?.selections || {};
  const labels = {
    workSource: "Work source",
    orchestrator: "Orchestrator",
    executor: "Executor",
    codeIntelligence: "Code intelligence",
    sourceControl: "Source control"
  };
  const rows = Object.entries(labels).map(([key, label]) => {
    const row = element("div", "control-plane-row");
    row.append(element("span", "", label), element("strong", "", selections[key] || "kapalı"));
    return row;
  });
  const capabilities = snapshot.capabilities?.registry || [];
  const capabilityRow = element("div", "capability-preview");
  capabilities.slice(0, 5).forEach((capability) => {
    capabilityRow.append(element("span", "skill-chip", capability.id));
  });
  rows.push(capabilityRow);
  elements.controlPlane.replaceChildren(...rows);
  if (elements.capabilityCount) {
    elements.capabilityCount.textContent = capabilities.length + " capability";
  }
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

  if (elements.supervisorDot) elements.supervisorDot.className = `supervisor-dot ${statusInfo.class}`;
  if (elements.supervisorStatusText) elements.supervisorStatusText.textContent = statusInfo.label;
  if (elements.supervisorPid) elements.supervisorPid.textContent = supervisor.pid ?? "—";
  if (elements.supervisorMode) elements.supervisorMode.textContent = supervisor.mode || "—";
  if (elements.supervisorCycles) elements.supervisorCycles.textContent = supervisor.cycleCount ?? 0;

  if (supervisor.lastHeartbeatAt && elements.supervisorHeartbeat) {
    const nowMs = snapshot.generatedAt ? new Date(snapshot.generatedAt).getTime() : Date.now();
    const hbMs = new Date(supervisor.lastHeartbeatAt).getTime();
    const diffSec = Math.max(0, Math.floor((nowMs - hbMs) / 1000));
    elements.supervisorHeartbeat.textContent = diffSec < 60 ? `${diffSec}sn önce` : formatTime(supervisor.lastHeartbeatAt);
  } else if (elements.supervisorHeartbeat) {
    elements.supervisorHeartbeat.textContent = "—";
  }
}

function renderActivity() {
  if (!elements.activity || !state.snapshot) return;
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

  elements.activity.replaceChildren(...rows);
}

// ── View Navigation & URL State Management ───────────────────────────────────

function updateUrlState(params = {}) {
  if (typeof window === "undefined" || !window.location || !window.history) return;
  try {
    const url = new URL(window.location.href);
    if (params.view !== undefined) {
      if (params.view) url.searchParams.set("view", params.view.replace("-view", ""));
      else url.searchParams.delete("view");
    }
    if (params.parent !== undefined) {
      if (params.parent) url.searchParams.set("parent", params.parent);
      else url.searchParams.delete("parent");
    }
    if (params.issue !== undefined) {
      if (params.issue) url.searchParams.set("issue", params.issue);
      else url.searchParams.delete("issue");
    }
    if (params.run !== undefined) {
      if (params.run) url.searchParams.set("run", params.run);
      else url.searchParams.delete("run");
    }
    window.history.replaceState({}, "", url.toString());
  } catch {}
}

function restoreUrlState() {
  if (typeof window === "undefined" || !window.location) return;
  try {
    const url = new URL(window.location.href);
    const viewParam = url.searchParams.get("view");
    const parentParam = url.searchParams.get("parent");
    const issueParam = url.searchParams.get("issue");
    const runParam = url.searchParams.get("run");

    if (viewParam) {
      const targetId = viewParam.endsWith("-view") ? viewParam : `${viewParam}-view`;
      switchView(targetId, false);
    }
    if (parentParam) {
      state.selectedParentKey = parentParam;
      renderParentsView(parentParam);
    }
    if (issueParam) {
      openDecisionTrace(issueParam);
    }
    if (runParam) {
      openTelemetryDetail(runParam);
    }
  } catch {}
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => restoreUrlState());
}

function switchView(targetViewId, updateUrl = true) {
  if (typeof document === "undefined") return;
  const tabs = document.querySelectorAll(".tab-button");
  const contents = document.querySelectorAll(".tab-content");
  if (!tabs.length) return;

  tabs.forEach(b => b.classList.remove("is-active"));
  contents.forEach(c => {
    c.classList.remove("is-active");
    c.hidden = true;
  });

  const activeBtn = Array.from(tabs).find(b => b.dataset.target === targetViewId);
  const activeContent = document.getElementById(targetViewId);

  if (activeBtn) activeBtn.classList.add("is-active");
  if (activeContent) {
    activeContent.classList.add("is-active");
    activeContent.hidden = false;
  }

  state.currentView = targetViewId;
  if (updateUrl) {
    updateUrlState({ view: targetViewId });
  }

  if (targetViewId === "parents-view") {
    renderParentsView(state.selectedParentKey);
  } else if (targetViewId === "pm-view") {
    renderPmWorkspace();
  } else if (targetViewId === "observability-view") {
    renderObservability();
  } else if (targetViewId === "config-view") {
    renderConfigView();
  } else if (targetViewId === "agents-view") {
    renderAgentDefinitions();
  }
}

// ── Overview & Metrics Rendering ────────────────────────────────────────────

function renderOverview() {
  if (!state.snapshot) return;
  const snap = state.snapshot;
  const ws = snap.pmWorkspace || {};
  const counts = ws.counts || {};
  const totals = snap.totals || {};

  // Operating Mode
  const mode = (snap.config?.operatingMode || ws.operatingMode || "AUTONOMOUS").toUpperCase();
  if (elements.operatingModeLabel) elements.operatingModeLabel.textContent = mode;
  if (elements.overviewModeBadge) elements.overviewModeBadge.textContent = mode;
  if (elements.operatingModePill) {
    elements.operatingModePill.className = `mode-pill mode-${mode.toLowerCase()}`;
  }
  if (elements.overviewModeDesc) {
    if (mode === "MANUAL") {
      elements.overviewModeDesc.innerHTML = `<strong>MANUAL:</strong> Tüm görev adımları, branch oluşturma ve review süreçleri insan onayına tabidir. Otonom başlatma yapılmaz.`;
    } else if (mode === "SUPERVISED") {
      elements.overviewModeDesc.innerHTML = `<strong>SUPERVISED:</strong> Düşük riskli işler otonom yürütülür; yüksek riskli işler ve branch değişiklikleri plan parmak izi korumalı PM onayı bekler.`;
    } else {
      elements.overviewModeDesc.innerHTML = `<strong>AUTONOMOUS:</strong> Ready işler otonom yürütülür, review ve parent entegrasyonu otomatik işletilir; nihai Develop merge ve Done geçişi insan kontrolündedir.`;
    }
  }

  // Supervisor Status
  renderSupervisor();

  // Truthful Top Metrics
  if (elements.metricActive) elements.metricActive.textContent = counts.executing || 0;
  if (elements.metricQueued) elements.metricQueued.textContent = counts.ready || 0;
  if (elements.metricReview) elements.metricReview.textContent = counts.inReview || 0;
  if (elements.metricRework) elements.metricRework.textContent = counts.needsRework || 0;
  if (elements.metricBlocked) elements.metricBlocked.textContent = counts.blocked || 0;
  if (elements.metricAwaitingApproval) elements.metricAwaitingApproval.textContent = counts.awaitingApproval || 0;
  if (elements.metricHumanApproval) elements.metricHumanApproval.textContent = counts.humanApproval || 0;

  // Active Parents & Conflicts
  const parents = snap.parentExecutions || [];
  const activeParentsCount = parents.filter(p => ["active", "integrating", "waiting_approval", "in_review"].includes(p.state)).length;
  if (elements.metricActiveParents) elements.metricActiveParents.textContent = activeParentsCount || parents.length || 0;

  let conflictCount = 0;
  parents.forEach(p => {
    if (p.driftDetected) conflictCount++;
  });
  if (elements.metricParentConflicts) {
    elements.metricParentConflicts.textContent = conflictCount > 0 ? `${conflictCount} çatışma` : "0 çatışma";
  }

  // Token Usage (Truthful: show unavailable if unknown)
  if (elements.metricTokens) {
    if (totals.tokens != null && totals.tokens > 0) {
      elements.metricTokens.textContent = formatNumber(totals.tokens);
    } else {
      elements.metricTokens.textContent = "—";
    }
  }

  if (elements.project) elements.project.textContent = snap.project || "PACE";

  // Capacity & Providers
  renderCapacity();
  renderControlPlane();

  // Fleet Runs grid & Activity stream
  renderRuns();
  renderActivity();
}

// ── Parent Orchestration View ───────────────────────────────────────────────

async function renderParentsView(selectedKey = null) {
  const select = document.querySelector("#parent-select");
  const summaryCard = document.querySelector("#parent-summary-card");
  const humanCard = document.querySelector("#parent-human-approval-card");
  const dagContainer = document.querySelector("#parent-dag-container");
  const textFallback = document.querySelector("#parent-dag-text-fallback");
  const intLane = document.querySelector("#parent-integration-lane");
  if (!select) return;

  try {
    let parents = state.snapshot?.parentExecutions || [];
    if (parents.length === 0) {
      const res = await fetch("/api/pm/parents");
      if (res.ok) {
        const data = await res.json();
        if (data.ok && Array.isArray(data.parents)) parents = data.parents;
      }
    }

    select.innerHTML = parents.length === 0
      ? '<option value="">Kayıtlı parent / epic bulunamadı</option>'
      : parents.map(p => `<option value="${safeHtml(p.parentKey)}" ${p.parentKey === selectedKey ? 'selected' : ''}>${safeHtml(p.parentKey)} — ${safeHtml(p.summary || p.parentKey)} (${safeHtml(p.state)})</option>`).join("");

    const activeKey = selectedKey || (parents.length > 0 ? parents[0].parentKey : null);
    if (!activeKey) {
      if (summaryCard) summaryCard.innerHTML = `<div style="padding: 20px; color: var(--muted);">Aktif parent orkestrasyon kaydı bulunamadı.</div>`;
      if (dagContainer) dagContainer.innerHTML = "";
      if (intLane) intLane.innerHTML = "";
      return;
    }

    state.selectedParentKey = activeKey;
    updateUrlState({ parent: activeKey });

    const detailRes = await fetch(`/api/pm/parents/${activeKey}`);
    if (!detailRes.ok) throw new Error("Parent detay bilgisi alınamadı");
    const detailData = await detailRes.json();
    if (!detailData.ok) throw new Error(detailData.error || "Detay verisi geçersiz");

    const parent = detailData.parent;
    renderParentSummary(parent, summaryCard, humanCard);
    renderParentDag(parent, dagContainer, textFallback);
    renderParentIntegrationLane(parent, intLane);

  } catch (err) {
    if (summaryCard) {
      summaryCard.innerHTML = `<div class="error-banner">Hata: ${safeHtml(err.message)}</div>`;
    }
  }
}

function renderParentSummary(parent, cardEl, humanCardEl) {
  if (!cardEl) return;
  const p = parent.parent || parent;
  const stateVal = (parent.state || p.state || "active").toLowerCase();

  // WAITING_HUMAN Completion Evidence Banner
  if (humanCardEl) {
    if (stateVal === "waiting_human" || parent.waitingHuman) {
      humanCardEl.hidden = false;
      const review = parent.integrationReview || parent.completionPacket?.integrationReview;
      humanCardEl.innerHTML = `
        <div class="human-badge">★ HAZIR · İNSAN ONAYI BEKLİYOR</div>
        <h4 style="margin: 0 0 8px 0; color: #fff; font-size: 1.05rem;">Parent Entegrasyonu Tamamlandı — Geliştirme Dalına Merge Bekliyor</h4>
        <p style="margin: 0 0 12px 0; color: #cbd5e1; font-size: 0.85rem; line-height: 1.4;">
          Tüm alt görevler başarıyla entegre edildi ve aggregate reviewer tarafından doğrulandı. Otonom teslimat tamamlanmıştır.
          <strong>Güvenlik Sınırı:</strong> Otomatik merge veya deploy butonu bulunmaz; nihai <code>develop</code> merge ve <code>Done</code> geçişi insan kontrolündedir.
        </p>
        <div style="background: rgba(0,0,0,0.3); border-radius: 6px; padding: 10px; font-size: 0.8rem;">
          <div><strong>Branch:</strong> <code>${safeHtml(parent.integrationBranch || p.integrationBranch || '—')}</code> (SHA: <code>${safeHtml(parent.integrationHeadSha?.slice(0, 8) || '—')}</code>)</div>
          <div><strong>Reviewer:</strong> ${safeHtml(review?.reviewerId || 'lead-reviewer')} · <strong>Verdict:</strong> <span style="color: #4ade80; font-weight: bold;">${safeHtml(review?.verdict?.toUpperCase() || 'CLEAN')}</span> · <strong>Süre:</strong> ${review?.durationMs ? Math.round(review.durationMs / 1000) + 's' : '—'}</div>
        </div>
      `;
    } else {
      humanCardEl.hidden = true;
      humanCardEl.innerHTML = "";
    }
  }

  // Blocked / Hierarchy Drift notice
  let blockedHtml = "";
  if (Array.isArray(parent.blockedReasons) && parent.blockedReasons.length > 0) {
    blockedHtml = `
      <div class="blocked-reasons-panel">
        <strong>⚠️ Parent Orkestrasyon Engelleri:</strong>
        <ul style="margin: 4px 0 0 16px; padding: 0;">
          ${parent.blockedReasons.map(r => `<li>${safeHtml(r)}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  cardEl.innerHTML = `
    <div class="parent-summary-top">
      <div>
        <h3 class="parent-title">${safeHtml(p.parentKey || parent.parentKey)}: ${safeHtml(p.summary || parent.summary || '')}</h3>
        <div style="font-size: 0.8rem; color: var(--muted); margin-top: 4px;">
          Kaynak: <strong>${safeHtml(p.sourceProvider || 'jira').toUpperCase()}</strong> · Base: <code>${safeHtml(parent.baseRef || 'develop')}</code>
          (${parent.baseSha ? `<code>${parent.baseSha.slice(0, 8)}</code>` : '—'})
        </div>
      </div>
      <div>
        <span class="badge status-${safeHtml(stateVal)}">${safeHtml(STATUS_LABELS[stateVal] || stateVal.toUpperCase())}</span>
      </div>
    </div>

    ${blockedHtml}

    <div class="parent-meta-grid">
      <div class="parent-meta-cell">
        <span>Integration Branch</span>
        <strong><code>${safeHtml(parent.integrationBranch || p.integrationBranch || '—')}</code></strong>
      </div>
      <div class="parent-meta-cell">
        <span>Integration Head SHA</span>
        <strong><code>${safeHtml(parent.integrationHeadSha?.slice(0, 10) || '—')}</code></strong>
      </div>
      <div class="parent-meta-cell">
        <span>Graph Fingerprint</span>
        <strong title="${safeHtml(parent.graphFingerprint || '')}"><code>${safeHtml(parent.graphFingerprint?.slice(0, 12) || '—')}</code></strong>
      </div>
      <div class="parent-meta-cell">
        <span>Alt Görev Sayısı</span>
        <strong>${parent.children?.length || 0} Child Tasks</strong>
      </div>
    </div>
  `;
}

function renderParentDag(parent, containerEl, textFallbackEl) {
  if (!containerEl) return;
  const children = parent.children || [];

  if (children.length === 0) {
    containerEl.innerHTML = `<div style="padding: 24px; color: var(--muted); font-size: 0.85rem;">Bu parent altında kayıtlı child task bulunmuyor.</div>`;
    if (textFallbackEl) textFallbackEl.textContent = "Bağlı alt görev yok.";
    return;
  }

  // Render Accessible Text Fallback
  if (textFallbackEl) {
    const lines = children.map(c => {
      const deps = c.dependencies?.length ? ` [Bağımlılıklar: ${c.dependencies.join(", ")}]` : " [Bağımsız]";
      return `${c.issueKey}: ${c.summary} (${c.runtimeState || 'idle'}) - Entegrasyon: ${c.integrationState}${deps}`;
    });
    textFallbackEl.textContent = lines.join("\n");
  }

  // Partition Independent vs Dependent nodes
  const independent = children.filter(c => !c.dependencies || c.dependencies.length === 0);
  const dependent = children.filter(c => c.dependencies && c.dependencies.length > 0);

  function renderDagNode(c) {
    const stateClass = c.integrationState === "integrated"
      ? "state-integrated"
      : c.integrationState === "conflict" || c.runtimeState?.includes("conflict")
        ? "state-conflict"
        : c.runtimeState?.includes("blocked")
          ? "state-blocked"
          : c.runtimeState === "executing"
            ? "state-executing"
            : c.runtimeState === "reviewing" || c.runtimeState === "verifying"
              ? "state-review"
              : "state-idle";

    const depsBadge = c.dependencies?.length
      ? `<span class="dep-badge">Bağımlı: ${safeHtml(c.dependencies.join(", "))}</span>`
      : `<span class="dep-badge" style="background: rgba(255,255,255,0.05);">Bağımsız</span>`;

    const conflictMsg = c.blockedReasons?.length
      ? `<div style="color: #f87171; font-size: 0.72rem; margin-top: 4px;">⚠️ ${safeHtml(c.blockedReasons[0])}</div>`
      : "";

    return `
      <div class="dag-node-card ${stateClass}" onclick="openDecisionTrace('${safeHtml(c.issueKey)}')">
        <div class="dag-node-header">
          <span class="dag-node-key">${safeHtml(c.issueKey)}</span>
          <span class="badge status-${safeHtml(c.runtimeState)}">${safeHtml(STATUS_LABELS[c.runtimeState] || c.runtimeState)}</span>
        </div>
        <div class="dag-node-summary">${safeHtml(c.summary || c.issueKey)}</div>
        <div style="margin-top: 8px;">${depsBadge}</div>
        <div class="dag-node-footer">
          <span>Entegrasyon: <strong>${safeHtml(c.integrationState || 'not-queued')}</strong></span>
          <button class="pm-btn pm-btn-view" style="font-size: 0.7rem; padding: 2px 6px;">İncele</button>
        </div>
        ${conflictMsg}
      </div>
    `;
  }

  containerEl.innerHTML = `
    <div style="margin-bottom: 12px; font-weight: 600; font-size: 0.85rem; color: #94a3b8;">
      PARALEL / BAĞIMSIZ GÖREVLER (${independent.length})
    </div>
    <div class="dag-stage">
      ${independent.map(renderDagNode).join("")}
    </div>

    ${dependent.length > 0 ? `
      <div style="margin: 20px 0 12px 0; font-weight: 600; font-size: 0.85rem; color: #94a3b8;">
        BAĞIMLI / ARDIŞIK GÖREVLER (${dependent.length})
      </div>
      <div class="dag-stage">
        ${dependent.map(renderDagNode).join("")}
      </div>
    ` : ''}
  `;
}

function renderParentIntegrationLane(parent, containerEl) {
  if (!containerEl) return;
  const children = parent.children || [];

  if (children.length === 0) {
    containerEl.innerHTML = `<div style="color: var(--muted); font-size: 0.8rem;">Entegrasyon kaydı bulunmuyor.</div>`;
    return;
  }

  containerEl.innerHTML = `
    <div class="integration-lane-grid">
      ${children.map(c => `
        <div class="integration-lane-card">
          <div class="ilc-top">
            <span class="badge badge-key">${safeHtml(c.issueKey)}</span>
            <span class="badge status-${safeHtml(c.integrationState)}">${safeHtml(c.integrationState?.toUpperCase() || 'NOT QUEUED')}</span>
          </div>
          <div style="font-size: 0.8rem; font-weight: 500; color: #fff; margin: 4px 0 8px 0;">${safeHtml(c.summary || c.issueKey)}</div>
          <div style="font-size: 0.72rem; color: var(--muted); line-height: 1.4;">
            <div>Reviewed SHA: <code>${safeHtml(c.reviewedSha?.slice(0, 8) || '—')}</code></div>
            <div>Integrated SHA: <code>${safeHtml(c.integratedSha?.slice(0, 8) || '—')}</code></div>
            <div>Base SHA: <code>${safeHtml(c.childBaseSha?.slice(0, 8) || '—')}</code></div>
          </div>
          <div style="margin-top: 8px;">
            <button class="pm-btn pm-btn-view" style="font-size: 0.72rem; width: 100%;" onclick="openDecisionTrace('${safeHtml(c.issueKey)}')">İş Karar İzini Aç</button>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

// ── Work Item Decision Trace Modal ──────────────────────────────────────────

async function openDecisionTrace(issueKey) {
  const modal = document.querySelector("#decision-trace-modal");
  const body = document.querySelector("#decision-trace-body");
  const pill = document.querySelector("#trace-issue-pill");
  const title = document.querySelector("#trace-issue-title");
  if (!modal || !body) return;

  modal.hidden = false;
  body.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--muted);">İş kalemi detayları yükleniyor...</div>`;

  try {
    const res = await fetch(`/api/pm/work-items/${issueKey}`);
    if (!res.ok) throw new Error("İş kalemi verisi alınamadı");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Bilinmeyen hata");

    const item = data.workItem;
    pill.textContent = item.issueKey;
    title.textContent = `${item.issueKey}: ${item.summary || 'Detay Görünümü'}`;

    const decisions = item.decisions || [];
    const runs = item.runs || [];
    const parentInfo = item.parent || {};

    let decisionsHtml = "";
    if (decisions.length === 0) {
      decisionsHtml = `<p style="color: var(--muted); font-size: 0.8rem;">Henüz kayıtlı karar bulunmuyor.</p>`;
    } else {
      decisionsHtml = decisions.map(d => `
        <div class="timeline-item">
          <div class="timeline-top">
            <span class="actor-badge actor-${d.actor || 'system'}">${d.actor || 'SİSTEM'}</span>
            <span class="timeline-time">${formatTime(d.createdAt, true)}</span>
          </div>
          <div style="color: #fff; font-weight: 500; margin: 2px 0;">${safeHtml(d.action)}: ${d.approved !== false ? '✅ ONAYLANDI' : '❌ REDDEDİLDİ'}</div>
          ${d.reason ? `<div style="font-size: 0.78rem; color: #94a3b8;">${safeHtml(d.reason)}</div>` : ''}
          ${d.planFingerprint ? `<div style="font-size: 0.72rem; color: var(--muted); margin-top: 2px;">Plan FP: <code>${safeHtml(d.planFingerprint.slice(0, 12))}</code></div>` : ''}
        </div>
      `).join("");
    }

    let runsHtml = "";
    if (runs.length === 0) {
      runsHtml = `<p style="color: var(--muted); font-size: 0.8rem;">Henüz yürütme kaydı bulunmuyor.</p>`;
    } else {
      runsHtml = runs.map(r => `
        <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="color: #fff;">Run #${r.id} (${r.role || 'worker'})</strong>
            <span class="badge status-${r.state}">${r.state}</span>
          </div>
          <div style="font-size: 0.75rem; color: var(--muted); margin-top: 4px;">
            Agent: <strong>${r.taskAgent || r.persona}</strong> · Model: <strong>${r.model || 'default'}</strong> · Tokens: <strong>${r.tokens || 0}</strong>
          </div>
          <div style="margin-top: 6px;">
            <button class="pm-btn pm-btn-view" style="font-size: 0.72rem;" onclick="openTelemetryDetail('${r.id}')">📊 Telemetri ve Timeline İncele</button>
          </div>
        </div>
      `).join("");
    }

    body.innerHTML = `
      <div class="trace-section">
        <h4>📋 İş Kalemi Durumu</h4>
        <div class="trace-grid-two">
          <div class="trace-info-cell"><span>Statü / Aşama</span><strong>${safeHtml(item.state || 'idle')}</strong></div>
          <div class="trace-info-cell"><span>Öncelik / Risk</span><strong>${safeHtml(item.risk || 'normal')}</strong></div>
          <div class="trace-info-cell"><span>Parent / Epik</span><strong>${item.parentKey ? `<a href="javascript:void(0)" onclick="switchView('parents-view'); renderParentsView('${item.parentKey}');" style="color: #60a5fa;">${item.parentKey}</a>` : '—'}</strong></div>
          <div class="trace-info-cell"><span>Entegrasyon Durumu</span><strong>${safeHtml(item.integrationState || 'not-queued')}</strong></div>
        </div>
      </div>

      <div class="trace-section">
        <h4>⚖️ PM & Orkestrasyon Kararları</h4>
        <div class="timeline-list">${decisionsHtml}</div>
      </div>

      <div class="trace-section">
        <h4>🚀 İlgili Çalıştırmalar (Runs)</h4>
        <div>${runsHtml}</div>
      </div>
    `;

    updateUrlState({ issue: issueKey });

  } catch (err) {
    body.innerHTML = `<div class="error-banner">Hata: ${safeHtml(err.message)}</div>`;
  }
}

const traceCloseBtn = document.querySelector("#trace-close-btn");
if (traceCloseBtn) {
  traceCloseBtn.addEventListener("click", () => {
    const modal = document.querySelector("#decision-trace-modal");
    if (modal) modal.hidden = true;
    updateUrlState({ issue: null });
  });
}

// ── In-Page Modals: Approvals & Rejections ───────────────────────────────────

let currentApprovalContext = null;

function openApprovalModal(issueKey, action, planFingerprint, attempt, summary = "", risk = "normal", agent = "backend-engineer") {
  const modal = document.querySelector("#approval-modal");
  const sub = document.querySelector("#approval-modal-sub");
  const scopeEl = document.querySelector("#approval-plan-scope");
  const fpEl = document.querySelector("#approval-plan-fingerprint");
  const errEl = document.querySelector("#approval-modal-error");
  if (!modal) return;

  currentApprovalContext = { issueKey, action, planFingerprint, attempt };
  if (sub) sub.textContent = `${issueKey}: ${summary} (Aksiyon: ${action}, Risk: ${risk})`;
  if (scopeEl) scopeEl.textContent = `Aksiyon: ${action} | Hedef Agent: ${agent} | Risk Seviyesi: ${risk}`;
  if (fpEl) fpEl.textContent = planFingerprint;
  if (errEl) { errEl.hidden = true; errEl.textContent = ""; }

  modal.hidden = false;
}

function closeApprovalModal() {
  const modal = document.querySelector("#approval-modal");
  if (modal) modal.hidden = true;
  currentApprovalContext = null;
}

const appCancelBtn = document.querySelector("#approval-cancel-btn");
if (appCancelBtn) appCancelBtn.addEventListener("click", closeApprovalModal);

const appConfirmBtn = document.querySelector("#approval-confirm-btn");
if (appConfirmBtn) {
  appConfirmBtn.addEventListener("click", async () => {
    if (!currentApprovalContext) return;
    const { issueKey, action, planFingerprint, attempt } = currentApprovalContext;
    const errEl = document.querySelector("#approval-modal-error");
    appConfirmBtn.disabled = true;
    appConfirmBtn.textContent = "Onaylanıyor...";

    try {
      const res = await fetch(`/api/pm/work-items/${issueKey}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          planFingerprint,
          attempt,
          approver: "PM Operator",
          reason: "Onay modalı üzerinden onaylandı"
        })
      });

      if (res.status === 409) {
        const data = await res.json();
        throw new Error(data.error || "Plan parmak izi uyuşmazlığı (stale fingerprint). Çalışma alanı yenileniyor.");
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Onay başarısız (${res.status})`);
      }

      closeApprovalModal();
      await refresh();

    } catch (err) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message;
      }
      setTimeout(() => refresh(), 1500);
    } finally {
      appConfirmBtn.disabled = false;
      appConfirmBtn.textContent = "Onayla ve Başlat";
    }
  });
}

function openRejectionModal(issueKey, action, planFingerprint, attempt, summary = "") {
  const modal = document.querySelector("#rejection-modal");
  const sub = document.querySelector("#rejection-modal-sub");
  const reasonInput = document.querySelector("#rejection-reason-input");
  const errEl = document.querySelector("#rejection-modal-error");
  if (!modal) return;

  currentApprovalContext = { issueKey, action, planFingerprint, attempt };
  if (sub) sub.textContent = `${issueKey}: ${summary} (Aksiyon: ${action})`;
  if (reasonInput) reasonInput.value = "";
  if (errEl) { errEl.hidden = true; errEl.textContent = ""; }

  modal.hidden = false;
}

function closeRejectionModal() {
  const modal = document.querySelector("#rejection-modal");
  if (modal) modal.hidden = true;
  currentApprovalContext = null;
}

const rejCancelBtn = document.querySelector("#rejection-cancel-btn");
if (rejCancelBtn) rejCancelBtn.addEventListener("click", closeRejectionModal);

const rejConfirmBtn = document.querySelector("#rejection-confirm-btn");
if (rejConfirmBtn) {
  rejConfirmBtn.addEventListener("click", async () => {
    if (!currentApprovalContext) return;
    const { issueKey, action, planFingerprint, attempt } = currentApprovalContext;
    const reasonInput = document.querySelector("#rejection-reason-input");
    const errEl = document.querySelector("#rejection-modal-error");
    const reason = reasonInput ? reasonInput.value.trim() : "";

    if (!reason) {
      if (errEl) { errEl.hidden = false; errEl.textContent = "Lütfen bir ret gerekçesi giriniz."; }
      return;
    }

    rejConfirmBtn.disabled = true;
    rejConfirmBtn.textContent = "Reddediliyor...";

    try {
      const res = await fetch(`/api/pm/work-items/${issueKey}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          planFingerprint,
          attempt,
          approver: "PM Operator",
          reason
        })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Ret işlemi başarısız (${res.status})`);
      }

      closeRejectionModal();
      await refresh();

    } catch (err) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message;
      }
    } finally {
      rejConfirmBtn.disabled = false;
      rejConfirmBtn.textContent = "Planı Reddet";
    }
  });
}

// ── PM Workspace View ───────────────────────────────────────────────────────

function renderPmWorkspace() {
  if (!state.snapshot?.pmWorkspace) return;
  const ws = state.snapshot.pmWorkspace;
  const groups = ws.groups || {};
  const container = document.querySelector("#pm-workspace-list");
  if (!container) return;

  let items = [];
  if (state.currentPmFilter === "inbox") {
    items = [...(groups.executionApproval || []), ...(groups.humanApproval || []), ...(groups.blocked || [])];
  } else if (state.currentPmFilter === "approvals") {
    items = groups.executionApproval || [];
  } else if (state.currentPmFilter === "blocked") {
    items = groups.blocked || [];
  } else if (state.currentPmFilter === "active") {
    items = [...(groups.ready || []), ...(groups.executing || []), ...(groups.inReview || []), ...(groups.needsRework || [])];
  } else if (state.currentPmFilter === "completed") {
    items = groups.completed || [];
  } else {
    items = Object.values(groups).flat();
  }

  if (items.length === 0) {
    container.innerHTML = `<div style="padding: 32px; text-align: center; color: var(--muted);">Bu filtrede iş kalemi bulunmuyor.</div>`;
    return;
  }

  container.innerHTML = items.map(item => {
    const isApprovalReq = item.status === "awaiting_approval" || item.group === "executionApproval";
    const isHumanApproval = item.status === "waiting_human" || item.group === "humanApproval";
    const isBlocked = item.status === "blocked" || item.group === "blocked";

    let actionsHtml = "";
    if (isApprovalReq && item.approvalRequest) {
      const req = item.approvalRequest;
      actionsHtml = `
        <button class="pm-btn pm-btn-approve" onclick="openApprovalModal('${safeHtml(item.issueKey)}', '${safeHtml(req.action)}', '${safeHtml(req.planFingerprint)}', ${req.attempt || 0}, '${safeHtml(item.summary || '')}', '${safeHtml(item.risk || 'normal')}', '${safeHtml(item.taskAgent || 'backend-engineer')}')">Onayla</button>
        <button class="pm-btn pm-btn-reject" onclick="openRejectionModal('${safeHtml(item.issueKey)}', '${safeHtml(req.action)}', '${safeHtml(req.planFingerprint)}', ${req.attempt || 0}, '${safeHtml(item.summary || '')}')">Reddet</button>
      `;
    } else if (isHumanApproval) {
      actionsHtml = `
        <span class="badge" style="background: rgba(234, 179, 8, 0.2); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.4);">İnsan Onayı Bekliyor</span>
      `;
    }

    return `
      <div class="pm-item-card">
        <div class="pm-item-header">
          <div>
            <span class="badge badge-key">${safeHtml(item.issueKey)}</span>
            <span class="pm-item-title">${safeHtml(item.summary || item.issueKey)}</span>
          </div>
          <div>
            <span class="badge status-${safeHtml(item.status)}">${safeHtml(STATUS_LABELS[item.status] || item.status)}</span>
          </div>
        </div>

        <div style="font-size: 0.8rem; color: var(--muted); margin: 6px 0;">
          Agent: <strong>${safeHtml(item.taskAgent || item.persona || 'unassigned')}</strong> · Risk: <strong>${safeHtml(item.risk || 'normal')}</strong>
          ${item.parentKey ? `· Parent: <a href="javascript:void(0)" onclick="switchView('parents-view'); renderParentsView('${safeHtml(item.parentKey)}');" style="color: #60a5fa;">${safeHtml(item.parentKey)}</a>` : ''}
        </div>

        ${item.blockedReasons?.length ? `
          <div style="color: #f87171; font-size: 0.75rem; background: rgba(239, 68, 68, 0.1); border-left: 2px solid #ef4444; padding: 4px 8px; margin: 6px 0;">
            ⚠️ ${safeHtml(item.blockedReasons[0])}
          </div>
        ` : ''}

        <div class="pm-item-actions">
          <button class="pm-btn pm-btn-view" onclick="openDecisionTrace('${safeHtml(item.issueKey)}')">İş Karar İzi</button>
          ${actionsHtml}
        </div>
      </div>
    `;
  }).join("");
}

function setupPmSubNav() {
  document.querySelectorAll(".pm-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".pm-filter-btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.currentPmFilter = btn.dataset.filter || "inbox";
      renderPmWorkspace();
    });
  });
}

// ── Observability View ──────────────────────────────────────────────────────

async function renderObservability() {
  const tableBody = document.querySelector("#obs-runs-table-body");
  const providersGrid = document.querySelector("#obs-providers-grid");
  if (!tableBody) return;

  try {
    const res = await fetch(`/api/observability/summary?window=${state.currentObsWindow}`);
    if (!res.ok) throw new Error("Observability verisi alınamadı");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Geçersiz yanıt");

    // Render Provider Health
    if (providersGrid) {
      const pHealth = data.providerHealth || [];
      if (pHealth.length === 0) {
        providersGrid.innerHTML = '<div style="color: var(--muted); font-size: 0.8rem;">Kayıtlı sağlayıcı sağlık verisi bulunamadı.</div>';
      } else {
        providersGrid.innerHTML = pHealth.map(p => `
          <div class="provider-health-card">
            <div class="ph-top">
              <span class="ph-provider-name">${safeHtml(p.provider.toUpperCase())}</span>
              <span class="badge status-${safeHtml(p.status)}">${safeHtml(p.status.toUpperCase())}</span>
            </div>
            <div class="ph-stats-grid">
              <div class="ph-stat-cell"><span>Başarı Oranı</span><strong>${p.successRate != null ? Math.round(p.successRate * 100) + '%' : '—'}</strong></div>
              <div class="ph-stat-cell"><span>Ort. Süre</span><strong>${p.averageDurationMs != null ? Math.round(p.averageDurationMs / 1000) + 's' : '—'}</strong></div>
              <div class="ph-stat-cell"><span>Başarı</span><strong>${p.recentSuccesses || 0}</strong></div>
              <div class="ph-stat-cell"><span>Hata</span><strong>${p.recentFailures || 0}</strong></div>
            </div>
          </div>
        `).join("");
      }
    }

    // Render Observability Runs Table
    const runs = data.runs || [];
    if (runs.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--muted); padding: 24px;">Bu zaman penceresinde kayıtlı çalıştırma yok.</td></tr>`;
      return;
    }

    tableBody.innerHTML = runs.map(r => `
      <tr>
        <td><span class="badge badge-key">${safeHtml(r.issueKey)}</span></td>
        <td><strong>${safeHtml(r.taskAgent || r.persona)}</strong> <small style="color: var(--muted); display: block;">${safeHtml(r.role)}</small></td>
        <td>${safeHtml(r.provider)} <small style="color: var(--muted); display: block;">${safeHtml(r.model || '—')}</small></td>
        <td><span class="badge status-${safeHtml(r.state)}">${safeHtml(STATUS_LABELS[r.state] || r.state)}</span></td>
        <td>${r.durationSeconds != null ? `${r.durationSeconds}s` : '—'}</td>
        <td>${r.usage?.available && r.usage?.totalTokens != null ? `<strong>${r.usage.totalTokens}</strong> tok` : '<span style="color: var(--muted);">—</span>'}</td>
        <td>${formatTime(r.createdAt, true)}</td>
        <td><button class="pm-btn pm-btn-view" style="font-size: 0.72rem;" onclick="openTelemetryDetail('${safeHtml(r.runId)}')">Timeline</button></td>
      </tr>
    `).join("");

  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="8" style="color: #f87171; padding: 16px;">Hata: ${safeHtml(err.message)}</td></tr>`;
  }
}

async function openTelemetryDetail(runId) {
  const modal = document.querySelector("#telemetry-drawer-modal");
  const body = document.querySelector("#telem-drawer-body");
  const pill = document.querySelector("#telem-run-pill");
  const title = document.querySelector("#telem-drawer-title");
  const summary = document.querySelector("#telem-run-summary");
  if (!modal || !body) return;

  modal.hidden = false;
  body.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--muted);">Telemetri verisi yükleniyor...</div>`;

  try {
    const res = await fetch(`/api/observability/runs/${runId}`);
    if (!res.ok) throw new Error("Telemetri verisi alınamadı");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Telemetri hatası");

    pill.textContent = data.identity?.issueKey || `Run #${runId}`;
    title.textContent = `Run Telemetry: ${data.identity?.issueKey || runId}`;
    summary.textContent = `Rol: ${data.identity?.role} · Agent: ${data.agent?.taskAgent} · Provider: ${data.execution?.provider} (${data.execution?.model || 'default'})`;

    const timings = data.timing || {};
    const usage = data.usage || {};
    const events = data.events || [];

    let eventsHtml = "";
    if (events.length === 0) {
      eventsHtml = `<p style="color: var(--muted); font-size: 0.8rem;">Olay kaydı bulunmuyor.</p>`;
    } else {
      eventsHtml = events.map(ev => `
        <div class="timeline-item">
          <div class="timeline-top">
            <span class="actor-badge actor-runtime">${safeHtml(ev.stage)}</span>
            <span class="timeline-time">${formatTime(ev.timestamp, true)}</span>
          </div>
          <div style="color: #f1f5f9; font-weight: 500;">
            ${safeHtml(ev.status.toUpperCase())} ${ev.model ? `· model: ${safeHtml(ev.model)}` : ''}
            ${ev.usage?.totalTokens != null ? `· ${ev.usage.totalTokens} tokens` : ''}
          </div>
          ${ev.error ? `<div style="color: #f87171; font-size: 0.75rem; margin-top: 2px;">⚠️ ${safeHtml(ev.error.safeMessage || ev.error.category)}</div>` : ''}
        </div>
      `).join("");
    }

    body.innerHTML = `
      <div class="trace-section">
        <h4>⚡ Yürütme ve Süre Bilgileri</h4>
        <div class="trace-grid-two">
          <div class="trace-info-cell"><span>Kuyruk Bekleme</span><strong>${timings.queueWaitMs != null ? timings.queueWaitMs + 'ms' : '—'}</strong></div>
          <div class="trace-info-cell"><span>Yürütme Süresi</span><strong>${timings.executionDurationMs != null ? timings.executionDurationMs + 'ms' : '—'}</strong></div>
          <div class="trace-info-cell"><span>Uçtan Uca Süre</span><strong>${timings.endToEndDurationMs != null ? timings.endToEndDurationMs + 'ms' : '—'}</strong></div>
          <div class="trace-info-cell"><span>Deneme / Attempt</span><strong>${timings.attempt != null ? timings.attempt + 1 : 1} / ${timings.totalAttempts || 3}</strong></div>
        </div>
      </div>

      <div class="trace-section">
        <h4>◇ Normalized Token Usage Ledger</h4>
        <div class="trace-grid-two">
          <div class="trace-info-cell"><span>Girdi Token</span><strong>${usage.available && usage.inputTokens != null ? usage.inputTokens : '—'}</strong></div>
          <div class="trace-info-cell"><span>Çıktı Token</span><strong>${usage.available && usage.outputTokens != null ? usage.outputTokens : '—'}</strong></div>
          <div class="trace-info-cell"><span>Cached Girdi</span><strong>${usage.available && usage.cachedInputTokens != null ? usage.cachedInputTokens : '—'}</strong></div>
          <div class="trace-info-cell"><span>Toplam Token</span><strong>${usage.available && usage.totalTokens != null ? usage.totalTokens : '—'}</strong></div>
        </div>
      </div>

      <div class="trace-section">
        <h4>📜 Telemetri Olay Çizelgesi (Ordered Lifecycle Events)</h4>
        <div class="timeline-list">${eventsHtml}</div>
      </div>
    `;

    updateUrlState({ run: runId });

  } catch (err) {
    body.innerHTML = `<div class="error-banner">Hata: ${safeHtml(err.message)}</div>`;
  }
}

const telemCloseBtn = document.querySelector("#telem-close-btn");
if (telemCloseBtn) {
  telemCloseBtn.addEventListener("click", () => {
    const modal = document.querySelector("#telemetry-drawer-modal");
    if (modal) modal.hidden = true;
    updateUrlState({ run: null });
  });
}

document.querySelectorAll(".window-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".window-btn").forEach(b => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.currentObsWindow = btn.dataset.window || "24h";
    renderObservability();
  });
});

// ── Agent Management View ───────────────────────────────────────────────────

async function renderAgentDefinitions() {
  const container = document.querySelector("#agents-list");
  if (!container) return;

  try {
    const res = await fetch("/api/agents?includeArchived=true");
    if (!res.ok) throw new Error("Agent listesi alınamadı");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Geçersiz yanıt");

    const agents = data.agents || [];
    if (agents.length === 0) {
      container.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--muted);">Kayıtlı agent tanımı bulunamadı.</div>`;
      return;
    }

    container.innerHTML = agents.map(agent => {
      const isEnabled = agent.status === "enabled";
      const isArchived = agent.status === "archived";

      return `
        <div class="agent-reg-card">
          <div class="arc-header">
            <div>
              <span class="arc-id">${safeHtml(agent.id)}</span>
              <span class="badge status-${safeHtml(agent.status)}">${safeHtml(agent.status.toUpperCase())}</span>
              <span class="badge" style="background: rgba(255,255,255,0.05); color: #cbd5e1;">v${agent.version || 1}</span>
            </div>
            <div class="arc-actions">
              <button class="pm-btn pm-btn-view" style="font-size: 0.72rem;" onclick="openAgentVersionsDrawer('${safeHtml(agent.id)}')">Versiyonlar</button>
              <button class="pm-btn pm-btn-view" style="font-size: 0.72rem;" onclick="openAgentEditModal('${safeHtml(agent.id)}')">Yeni Versiyon Kaydet</button>
              ${isEnabled
                ? `<button class="pm-btn pm-btn-reject" style="font-size: 0.72rem;" onclick="toggleAgentStatus('${safeHtml(agent.id)}', 'disable')">Devre Dışı Bırak</button>`
                : `<button class="pm-btn pm-btn-approve" style="font-size: 0.72rem;" onclick="toggleAgentStatus('${safeHtml(agent.id)}', 'enable')">Aktifleştir</button>`}
            </div>
          </div>

          <div style="font-size: 0.85rem; color: #fff; font-weight: 500; margin: 6px 0;">${safeHtml(agent.displayName || agent.id)}</div>
          <div style="font-size: 0.78rem; color: var(--muted);">
            Rol: <strong>${safeHtml(agent.role || 'implementation')}</strong> · Model: <strong>${safeHtml(agent.preferredModel || 'default')}</strong> · Risk: <strong>${safeHtml(agent.risk || 'normal')}</strong>
          </div>

          ${agent.skills?.length ? `
            <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
              ${agent.skills.map(s => `<span class="skill-chip">${safeHtml(s)}</span>`).join("")}
            </div>
          ` : ''}

          <div style="margin-top: 8px; font-size: 0.72rem; color: var(--muted);">
            Tanım Özeti (SHA): <code>${safeHtml(agent.definitionHash?.slice(0, 12) || '—')}</code>
          </div>
        </div>
      `;
    }).join("");

  } catch (err) {
    container.innerHTML = `<div class="error-banner">Hata: ${safeHtml(err.message)}</div>`;
  }
}

async function toggleAgentStatus(agentId, action) {
  try {
    const res = await fetch(`/api/agents/${agentId}/${action}`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Agent durum güncelleme başarısız (${res.status})`);
    }
    await renderAgentDefinitions();
  } catch (err) {
    alert(`Hata: ${err.message}`);
  }
}

async function openAgentVersionsDrawer(agentId) {
  const drawer = document.querySelector("#agent-versions-drawer");
  const listEl = document.querySelector("#agent-versions-list");
  const subEl = document.querySelector("#agent-versions-sub");
  if (!drawer || !listEl) return;

  drawer.hidden = false;
  if (subEl) subEl.textContent = `${agentId} için sabit versiyon geçmişi`;
  listEl.innerHTML = `<div style="padding: 16px; color: var(--muted);">Versiyon geçmişi yükleniyor...</div>`;

  try {
    const res = await fetch(`/api/agents/${agentId}/versions`);
    if (!res.ok) throw new Error("Versiyonlar alınamadı");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Geçersiz yanıt");

    const versions = data.versions || [];
    listEl.innerHTML = versions.map(v => `
      <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <strong style="color: #fff;">Versiyon v${v.version}</strong>
          <small style="color: var(--muted);">${formatTime(v.createdAt, true)}</small>
        </div>
        <div style="font-size: 0.72rem; color: var(--muted); margin: 4px 0;">
          Hash: <code>${safeHtml(v.definitionHash || '—')}</code>
        </div>
        <pre style="background: rgba(0,0,0,0.4); padding: 8px; border-radius: 4px; font-size: 0.72rem; color: #a5f3fc; overflow-x: auto; margin: 6px 0 0 0;">${safeHtml(JSON.stringify(v.definition, null, 2))}</pre>
      </div>
    `).join("");

  } catch (err) {
    listEl.innerHTML = `<div class="error-banner">Hata: ${safeHtml(err.message)}</div>`;
  }
}

const verCloseBtn = document.querySelector("#agent-versions-close-btn");
if (verCloseBtn) {
  verCloseBtn.addEventListener("click", () => {
    const drawer = document.querySelector("#agent-versions-drawer");
    if (drawer) drawer.hidden = true;
  });
}

// ── Provider / Configuration View ───────────────────────────────────────────

async function renderConfigView() {
  const container = document.querySelector("#config-providers-container");
  const readOnlyNotice = document.querySelector("#config-readonly-notice");
  if (!container) return;

  try {
    const res = await fetch("/api/snapshot");
    if (!res.ok) throw new Error("Snapshot alınamadı");
    const data = await res.json();

    const meta = data.controlPlane || {};
    const providers = meta.providers || {};
    const selections = meta.config?.selections || {};
    const mutationEnabled = Boolean(meta.config?.mutationEnabled);

    if (readOnlyNotice) {
      readOnlyNotice.hidden = mutationEnabled;
    }

    const sections = [
      { key: "workSource", title: "Work Source", list: providers.workSources || [] },
      { key: "orchestrator", title: "Orchestrator", list: providers.orchestrators || [] },
      { key: "executor", title: "Executor", list: providers.executors || [] },
      { key: "codeIntelligence", title: "Code Intelligence", list: providers.codeIntelligence || [] },
      { key: "sourceControl", title: "Source Control", list: providers.sourceControl || [] }
    ];

    container.innerHTML = sections.map(sec => {
      const selectedId = selections[sec.key] || "";
      const isMutable = mutationEnabled && sec.key !== "sourceControl";

      return `
        <div class="config-provider-card">
          <div class="cpc-header">
            <h4>${safeHtml(sec.title)}</h4>
            <span class="badge" style="background: rgba(255,255,255,0.05); color: #cbd5e1;">${safeHtml(selectedId || 'none')}</span>
          </div>

          <div style="margin: 12px 0;">
            <label style="font-size: 0.78rem; color: var(--muted); display: block; margin-bottom: 4px;">Aktif Sağlayıcı Seçimi:</label>
            <select class="form-select config-provider-select" data-section="${safeHtml(sec.key)}" ${!isMutable ? 'disabled' : ''}>
              ${sec.list.map(p => `
                <option value="${safeHtml(p.id || p.name)}" ${p.selected || p.id === selectedId || p.name === selectedId ? 'selected' : ''} ${p.enabled === false ? 'disabled' : ''}>
                  ${safeHtml(p.displayName || p.name || p.id)} ${p.enabled === false ? '(Devre Dışı)' : ''}
                </option>
              `).join("")}
            </select>
          </div>

          <div style="font-size: 0.72rem; color: var(--muted);">
            ${isMutable ? 'Seçimi değiştirdiğinizde ayarlar diske atomik kaydedilir.' : 'Bu sağlayıcı seçimi çalışma zamanında salt-okunurdur.'}
          </div>
        </div>
      `;
    }).join("");

    // Bind onChange handlers for mutable provider dropdowns
    container.querySelectorAll(".config-provider-select").forEach(sel => {
      sel.addEventListener("change", async () => {
        const section = sel.dataset.section;
        const newProvider = sel.value;
        try {
          const patchRes = await fetch("/api/config/providers", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [section]: newProvider })
          });
          if (!patchRes.ok) {
            const patchErr = await patchRes.json().catch(() => ({}));
            throw new Error(patchErr.error || `Güncelleme başarısız (${patchRes.status})`);
          }
          await refresh();
          await renderConfigView();
        } catch (err) {
          alert(`Hata: ${err.message}`);
          await renderConfigView();
        }
      });
    });

  } catch (err) {
    container.innerHTML = `<div class="error-banner">Hata: ${safeHtml(err.message)}</div>`;
  }
}

// ── Refresh & Polling ───────────────────────────────────────────────────────

async function refresh() {
  try {
    const res = await fetch("/api/snapshot");
    if (!res.ok) throw new Error("Snapshot alınamadı");
    const snapshot = await res.json();
    state.snapshot = snapshot;
    state.connected = true;
    state.loading = false;

    if (elements.connectionDot) elements.connectionDot.className = "status-dot is-connected";
    if (elements.connectionLabel) elements.connectionLabel.textContent = "Bağlı";
    if (elements.syncTime) elements.syncTime.textContent = formatTime(snapshot.generatedAt || new Date().toISOString());
    if (elements.error) elements.error.hidden = true;

    renderOverview();

    if (state.currentView === "parents-view") {
      renderParentsView(state.selectedParentKey);
    } else if (state.currentView === "pm-view") {
      renderPmWorkspace();
    } else if (state.currentView === "observability-view") {
      renderObservability();
    } else if (state.currentView === "config-view") {
      renderConfigView();
    } else if (state.currentView === "agents-view") {
      renderAgentDefinitions();
    }

  } catch (err) {
    state.connected = false;
    if (elements.connectionDot) elements.connectionDot.className = "status-dot is-disconnected";
    if (elements.connectionLabel) elements.connectionLabel.textContent = "Bağlantı kesildi";
    if (elements.error) {
      elements.error.hidden = false;
      elements.error.textContent = `Kontrol paneli güncellenemedi: ${err.message}`;
    }
  }
}

// ── Event Handlers & Initialization ─────────────────────────────────────────

if (typeof document !== "undefined") {
  document.querySelectorAll(".tab-button").forEach(button => {
    button.addEventListener("click", () => {
      const target = button.dataset.target;
      if (target) switchView(target);
    });
  });

  const parentSel = document.querySelector("#parent-select");
  if (parentSel) {
    parentSel.addEventListener("change", () => {
      state.selectedParentKey = parentSel.value;
      renderParentsView(parentSel.value);
    });
  }

  const searchInput = document.querySelector("#run-search");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      state.query = e.target.value;
      renderRuns();
    });
  }

  document.querySelectorAll(".filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      state.filter = btn.dataset.filter || "all";
      renderRuns();
    });
  });

  setupPmSubNav();
  restoreUrlState();
  refresh();

  setInterval(() => {
    if (!document.hidden) refresh();
  }, 2500);
}
