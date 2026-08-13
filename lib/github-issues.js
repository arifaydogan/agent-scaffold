import { mapProviderState } from "./workflow.js";

function labelNames(labels = []) {
  return labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

export class GitHubIssuesWorkSourceProvider {
  constructor(config, environment = process.env) {
    if (!config.owner || !config.repo) {
      throw new Error("GitHub Issues provider requires owner and repo");
    }
    this.name = config.providerName || "github-issues";
    this.owner = config.owner;
    this.repo = config.repo;
    this.projectKey = config.projectKey || config.keyPrefix || this.repo.toUpperCase();
    this.baseUrl = (config.baseUrl || "https://api.github.com").replace(/\/$/, "");
    this.apiVersion = config.apiVersion || "2022-11-28";
    this.token = config.tokenEnv ? environment[config.tokenEnv] : null;
    this.writeEnabled = Boolean(config.writeEnabled);
    this.stateMapping = config.stateMapping || {};
    this.writeMapping = config.writeMapping || {};
  }

  async request(route) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": "agent-scaffold"
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(`${this.baseUrl}${route}`, { headers });
    if (!response.ok) {
      throw new Error(`GitHub Issues GET ${route} failed: ${response.status}`);
    }
    return response.json();
  }

  shapeIssue(raw) {
    const labels = labelNames(raw.labels);
    const providerState = raw.state_reason || raw.state;
    return {
      key: `${this.projectKey}-${raw.number}`,
      providerKey: `#${raw.number}`,
      summary: raw.title,
      description: raw.body || "",
      issueType: labels.some((label) => /^epic$/i.test(label)) ? "Epic" : "Issue",
      status: providerState,
      canonicalState: mapProviderState(
        "github-issues",
        providerState,
        this.stateMapping,
        [raw.state, ...labels]
      ),
      labels,
      parentKey: null,
      assignee: raw.assignee?.login || null,
      source: {
        provider: this.name,
        id: String(raw.number),
        url: raw.html_url || null
      },
      raw
    };
  }

  issueNumber(key) {
    const value = String(key);
    const match = value.match(/(?:#|-)(\d+)$/) || value.match(/^(\d+)$/);
    if (!match) throw new Error(`Invalid GitHub issue key: ${key}`);
    return match[1];
  }

  async getWorkItem(key) {
    const raw = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${this.issueNumber(key)}`
    );
    if (raw.pull_request) throw new Error(`GitHub item ${key} is a pull request, not an issue`);
    return this.shapeIssue(raw);
  }

  async getIssue(key) {
    return this.getWorkItem(key);
  }

  async poll(projectOrOptions, requiredLabel, legacyLimit) {
    const options = typeof projectOrOptions === "object"
      ? projectOrOptions
      : { requiredLabels: [requiredLabel], limit: legacyLimit };
    return this.listWorkItems({
      limit: options.limit || 10,
      requiredLabels: options.requiredLabels,
      canonicalStates: options.canonicalStates
    });
  }

  async listWorkItems(query) {
    const limit = Math.min(100, query.limit || 10);
    const searchParams = new URLSearchParams({ state: "open", per_page: String(limit) });
    
    // In GitHub we filter by labels for states
    let labels = [...(query.requiredLabels || [])].filter(Boolean);
    if (query.canonicalStates && query.canonicalStates.length > 0) {
      // We pick the first mapped label for each state
      const mappedLabels = query.canonicalStates.flatMap(state => {
        const mapped = this.stateMapping[state] || [];
        return mapped.length > 0 ? [mapped[0]] : [];
      });
      if (mappedLabels.length > 0) {
        labels = labels.concat(mappedLabels);
      }
    }
    
    if (labels.length) searchParams.set("labels", labels.join(","));
    
    const raw = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues?${searchParams}`
    );
    return raw
      .filter((item) => !item.pull_request)
      .slice(0, limit)
      .map((item) => this.shapeIssue(item));
  }

  async getComments(id) {
    const issueNum = this.issueNumber(id);
    const raw = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNum}/comments`
    );
    return raw.map(c => ({
      id: String(c.id),
      author: c.user?.login || "Unknown",
      body: c.body,
      created: c.created_at
    }));
  }

  async getChildren(id) {
    // GitHub issues don't have native children. Return empty.
    return [];
  }

  async getParent(id) {
    return null;
  }

  async getDependencies(id) {
    return [];
  }

  async transition(id, canonicalState, metadata) {
    if (!this.writeEnabled) return;
    const writeOp = this.writeMapping[canonicalState];
    if (!writeOp || !writeOp.addLabel) return;
    
    const issueNum = this.issueNumber(id);
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": "agent-scaffold",
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json"
    };
    await fetch(`${this.baseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNum}/labels`, {
      method: "POST",
      headers,
      body: JSON.stringify({ labels: [writeOp.addLabel] })
    });
  }

  async addComment(id, comment) {
    if (!this.writeEnabled) return;
    const issueNum = this.issueNumber(id);
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": "agent-scaffold",
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json"
    };
    await fetch(`${this.baseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNum}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: comment })
    });
  }

  async addLink(id, link) {}
  async claim(id, metadata) {}
  async releaseClaim(id, metadata) {}
}
