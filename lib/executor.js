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

function executionCandidate(profile) {
  return {
    provider: profile.provider,
    model: profile.model || null,
    modelProfile: profile.modelProfile || null,
    effort: profile.effort || "medium",
    mode: profile.mode || "accept-edits",
    persona: profile.persona || null,
    taskAgent: profile.taskAgent || profile.persona || null,
    agent: profile.agent || profile.taskAgent || profile.persona || null
  };
}

function requestedExecutor(plan = {}) {
  return typeof plan.executor === "string" ? plan.executor : plan.executor?.provider || null;
}

/**
 * Build the complete, approval-bound execution order. Disabled or model-less
 * local providers are never candidates. Explicit ticket/agent provider pins
 * remain pins; adaptive routing must not weaken an authorization constraint.
 */
export function selectExecutionCandidates(settings, issue, plan = {}, primaryProfile = null) {
  const primary = primaryProfile || selectExecutionProfile(settings, issue, plan);
  const adaptive = settings.data.executor?.adaptiveRouting || {};
  const first = executionCandidate(primary);
  if (adaptive.enabled !== true) return [first];

  const executors = configuredExecutors(settings);
  const labels = issue.labels || [];
  const providerPinned = Boolean(
    settings.data.executor?.overrideProvider ||
    labelValue(labels, ["agent-provider-", "provider-"]) ||
    plan?.agentExecutor?.provider ||
    requestedExecutor(plan)
  );
  const configuredOrder = Array.isArray(adaptive.providerOrder)
    ? adaptive.providerOrder
    : Object.keys(executors);
  const providers = providerPinned
    ? [primary.provider]
    : [primary.provider, ...configuredOrder.filter(name => name !== primary.provider)];
  const fallbackProfiles = Array.isArray(adaptive.modelFallbackProfiles)
    ? adaptive.modelFallbackProfiles
    : ["medium", "low"];
  const profiles = [primary.modelProfile, ...fallbackProfiles]
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const candidates = [];
  const seen = new Set();
  const maxCandidates = Math.max(1, Number(adaptive.maxCandidates || 6));

  const add = candidate => {
    const key = `${candidate.provider}\u0000${candidate.model || ""}`;
    if (seen.has(key) || candidates.length >= maxCandidates) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const provider of providers) {
    const config = executors[provider];
    if (!config || config.enabled === false || !Array.isArray(config.command) || config.command.length === 0) continue;
    for (const modelProfile of profiles) {
      if (provider === primary.provider && modelProfile === primary.modelProfile) {
        add(first);
        continue;
      }
      const model = config.modelProfiles?.[modelProfile]
        || (modelProfile === adaptive.defaultProfile ? config.defaultModel : null)
        || (!config.modelProfiles && config.defaultModel)
        || null;
      if (!model) continue;
      add({
        provider,
        model,
        modelProfile,
        effort: config.effortProfiles?.[modelProfile]
          || config.defaultEffort
          || (modelProfile === "high" ? "high" : modelProfile === "low" ? "low" : "medium"),
        mode: config.mode || "accept-edits",
        persona: primary.persona || null,
        taskAgent: primary.taskAgent || primary.persona || null,
        agent: primary.agent || primary.taskAgent || primary.persona || null
      });
    }
  }
  if (candidates.length === 0) candidates.push(first);
  return candidates;
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

  const recommendedExecutor = requestedExecutor(plan);
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
  if (config.enabled === false) throw new Error(`Executor provider '${provider}' is disabled`);

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
    (plan?.risk === "high" ? "high" : null) ||
    (config.modelProfiles?.[settings.data.executor?.adaptiveRouting?.taskProfiles?.[plan.taskAgent || plan.persona]]
      ? settings.data.executor.adaptiveRouting.taskProfiles[plan.taskAgent || plan.persona]
      : null) ||
    "medium";

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
  const validEfforts = config.supportedEfforts || ["none", "low", "medium", "high", "xhigh", "max"];
  if (recommendedEffort && !validEfforts.includes(String(recommendedEffort).toLowerCase())) {
    throw new Error(`Unsupported effort value '${recommendedEffort}'. Allowed: ${validEfforts.join(", ")}`);
  }

  const effort =
    labelValue(labels, ["effort-"]) ||
    recommendedEffort ||
    config.effortProfiles?.[modelProfile] ||
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
  const model = snapshot?.reviewModel || reviewPolicy?.model || config.modelProfiles?.[modelProfile] || config.defaultModel;
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

// Antigravity's Claude model aliases encode their reasoning mode in the model
// selection and reject the separate --effort flag. Keep effort in the approved
// profile for audit/routing, but omit the unsupported CLI argument at execution.
function supportsEffortFlag(profile) {
  if (profile?.provider !== "antigravity") return true;
  return !/^claude-/i.test(String(profile?.model || ""));
}

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
  const basePath = settings?.source ? path.dirname(settings.source) : (settings?.repoPath || process.cwd());
  const runtimeRoot = path.join(basePath, ".agent-runtime");
  const logDirectory = path.join(runtimeRoot, "logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  const logFile = path.join(logDirectory, `${runId}-${profile.provider}.log`);
  const resultSchema = profile?.config?.resultSchema
    ? path.resolve(basePath, profile.config.resultSchema)
    : "";
  const replacements = {
    worktree: prepared.worktree,
    prompt,
    agent: profile.agent,
    model: profile.model,
    effort: profile.effort,
    mode: profile.mode,
    endpoint: profile.config.endpoint,
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
  if (!supportsEffortFlag(profile)) {
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

function safeFailureMessage(value) {
  return String(value || "")
    .replace(/\b(Bearer\s+)[A-Za-z0-9_\-\.]{10,}\b/gi, "$1[redacted]")
    .replace(/\b(sk-[A-Za-z0-9_\-]{10,})\b/gi, "[redacted]")
    .replace(/\b(token|password|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .trim()
    .slice(0, 1200);
}

/**
 * Classify execution failures for both operator diagnostics and failover.
 * Only infrastructure/capacity failures are eligible. Policy, credentials,
 * write-scope violations and task questions always stop for human attention.
 */
export function classifyExecutionFailure({ telemetry = {}, returnCode = 1, scope = {}, stdout = "", stderr = "" } = {}) {
  const result = telemetry?.result || null;
  const blockers = Array.isArray(result?.blockers) ? result.blockers : [];
  const raw = [
    stderr,
    stdout,
    telemetry?.error?.safeMessage,
    typeof telemetry?.error === "string" ? telemetry.error : "",
    result?.summary,
    ...blockers
  ].filter(Boolean).join("\n");
  const blockerLine = String(stdout || "").match(/blockers:\s*(?:\r?\n)?\s*-\s*["']?([^\r\n"']+)/i)?.[1];
  const safeMessage = safeFailureMessage(blockers[0] || blockerLine || telemetry?.error?.safeMessage || stderr || stdout || `Process exited with code ${returnCode}`);

  let category = "execution_failed";
  let reason = "Agent execution failed";
  let autoFailover = false;
  let providerWide = false;

  if (scope?.allowed === false) {
    category = "scope_violation";
    reason = "Changed files exceeded the authorized scope";
  } else if (/code[- ]mode host|failed to spawn[^\n]*host|tool host[^\n]*(?:missing|not found|unavailable)|codex-code-mode-host/i.test(raw)) {
    category = "tool_host_unavailable";
    reason = "Provider tool host is unavailable";
    autoFailover = true;
    providerWide = true;
  } else if (/insufficient[_ -]?quota|quota[^\n]*(?:exhausted|exceeded)|usage limit|credits?[^\n]*(?:exhausted|depleted)|token limit[^\n]*(?:reached|exceeded)/i.test(raw)) {
    category = "quota_exhausted";
    reason = "Provider usage limit was reached";
    autoFailover = true;
    providerWide = true;
  } else if (/rate limit|too many requests|\b429\b/i.test(raw)) {
    category = "rate_limited";
    reason = "Provider rate limit was reached";
    autoFailover = true;
    providerWide = true;
  } else if (/invalid model selection[^\n]*(?:--effort|effort)|--effort[^\n]*not supported for model/i.test(raw)) {
    category = "model_configuration_invalid";
    reason = "Selected model options are incompatible";
    autoFailover = true;
  } else if (/model[^\n]*(?:not found|unsupported|unavailable|does not exist)|unknown model/i.test(raw)) {
    category = "model_unavailable";
    reason = "Selected model is unavailable";
    autoFailover = true;
  } else if (/timeout|timed out/i.test(raw)) {
    category = "provider_timeout";
    reason = "Provider timed out";
    autoFailover = true;
    providerWide = true;
  } else if (/econnrefused|enotfound|\b502\b|\b503\b|service unavailable|command not found|is not recognized/i.test(raw) || returnCode === 127) {
    category = "provider_unavailable";
    reason = "Provider is unavailable";
    autoFailover = true;
    providerWide = true;
  } else if (/unauthorized|authentication failed|invalid api key|invalid token|credential/i.test(raw)) {
    category = "authentication_failed";
    reason = "Provider authentication needs attention";
  } else if (telemetry?.permissionDenied || /auto-denied|permission.*denied|access.*denied/i.test(raw)) {
    category = "permission_denied";
    reason = "Provider permission was denied";
  } else if (result?.status === "blocked" && blockers.length > 0) {
    category = "operator_input_required";
    reason = "Agent needs operator input";
  } else if (["json_parse_error", "schema_validation_error", "empty_output_error"].includes(telemetry?.error?.category)) {
    category = "output_contract_error";
    reason = "Provider returned an invalid structured result";
  } else if (result?.status === "failed") {
    category = "task_failed";
    reason = "Agent reported that the task failed";
  }

  const changedFiles = Array.isArray(scope?.changedFiles) ? scope.changedFiles : [];
  if (changedFiles.length > 0) autoFailover = false;
  return { category, reason, safeMessage, autoFailover, providerWide };
}

export function parseExecutionOutput(provider, stdout, stderr, returnCode) {
  function makeError(category, rawMessage) {
    const safeMessage = String(rawMessage || "")
      .replace(/\b(Bearer\s+)[A-Za-z0-9_\-\.]{10,}\b/gi, "$1[redacted]")
      .replace(/\b(sk-[A-Za-z0-9_\-]{10,})\b/gi, "[redacted]")
      .slice(0, 300);
    return { category, safeMessage };
  }

  if (provider !== "antigravity") {
    const parsed = parseStructuredResponse(stdout || null);
    const isObject = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    const result = isObject && parsed.result !== undefined ? parsed.result : (isObject ? parsed : null);
    const usage = isObject && parsed.usage ? parsed.usage : null;
    const durationSeconds = (isObject && parsed.duration_seconds !== undefined && parsed.duration_seconds !== null && Number.isFinite(Number(parsed.duration_seconds)))
      ? Number(parsed.duration_seconds)
      : null;
    const schemaValid = validExecutionResult(result);
    const ok = returnCode === 0 && isObject && schemaValid;
    let error = null;
    if (!ok) {
      let category = "executor_error";
      if (returnCode !== 0) category = "provider_error";
      else if (!stdout || !stdout.trim()) category = "empty_output_error";
      else if (!isObject) category = "json_parse_error";
      else if (!schemaValid) category = "schema_validation_error";
      error = makeError(category, stderr || stdout || `Process exited with code ${returnCode}`);
    }
    return {
      ok,
      result,
      usage,
      durationSeconds,
      schemaValid,
      error
    };
  }

  const events = parsedJsonLines(stdout);
  const finalEvent = [...events]
    .reverse()
    .find((item) => item && (
      item.status || item.usage || item.response !== undefined ||
      (item.event === "result" && item.result && typeof item.result === "object")
    ));
  // Current Antigravity stream-json wraps the terminal payload as
  // { event: "result", result: { status, response, error, ... } }. Retain
  // compatibility with older top-level terminal events as well.
  const final = finalEvent?.event === "result" && finalEvent?.result && typeof finalEvent.result === "object"
    ? finalEvent.result
    : finalEvent;
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

  const durationSeconds = (final?.duration_seconds !== undefined && final?.duration_seconds !== null && Number.isFinite(Number(final.duration_seconds)))
    ? Number(final.duration_seconds)
    : null;

  let error = null;
  if (!ok) {
    let category = "executor_error";
    if (returnCode !== 0) category = "provider_error";
    else if (denied) category = "permission_denied";
    else if (!stdout || !stdout.trim()) category = "empty_output_error";
    else if (!result) category = "json_parse_error";
    else if (!schemaValid) category = "schema_validation_error";
    error = makeError(category, stderr || final?.error || final?.response || `Process exited with code ${returnCode}`);
  }

  return {
    ok,
    providerStatus: final?.status || null,
    conversationId: final?.conversation_id || null,
    durationSeconds,
    turns: final?.num_turns || null,
    usage: final?.usage || null,
    result,
    schemaValid,
    permissionDenied: denied,
    error
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
