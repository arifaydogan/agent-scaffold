const acceptancePattern =
  /(acceptance criteria|kabul kriter|definition of done|\[ \])/i;

export function evaluateIssue(issue, policy) {
  const reasons = [];
  const project = issue.key.split("-", 1)[0];
  if (!policy.allowedProjects.includes(project)) {
    reasons.push(`Project ${project} is not allowlisted`);
  }
  if (["epic", "epik"].includes(issue.issueType.toLowerCase())) {
    reasons.push("Epic issues are human-only");
  }
  const missing = policy.requiredLabels.filter(
    (label) => !issue.labels.includes(label)
  );
  if (missing.length) {
    reasons.push(`Missing required labels: ${missing.join(", ")}`);
  }
  if (!acceptancePattern.test(issue.description || "")) {
    reasons.push("Acceptance criteria are missing");
  }
  if (policy.humanOnlyStatuses.includes(issue.status)) {
    reasons.push(`Issue is already in human-only status: ${issue.status}`);
  }
  return { allowed: reasons.length === 0, reasons };
}
