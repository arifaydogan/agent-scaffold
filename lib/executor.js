import fs from "node:fs";
import path from "node:path";

function labelValue(labels, prefixes) {
  for (const prefix of prefixes) {
    const label = labels.find((item) => item.startsWith(prefix));
    if (label) return label.slice(prefix.length);
  }
  return null;
}

export function configuredExecutors(settings) {
  const executor = settings.data.executor || { providers: {} };
  if (executor.providers) return executor.providers;
  return Object.fromEntries(
    Object.entries(executor).filter(([, value]) => Array.isArray(value?.command))
  );
}

export function selectExecutionProfile(settings, issue, plan = {}) {
  const executors = configuredExecutors(settings);
  const labels = issue.labels || [];
  const requestedProvider = labelValue(labels, [
    "agent-provider-",
    "provider-"
  ]);
  const requestedProfile = labelValue(labels, ["model-profile-"]);
  const providerForProfile = requestedProfile
    ? Object.entries(executors).find(([, config]) => config.modelProfiles?.[requestedProfile])?.[0]
    : null;

  const recommendedExecutor = typeof plan?.executor === "string" ? plan.executor : (plan?.executor?.provider || null);
  const recommendedModel = plan?.model || (typeof plan?.executor === "object" ? plan?.executor?.model : null);
  const recommendedProfile = plan?.modelProfile || (typeof plan?.executor === "object" ? plan?.executor?.modelProfile : null);
  const recommendedEffort = plan?.effort || (typeof plan?.executor === "object" ? plan?.executor?.effort : null);

  // 1. Explicit executor validation: fail closed if explicitly recommended executor is unknown/unconfigured
  if (recommendedExecutor) {
    if (!executors[recommendedExecutor]) {
      throw new Error(`Recommended executor provider '${recommendedExecutor}' is not configured`);
    }
  }

  if (plan?.agentExecutor?.provider) {
    const agentProvider = plan.agentExecutor.provider;
    if (recommendedExecutor && recommendedExecutor !== agentProvider) {
      throw new Error(`Orchestrator recommended executor '${recommendedExecutor}', but agent '${plan.taskAgent || plan.agentId || "agent"}' is constrained to '${agentProvider}'`);
    }
  }

  if (plan?.agentExecutor?.modelProfile) {
    const agentProfile = plan.agentExecutor.modelProfile;
    if (recommendedProfile && recommendedProfile !== agentProfile) {
      throw new Error(`Orchestrator recommended model profile '${recommendedProfile}', but agent '${plan.taskAgent || plan.agentId || "agent"}' is constrained to '${agentProfile}'`);
    }
  }

  if (plan?.agentExecutor?.model) {
    const agentModel = plan.agentExecutor.model;
    if (recommendedModel && recommendedModel !== agentModel) {
      throw new Error(`Orchestrator recommended model '${recommendedModel}', but agent '${plan.taskAgent || plan.agentId || "agent"}' is constrained to '${agentModel}'`);
    }
  }

  const provider =
    settings.data.executor?.overrideProvider ||
    requestedProvider ||
    plan?.agentExecutor?.provider ||
    recommendedExecutor ||
    providerForProfile ||
    (plan?.risk === "high" && executors.codex ? "codex" : null) ||
    settings.data.executor?.defaultProvider ||
    (executors.codex ? "codex" : Object.keys(executors)[0]);
  const config = executors[provider];
  if (!config) throw new Error(`Unknown executor provider: ${provider}`);

  // 2. Explicit modelProfile validation: fail closed if explicitly recommended profile is unsupported
  if (recommendedProfile) {
    if (config.modelProfiles && !config.modelProfiles[recommendedProfile]) {
      throw new Error(`Recommended model profile '${recommendedProfile}' is not supported for provider '${provider}'`);
    }
  }

  const modelProfile =
    requestedProfile ||
    plan?.agentExecutor?.modelProfile ||
    (recommendedProfile && config.modelProfiles?.[recommendedProfile] ? recommendedProfile : null) ||
    (plan?.risk === "high" ? "high" : "medium");

  // 3. Explicit model validation: fail closed if explicitly recommended model is unsupported
  if (recommendedModel) {
    const validModels = [];
    if (config.modelProfiles) validModels.push(...Object.values(config.modelProfiles));
    if (config.defaultModel) validModels.push(config.defaultModel);
    if (validModels.length > 0 && !validModels.includes(recommendedModel)) {
      throw new Error(`Recommended model '${recommendedModel}' is not supported for provider '${provider}'`);
    }
  }

  const model =
    plan?.agentExecutor?.model ||
    (recommendedModel && (!config.modelProfiles || Object.values(config.modelProfiles).includes(recommendedModel) || config.defaultModel === recommendedModel) ? recommendedModel : null) ||
    config.modelProfiles?.[modelProfile] ||
    config.defaultModel ||
    null;
  if (config.modelProfiles && !model) {
    throw new Error(
      `Unknown model profile '${modelProfile}' for provider '${provider}'`
    );
  }

  // 4. Explicit effort validation: fail closed if unsupported effort value
  const validEfforts = ["low", "medium", "high"];
  if (recommendedEffort && !validEfforts.includes(String(recommendedEffort).toLowerCase())) {
    throw new Error(`Unsupported effort value '${recommendedEffort}'. Allowed: ${validEfforts.join(", ")}`);
  }

  const effort =
    labelValue(labels, ["effort-"]) ||
    recommendedEffort ||
    config.defaultEffort ||
    (plan?.risk === "high" ? "high" : "medium");

  return {
    provider,
    config,
    persona: plan.persona,
    taskAgent: plan.taskAgent || plan.persona,
    agent: plan.taskAgent || plan.persona, // Keep agent for backwards compatibility if needed
    model,
    modelProfile,
    effort,
    mode: config.mode || "accept-edits",
    recommendedExecutor,
    recommendedModel,
    recommendedProfile,
    recommendedEffort
  };
}

