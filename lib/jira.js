import { mapProviderState, stateMappingFor, writeMappingFor } from "./workflow.js";

const JIRA_SEARCH_PAGE_SIZE = 100;
const JIRA_SEARCH_MAX_ITEMS = 5_000;

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

export function extractJiraUpstreamDependencyKeys(links = []) {
  const keys = new Set();
  for (const link of links) {
    if (!link || typeof link !== "object") continue;
    const typeName = String(link.type?.name || "").trim().toLowerCase();
    const inward = String(link.type?.inward || "").trim().toLowerCase();
    const outward = String(link.type?.outward || "").trim().toLowerCase();

    // Check inward link (current issue is target of inward relationship)
    if (link.inwardIssue?.key) {
      if (
        inward === "is blocked by" ||
        inward === "blocked by" ||
        inward === "depends on" ||
        (typeName === "blocks" && inward.includes("block"))
      ) {
        keys.add(link.inwardIssue.key);
      }
    }

    // Check outward link (current issue is source of outward relationship)
    if (link.outwardIssue?.key) {
      if (
        outward === "depends on" ||
        outward === "is blocked by" ||
        outward === "blocked by" ||
        (typeName === "dependency" && outward.includes("depend")) ||
        (typeName === "depends" && outward.includes("depend"))
      ) {
        keys.add(link.outwardIssue.key);
      }
    }
  }
  return [...keys];
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
    this.writeMapping = config.writeMapping ? { ...config.writeMapping } : writeMappingFor("jira", config.writeMapping);
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

  shapeWorkItem(raw) {
    const values = raw.fields || {};
    const status = values.status?.name || "Unknown";
    return {
      key: raw.key,
      providerKey: raw.key,
      summary: values.summary || raw.key,
      description: adfText(values.description),
      issueType: values.issuetype?.name || "Issue",
      status,
      canonicalState: mapProviderState("jira", status, this.stateMapping),
      labels: values.labels || [],
      components: (values.components || []).map(component => component?.name || component).filter(Boolean),
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

  async getWorkItem(key) {
    const fields =
      "summary,description,issuetype,status,labels,components,parent,assignee";
    const raw = await this.request(
      "GET",
      `/rest/api/3/issue/${key}?fields=${fields}`
    );
    return this.shapeWorkItem(raw);
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
      requiredLabels: options.requiredLabels,
      canonicalStates: options.canonicalStates
    });
  }

  async searchJqlIssues(jqlText, fields, requestedLimit = 10) {
    const limit = Math.max(1, Math.min(Number(requestedLimit) || 10, JIRA_SEARCH_MAX_ITEMS));
    const issues = [];
    const seenTokens = new Set();
    let nextPageToken = null;

    while (issues.length < limit) {
      const pageSize = Math.min(JIRA_SEARCH_PAGE_SIZE, limit - issues.length);
      const tokenQuery = nextPageToken
        ? `&nextPageToken=${encodeURIComponent(nextPageToken)}`
        : "";
      const raw = await this.request(
        "GET",
        `/rest/api/3/search/jql?jql=${encodeURIComponent(jqlText)}&maxResults=${pageSize}&fields=${fields}${tokenQuery}`
      );
      const pageIssues = Array.isArray(raw.issues) ? raw.issues : [];
      issues.push(...pageIssues.slice(0, limit - issues.length));

      const token = raw.nextPageToken ? String(raw.nextPageToken) : null;
      if (raw.isLast === true || !token || pageIssues.length === 0) break;
      if (seenTokens.has(token)) {
        throw new Error("Jira search pagination returned a repeated nextPageToken");
      }
      seenTokens.add(token);
      nextPageToken = token;
    }

    return issues;
  }

  async listWorkItems(query) {
    const project = query.projectKey;
    const limit = query.limit || 10;
    const parts = [`project = ${project}`];

    if (query.requiredLabels && query.requiredLabels.length > 0) {
      parts.push(`labels = "${query.requiredLabels[0]}"`);
    }

    if (query.canonicalStates && query.canonicalStates.length > 0) {
      const mapping = stateMappingFor("jira", this.stateMapping);
      const providerStates = query.canonicalStates.flatMap((state) => mapping[state] || []);
      if (providerStates.length > 0) {
        const stateStr = providerStates.map(s => `"${s}"`).join(", ");
        parts.push(`status IN (${stateStr})`);
      }
    }

    const jql = parts.join(" AND ") + " ORDER BY priority DESC, created ASC";
    const fields = query.includeDescription === false
      ? "key,summary,issuetype,status,labels,components,parent,assignee"
      : "key,summary,description,issuetype,status,labels,components,parent,assignee";
    const rawItems = await this.searchJqlIssues(jql, fields, limit);
    return Promise.all(rawItems.map((item) =>
      item.fields ? this.shapeWorkItem(item) : this.getWorkItem(item.key)));
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
    const fields = "key,summary,description,issuetype,status,labels,components,parent,assignee";
    const rawItems = await this.searchJqlIssues(
      `parent = ${id} ORDER BY created ASC`,
      fields,
      JIRA_SEARCH_MAX_ITEMS
    );
    return Promise.all(rawItems.map((item) =>
      item.fields ? this.shapeWorkItem(item) : this.getWorkItem(item.key)));
  }

  async getParent(id) {
    const item = await this.getWorkItem(id);
    return item.parentKey ? await this.getWorkItem(item.parentKey) : null;
  }

  async getDependencies(id) {
    const raw = await this.request("GET", `/rest/api/3/issue/${id}?fields=issuelinks`);
    const links = raw.fields?.issuelinks || [];
    const keys = extractJiraUpstreamDependencyKeys(links);
    return Promise.all(keys.map(k => this.getWorkItem(k)));
  }

  async transition(id, canonicalState, metadata) {
    if (!this.writeEnabled) return;
    const targetStatus = this.writeMapping[canonicalState];
    if (!targetStatus) {
      throw new Error(`Jira writeMapping is missing target status for canonical state: "${canonicalState}"`);
    }

    const raw = await this.request("GET", `/rest/api/3/issue/${id}/transitions`);
    const transition = raw.transitions?.find(
      t => t.name.toLowerCase() === targetStatus.toLowerCase() || t.to?.name.toLowerCase() === targetStatus.toLowerCase()
    );
    if (!transition) {
      throw new Error(`No available Jira transition found matching target status "${targetStatus}" for issue ${id}`);
    }
    await this.request("POST", `/rest/api/3/issue/${id}/transitions`, {
      transition: { id: transition.id }
    });
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

  async addLink(id, link) { }
  async claim(id, metadata) { }
  async releaseClaim(id, metadata) { }
}
