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
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    const email = environment[config.emailEnv];
    const token = environment[config.tokenEnv];
    if (!email || !token) {
      throw new Error("Jira credentials are not available in configured env vars");
    }
    this.authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
    this.writeEnabled = Boolean(config.writeEnabled);
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

  async getIssue(key) {
    const fields =
      "summary,description,issuetype,status,labels,parent,assignee";
    const raw = await this.request(
      "GET",
      `/rest/api/3/issue/${key}?fields=${fields}`
    );
    const values = raw.fields;
    return {
      key: raw.key,
      summary: values.summary,
      description: adfText(values.description),
      issueType: values.issuetype.name,
      status: values.status.name,
      labels: values.labels || [],
      parentKey: values.parent?.key || null,
      assignee: values.assignee?.displayName || null,
      raw
    };
  }

  async poll(project, requiredLabel, limit) {
    const jql = encodeURIComponent(
      `project = ${project} AND labels = "${requiredLabel}" ORDER BY priority DESC, created ASC`
    );
    const raw = await this.request(
      "GET",
      `/rest/api/3/search/jql?jql=${jql}&maxResults=${limit}&fields=key`
    );
    return Promise.all((raw.issues || []).map((item) => this.getIssue(item.key)));
  }
}
