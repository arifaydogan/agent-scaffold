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

export function validateOperatingMode(mode) {
  if (!mode || typeof mode !== "string") return "autonomous";
  const normalized = mode.trim().toLowerCase();
  if (!OPERATING_MODES.includes(normalized)) {
    throw new Error(`Invalid operatingMode: "${mode}". Allowed values: ${OPERATING_MODES.join(", ")}`);
  }
  return normalized;
}

export function resolveOperatingMode(settings = {}) {
  const raw =
    settings?.data?.project?.operatingMode ||
    settings?.data?.policy?.operatingMode ||
    settings?.project?.operatingMode ||
    settings?.operatingMode ||
    "autonomous";
  return validateOperatingMode(raw);
}

export function resolveAutonomyPolicy(settings = {}) {
  const mode = resolveOperatingMode(settings);
  const defaults = DEFAULT_MODE_AUTONOMY[mode] || DEFAULT_MODE_AUTONOMY.autonomous;
  const userAutonomy =
    settings?.data?.policy?.autonomy ||
    settings?.policy?.autonomy ||
    settings?.autonomy ||
    {};

  const resolved = { ...defaults, ...userAutonomy };

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

  // Phase B: Operating mode and autonomy evaluation
  if (options.settings) {
    const mode = resolveOperatingMode(options.settings);
    const action = options.action || (issue.canonicalState === "review" ? "review" : "implementation");

    if (HUMAN_ONLY_ACTIONS.includes(action)) {
      reasons.push(`Action "${action}" is human-only and cannot be executed automatically`);
    } else if (!isActionAutonomous(options.settings, action)) {
      let approved = Boolean(options.approved || options.explicit);
      let rejectedReason = null;

      if (!approved && options.store && typeof options.store.hasExecutionApproval === "function") {
        const decision = options.store.hasExecutionApproval(issue.key);
        if (decision) {
          if (decision.approved) {
            approved = true;
          } else {
            rejectedReason = decision.reason || "Rejected by human decision";
          }
        }
      }

      if (rejectedReason) {
        reasons.push(`Execution rejected: ${rejectedReason}`);
      } else if (!approved) {
        if (mode === "manual") {
          reasons.push("Automatic worker dispatch is denied in manual operating mode");
        } else if (mode === "supervised") {
          reasons.push("Execution requires human approval in supervised operating mode");
        } else {
          reasons.push(`Action "${action}" requires explicit human approval by policy`);
        }
      }
    }
  }

  return { allowed: reasons.length === 0, reasons };
}
