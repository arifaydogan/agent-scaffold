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
  controlPlane: document.querySelector("#control-plane-list"),
  capabilityCount: document.querySelector("#capability-count"),
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
    const maxAttempts = state.snapshot.policy?.maxAttempts || 3;
    const retryPanel = element("div", "retry-panel");
    const retryBtn = element("button", "retry-button", "Blocker çözüldü — aynı işi yeniden çalıştır");
    const retryStatus = element("p", "retry-status", "");
    const hasHandler = state.snapshot.capabilities?.retryHandler;
    const canRetry = (run.attempt || lane.attempts.length) < maxAttempts;
    if (!hasHandler || !canRetry) {
      retryBtn.disabled = true;
      retryStatus.textContent = !hasHandler
        ? "Yeniden çalıştırma servisi şu anda bağlı değil."
        : `${maxAttempts}/${maxAttempts} otomatik deneme kullanıldı; yeni worker başlatılmayacak.`;
    } else {
      retryBtn.onclick = async () => {
        if (!confirm("Teknik blocker çözüldü mü? Aynı güvenli plan yeni deneme olarak kuyruğa alınacak.")) return;
        retryBtn.disabled = true;
        retryBtn.textContent = "Kuyruğa alınıyor…";
        retryStatus.textContent = "İstek coordinator kuyruğuna yazılıyor.";
        try {
          const response = await fetch("/api/retry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ runId: run.id, issueKey: run.issue })
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || "Retry request rejected");
          retryBtn.textContent = "Yeniden deneme kuyruğunda";
          retryStatus.textContent = "Statü güncellendi; uygun worker slotu açıldığında iş başlayacak.";
          await refresh();
        } catch (error) {
          retryBtn.disabled = false;
          retryBtn.textContent = "Blocker çözüldü — aynı işi yeniden çalıştır";
          retryStatus.textContent = `Yeniden deneme başlatılamadı: ${error.message}`;
        }
      };
    }
    retryPanel.append(
      element("p", "retry-help", "Bu işlem onay veya merge vermez; aynı branch ve güvenli planla yeni worker denemesi oluşturur."),
      retryBtn,
      retryStatus
    );
    section.append(retryPanel);
  }

  return section;
}

