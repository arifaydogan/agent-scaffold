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
    const div = element("div", "agent-definition");
    div.append(
      element("strong", "", agent.id),
      element("span", "version", `v${agent.version}`),
      element("pre", "", JSON.stringify(agent.definition, null, 2))
    );
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

function renderTabs() {
  renderPmMessages();
  renderPmDecisions();
  renderAgentDefinitions();
  renderUsageEvents();
}

document.querySelectorAll('.tab-button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('is-active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('is-active'));
    document.querySelectorAll('.tab-content').forEach(c => c.hidden = true);
    
    button.classList.add('is-active');
    const target = document.getElementById(button.dataset.target);
    target.classList.add('is-active');
    target.hidden = false;
  });
});

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 2500);
