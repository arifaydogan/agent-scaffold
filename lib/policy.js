import crypto from "node:crypto";

const acceptancePattern =
  /(acceptance criteria|kabul kriter|definition of done|\[ \])/i;

export const OPERATING_MODES = Object.freeze(["manual", "supervised", "autonomous"]);

export const HUMAN_ONLY_ACTIONS = Object.freeze([
  "finalMerge",
  "markDone",
  "productionDeploy",
  "deployment",
  "destructiveMigration",
  "secretMutation",
  "credentialChanges"
]);

export const SUPPORTED_AUTONOMY_ACTIONS = Object.freeze([
  "discovery",
  "planning",
  "routing",
  "agentSelection",
  "implementation",
  "review",
  "rework",
  "createBranch",
  "branchCreation",
  "integrateChildren",
  "childIntegration",
  "createPullRequest",
  "prCreation",
  "finalMerge",
  "markDone",
  "productionDeploy",
  "deployment",
  "destructiveMigration",
  "secretMutation",
  "credentialChanges"
]);

export const DEFAULT_MODE_AUTONOMY = Object.freeze({
  manual: {
    discovery: "auto",
    planning: "auto",
    routing: "auto",
    agentSelection: "auto",
    implementation: "approval",
    review: "approval",
    rework: "approval",
    createBranch: "approval",
    branchCreation: "approval",
    integrateChildren: "approval",
    childIntegration: "approval",
    createPullRequest: "approval",
    prCreation: "approval",
    finalMerge: "human",
    markDone: "human",
    productionDeploy: "human",
    deployment: "human",
    destructiveMigration: "human",
    secretMutation: "human",
    credentialChanges: "human"
  },
  supervised: {
    discovery: "auto",
    planning: "auto",
    routing: "auto",
    agentSelection: "auto",
    implementation: "approval",
    review: "auto",
    rework: "approval",
    createBranch: "auto",
    branchCreation: "auto",
    integrateChildren: "approval",
    childIntegration: "approval",
    createPullRequest: "approval",
    prCreation: "approval",
    finalMerge: "human",
    markDone: "human",
    productionDeploy: "human",
    deployment: "human",
    destructiveMigration: "human",
    secretMutation: "human",
    credentialChanges: "human"
  },
  autonomous: {
    discovery: "auto",
    planning: "auto",
    routing: "auto",
    agentSelection: "auto",
    implementation: "auto",
    review: "auto",
    rework: "auto",
    createBranch: "auto",
    branchCreation: "auto",
    integrateChildren: "auto",
    childIntegration: "auto",
    createPullRequest: "auto",
    prCreation: "auto",
    finalMerge: "human",
    markDone: "human",
    productionDeploy: "human",
    deployment: "human",
    destructiveMigration: "human",
    secretMutation: "human",
    credentialChanges: "human"
  }
});

