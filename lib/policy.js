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
  const canonical = {
    issue: plan.issue || null,
    persona: plan.persona || plan.taskAgent || null,
    taskAgent: plan.taskAgent || plan.persona || null,
    allowedPaths: Array.isArray(plan.allowedPaths) ? [...plan.allowedPaths].sort() : [],
    provider: plan.execution?.provider || plan.configSnapshot?.executorProvider || null,
    model: plan.execution?.model || plan.configSnapshot?.executorModel || null
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
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
  attempt = 0,
  originatingRun = null,
  approved = false
} = {}) {
  if (HUMAN_ONLY_ACTIONS.includes(action)) {
    return {
      allowed: false,
      reason: `Action "${action}" is human-only and cannot be executed automatically`
    };
  }

  const effectiveSettings = originatingRun?.payload?.configSnapshot
    ? {
        ...settings,
        data: {
          ...settings?.data,
          project: {
            ...settings?.data?.project,
            operatingMode: originatingRun.payload.configSnapshot.operatingMode
          },
          policy: {
            ...settings?.data?.policy,
            autonomy: originatingRun.payload.configSnapshot.autonomy
          }
        }
      }
    : settings;

  const mode = resolveOperatingMode(effectiveSettings);
  const isAuto = isActionAutonomous(effectiveSettings, action);

  if (isAuto) {
    return { allowed: true, reason: null, mode, autonomous: true };
  }

  let isApproved = Boolean(approved);
  let rejectedReason = null;

  if (!isApproved && store && typeof store.hasExecutionApproval === "function" && issueKey) {
    const decision = store.hasExecutionApproval(issueKey, { action, plan, attempt });
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

    const auth = authorizeRuntimeAction(options.settings, options.store, {
      issueKey: issue.key,
      action,
      plan: options.plan,
      attempt: options.attempt || 0,
      originatingRun: options.originatingRun,
      approved: options.approved || options.explicit
    });

    if (!auth.allowed) {
      reasons.push(auth.reason);
    }
  }

  return { allowed: reasons.length === 0, reasons };
}