/**
 * Optional review is opt-in through review-claude or claude-review labels.
 * It selects the Antigravity Claude review profile without changing builder selection.
 */
export function selectReviewProfile(settings, issue, plan = null, snapshot = null) {
  const reviewPolicy = settings.data.policy?.review;
  const provider = snapshot?.reviewProvider || reviewPolicy?.provider;
  if (!provider) return null;
  
  const config = configuredExecutors(settings)[provider];
  if (!config) throw new Error(`Review provider '${provider}' is not configured`);
  
  const modelProfile = snapshot?.reviewModelProfile || reviewPolicy?.modelProfile || "medium";
  const model = snapshot?.reviewModel || config.modelProfiles?.[modelProfile] || config.defaultModel;
  if (!model) throw new Error(`Unknown model profile '${modelProfile}' for review provider '${provider}'`);
  
  const resolvedTaskAgent = snapshot?.reviewTaskAgent || reviewPolicy?.taskAgent || reviewPolicy?.reviewer || plan?.reviewer || "correctness-reviewer";
  const resolvedPersona = snapshot?.reviewPersona || reviewPolicy?.persona || resolvedTaskAgent;

  return {
    provider,
    config,
    persona: resolvedPersona,
    taskAgent: resolvedTaskAgent,
    agent: resolvedTaskAgent,
    model,
    modelProfile,
    effort: snapshot?.reviewEffort || reviewPolicy?.effort || config.defaultEffort || "medium",
    mode: config.mode || "accept-edits",
    reviewOnly: true
  };
}

function replacePlaceholders(value, replacements) {
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) =>
      result.replaceAll(`{${key}}`, replacement ?? ""),
    value
  );
}

// Models that do not support the --effort flag. The placeholder {effort} will
// remain in the command template and we strip the flag pair after substitution.
const EFFORT_UNSUPPORTED_MODELS = new Set([
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-6"
]);

/**
 * Remove consecutive --effort <value> flag pairs from a resolved command array.
 * This is done post-substitution so we never silently drop unresolved placeholders.
 */
function stripEffortFlag(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "--effort" && i + 1 < parts.length) {
      i += 1; // skip the value too
      continue;
    }
    out.push(parts[i]);
  }
  return out;
}

/**
 * For Antigravity runs, enforce --output-format stream-json.
 * If the command already contains '--output-format <something>', replace the value.
 * If the flag is absent, insert '--output-format stream-json' before '-p'/'--prompt'
 * (after --add-dir injection, so order remains stable).
 * This ensures the async parser receives incremental JSON lines regardless of what
 * the config template says.
 */
function enforceStreamJson(parts) {
  const flagIndex = parts.indexOf("--output-format");
  if (flagIndex >= 0 && flagIndex + 1 < parts.length) {
    // Replace whatever value is there with stream-json.
    const out = [...parts];
    out[flagIndex + 1] = "stream-json";
    return out;
  }
  // Flag absent: insert before -p / --prompt (or at end if no prompt flag).
  const out = [];
  let inserted = false;
  for (let i = 0; i < parts.length; i++) {
    if (!inserted && (parts[i] === "-p" || parts[i] === "--prompt") && i + 1 < parts.length) {
      out.push("--output-format", "stream-json");
      inserted = true;
    }
    out.push(parts[i]);
  }
  if (!inserted) out.push("--output-format", "stream-json");
  return out;
}

/**
 * Inject --add-dir <worktree> before the FIRST -p/--prompt argument in the command so
 * the Antigravity CLI operates on the exact worktree directory rather than the
 * directory inferred from cwd or workspace defaults.
 * Injection happens at most once even if the template has repeated prompt flags.
 */