export function computePlanFingerprint(plan) {
  if (!plan) return null;

  const rawMetadata = plan.metadata || plan.configSnapshot?.metadata || {};
  const stableMetadata = Object.fromEntries(
    Object.entries(rawMetadata)
      .filter(([k]) => !["createdAt", "created_at", "updatedAt", "updated_at", "timestamp", "runId", "leaseId", "workerLeaseId"].includes(k))
      .sort(([a], [b]) => a.localeCompare(b))
  );

  const dependencies = Array.isArray(plan.dependencies)
    ? [...plan.dependencies].sort()
    : (Array.isArray(plan.configSnapshot?.dependencies) ? [...plan.configSnapshot.dependencies].sort() : []);

  const rationale = Array.isArray(plan.rationale)
    ? [...plan.rationale]
    : (Array.isArray(plan.reasons)
        ? [...plan.reasons]
        : (Array.isArray(plan.configSnapshot?.rationale)
            ? [...plan.configSnapshot.rationale]
            : (plan.rationale ? [String(plan.rationale)] : [])));

  const recommendedExecutor = plan.recommendedExecutor || plan.configSnapshot?.recommendedExecutor || (typeof plan.executor === "string" ? plan.executor : plan.executor?.provider) || null;
  const recommendedModel = plan.recommendedModel || plan.configSnapshot?.recommendedModel || plan.model || (typeof plan.executor === "object" ? plan.executor?.model : null) || null;
  const recommendedProfile = plan.recommendedProfile || plan.configSnapshot?.recommendedProfile || plan.modelProfile || (typeof plan.executor === "object" ? plan.executor?.modelProfile : null) || null;
  const recommendedEffort = plan.recommendedEffort || plan.configSnapshot?.recommendedEffort || plan.effort || (typeof plan.executor === "object" ? plan.executor?.effort : null) || null;

  const canonical = {
    issue: plan.issue || null,
    summary: plan.summary || null,
    persona: plan.persona || plan.taskAgent || null,
    taskAgent: plan.taskAgent || plan.persona || null,
    skills: Array.isArray(plan.skills) ? [...plan.skills].sort() : [],
    risk: plan.risk || null,
    parallelSafe: plan.parallelSafe ?? plan.configSnapshot?.parallelSafe ?? null,
    allowedPaths: Array.isArray(plan.allowedPaths) ? [...plan.allowedPaths].sort() : [],
    dependencies,
    rationale,
    recommendedExecutor,
    recommendedModel,
    recommendedProfile,
    recommendedEffort,
    metadata: stableMetadata,
    branch: plan.branch || null,
    baseRef: plan.baseRef || plan.baseBranch || plan.epicBranch || null,
    orchestratorProvider: plan.orchestratorProvider || plan.configSnapshot?.orchestratorProvider || null,
    executorProvider: plan.execution?.provider || plan.configSnapshot?.executorProvider || null,
    executorModel: plan.execution?.model || plan.configSnapshot?.executorModel || null,
    executorModelProfile: plan.execution?.modelProfile || plan.configSnapshot?.executorModelProfile || null,
    executorEffort: plan.execution?.effort || plan.configSnapshot?.executorEffort || null,
    operatingMode: plan.configSnapshot?.operatingMode || null,
    autonomy: plan.configSnapshot?.autonomy || null,
    policyVersion: plan.configSnapshot?.policyVersion || null,
    agentId: plan.agentId || plan.configSnapshot?.agentId || plan.taskAgent || plan.persona || null,
    agentVersion: plan.agentVersion ?? plan.configSnapshot?.agentVersion ?? null,
    agentHash: plan.agentHash || plan.configSnapshot?.agentHash || null,
    reviewProvider: plan.configSnapshot?.reviewProvider || null,
    reviewModel: plan.configSnapshot?.reviewModel || null,
    reviewModelProfile: plan.configSnapshot?.reviewModelProfile || null,
    reviewPersona: plan.configSnapshot?.reviewPersona || null,
    reviewTaskAgent: plan.configSnapshot?.reviewTaskAgent || null,
    reviewEffort: plan.configSnapshot?.reviewEffort || null,
    reviewAgentId: plan.reviewAgentId || plan.configSnapshot?.reviewAgentId || plan.reviewTaskAgent || null,
    reviewAgentVersion: plan.reviewAgentVersion ?? plan.configSnapshot?.reviewAgentVersion ?? null,
    reviewAgentHash: plan.reviewAgentHash || plan.configSnapshot?.reviewAgentHash || null,
    maxReworkAttempts: plan.configSnapshot?.maxReworkAttempts ?? null
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function computeIntegrationFingerprint(integrationPlan) {
  if (!integrationPlan) return null;
  const canonical = {
    childIssueKey: String(integrationPlan.childIssueKey || integrationPlan.issueKey || ""),
    leafBranch: String(integrationPlan.leafBranch || integrationPlan.sourceBranch || ""),
    targetBranch: String(integrationPlan.targetBranch || integrationPlan.epicBranch || ""),
    reviewedSha: String(integrationPlan.reviewedSha || "").toLowerCase()
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function computeParentBranchFingerprint(plan) {
  if (!plan) return null;
  const canonical = {
    parentKey: String(plan.parentKey || plan.issueKey || plan.issue || ""),
    graphFingerprint: String(plan.graphFingerprint || ""),
    baseSha: String(plan.baseSha || "").toLowerCase(),
    integrationBranch: String(plan.integrationBranch || plan.branch || "")
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function computeParentReviewFingerprint(plan) {
  if (!plan) return null;
  const canonical = {
    parentKey: String(plan.parentKey || plan.issueKey || plan.issue || ""),
    graphFingerprint: String(plan.graphFingerprint || ""),
    parentBaseSha: String(plan.parentBaseSha || plan.baseSha || "").toLowerCase(),
    integrationHeadSha: String(plan.integrationHeadSha || plan.headSha || "").toLowerCase(),
    reviewerAgentId: String(plan.reviewerAgentId || plan.reviewer || plan.taskAgent || ""),
    reviewerVersion: Number(plan.reviewerVersion ?? 1),
    reviewerHash: plan.reviewerHash ? String(plan.reviewerHash) : null
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function validateOperatingMode(mode) {
  if (typeof mode !== "string") {
    throw new Error(`Invalid operatingMode type: expected string, got ${typeof mode}`);
  }
  const normalized = mode.trim().toLowerCase();
  if (!OPERATING_MODES.includes(normalized)) {
    throw new Error(`Invalid operatingMode: "${mode}". Allowed values: ${OPERATING_MODES.join(", ")}`);
  }
  return normalized;
}

export function resolveOperatingMode(settings = {}) {
  const projMode = settings?.data?.project?.operatingMode ?? settings?.project?.operatingMode;
  const polMode = settings?.data?.policy?.operatingMode ?? settings?.policy?.operatingMode;

  if (projMode !== undefined && polMode !== undefined && projMode !== polMode) {
    throw new Error(`Conflicting operatingMode definitions: project.operatingMode is '${projMode}' but policy.operatingMode is '${polMode}'`);
  }

  const raw = projMode ?? polMode ?? settings?.operatingMode;
  if (raw === undefined || raw === null) return "autonomous";
  return validateOperatingMode(raw);
}

export function resolveAutonomyPolicy(settings = {}) {
  const mode = resolveOperatingMode(settings);
  const defaults = DEFAULT_MODE_AUTONOMY[mode] || DEFAULT_MODE_AUTONOMY.autonomous;
  const userAutonomy =
    settings?.data?.policy?.autonomy ||
    settings?.policy?.autonomy ||
    settings?.autonomy;

  if (userAutonomy !== undefined && userAutonomy !== null) {
    if (typeof userAutonomy !== "object" || Array.isArray(userAutonomy)) {
      throw new Error("policy.autonomy must be an object");
    }
    for (const [key, val] of Object.entries(userAutonomy)) {
      if (!SUPPORTED_AUTONOMY_ACTIONS.includes(key)) {
        throw new Error(`Unsupported autonomy action: "${key}". Supported: ${SUPPORTED_AUTONOMY_ACTIONS.join(", ")}`);
      }
      if (!["auto", "approval", "human"].includes(val)) {
        throw new Error(`Invalid autonomy value '${val}' for action '${key}'. Allowed values: auto, approval, human`);
      }
    }
  }

  const resolved = { ...defaults, ...(userAutonomy || {}) };

  // Enforce deterministic human-only hard gates
  for (const humanAction of HUMAN_ONLY_ACTIONS) {
    resolved[humanAction] = "human";
  }

  return resolved;
}

export function isActionAutonomous(settings = {}, action) {
  if (HUMAN_ONLY_ACTIONS.includes(action)) {
    return false;
  }
  const policy = resolveAutonomyPolicy(settings);
  return policy[action] === "auto";
}

export function authorizeRuntimeAction(settings, store, {
  issueKey,
  action = "implementation",
  plan = null,
  planFingerprint = null,
  attempt = 0,
  originatingRun = null,
  approved = false,
  approvedAction = null
} = {}) {
  if (HUMAN_ONLY_ACTIONS.includes(action)) {
    return {
      allowed: false,
      reason: `Action "${action}" is human-only and cannot be executed automatically`
    };
  }

  const snapshot = originatingRun?.payload?.configSnapshot || originatingRun?.configSnapshot || null;
  const effectiveSettings = snapshot
    ? {
        ...settings,
        data: {
          ...settings?.data,
          project: {
            ...settings?.data?.project,
            operatingMode: snapshot.operatingMode
          },
          policy: {
            ...settings?.data?.policy,
            operatingMode: snapshot.operatingMode,
            autonomy: snapshot.autonomy
          }
        }
      }
    : settings;

  const mode = resolveOperatingMode(effectiveSettings);
  const isAuto = isActionAutonomous(effectiveSettings, action);

  if (isAuto) {
    return { allowed: true, reason: null, mode, autonomous: true };
  }

  let isApproved = Boolean(approved && (!approvedAction || approvedAction === action));
  let rejectedReason = null;

  if (!isApproved && store && typeof store.hasExecutionApproval === "function" && issueKey) {
    const decision = store.hasExecutionApproval(issueKey, {
      action,
      plan,
      planFingerprint,
      attempt
    });
    if (decision) {
      if (decision.approved) {
        isApproved = true;
      } else {
        rejectedReason = decision.reason || "Rejected by human decision";
      }
    }
  }

  if (rejectedReason) {
    return {
      allowed: false,
      reason: `Action "${action}" was rejected: ${rejectedReason}`,
      mode,
      autonomous: false
    };
  }

  if (isApproved) {
    return { allowed: true, reason: null, mode, autonomous: false, approved: true };
  }

  if (mode === "manual") {
    return {
      allowed: false,
      reason: `Action "${action}" is denied in manual operating mode without explicit approval`,
      mode,
      autonomous: false
    };
  }

  if (mode === "supervised") {
    return {
      allowed: false,
      reason: `Action "${action}" requires human approval in supervised operating mode`,
      mode,
      autonomous: false
    };
  }

  return {
    allowed: false,
    reason: `Action "${action}" requires explicit human approval by policy`,
    mode,
    autonomous: false
  };
}

export function evaluateIssue(issue, policy, options = {}) {
  const reasons = [];
  const project = issue.key.split("-", 1)[0];
  if (policy?.allowedProjects && !policy.allowedProjects.includes(project)) {
    reasons.push(`Project ${project} is not allowlisted`);
  }
  if (issue.issueType && ["epic", "epik"].includes(issue.issueType.toLowerCase())) {
    reasons.push("Epic issues are human-only");
  }
  if (policy?.requiredLabels) {
    const missing = policy.requiredLabels.filter(
      (label) => !(issue.labels || []).includes(label)
    );
    if (missing.length) {
      reasons.push(`Missing required labels: ${missing.join(", ")}`);
    }
  }
  if (!acceptancePattern.test(issue.description || "")) {
    reasons.push("Acceptance criteria are missing");
  }
  if (issue.canonicalState === "unknown") {
    reasons.push("Provider state does not have a canonical workflow mapping");
  }
  if (["done", "cancelled", "human_approval"].includes(issue.canonicalState)) {
    reasons.push(`Work item is in human-only canonical state: ${issue.canonicalState}`);
  }
  if (policy?.humanOnlyStatuses && policy.humanOnlyStatuses.includes(issue.status)) {
    reasons.push(`Issue is already in human-only status: ${issue.status}`);
  }
  // Phase B: Operating mode and autonomy authorization
  if (options.settings) {
    const action = options.action || (
      issue.canonicalState === "review"
        ? "review"
        : issue.canonicalState === "rework"
        ? "rework"
        : "implementation"
    );

    // Pre-execution write-scope authorization gate for implementation and rework
    if (options.plan && (action === "implementation" || action === "rework")) {
      if (!Array.isArray(options.plan.allowedPaths) || options.plan.allowedPaths.length === 0) {
        const agent = options.plan.taskAgent || options.plan.persona || "unknown";
        reasons.push(`No authorized write scope for taskAgent '${agent}'`);
      }
    }

    // Agent Registry Lifecycle & Registration Check: taskAgent or reviewTaskAgent must resolve to an actual registry definition
    if (options.store && typeof options.store.getAgentDefinition === "function" && options.plan) {
      const isReview = action === "review" || issue.canonicalState === "review";
      const agentId = isReview
        ? (options.plan.reviewTaskAgent || options.plan.configSnapshot?.reviewTaskAgent || options.plan.reviewer || options.plan.reviewPersona || "correctness-reviewer")
        : (options.plan.taskAgent || options.plan.persona);

      if (agentId) {
        const agentRecord = options.store.getAgentDefinition(agentId);
        if (!agentRecord) {
          reasons.push(`Agent '${agentId}' is not registered`);
        } else if (agentRecord.status === "disabled") {
          reasons.push(`Agent '${agentId}' is disabled and cannot receive work`);
        } else if (agentRecord.status === "archived") {
          reasons.push(`Agent '${agentId}' is archived and cannot receive work`);
        }
      }
    }

    const isActionExplicitlyApproved = options.approvedAction
      ? (options.approvedAction === action && Boolean(options.approved))
      : (options.action === action && Boolean(options.approved || options.explicit));

    const auth = authorizeRuntimeAction(options.settings, options.store, {
      issueKey: issue.key,
      action,
      plan: options.plan,
      attempt: options.attempt || 0,
      originatingRun: options.originatingRun,
      approved: isActionExplicitlyApproved
    });

    if (!auth.allowed) {
      reasons.push(auth.reason);
    }

    // If implementation is requested, also verify branchCreation authorization
    if (action === "implementation") {
      const isBranchExplicitlyApproved = options.approvedAction === "branchCreation" && Boolean(options.approved);
      const branchAuth = authorizeRuntimeAction(options.settings, options.store, {
        issueKey: issue.key,
        action: "branchCreation",
        plan: options.plan,
        attempt: options.attempt || 0,
        originatingRun: options.originatingRun,
        approved: isBranchExplicitlyApproved
      });
      if (!branchAuth.allowed && !reasons.includes(branchAuth.reason)) {
        reasons.push(branchAuth.reason);
      }
    }
  }

  return { allowed: reasons.length === 0, reasons };
}
