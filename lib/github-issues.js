import { mapProviderState, stateMappingFor } from "./workflow.js";

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
    const mapping = stateMappingFor("github-issues", this.stateMapping);
    const requiredLabels = (query.requiredLabels || []).filter(Boolean);
    const results = new Map();

    if (query.canonicalStates && query.canonicalStates.length > 0) {
      const stateLabels = query.canonicalStates.flatMap(state => mapping[state] || []).filter(Boolean);
      const labelQueries = stateLabels.length > 0
        ? stateLabels.map(sl => [...requiredLabels, sl])
        : [requiredLabels];

      for (const labels of labelQueries) {
        const searchParams = new URLSearchParams({ state: "open", per_page: String(limit) });
        if (labels.length > 0) {
          searchParams.set("labels", labels.join(","));
        }
        try {
          const raw = await this.request(
            `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues?${searchParams}`
          );
          for (const item of raw) {
            if (!item.pull_request && !results.has(item.number)) {
              results.set(item.number, item);
            }
          }
        } catch {
          // If a subquery fails, continue to next
        }
      }
    } else {
      const searchParams = new URLSearchParams({ state: "open", per_page: String(limit) });
      if (requiredLabels.length > 0) {
        searchParams.set("labels", requiredLabels.join(","));
      }
      const raw = await this.request(
        `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues?${searchParams}`
      );
      for (const item of raw) {
        if (!item.pull_request && !results.has(item.number)) {
          results.set(item.number, item);
        }
      }
    }

    return Array.from(results.values())
      .map((item) => this.shapeIssue(item))
      .filter((issue) => {
        if (query.canonicalStates && query.canonicalStates.length > 0) {
          if (!query.canonicalStates.includes(issue.canonicalState)) return false;
        }
        if (requiredLabels.length > 0) {
          if (!requiredLabels.every(l => issue.labels.includes(l))) return false;
        }
        return true;
      })
      .slice(0, limit);
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
    const mapping = stateMappingFor("github-issues", this.stateMapping);
    
    // Collect all canonical workflow labels that should be removed when transitioning
    const allWorkflowLabels = new Set(
      Object.values(mapping).flat().map(l => l.toLowerCase())
    );

    const issueNum = this.issueNumber(id);
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": "agent-scaffold",
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json"
    };

    // First fetch current issue to preserve unrelated labels
    const current = await this.request(
      `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNum}`
    );
    const currentLabels = labelNames(current.labels);

    // Keep unrelated labels, remove old canonical workflow labels
    const newLabels = currentLabels.filter(label => !allWorkflowLabels.has(label.toLowerCase()));
    
    if (writeOp?.addLabel) {
      newLabels.push(writeOp.addLabel);
    } else if (mapping[canonicalState]?.[0]) {
      newLabels.push(mapping[canonicalState][0]);
    }

    const labelRes = await fetch(`${this.baseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNum}/labels`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ labels: [...new Set(newLabels)] })
    });
    if (!labelRes.ok) {
      throw new Error(`GitHub Issues PUT labels failed for issue #${issueNum}: ${labelRes.status}`);
    }

    if (writeOp?.state) {
      const stateRes = await fetch(`${this.baseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNum}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ state: writeOp.state })
      });
      if (!stateRes.ok) {
        throw new Error(`GitHub Issues PATCH state failed for issue #${issueNum}: ${stateRes.status}`);
      }
    }
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
    const response = await fetch(`${this.baseUrl}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}/issues/${issueNum}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body: comment })
    });
    if (!response.ok) {
      throw new Error(`GitHub Issues POST comment failed for issue #${issueNum}: ${response.status}`);
    }
    return response.json();
  }

  async addLink(id, link) {}
  async claim(id, metadata) {}
  async releaseClaim(id, metadata) {}
}
