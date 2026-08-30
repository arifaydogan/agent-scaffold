import { GitHubIssuesWorkSourceProvider } from "./github-issues.js";
import { JiraClient } from "./jira.js";
import { resolveJiraProviderConnection, resolveTokenProviderConnection } from "./provider-connections.js";
import { stateMappingFor } from "./workflow.js";

export class WorkSourceProvider {
  async listWorkItems(query) { return []; }
  async getWorkItem(id) { throw new Error("Not implemented"); }
  async getComments(id) { return []; }
  async getChildren(id) { return []; }
  async getParent(id) { return null; }
  async getDependencies(id) { return []; }
  async transition(id, canonicalState, metadata) {}
  async addComment(id, comment) {}
  async addLink(id, link) {}
  async claim(id, metadata) {}
  async releaseClaim(id, metadata) {}

  async poll(projectOrOptions, requiredLabel, legacyLimit) {
    const options = typeof projectOrOptions === "object"
      ? projectOrOptions
      : { projectKey: projectOrOptions, requiredLabels: requiredLabel ? [requiredLabel] : undefined, limit: legacyLimit };
    return this.listWorkItems({
      projectKey: options.projectKey,
      limit: options.limit || 10,
      requiredLabels: options.requiredLabels,
      canonicalStates: options.canonicalStates
    });
  }

  // Legacy alias
  async getIssue(id) { return this.getWorkItem(id); }
}


export function configuredWorkSourceProviders(settings) {
  return settings.data.workSource?.providers || {};
}

export function selectedWorkSourceProviderName(settings) {
  const providers = configuredWorkSourceProviders(settings);
  return settings.data.workSource?.defaultProvider || Object.keys(providers)[0];
}

export function createWorkSourceProvider(settings, environment = process.env, options = {}) {
  const name = selectedWorkSourceProviderName(settings);
  const config = configuredWorkSourceProviders(settings)[name];
  if (!config) throw new Error(`Unknown work source provider: ${name}`);
  if (name === "jira" || config.type === "jira") {
    const resolved = resolveJiraProviderConnection(settings, name, config, environment, {
      vault: options.vault,
      vaultOptions: options.vaultOptions
    });
    return new JiraClient({ ...resolved.config, providerName: name }, resolved.environment);
  }
  if (name === "github-issues" || config.type === "github-issues") {
    const resolved = resolveTokenProviderConnection(settings, "github", config, environment, {
      defaultTokenEnv: "GITHUB_TOKEN",
      vault: options.vault,
      vaultOptions: options.vaultOptions
    });
    return new GitHubIssuesWorkSourceProvider(
      { ...resolved.config, providerName: name, projectKey: settings.projectKey },
      resolved.environment
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

/**
 * Discovers work items from the configured WorkSourceProvider using provider-neutral
 * canonical states, and durably records backlog/discovered items into SQLite store.
 */
export async function discoverWorkItems(settings, options = {}) {
  const store = options.store || settings?._store;
  const workSource = options.workSource || createWorkSourceProvider(settings);
  const limit = options.limit || 50;
  const canonicalStates = options.canonicalStates || ["backlog", "ready", "rework", "review", "human_approval"];

  const items = typeof workSource.poll === "function"
    ? await workSource.poll({
        projectKey: settings.projectKey,
        limit,
        canonicalStates,
        requiredLabels: options.requiredLabels || settings?.data?.policy?.requiredLabels
      })
    : (typeof workSource.listWorkItems === "function"
        ? await workSource.listWorkItems({
            projectKey: settings.projectKey,
            limit,
            canonicalStates,
            requiredLabels: options.requiredLabels || settings?.data?.policy?.requiredLabels
          })
        : []);

  const recorded = [];
  if (store && typeof store.recordDiscoveredWorkItem === "function") {
    for (const item of items) {
      const cState = String(item.canonicalState || "").toLowerCase();
      if (cState === "backlog" || cState === "discovered" || !cState) {
        const rec = store.recordDiscoveredWorkItem({
          key: item.key || item.id,
          issueKey: item.key || item.id,
          summary: item.summary || item.title || item.key || item.id,
          provider: item.provider || item.sourceProvider || selectedWorkSourceProviderName(settings) || "work-source",
          url: item.url || item.sourceUrl || item.htmlUrl || null,
          raw: {
            canonicalState: item.canonicalState || "backlog",
            status: item.status || item.state,
            labels: item.labels || [],
            priority: item.priority || null,
            reporter: item.reporter || null,
            ...(item.raw || {})
          }
        });
        recorded.push(rec);
      }
    }
  }

  return {
    ok: true,
    count: items.length,
    items,
    recorded
  };
}
