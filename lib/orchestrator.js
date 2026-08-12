import { routeIssue } from "./routing.js";

class BuiltinOrchestratorProvider {
  constructor(name, config) {
    this.name = name;
    this.type = config.type || "builtin";
  }

  plan(workItem) {
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
