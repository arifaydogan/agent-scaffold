import { GitHubIssuesWorkSourceProvider } from "./github-issues.js";
import { JiraClient } from "./jira.js";
import { stateMappingFor } from "./workflow.js";

export function configuredWorkSourceProviders(settings) {
  return settings.data.workSource?.providers || {};
}

export function selectedWorkSourceProviderName(settings) {
  const providers = configuredWorkSourceProviders(settings);
  return settings.data.workSource?.defaultProvider || Object.keys(providers)[0];
}

export function createWorkSourceProvider(settings, environment = process.env) {
  const name = selectedWorkSourceProviderName(settings);
  const config = configuredWorkSourceProviders(settings)[name];
  if (!config) throw new Error(`Unknown work source provider: ${name}`);
  if (name === "jira" || config.type === "jira") {
    return new JiraClient({ ...config, providerName: name }, environment);
  }
  if (name === "github-issues" || config.type === "github-issues") {
    return new GitHubIssuesWorkSourceProvider(
      { ...config, providerName: name, projectKey: settings.projectKey },
      environment
    );
  }
  throw new Error(`Unsupported work source provider type: ${config.type || name}`);
}

export function describeWorkSourceProviders(settings) {
  const selected = selectedWorkSourceProviderName(settings);
  return Object.entries(configuredWorkSourceProviders(settings)).map(([name, config]) => ({
    id: name,
    type: config.type || name,
    selected: name === selected,
    enabled: config.enabled !== false,
    writeEnabled: Boolean(config.writeEnabled),
    stateMapping: stateMappingFor(config.type || name, config.stateMapping)
  }));
}