function injectAddDir(parts, worktree) {
  if (!worktree) return parts;
  const out = [];
  let injected = false;
  for (let i = 0; i < parts.length; i++) {
    // Insert --add-dir right before the first -p / --prompt occurrence only.
    if (!injected && (parts[i] === "-p" || parts[i] === "--prompt") && i + 1 < parts.length) {
      out.push("--add-dir", worktree);
      injected = true;
    }
    out.push(parts[i]);
  }
  return out;
}

export function buildExecutorCommand({
  settings,
  profile,
  prepared,
  prompt,
  runId
}) {
  const runtimeRoot = path.join(path.dirname(settings.source), ".agent-runtime");
  const logDirectory = path.join(runtimeRoot, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFile = path.join(logDirectory, `${runId}-${profile.provider}.log`);
  const resultSchema = profile.config.resultSchema
    ? path.resolve(path.dirname(settings.source), profile.config.resultSchema)
    : "";
  const replacements = {
    worktree: prepared.worktree,
    prompt,
    agent: profile.agent,
    model: profile.model,
    effort: profile.effort,
    mode: profile.mode,
    resultSchema,
    logFile
  };

  let command = profile.config.command.map((part) =>
    replacePlaceholders(part, replacements)
  );
  let redactedCommand = profile.config.command.map((part) =>
    replacePlaceholders(part, { ...replacements, prompt: "<redacted>" })
  );

  // Strip --effort for models that don't support it.
  if (profile.model && EFFORT_UNSUPPORTED_MODELS.has(profile.model)) {
    command = stripEffortFlag(command);
    redactedCommand = stripEffortFlag(redactedCommand);
  }

  // For the antigravity provider, inject --add-dir to target the exact worktree and
  // enforce stream-json output format so the async parser receives incremental JSON lines.
  // Legacy configs that say '--output-format json' are corrected here; new configs should
  // already say 'stream-json' (the example template is updated accordingly).
  if (profile.provider === "antigravity") {
    command = injectAddDir(command, prepared.worktree);
    redactedCommand = injectAddDir(redactedCommand, prepared.worktree);
    command = enforceStreamJson(command);
    redactedCommand = enforceStreamJson(redactedCommand);
  }

  const cwd = replacePlaceholders(
    profile.config.cwd || prepared.worktree,
    replacements
  );
  return { command, redactedCommand, cwd, logFile, resultSchema };
}

function parsedJsonLines(stdout) {
  const values = [];
  for (const line of (stdout || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // Human-readable progress lines are retained in the log file, not telemetry.
    }
  }
  return values;
}

function parseStructuredResponse(response) {
  if (typeof response !== "string") return response || null;
  try {
    return JSON.parse(response);
  } catch {
    const blocks = [...response.matchAll(/```json\s*([\s\S]*?)```/gi)];
    for (const block of blocks) {
      try {
        return JSON.parse(block[1]);
      } catch {
        // Continue until a valid JSON block is found.
      }
    }
    return null;
  }
}

function validExecutionResult(result) {
  if (!result || typeof result !== "object") return false;
  if (result.verdict === "clean" || result.verdict === "changes-requested") {
    return Array.isArray(result.evidence);
  }
  return Boolean(
    ["completed", "blocked", "failed"].includes(result.status) &&
      typeof result.summary === "string" &&
      result.summary.trim() &&
      Array.isArray(result.changed_files) &&
      Array.isArray(result.validation_commands) &&
      Array.isArray(result.blockers) &&
      Array.isArray(result.risks)
  );
}

export function parseExecutionOutput(provider, stdout, stderr, returnCode) {
  if (provider !== "antigravity") {
    return { ok: returnCode === 0 };
  }
  const events = parsedJsonLines(stdout);
  const final = [...events]
    .reverse()
    .find((item) => item && (item.status || item.usage || item.response !== undefined));
  const denied = /auto-denied|permission.*denied|no output produced/i.test(
    `${stderr || ""}\n${final?.response || ""}`
  );
  const result = parseStructuredResponse(final?.response || null);
  const schemaValid = validExecutionResult(result);
  const ok =
    returnCode === 0 &&
    final?.status === "SUCCESS" &&
    !denied &&
    schemaValid;
  return {
    ok,
    providerStatus: final?.status || null,
    conversationId: final?.conversation_id || null,
    durationSeconds: final?.duration_seconds || null,
    turns: final?.num_turns || null,
    usage: final?.usage || null,
    result,
    schemaValid,
    permissionDenied: denied
  };
}

export const configuredExecutorProviders = configuredExecutors;
export const selectExecutorProfile = selectExecutionProfile;

export function describeExecutorProviders(settings) {
  const selected = settings.data.executor?.defaultProvider || null;
  return Object.entries(configuredExecutors(settings)).map(([name, config]) => ({
    id: name,
    type: config.type || name,
    selected: name === selected,
    enabled: config.enabled !== false,
    mode: config.mode || "accept-edits",
    modelProfiles: Object.keys(config.modelProfiles || {}),
    defaultModel: config.defaultModel || null
  }));
}
