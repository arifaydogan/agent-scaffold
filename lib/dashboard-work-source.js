const PARENT_TYPES = new Set(["epic", "epik"]);

function sourceInfo(item = {}) {
  const source = item.source || {};
  return {
    sourceProvider: source.provider || item.provider || item.sourceProvider || "work-source",
    sourceId: source.id || item.providerKey || item.key || item.id,
    sourceUrl: source.url || item.url || item.sourceUrl || null
  };
}

export function normalizeDashboardCatalogItem(item = {}) {
  const key = String(item.key || item.id || "").trim();
  if (!key) throw new Error("Work-source item is missing a key");
  return {
    key,
    summary: String(item.summary || item.title || key),
    description: String(item.description || item.body || ""),
    issueType: String(item.issueType || item.type || "Issue"),
    status: String(item.status || item.state || "Unknown"),
    canonicalState: String(item.canonicalState || "unknown"),
    labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
    components: Array.isArray(item.components)
      ? item.components.map(component => String(component?.name || component)).filter(Boolean)
      : [],
    parentKey: item.parentKey ? String(item.parentKey) : null,
    assignee: item.assignee ? String(item.assignee) : null,
    ...sourceInfo(item)
  };
}

export function isDashboardParentItem(item = {}) {
  return PARENT_TYPES.has(String(item.issueType || item.type || "").trim().toLowerCase());
}

export async function loadDashboardWorkSourceCatalog(settings, workSource, options = {}) {
  if (!workSource || typeof workSource.listWorkItems !== "function") {
    throw new Error("Configured work-source does not support catalog listing");
  }
  const limit = Math.max(1, Math.min(Number(options.limit) || 5_000, 5_000));
  const rawItems = await workSource.listWorkItems({
    projectKey: settings.projectKey,
    limit,
    includeDescription: false
  });
  const items = (rawItems || []).map(normalizeDashboardCatalogItem);
  return {
    provider: workSource.name || settings.data?.workSource?.defaultProvider || "work-source",
    items,
    parents: items.filter(isDashboardParentItem),
    syncedAt: new Date().toISOString()
  };
}

function catalogOperationalGroup(canonicalState) {
  const state = String(canonicalState || "").toLowerCase();
  if (["ready"].includes(state)) return "ready";
  if (["in_progress", "executing"].includes(state)) return "executing";
  if (state === "review") return "inReview";
  if (state === "rework") return "needsRework";
  if (state === "blocked") return "blocked";
  if (state === "human_approval") return "humanApproval";
  return "needsPlanning";
}

export function buildDashboardWorkItemDetail(item, settings) {
  const workItem = normalizeDashboardCatalogItem(item);
  const operationalGroup = catalogOperationalGroup(workItem.canonicalState);
  return {
    ok: true,
    providerOnly: true,
    workItem: {
      ...workItem,
      operationalGroup,
      autonomousEligible: false
    },
    orchestratorDecision: {
      orchestratorProvider: "unassigned",
      persona: "unassigned",
      taskAgent: "unassigned",
      skills: [],
      capabilities: [],
      risk: "unknown",
      parallelSafe: true,
      dependencies: [],
      allowedPaths: [],
      rationale: ["Work item is visible from the connected work source; no local plan has been created yet."],
      stableMetadata: {},
      planFingerprint: null
    },
    agentIdentity: {
      agentId: null,
      agentVersion: null,
      agentHash: null,
      liveRegistryStatus: "unassigned",
      liveRegistryVersion: null,
      liveRegistryHash: null,
      isPinnedVersionCurrent: true
    },
    execution: {
      provider: "unassigned",
      model: null,
      modelProfile: null,
      effort: null,
      currentRunState: "not_started",
      attempt: 0,
      maxAttempts: Number(settings.data?.policy?.maxAttempts || 3),
      workerPid: null,
      workerStatus: "not_started",
      tokens: null,
      durationSeconds: null,
      branch: null,
      worktree: null,
      commit: null
    },
    review: {
      reviewerTaskAgent: null,
      reviewAgentVersion: null,
      reviewAgentHash: null,
      reviewProvider: null,
      reviewModel: null,
      reviewModelProfile: null,
      verdict: null,
      latestImplementationSha: null,
      structuredFindings: [],
      reviewCycles: []
    },
    humanControl: {
      currentRequiredHumanAction: null,
      humanActionRequired: false,
      operatingMode: settings.data?.project?.operatingMode || settings.data?.policy?.operatingMode || "AUTONOMOUS",
      pendingAction: "planning",
      planFingerprint: null,
      approvalState: "not_required",
      approvalHistory: []
    },
    blockedInfo: {
      isBlocked: operationalGroup === "blocked",
      reason: operationalGroup === "blocked" ? workItem.status : null,
      originatingAction: "planning",
      taskAgent: "unassigned",
      reviewer: null,
      attempt: 0,
      lastSuccessfulStage: "work_source_sync",
      canRetry: false,
      canApprove: false
    },
    history: [{
      id: `source-${workItem.key}`,
      timestamp: new Date().toISOString(),
      stage: "work_source_sync",
      label: `Loaded from ${workItem.sourceProvider}`,
      actor: { type: "work-source", id: workItem.sourceProvider },
      details: { status: workItem.status, issueType: workItem.issueType, parentKey: workItem.parentKey }
    }]
  };
}

export async function buildDashboardParentDetail(parentItem, workSource) {
  const parent = normalizeDashboardCatalogItem(parentItem);
  const rawChildren = typeof workSource?.getChildren === "function"
    ? await workSource.getChildren(parent.key)
    : [];
  const children = (rawChildren || []).map(normalizeDashboardCatalogItem).map(child => ({
    issueKey: child.key,
    summary: child.summary,
    parentKey: parent.key,
    dependencies: [],
    dependencyState: "unknown",
    runtimeState: child.status,
    orchestrationState: "not_started",
    branch: null,
    worktree: null,
    childBaseSha: null,
    reviewedSha: null,
    integrationState: "not_queued",
    integratedSha: null,
    blockedReasons: [],
    canonicalState: child.canonicalState,
    sourceUrl: child.sourceUrl
  }));
  return {
    parent: {
      parentKey: parent.key,
      key: parent.key,
      summary: parent.summary,
      description: parent.description,
      status: parent.status,
      issueType: parent.issueType,
      sourceProvider: parent.sourceProvider,
      sourceUrl: parent.sourceUrl
    },
    state: parent.canonicalState || "unknown",
    readOnly: true,
    providerOnly: true,
    baseRef: null,
    baseSha: null,
    integrationBranch: null,
    integrationHeadSha: null,
    graphFingerprint: null,
    children,
    blockedReasons: [],
    waitingHuman: false,
    integrationReview: null
  };
}
