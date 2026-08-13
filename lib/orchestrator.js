import { routeIssue } from "./routing.js";

export class OrchestratorProvider {
  constructor(name, config) {
    this.name = name;
    this.type = config.type || "unknown";
  }

  async analyzeWorkItem(context) { throw new Error("Not implemented"); }
  async createPlan(context) { throw new Error("Not implemented"); }
  async routeWork(context) { throw new Error("Not implemented"); }
  async decomposeParent(context) { throw new Error("Not implemented"); }
  async buildDependencyGraph(context) { throw new Error("Not implemented"); }
  async respondToHuman(context) { throw new Error("Not implemented"); }
  async handleBlocker(context) { throw new Error("Not implemented"); }
  async summarizeDecision(context) { throw new Error("Not implemented"); }
}

export class BuiltinOrchestratorProvider extends OrchestratorProvider {
  constructor(name, config) {
    super(name, config);
    this.type = config.type || "builtin";
  }

  // Maintains backwards compatibility for tests
  plan(workItem) {
    return routeIssue(workItem);
  }

  async createPlan(workItem) {
    return routeIssue(workItem);
  }
}

export class LLMOrchestratorProvider extends OrchestratorProvider {
  constructor(name, config) {
    super(name, config);
    this.type = config.type || "llm";
  }
  
  async createPlan(workItem) {
    // LLM fallback logic: for now, route it via builtin
    return routeIssue(workItem);
  }
}

export function configuredOrchestratorProviders(settings) {
  return settings.data.orchestrator?.providers || { builtin: { type: "builtin" } };
}

export function selectedOrchestratorProviderName(settings) {
  const providers = configuredOrchestratorProviders(settings);
  return settings.data.orchestrator?.defaultProvider || Object.keys(providers)[0] || "builtin";
}

export function createOrchestratorProvider(settings) {
  const name = selectedOrchestratorProviderName(settings);
  const config = configuredOrchestratorProviders(settings)[name];
  if (!config) throw new Error(`Unknown orchestrator provider: ${name}`);
  if ((config.type || name) === "builtin") {
    return new BuiltinOrchestratorProvider(name, config);
  }
  // Stub implementations for the llm types
  if (["codex", "antigravity", "claude-code", "generic-cli"].includes(config.type || name)) {
    return new LLMOrchestratorProvider(name, config);
  }
  throw new Error(`Unsupported orchestrator provider type: ${config.type || name}`);
}

export function describeOrchestratorProviders(settings) {
  const selected = selectedOrchestratorProviderName(settings);
  return Object.entries(configuredOrchestratorProviders(settings)).map(([name, config]) => ({
    id: name,
    type: config.type || name,
    selected: name === selected,
    enabled: config.enabled !== false
  }));
}
