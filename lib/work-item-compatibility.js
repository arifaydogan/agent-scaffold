import crypto from "node:crypto";

function item(id, category, title, current, proposed, resolution, automatic = false) {
  return { id, category, title, current, proposed, resolution, automatic };
}

function splitValues(value) {
  return String(value || "").split(",").map(part => part.trim()).filter(Boolean);
}

export function buildWorkItemCompatibility(plan = {}) {
  const reasons = Array.isArray(plan.eligibilityReasons) ? plan.eligibilityReasons : [];
  const items = [];

  for (const reason of reasons) {
    let match = String(reason).match(/^Missing required labels:\s*(.+)$/i);
    if (match) {
      const labels = splitValues(match[1]);
      items.push(item(
        `labels:${labels.join(",")}`,
        "work_source",
        "Required work-source labels are missing",
        labels.join(", "),
        labels.join(", "),
        "Add the listed labels in the connected work source, then prepare the plan again."
      ));
      continue;
    }

    match = String(reason).match(/^Agent '([^']+)' is not registered$/i);
    if (match) {
      items.push(item(
        `agent:${match[1]}`,
        "agent",
        "The selected agent is not registered",
        match[1],
        match[1],
        "Refresh the durable agent registry or select a registered route."
      ));
      continue;
    }

    match = String(reason).match(/^Agent '([^']+)' is (disabled|archived)/i);
    if (match) {
      items.push(item(
        `agent-state:${match[1]}`,
        "agent",
        "The selected agent cannot receive work",
        `${match[1]} (${match[2].toLowerCase()})`,
        `${match[1]} (enabled)`,
        "Review the agent definition and enable it explicitly if it should receive work."
      ));
      continue;
    }

    match = String(reason).match(/^No authorized write scope for taskAgent '([^']+)'$/i);
    if (match) {
      const requested = Array.isArray(plan.requestedAllowedPaths) ? plan.requestedAllowedPaths : [];
      items.push(item(
        `scope:${match[1]}`,
        "scope",
        "The requested file scope is not authorized",
        Array.isArray(plan.allowedPaths) && plan.allowedPaths.length ? plan.allowedPaths.join(", ") : "No effective path",
        requested.length ? requested.join(", ") : "A reviewed, narrow path scope",
        "Review the ticket scope, durable agent definition, and hard policy intersection. Scope is never widened automatically."
      ));
      continue;
    }

    match = String(reason).match(/^Git base ref does not exist:\s*(.+)$/i);
    if (match) {
      items.push(item(
        `base-ref:${match[1]}`,
        "source_control",
        "The requested Git base does not exist",
        match[1],
        "An existing, reviewed integration base",
        "Create or select the intended parent/integration branch explicitly. No fallback branch is chosen automatically."
      ));
      continue;
    }

    if (/^Acceptance criteria are missing$/i.test(reason)) {
      items.push(item(
        "acceptance-criteria",
        "work_source",
        "Acceptance criteria are missing",
        "No recognized acceptance criteria",
        "Testable acceptance criteria",
        "Add acceptance criteria to the work item, then prepare the plan again."
      ));
      continue;
    }

    if (/canonical workflow mapping/i.test(reason)) {
      items.push(item(
        "workflow-mapping",
        "work_source",
        "The provider status is not mapped",
        reason,
        "A canonical workflow state",
        "Map the provider status in the local work-source configuration."
      ));
      continue;
    }

    items.push(item(
      `policy:${items.length + 1}`,
      "policy",
      "A policy gate requires attention",
      String(reason),
      "Satisfied policy gate",
      "Review this gate explicitly; the dashboard will not bypass it."
    ));
  }

  const status = plan.eligible === true ? "compatible" : "needs_attention";
  const canonical = {
    issue: String(plan.issue || ""),
    planFingerprint: String(plan.planFingerprint || ""),
    status,
    items
  };
  return {
    status,
    items,
    fingerprint: crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
  };
}
