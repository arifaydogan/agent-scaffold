import { mapProviderState } from "./workflow.js";

function adfText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const chunks = [];
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.type === "text") chunks.push(node.text || "");
    if (["paragraph", "heading", "listItem"].includes(node.type)) {
      chunks.push("\n");
    }
    walk(node.content);
  }
  walk(value);
  return chunks.join("").trim();
}

export class JiraClient {
  constructor(config, environment = process.env) {
    this.name = config.providerName || "jira";
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    const email = environment[config.emailEnv];
    const token = environment[config.tokenEnv];
    if (!email || !token) {
      throw new Error("Jira credentials are not available in configured env vars");
    }
    this.authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    this.writeEnabled = Boolean(config.writeEnabled);
    this.stateMapping = config.stateMapping || {};
    this.writeMapping = config.writeMapping || {};
  }

  async request(method, route, body) {
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      throw new Error(`Jira ${method} ${route} failed: ${response.status}`);
    }
    return response.status === 204 ? {} : response.json();
  }

  async getWorkItem(key) {
    const fields =
      "summary,description,issuetype,status,labels,parent,assignee";
    const raw = await this.request(
      "GET",
      `/rest/api/3/issue/${key}?fields=${fields}`
    );
    const values = raw.fields;
    const status = values.status.name;
    return {
      key: raw.key,
      providerKey: raw.key,
      summary: values.summary,
      description: adfText(values.description),
      issueType: values.issuetype.name,
      status,
      canonicalState: mapProviderState("jira", status, this.stateMapping),
      labels: values.labels || [],
      parentKey: values.parent?.key || null,
      assignee: values.assignee?.displayName || null,
      source: {
        provider: this.name,
        id: raw.id || raw.key,
        url: `${this.baseUrl}/browse/${encodeURIComponent(raw.key)}`
      },
      raw
    };
  }

  async getIssue(key) {
    return this.getWorkItem(key);
  }

  async poll(projectOrOptions, requiredLabel, legacyLimit) {
    const options = typeof projectOrOptions === "object"
      ? projectOrOptions
      : { projectKey: projectOrOptions, requiredLabels: [requiredLabel], limit: legacyLimit };
    return this.listWorkItems({
      projectKey: options.projectKey,
      limit: options.limit || 10,
      requiredLabels: options.requiredLabels
    });
  }

  async listWorkItems(query) {
    const project = query.projectKey;
    const limit = query.limit || 10;
    const parts = [`project = ${project}`];
    
    if (query.requiredLabels && query.requiredLabels.length > 0) {
      parts.push(`labels = "${query.requiredLabels[0]}"`);
    }
    
    if (query.canonicalStates && query.canonicalStates.length > 0) {
      // Map canonical states back to provider states
      const providerStates = query.canonicalStates.flatMap((state) => {
        // Find mapped provider states from stateMapping
        const mapped = this.stateMapping[state] || [];
        return mapped.length > 0 ? mapped : [];
      });
      if (providerStates.length > 0) {
        const stateStr = providerStates.map(s => `"${s}"`).join(", ");
        parts.push(`status IN (${stateStr})`);
      }
    }

    const jql = encodeURIComponent(parts.join(" AND ") + " ORDER BY priority DESC, created ASC");
    const raw = await this.request(
      "GET",
      `/rest/api/3/search/jql?jql=${jql}&maxResults=${limit}&fields=key`
    );
    return Promise.all((raw.issues || []).map((item) => this.getWorkItem(item.key)));
  }

  async getComments(id) {
    const raw = await this.request("GET", `/rest/api/3/issue/${id}/comment`);
    return (raw.comments || []).map(c => ({
      id: c.id,
      author: c.author?.displayName || "Unknown",
      body: adfText(c.body),
      created: c.created
    }));
  }

  async getChildren(id) {
    const jql = encodeURIComponent(`parent = ${id} ORDER BY created ASC`);
    const raw = await this.request(
      "GET",
      `/rest/api/3/search/jql?jql=${jql}&maxResults=100&fields=key`
    );
    return Promise.all((raw.issues || []).map((item) => this.getWorkItem(item.key)));
  }

  async getParent(id) {
    const item = await this.getWorkItem(id);
    return item.parentKey ? await this.getWorkItem(item.parentKey) : null;
  }

  async getDependencies(id) {
    const raw = await this.request("GET", `/rest/api/3/issue/${id}?fields=issuelinks`);
    const links = raw.fields.issuelinks || [];
    // Just return keys of linked issues for simplicity
    const keys = [];
    for (const link of links) {
      if (link.outwardIssue) keys.push(link.outwardIssue.key);
      if (link.inwardIssue) keys.push(link.inwardIssue.key);
    }
    return Promise.all(keys.map(k => this.getWorkItem(k)));
  }

  async transition(id, canonicalState, metadata) {
    if (!this.writeEnabled) return;
    const targetStatus = this.writeMapping[canonicalState];
    if (!targetStatus) return;

    const raw = await this.request("GET", `/rest/api/3/issue/${id}/transitions`);
    const transition = raw.transitions?.find(t => t.name.toLowerCase() === targetStatus.toLowerCase() || t.to?.name.toLowerCase() === targetStatus.toLowerCase());
    if (transition) {
      await this.request("POST", `/rest/api/3/issue/${id}/transitions`, {
        transition: { id: transition.id }
      });
    }
  }

  async addComment(id, comment) {
    if (!this.writeEnabled) return;
    // Simple ADF generation for text
    const adf = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: comment }] }]
    };
    await this.request("POST", `/rest/api/3/issue/${id}/comment`, { body: adf });
  }

  async addLink(id, link) {}
  async claim(id, metadata) {}
  async releaseClaim(id, metadata) {}
}