function taskCard(group) {
  const run = group.latest;
  const allRuns = group.attempts;
  const latestLane = group.lanes.find((lane) => lane.latest.id === run.id) || group.lanes[0];
  const attempts = latestLane.attempts;
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

  const taskTitle = element("h3", "task-title");
  const taskLink = element("a", "task-title-link", run.summary);
  taskLink.href = issueLink.href;
  taskLink.target = "_blank";
  taskLink.rel = "noopener noreferrer";
  taskTitle.append(taskLink);
  card.append(taskTitle);
  const lanes = element("div", "role-lanes");
  lanes.append(...group.lanes.map(roleLane));
  card.append(lanes);

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

  if (!group.lanes.length && (run.blockers?.length || run.stateKind === "blocked")) {
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

  if (!group.lanes.length && attempts.length > 1) {
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

  const isTerminal = ["failed", "failed-retryable", "failed-scope", "blocked", "human_action_required"].includes(run.state);
  const maxAttempts = state.snapshot.policy?.maxAttempts || 3;
  if (isTerminal) {
    const canRetry = ["failed-retryable", "blocked", "human_action_required"].includes(run.state) && (run.attempt || attempts.length) < maxAttempts;
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
      retryBtn.onclick = async () => {
        if (confirm("Are you sure you want to retry this task?")) {
          retryBtn.disabled = true;
          retryBtn.textContent = "Kuyruğa alınıyor…";
          try {
            const response = await fetch("/api/retry", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ runId: run.id, issueKey: run.issue })
            });
            if (!response.ok) throw new Error("Retry request rejected");
            retryBtn.textContent = "Yeniden deneme kuyruğunda";
            await refresh();
          } catch {
            retryBtn.disabled = false;
            retryBtn.textContent = "Tekrar dene";
            retryBtn.title = "Yeniden deneme isteği gönderilemedi";
          }
        }
      };
    }
    card.append(retryBtn);
  }

  const footer = element("footer", "agent-card-footer");
  const taskTokens = allRuns.reduce((sum, r) => sum + (r.tokens || 0), 0);
  const latestTokens = run.tokens;

  const tokenText = (latestTokens === undefined || latestTokens === null || latestTokens === 0)
    ? "Usage unavailable"
    : `${formatNumber(taskTokens)} token (total) · ${formatNumber(latestTokens)} (this attempt)`;

  const taskTokenText = taskTokens > 0
    ? `${formatNumber(taskTokens)} token toplam - ${run.usageAvailable && latestTokens > 0 ? `${formatNumber(latestTokens)} son deneme` : "son deneme usage unavailable"}`
    : tokenText;

  footer.append(
    element("span", "", taskTokenText),
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
      stateKind: latest.stateKind
    };
  });

  return groupedTasks.filter((task) => {
    const run = task.latest;
    const matchesFilter = state.filter === "all" || task.lanes.some((lane) => lane.latest.stateKind === state.filter);
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
  const { capacity } = state.snapshot;
  const queuedText = capacity.queued ? ` (${capacity.queued} kuyrukta)` : "";
  elements.capacityTotal.textContent = `${capacity.active} / ${capacity.total}${queuedText}`;
  elements.providers.replaceChildren(...capacity.providers.map(providerItem));
}

function renderControlPlane() {
  if (!elements.controlPlane) return;
  const snapshot = state.snapshot;
  const selections = snapshot.config?.selections || {};
  const labels = {
    workSource: "Work source",
    orchestrator: "Orchestrator",
    executor: "Executor",
    codeIntelligence: "Code intelligence"
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
  elements.capabilityCount.textContent = capabilities.length + " capability";
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
  renderControlPlane();
  renderRuns();
  renderActivity();
  if (typeof renderTabs === "function") renderTabs();
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

function renderPmMessages() {
  const container = document.getElementById("pm-messages");
  if (!container || !state.snapshot.pmMessages) return;
  container.innerHTML = "";
  if (state.snapshot.pmMessages.length === 0) {
    container.innerHTML = '<div class="empty-state">Mesaj bulunmuyor</div>';
    return;
  }
  state.snapshot.pmMessages.forEach(msg => {
    const div = element("div", `pm-message ${msg.role}`);
    div.append(
      element("strong", "", msg.role === 'user' ? 'Sen' : 'PM Agent'),
      element("span", "time", formatTime(msg.createdAt)),
      element("p", "", msg.content)
    );
    container.append(div);
  });
}

function renderPmDecisions() {
  const container = document.getElementById("pm-decisions");
  if (!container || !state.snapshot.pmDecisions) return;
  container.innerHTML = "";
  if (state.snapshot.pmDecisions.length === 0) {
    container.innerHTML = '<div class="empty-state">Karar kaydı bulunmuyor</div>';
    return;
  }
  state.snapshot.pmDecisions.forEach(decision => {
    const div = element("div", "pm-decision");
    div.append(
      element("strong", "", decision.type),
      element("span", "time", formatTime(decision.createdAt)),
      element("pre", "", JSON.stringify(decision.payload, null, 2))
    );
    container.append(div);
  });
}

function renderAgentDefinitions() {
  const container = document.getElementById("agent-definitions");
  if (!container || !state.snapshot.agentDefinitions) return;
  container.innerHTML = "";
  if (state.snapshot.agentDefinitions.length === 0) {
    container.innerHTML = '<div class="empty-state">Kayıtlı agent bulunmuyor</div>';
    return;
  }
  state.snapshot.agentDefinitions.forEach(agent => {
    const def = agent.definition || {};
    const div = element("div", "agent-definition");
    div.style.marginBottom = "1rem";
    div.style.padding = "1rem";
    div.style.background = "var(--panel-subtle, rgba(255,255,255,0.03))";
    div.style.borderRadius = "8px";
    div.style.border = "1px solid var(--border-subtle, rgba(255,255,255,0.1))";

    const header = element("div", "agent-header");
    header.style.display = "flex";
    header.style.justifyContent = "space-between";
    header.style.alignItems = "center";
    header.style.marginBottom = "0.5rem";

    const titleBox = element("div");
    titleBox.append(
      element("strong", "", agent.displayName || agent.id),
      element("small", "", ` (${agent.id})`),
      element("span", `badge badge-${agent.status || 'enabled'}`, ` ${agent.status || 'enabled'} `),
      element("span", "badge badge-version", ` v${agent.version} `)
    );

    const actionsBox = element("div", "agent-actions");
    actionsBox.style.display = "flex";
    actionsBox.style.gap = "0.5rem";

    if (agent.status === "enabled") {
      const disableBtn = element("button", "btn-sm", "Devre Dışı Bırak");
      disableBtn.onclick = async () => {
        await fetch(`/api/agents/${encodeURIComponent(agent.id)}/disable`, { method: "POST" });
        refresh();
      };
      const archiveBtn = element("button", "btn-sm", "Arşivle");
      archiveBtn.onclick = async () => {
        await fetch(`/api/agents/${encodeURIComponent(agent.id)}/archive`, { method: "POST" });
        refresh();
      };
      actionsBox.append(disableBtn, archiveBtn);
    } else if (agent.status === "disabled") {
      const enableBtn = element("button", "btn-sm", "Etkinleştir");
      enableBtn.onclick = async () => {
        await fetch(`/api/agents/${encodeURIComponent(agent.id)}/enable`, { method: "POST" });
        refresh();
      };
      const archiveBtn = element("button", "btn-sm", "Arşivle");
      archiveBtn.onclick = async () => {
        await fetch(`/api/agents/${encodeURIComponent(agent.id)}/archive`, { method: "POST" });
        refresh();
      };
      actionsBox.append(enableBtn, archiveBtn);
    } else if (agent.status === "archived") {
      const enableBtn = element("button", "btn-sm", "Tekrar Etkinleştir");
      enableBtn.onclick = async () => {
        await fetch(`/api/agents/${encodeURIComponent(agent.id)}/enable`, { method: "POST" });
        refresh();
      };
      actionsBox.append(enableBtn);
    }

    const versionsBtn = element("button", "btn-sm", "Versiyonlar");
    versionsBtn.onclick = async () => {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent.id)}/versions`);
      const data = await res.json();
      alert(`Agent ${agent.id} Versiyon Geçmişi:\n` + JSON.stringify(data.versions, null, 2));
    };
    actionsBox.append(versionsBtn);

    header.append(titleBox, actionsBox);

    const details = element("div", "agent-details");
    details.style.fontSize = "0.85rem";
    details.style.color = "var(--text-muted, #888)";
    details.innerHTML = `
      <div><strong>Rol:</strong> ${def.role || 'implementation'} | <strong>Default Persona:</strong> ${def.defaultPersona || 'startup-cto'} | <strong>Risk:</strong> ${def.risk || 'normal'}</div>
      <div><strong>Skills:</strong> ${(def.skills || []).join(", ") || "—"}</div>
      <div><strong>Allowed Paths:</strong> ${(def.allowedPaths || []).join(", ") || "[]"}</div>
    `;

    div.append(header, details);
    container.append(div);
  });
}

function renderUsageEvents() {
  const container = document.getElementById("usage-events");
  if (!container || !state.snapshot.usageEvents) return;
  container.innerHTML = "";
  if (state.snapshot.usageEvents.length === 0) {
    container.innerHTML = '<div class="empty-state">Kullanım verisi bulunmuyor</div>';
    return;
  }
  state.snapshot.usageEvents.forEach(event => {
    const div = element("div", "usage-event");
    div.append(
      element("strong", "", `${event.provider} · ${event.model}`),
      element("span", "time", formatTime(event.createdAt)),
      element("p", "", `Run: ${event.runId} | Süre: ${event.durationMs}ms | Token: In ${event.inputTokens} / Out ${event.outputTokens}`)
    );
    container.append(div);
  });
}

function getElem(id) {
  if (typeof document === "undefined") return null;
  if (typeof document.getElementById === "function") return document.getElementById(id);
  if (typeof document.querySelector === "function") return document.querySelector("#" + id);
  return null;
}

// ── PM Workspace Rendering ──────────────────────────────────────────────────

let currentPmFilter = "inbox";

function setupPmSubNav() {
  if (typeof document === "undefined" || typeof document.querySelectorAll !== "function") return;
  const filterButtons = document.querySelectorAll(".pm-filter-btn");
  if (Array.isArray(filterButtons) || (filterButtons && typeof filterButtons.forEach === "function")) {
    filterButtons.forEach(btn => {
      btn.onclick = () => {
        filterButtons.forEach(b => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        currentPmFilter = btn.dataset.pmFilter;

        const inbox = getElem("pm-inbox-section");
        const attention = getElem("pm-attention-section");
        const approvals = getElem("pm-approvals-section");
        const journal = getElem("pm-journal-section");

        if (inbox) inbox.hidden = currentPmFilter !== "inbox";
        if (attention) attention.hidden = currentPmFilter !== "attention";
        if (approvals) approvals.hidden = currentPmFilter !== "approvals";
        if (journal) journal.hidden = currentPmFilter !== "journal";
      };
    });
  }

  const closeBtn = getElem("trace-close-btn");
  const modal = getElem("decision-trace-modal");
  if (closeBtn && modal) {
    closeBtn.onclick = () => { modal.hidden = true; };
    modal.onclick = (e) => {
      if (e.target === modal) modal.hidden = true;
    };
  }
}

function renderPmWorkspace() {
  const ws = state.snapshot.pmWorkspace;
  if (!ws) return;

  const counts = ws.counts || {};
  const groups = ws.groups || {};

  // Summary counts
  const elApprovals = getElem("pm-stat-approvals");
  const elBlocked = getElem("pm-stat-blocked");
  const elExecuting = getElem("pm-stat-executing");
  const elReview = getElem("pm-stat-review");
  const elRework = getElem("pm-stat-rework");
  const elReady = getElem("pm-stat-ready");
  const elHumanApproval = getElem("pm-stat-human-approval");
  const badgeAttention = getElem("pm-badge-attention");
  const badgeApprovals = getElem("pm-badge-approvals");

  if (elApprovals) elApprovals.textContent = counts.awaitingApproval || 0;
  if (elBlocked) elBlocked.textContent = counts.blocked || 0;
  if (elExecuting) elExecuting.textContent = counts.executing || 0;
  if (elReview) elReview.textContent = counts.inReview || 0;
  if (elRework) elRework.textContent = counts.needsRework || 0;
  if (elReady) elReady.textContent = counts.ready || 0;
  if (elHumanApproval) elHumanApproval.textContent = counts.humanApproval || 0;
  if (badgeAttention) badgeAttention.textContent = counts.needsAttention || 0;
  if (badgeApprovals) badgeApprovals.textContent = counts.awaitingApproval || 0;

  renderPmInbox(groups);
  renderPmApprovals(groups.awaitingApproval || []);
  renderPmAttention([...(groups.blocked || []), ...(groups.needsRework || []), ...(groups.awaitingApproval || [])]);
}

function renderPmCard(item) {
  const card = element("div", "pm-card");

  const top = element("div", "pm-card-top");
  const keySpan = element("span", "pm-card-key", item.issueKey);
  const statePillNode = element("span", `state-pill ${item.currentRunState ? (item.currentRunState.includes("review") ? "review" : (item.currentRunState.includes("failed") || item.currentRunState.includes("blocked") ? "blocked" : "active")) : "idle"}`, item.currentRunState || "ready");
  top.append(keySpan, statePillNode);

  const title = element("h4", "pm-card-summary", item.summary);

  const metaTags = element("div", "pm-meta-tags");
  metaTags.append(
    element("span", "meta-tag persona-tag", `🎭 ${item.persona || 'unassigned'}`),
    element("span", "meta-tag", `🤖 ${item.taskAgent || 'unassigned'} ${item.agentVersion != null ? `v${item.agentVersion}` : '(version unknown)'}`),
    element("span", "meta-tag", `⚡ ${item.executorProvider}${item.executorModel ? ` (${item.executorModel})` : ''}`),
    element("span", `meta-tag ${item.risk === 'high' ? 'risk-tag-high' : ''}`, `Risk: ${item.risk}`)
  );

  if (!item.agentUpToDate && item.agentLiveVersion) {
    metaTags.append(element("span", "meta-tag version-diff-tag", `⚠️ Live: v${item.agentLiveVersion} (${item.agentLiveStatus})`));
  }

  card.append(top, title, metaTags);

  if (item.operationalGroup === "awaitingApproval" || item.approvalReason) {
    const notice = element("div", "pm-card-notice notice-approval");
    notice.innerHTML = `<span>⏳ <strong>Onay Gerekli:</strong> ${item.approvalReason || 'İşlem PM onayı bekliyor.'}</span>`;
    card.append(notice);
  } else if (item.operationalGroup === "blocked" || item.blockedReason) {
    const notice = element("div", "pm-card-notice notice-blocked");
    notice.innerHTML = `<span>🛑 <strong>Bloke:</strong> ${item.blockedReason || item.currentRunState}</span>`;
    card.append(notice);
  } else if (item.operationalGroup === "humanApproval") {
    const notice = element("div", "pm-card-notice notice-human-approval");
    notice.innerHTML = `<span>✅ <strong>İnsan Onayı:</strong> Review tamamlandı. Final merge / Done bekleniyor.</span>`;
    card.append(notice);
  }

  const actions = element("div", "pm-card-actions");
  const traceBtn = element("button", "btn-trace", "🔍 Decision Trace / Detay");
  traceBtn.onclick = () => openDecisionTrace(item.issueKey);
  actions.append(traceBtn);

  card.append(actions);
  return card;
}

function renderPmInbox(groups) {
  const container = getElem("pm-queue-container");
  if (!container) return;
  container.innerHTML = "";

  const sectionDefs = [
    { key: "awaitingApproval", title: "⏳ Onay Bekleyenler (Awaiting Approval)", color: "#fbbf24" },
    { key: "blocked", title: "🛑 Bloke & İlgi Gerekenler (Blocked / Attention)", color: "#f87171" },
    { key: "executing", title: "⚡ Yürütülen İşler (Executing)", color: "#38bdf8" },
    { key: "inReview", title: "👁 Review Aşamasındakiler (In Review)", color: "#a78bfa" },
    { key: "needsRework", title: "🔄 Rework Bekleyenler (Needs Rework)", color: "#fb923c" },
    { key: "ready", title: "🚀 Başlamaya Hazır (Agent Ready)", color: "#4ade80" },
    { key: "humanApproval", title: "🏁 İnsan Onay Kapısı (Human Approval / Done)", color: "#22c55e" },
    { key: "needsPlanning", title: "📋 Planlama Bekleyenler (Needs Planning)", color: "#94a3b8" }
  ];

  let totalRendered = 0;
  sectionDefs.forEach(def => {
    const items = groups[def.key] || [];
    if (items.length === 0 && def.key !== "executing" && def.key !== "awaitingApproval" && def.key !== "blocked") return;

    const groupDiv = element("div", "pm-group-section");
    const groupHeader = element("div", "pm-group-header");
    const titleNode = element("div", "pm-group-title");
    titleNode.innerHTML = `<span style="color: ${def.color}">●</span> <strong>${def.title}</strong> <span class="badge-count" style="background: rgba(255,255,255,0.1); color:#fff;">${items.length}</span>`;
    groupHeader.append(titleNode);
    groupDiv.append(groupHeader);

    if (items.length === 0) {
      groupDiv.append(element("div", "empty-state", "Bu grupta bekleyen iş paketi yok"));
    } else {
      const grid = element("div", "pm-cards-grid");
      items.forEach(item => grid.append(renderPmCard(item)));
      groupDiv.append(grid);
    }

    container.append(groupDiv);
    totalRendered += items.length;
  });

  if (totalRendered === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Kuyrukta iş paketi bulunmuyor</h3><p>Yeni bir issue planlayın veya dispatch edin.</p></div>';
  }
}

function renderPmApprovals(items) {
  const container = getElem("pm-approvals-list");
  if (!container) return;
  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Bekleyen onay talebi bulunmuyor</h3><p>Tüm otonom veya onaylı süreçler yürütülüyor.</p></div>';
    return;
  }

  items.forEach(item => {
    const card = element("div", "approval-card");

    const header = element("div", "approval-header");
    const title = element("h4", "approval-title", `[${item.issueKey}] ${item.summary}`);
    const badge = element("span", "state-pill blocked", `Aksiyon: ${item.action || 'implementation'}`);
    header.append(title, badge);

    const details = element("div", "approval-details-grid");
    details.innerHTML = `
      <div><strong>Task Agent:</strong> ${item.taskAgent || 'unassigned'} ${item.agentVersion != null ? `(v${item.agentVersion})` : '(version unknown)'}</div>
      <div><strong>Orkestratör Persona:</strong> ${item.persona || 'unassigned'}</div>
      <div><strong>Executor:</strong> ${item.executorProvider} (${item.executorModel || 'default'})</div>
      <div><strong>Risk Seviyesi:</strong> ${item.risk}</div>
      <div><strong>İzinli Yollar:</strong> ${(item.allowedPaths || []).join(", ") || "[]"}</div>
      <div><strong>Deneme:</strong> ${item.reworkAttempt + 1}</div>
    `;

    const fpBox = element("div", "approval-fingerprint-box");
    fpBox.innerHTML = `<span><strong>Plan Parmak İzi:</strong> ${item.planFingerprint || '—'}</span>`;

    const actionBar = element("div", "approval-action-bar");
    const approveBtn = element("button", "btn-approve", "✓ Onayla (Approve)");
    approveBtn.onclick = async () => {
      try {
        const res = await fetch(`/api/pm/work-items/${encodeURIComponent(item.issueKey)}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: item.action || "implementation",
            planFingerprint: item.planFingerprint,
            attempt: item.reworkAttempt || 0,
            approver: "PM Operator",
            reason: "Approved from PM Approvals workspace"
          })
        });
        if (res.status === 409) {
          const data = await res.json();
          alert(`⚠️ Plan Parmak İzi Uyuşmazlığı (409 Conflict):\nPlan güncellendiği için eski durum onaylanamaz. Sayfa yenileniyor.\nBeklenen: ${data.expected}`);
          refresh();
          return;
        }
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Onay başarısız");
        }
        refresh();
      } catch (err) {
        alert("Hata: " + err.message);
      }
    };

    const rejectBtn = element("button", "btn-reject", "✕ Reddet (Reject)");
    rejectBtn.onclick = async () => {
      const reason = prompt("Reddetme gerekçesi girin (opsiyonel):", "Scope/Risk uygun görülmedi");
      if (reason === null) return;
      try {
        const res = await fetch(`/api/pm/work-items/${encodeURIComponent(item.issueKey)}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: item.action || "implementation",
            planFingerprint: item.planFingerprint,
            attempt: item.reworkAttempt || 0,
            approver: "PM Operator",
            reason: reason || "Rejected from PM Approvals workspace"
          })
        });
        if (res.status === 409) {
          alert("⚠️ Plan Parmak İzi Uyuşmazlığı (409 Conflict): Plan değişti; lütfen sayfayı yenileyin.");
          refresh();
          return;
        }
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Reddetme başarısız");
        }
        refresh();
      } catch (err) {
        alert("Hata: " + err.message);
      }
    };

    const traceBtn = element("button", "btn-trace", "Detay / Trace");
    traceBtn.onclick = () => openDecisionTrace(item.issueKey);

    actionBar.append(traceBtn, rejectBtn, approveBtn);
    card.append(header, details, fpBox, actionBar);
    container.append(card);
  });
}

function renderPmAttention(items) {
  const container = getElem("pm-attention-list");
  if (!container) return;
  container.innerHTML = "";

  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>Müdahale gereken durum bulunmuyor</h3><p>Tüm akışlar normal parametrelerde çalışıyor.</p></div>';
    return;
  }

  const grid = element("div", "pm-cards-grid");
  items.forEach(item => grid.append(renderPmCard(item)));
  container.append(grid);
}

async function openDecisionTrace(issueKey) {
  const modal = getElem("decision-trace-modal");
  const body = getElem("trace-drawer-body");
  const titlePill = getElem("trace-issue-pill");
  const summaryText = getElem("trace-issue-summary");

  if (!modal || !body) return;
  modal.hidden = false;
  body.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';

  try {
    const res = await fetch(`/api/pm/work-items/${encodeURIComponent(issueKey)}`);
    if (!res.ok) throw new Error(`Work item '${issueKey}' yüklenemedi`);
    const detail = await res.json();

    const wi = detail.workItem || {};
    const orch = detail.orchestratorDecision || {};
    const ag = detail.agentIdentity || {};
    const exec = detail.execution || {};
    const rev = detail.review || {};
    const human = detail.humanControl || {};
    const blocked = detail.blockedInfo || {};
    const history = detail.history || [];

    if (titlePill) titlePill.textContent = wi.key;
    if (summaryText) summaryText.textContent = wi.summary;

    body.innerHTML = "";

    // 1. Orchestrator Decision Section
    const orchSection = element("div", "trace-section");
    orchSection.innerHTML = `
      <h4>🎯 Orkestratör Karar İzi (Decision Trace)</h4>
      <div class="trace-grid-two">
        <div class="trace-info-cell"><span>Orkestratör Provider</span><strong>${orch.orchestratorProvider || 'builtin'}</strong></div>
        <div class="trace-info-cell"><span>Atanan Persona</span><strong>${orch.persona}</strong></div>
        <div class="trace-info-cell"><span>Atanan Task Agent</span><strong>${orch.taskAgent}</strong></div>
        <div class="trace-info-cell"><span>Risk Seviyesi & Paralel</span><strong>Risk: ${orch.risk} | Paralel: ${orch.parallelSafe ? 'Evet' : 'Hayır'}</strong></div>
      </div>
      <div class="trace-info-cell" style="margin-top: 8px;">
        <span>İzinli Dosya Yolları (Allowed Paths)</span>
        <strong>${(orch.allowedPaths || []).join(", ") || "[]"}</strong>
      </div>
      <div class="trace-info-cell" style="margin-top: 8px;">
        <span>Seçim Gerekçesi (Rationale)</span>
        <p style="margin: 4px 0 0; color: #cbd5e1; font-size: 0.78rem;">${(orch.rationale || []).join(" ; ") || "Kanonik orkestrasyon kuralları uygulandı."}</p>
      </div>
      <div class="trace-info-cell" style="margin-top: 8px; font-family: var(--font-code); font-size: 0.72rem; word-break: break-all;">
        <span>Plan Parmak İzi (Fingerprint)</span>
        <strong style="color: #94a3b8;">${orch.planFingerprint || '—'}</strong>
      </div>
    `;
    body.append(orchSection);

    // 2. Agent Identity Context Section (Pinned vs Live Registry)
    const agentSection = element("div", "trace-section");
    const isVersionDiff = ag.liveRegistryVersion && ag.agentVersion && ag.agentVersion !== ag.liveRegistryVersion;
    agentSection.innerHTML = `
      <h4>🤖 Agent Registry Kimliği</h4>
      <div class="trace-grid-two">
        <div class="trace-info-cell"><span>Tarihsel Run Snaphot</span><strong>${ag.agentId || 'unassigned'} ${ag.agentVersion != null ? `v${ag.agentVersion}` : '(version unknown)'}</strong><small style="color:var(--muted); font-family:var(--font-code); font-size:0.65rem;">Hash: ${(ag.agentHash || '—').substring(0, 16)}...</small></div>
        <div class="trace-info-cell"><span>Canlı Registry Durumu</span><strong style="color: ${ag.liveRegistryStatus === 'enabled' ? '#4ade80' : '#f87171'};">${ag.liveRegistryStatus?.toUpperCase()} (v${ag.liveRegistryVersion || '—'})</strong><small style="color:var(--muted); font-family:var(--font-code); font-size:0.65rem;">Hash: ${(ag.liveRegistryHash || '—').substring(0, 16)}...</small></div>
      </div>
      ${isVersionDiff ? `<div class="pm-card-notice notice-approval" style="margin-top: 8px;"><span>⚠️ Bu run <strong>v${ag.agentVersion}</strong> tanımıyla kilitlenmiştir. Canlı registry'deki <strong>v${ag.liveRegistryVersion}</strong> güncellemesi tarihsel snapshot'ı değiştirmez.</span></div>` : ''}
    `;
    body.append(agentSection);

    // 3. Execution & Runtime Section
    const execSection = element("div", "trace-section");
    execSection.innerHTML = `
      <h4>⚡ Yürütme & Model Bilgisi</h4>
      <div class="trace-grid-two">
        <div class="trace-info-cell"><span>Executor / Model</span><strong>${exec.provider} · ${exec.model || 'default'} (${exec.modelProfile || 'normal'})</strong></div>
        <div class="trace-info-cell"><span>Mevcut Durum</span><strong>${exec.currentRunState} (Deneme ${exec.attempt}/${exec.maxAttempts})</strong></div>
        <div class="trace-info-cell"><span>Kullanılan Token / Süre</span><strong>${exec.tokens} token | ${exec.durationSeconds} sn</strong></div>
        <div class="trace-info-cell"><span>Git Branch & Commit</span><strong>${exec.branch || 'main'} ${exec.commit ? `(${exec.commit.substring(0, 7)})` : ''}</strong></div>
      </div>
    `;
    body.append(execSection);

    // 4. Structured Review Findings Section (Lossless display per attempt)
    const reviewSection = element("div", "trace-section");
    const cycles = rev.reviewCycles || [];
    let findingsHtml = "";

    if (cycles.length === 0) {
      findingsHtml = `<p style="color: var(--muted); font-size: 0.8rem; margin: 4px 0;">Henüz review aşamasına geçilmedi veya kayıtlı bulgu yok.</p>`;
    } else {
      cycles.forEach((c) => {
        const verdictBadge = c.verdict === "clean"
          ? `<span class="sev-badge" style="background: rgba(34,197,94,0.2); color:#4ade80; border:1px solid rgba(34,197,94,0.4);">✓ CLEAN</span>`
          : `<span class="sev-badge" style="background: rgba(239,68,68,0.2); color:#f87171; border:1px solid rgba(239,68,68,0.4);">✕ CHANGES REQUESTED</span>`;

        let tableRows = "";
        if (c.findings.length === 0) {
          tableRows = `<tr><td colspan="5" style="color: var(--muted); text-align: center;">Bulgu tespit edilmedi (Temiz review)</td></tr>`;
        } else {
          c.findings.forEach(f => {
            tableRows += `
              <tr>
                <td><span class="sev-badge sev-${f.severity}">${f.severity}</span></td>
                <td><code style="font-size:0.72rem; color:#a5f3fc;">${f.category}</code></td>
                <td><code style="font-size:0.72rem;">${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '—'}</code></td>
                <td><strong style="color:#f1f5f9;">${f.problem}</strong>${f.expected ? `<br><small style="color:var(--muted);">Beklenen: ${f.expected}</small>` : ''}</td>
                <td><small style="color:#94a3b8;">${f.verification || '—'}</small></td>
              </tr>
            `;
          });
        }

        findingsHtml += `
          <div style="background: rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.06); border-radius:8px; padding:12px; margin-top:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
              <div><strong>Review Döngüsü #${c.attempt}</strong> · <small style="color:var(--muted);">${formatTime(c.reviewedAt, true)}</small> · <small style="color:#38bdf8;">Reviewer: ${c.reviewerId}</small></div>
              ${verdictBadge}
            </div>
            <table class="findings-table">
              <thead>
                <tr><th>Önem</th><th>Kategori</th><th>Dosya / Satır</th><th>Problem & Beklenti</th><th>Doğrulama</th></tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>
        `;
      });
    }

    reviewSection.innerHTML = `
      <h4>🔍 Review Bulguları & Yaşam Döngüsü (Lossless Trace)</h4>
      ${findingsHtml}
    `;
    body.append(reviewSection);

    // 5. Human Control & Approvals Section
    const humanSection = element("div", "trace-section");
    const approvalState = human.approvalState;
    humanSection.innerHTML = `
      <h4>🛡 İnsan Kontrolü & Onay Durumu</h4>
      <div class="trace-grid-two">
        <div class="trace-info-cell"><span>İşletim Modu</span><strong>${human.operatingMode?.toUpperCase()}</strong></div>
        <div class="trace-info-cell"><span>Onay Durumu</span><strong>${approvalState?.toUpperCase()}</strong></div>
      </div>
      ${human.humanActionRequired ? `
        <div class="pm-card-notice notice-approval" style="margin-top: 8px;">
          <span>⏳ <strong>Aksiyon Bekleniyor:</strong> ${human.currentRequiredHumanAction || 'PM onayı veya insan incelemesi gerekiyor.'}</span>
        </div>
      ` : ''}
    `;
    body.append(humanSection);

    // 6. Chronological Audit Timeline Section
    const timelineSection = element("div", "trace-section");
    let timelineHtml = "";
    if (history.length === 0) {
      timelineHtml = '<p style="color: var(--muted); font-size: 0.8rem;">Henüz olay kaydı bulunmuyor.</p>';
    } else {
      history.forEach(item => {
        const actor = item.actor || { type: "runtime", id: "system" };
        timelineHtml += `
          <div class="timeline-item">
            <div class="timeline-top">
              <span class="actor-badge actor-${actor.type}">${actor.type}: ${actor.id}</span>
              <span class="timeline-time">${formatTime(item.timestamp, true)}</span>
            </div>
            <div style="color: #f1f5f9; font-weight: 500;">${item.label}</div>
          </div>
        `;
      });
    }

    timelineSection.innerHTML = `
      <h4>📜 Denetim & Karar Zaman Çizelgesi (Audit Timeline)</h4>
      <div class="timeline-list">${timelineHtml}</div>
    `;
    body.append(timelineSection);

  } catch (err) {
    body.innerHTML = `<div class="error-banner">Hata: ${err.message}</div>`;
  }
}

let currentObsWindow = "24h";

async function renderObservability() {
  const liveGrid = document.querySelector("#obs-live-grid");
  const providersGrid = document.querySelector("#obs-providers-grid");
  const runsTableBody = document.querySelector("#obs-runs-table-body");
  if (!liveGrid || !providersGrid || !runsTableBody) return;

  try {
    const res = await fetch(`/api/observability/summary?window=${currentObsWindow}`);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;

    // 1. Live & Queued
    const liveRuns = (data.runs || []).filter(r => ["queued", "started", "model_selected", "progress", "executing", "verifying"].includes(r.state));
    if (liveRuns.length === 0) {
      liveGrid.innerHTML = `<div style="color: var(--muted); font-size: 0.8rem; grid-column: 1/-1;">Şu anda aktif çalışan veya kuyrukta bekleyen işlem yok.</div>`;
    } else {
      liveGrid.innerHTML = liveRuns.map(r => `
        <div class="provider-health-card">
          <div class="ph-top">
            <span class="badge badge-key">${r.issueKey}</span>
            <span class="badge status-${r.state}">${STATUS_LABELS[r.state] || r.state}</span>
          </div>
          <div class="ph-stats-grid">
            <div class="ph-stat-cell"><span>Rol / Agent</span><strong>${r.taskAgent}</strong></div>
            <div class="ph-stat-cell"><span>Provider / Model</span><strong>${r.provider} / ${r.model || '—'}</strong></div>
            <div class="ph-stat-cell"><span>Süre</span><strong>${r.durationSeconds}s</strong></div>
            <div class="ph-stat-cell"><span>Token</span><strong>${r.usage?.available ? (r.usage.totalTokens || '—') : '—'}</strong></div>
          </div>
          <button class="pm-btn pm-btn-view" style="width: 100%; margin-top: 4px;" onclick="openTelemetryDetail('${r.runId}')">Detay ve Timeline</button>
        </div>
      `).join("");
    }

    // 2. Providers
    const providers = data.providers || [];
    if (providers.length === 0) {
      providersGrid.innerHTML = `<div style="color: var(--muted); font-size: 0.8rem; grid-column: 1/-1;">Kayıtlı provider bulunamadı.</div>`;
    } else {
      providersGrid.innerHTML = providers.map(p => `
        <div class="provider-health-card">
          <div class="ph-top">
            <span class="ph-provider-name">${p.provider.toUpperCase()}</span>
            <span class="ph-status-badge status-${p.status}">${p.status.toUpperCase()}</span>
          </div>
          <div class="ph-stats-grid">
            <div class="ph-stat-cell"><span>Başarı Oranı</span><strong>${p.successRate !== null ? Math.round(p.successRate * 100) + '%' : '—'}</strong></div>
            <div class="ph-stat-cell"><span>Ort. Süre</span><strong>${p.averageDurationMs ? Math.round(p.averageDurationMs / 1000) + 's' : '—'}</strong></div>
            <div class="ph-stat-cell"><span>Son Başarılar</span><strong>${p.recentSuccesses}</strong></div>
            <div class="ph-stat-cell"><span>Son Hatalar</span><strong>${p.recentFailures}</strong></div>
          </div>
          ${p.cooldownUntil ? `<div style="color: #fb923c; font-size: 0.72rem; margin-top: 4px;">⏳ Cooldown: ${formatTime(p.cooldownUntil, true)}</div>` : ''}
        </div>
      `).join("");
    }

    // 3. Recent Runs Table
    const runs = data.runs || [];
    if (runs.length === 0) {
      runsTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--muted); padding: 24px;">Bu zaman aralığında kaydedilmiş run bulunmuyor.</td></tr>`;
    } else {
      runsTableBody.innerHTML = runs.map(r => `
        <tr>
          <td><span class="badge badge-key">${r.issueKey}</span></td>
          <td><strong>${r.taskAgent}</strong> <small style="color: var(--muted); display: block;">${r.role}</small></td>
          <td>${r.provider} <small style="color: var(--muted); display: block;">${r.model || '—'}</small></td>
          <td><span class="badge status-${r.state}">${STATUS_LABELS[r.state] || r.state}</span></td>
          <td>${r.durationSeconds}s</td>
          <td>${r.usage?.available ? `<strong>${r.usage.totalTokens || 0}</strong> tok` : '<span style="color: var(--muted);">—</span>'}</td>
          <td>${formatTime(r.createdAt, true)}</td>
          <td><button class="pm-btn pm-btn-view" onclick="openTelemetryDetail('${r.runId}')">Timeline</button></td>
        </tr>
      `).join("");
    }

  } catch (err) {
    console.error("renderObservability error:", err);
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

    pill.textContent = data.identity.issueKey;
    title.textContent = `Run Telemetry: ${data.identity.issueKey}`;
    summary.textContent = `Rol: ${data.identity.role} · Agent: ${data.agent.taskAgent} · Provider: ${data.execution.provider} (${data.execution.model || 'default'})`;

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
            <span class="actor-badge actor-runtime">${ev.stage}</span>
            <span class="timeline-time">${formatTime(ev.timestamp, true)}</span>
          </div>
          <div style="color: #f1f5f9; font-weight: 500;">
            ${ev.status.toUpperCase()} ${ev.model ? `· model: ${ev.model}` : ''}
            ${ev.usage ? `· ${ev.usage.totalTokens || 0} tokens` : ''}
          </div>
          ${ev.error ? `<div style="color: #f87171; font-size: 0.75rem; margin-top: 2px;">⚠️ ${ev.error.safeMessage || ev.error.category}</div>` : ''}
        </div>
      `).join("");
    }

    body.innerHTML = `
      <div class="trace-section">
        <h4>⚡ Yürütme ve Süre Bilgileri</h4>
        <div class="trace-grid-two">
          <div class="trace-info-cell"><span>Kuyruk Bekleme</span><strong>${timings.queueWaitMs !== null ? timings.queueWaitMs + 'ms' : '—'}</strong></div>
          <div class="trace-info-cell"><span>Yürütme Süresi</span><strong>${timings.executionDurationMs !== null ? timings.executionDurationMs + 'ms' : '—'}</strong></div>
          <div class="trace-info-cell"><span>Uçtan Uca Süre</span><strong>${timings.endToEndDurationMs !== null ? timings.endToEndDurationMs + 'ms' : '—'}</strong></div>
          <div class="trace-info-cell"><span>Deneme / Attempt</span><strong>${timings.attempt + 1} / ${timings.totalAttempts}</strong></div>
        </div>
      </div>

      <div class="trace-section">
        <h4>◇ Normalized Token Usage Ledger</h4>
        <div class="trace-grid-two">
          <div class="trace-info-cell"><span>Girdi Token</span><strong>${usage.inputTokens !== null ? usage.inputTokens : '—'}</strong></div>
          <div class="trace-info-cell"><span>Çıktı Token</span><strong>${usage.outputTokens !== null ? usage.outputTokens : '—'}</strong></div>
          <div class="trace-info-cell"><span>Cached Girdi</span><strong>${usage.cachedInputTokens !== null ? usage.cachedInputTokens : '—'}</strong></div>
          <div class="trace-info-cell"><span>Toplam Token</span><strong>${usage.totalTokens !== null ? usage.totalTokens : '—'}</strong></div>
        </div>
        ${data.cost ? `
          <div style="margin-top: 8px; font-size: 0.8rem; color: #4ade80;">
            💰 <strong>Hesaplanan Maliyet:</strong> ${data.cost.amount} ${data.cost.currency} (v${data.cost.pricingVersion})
          </div>
        ` : ''}
      </div>

      <div class="trace-section">
        <h4>📜 Telemetri Olay Çizelgesi (Ordered Lifecycle Events)</h4>
        <div class="timeline-list">${eventsHtml}</div>
      </div>
    `;

  } catch (err) {
    body.innerHTML = `<div class="error-banner">Hata: ${err.message}</div>`;
  }
}

const telemCloseBtn = document.querySelector("#telem-close-btn");
if (telemCloseBtn) {
  telemCloseBtn.addEventListener("click", () => {
    const modal = document.querySelector("#telemetry-drawer-modal");
    if (modal) modal.hidden = true;
  });
}

document.querySelectorAll(".window-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".window-btn").forEach(b => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    currentObsWindow = btn.dataset.window || "24h";
    renderObservability();
  });
});

function renderTabs() {
  renderPmMessages();
  renderPmDecisions();
  renderPmWorkspace();
  renderObservability();
  renderAgentDefinitions();
  renderUsageEvents();
}

setupPmSubNav();

document.querySelectorAll('.tab-button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('is-active'));
    document.querySelectorAll('.tab-content').forEach(c => c.hidden = true);
    
    button.classList.add('is-active');
    const target = document.getElementById(button.dataset.target);
    if (target) {
      target.classList.add('is-active');
      target.hidden = false;
    }
  });
});

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 2500);
