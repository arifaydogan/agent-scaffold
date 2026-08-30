const routes = [
  {
    keywords: ["jira", "confluence", "requirement", "requirements", "backlog", "prd"],
    persona: "pm-analyst",
    skills: ["jira-management", "confluence-docs", "prd-writing", "minimal-change"]
  },
  {
    keywords: ["frontend", "next.js", "react", "ui", "dashboard"],
    persona: "frontend-engineer",
    skills: ["component-design", "frontend-testing", "minimal-change"]
  },
  {
    keywords: ["cv", "yolo", "bytetrack", "opencv", "camera", "mjpeg"],
    persona: "cv-engineer",
    skills: ["cv-pipeline-checks", "yolo-bytetrack", "opencv-patterns", "minimal-change"]
  },
  {
    keywords: ["database", "timescale", "sql", "schema", "table", "etl"],
    contextualKeywords: ["migration"],
    persona: "data-engineer",
    skills: ["database-patterns", "tsdb-patterns", "data-pipeline", "minimal-change"]
  },
  {
    keywords: ["worktree", "shared-path", "shared path", "path lock", "lock registry", "runtime", "node.js"],
    persona: "backend-engineer",
    skills: ["api-design", "backend-testing", "minimal-change"]
  },
  {
    keywords: ["autonomous", "supervisor", "resident worker", "heartbeat", "orchestration", "control plane"],
    persona: "devops-engineer",
    skills: ["bounded-autonomy", "multi-agent-reliability", "monitoring", "minimal-change"]
  },
  {
    keywords: ["docker", "ci/cd", "pipeline", "deployment", "monitoring"],
    persona: "devops-engineer",
    skills: ["docker-patterns", "ci-cd-patterns", "monitoring", "minimal-change"]
  }
];

const ROUTING_METADATA_HEADINGS = new Set([
  "agent route",
  "agent routing",
  "required skills",
  "skills",
  "source",
  "verification"
]);

function routingDescription(value) {
  const lines = String(value || "").split(/\r?\n/);
  const kept = [];
  let ignoredSection = false;
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      const normalizedHeading = heading[1].trim().toLowerCase().replace(/[:：]$/, "");
      ignoredSection = ROUTING_METADATA_HEADINGS.has(normalizedHeading);
      if (!ignoredSection) kept.push(line);
      continue;
    }
    if (/^\s*(required skills?|agent route|source)\s*:/i.test(line)) continue;
    if (!ignoredSection) kept.push(line);
  }
  return kept.join("\n").toLowerCase();
}

function routeScore(route, summary, description) {
  const summaryMatches = route.keywords.filter(keyword => summary.includes(keyword));
  const bodyMatches = route.keywords.filter(keyword => description.includes(keyword));
  const contextualMatches = (route.contextualKeywords || []).filter(keyword => {
    const fullText = `${summary}\n${description}`;
    const hasDomainContext = route.keywords.some(domain => fullText.includes(domain));
    return hasDomainContext && fullText.includes(keyword);
  });
  return {
    score: (summaryMatches.length * 4) + bodyMatches.length + contextualMatches.length,
    matches: [...new Set([...summaryMatches, ...bodyMatches, ...contextualMatches])]
  };
}

function normalizedPathCandidate(value) {
  const candidate = String(value || "")
    .trim()
    .replace(/^['"`]+|['"`,.;:]+$/g, "")
    .replaceAll("\\*", "*")
    .replaceAll("\\/", "/")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "/**");
  if (!candidate || candidate.includes("..") || candidate.startsWith("/") || /^[a-z]:/i.test(candidate)) return null;
  if (!candidate.includes("/") && !candidate.includes("*")) return null;
  if (!/^[a-z0-9_.*?{}@+-]+(?:\/[a-z0-9_.*?{}@+-]+)*$/i.test(candidate)) return null;
  return candidate;
}

function sectionBody(description, headingPattern) {
  const lines = String(description || "").split(/\r?\n/);
  const output = [];
  let active = false;
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      if (active) break;
      active = headingPattern.test(heading[1].trim());
      continue;
    }
    if (active) output.push(line);
  }
  return output.join("\n");
}

function extractPathTokens(value) {
  const tokens = [];
  for (const match of String(value || "").matchAll(/`([^`]+)`/g)) {
    const candidate = normalizedPathCandidate(match[1]);
    if (candidate) tokens.push(candidate);
  }
  if (tokens.length === 0) {
    for (const raw of String(value || "").split(/[\s,;]+/)) {
      const candidate = normalizedPathCandidate(raw);
      if (candidate) tokens.push(candidate);
    }
  }
  return tokens;
}

export function extractDeclaredAllowedPaths(description) {
  const scopeSection = sectionBody(description, /allowed.*(?:forbidden|scope)|scope.*allowed/i);
  const lines = String(description || "").split(/\r?\n/);
  let allowedText = scopeSection.split(/^\s*(?:[-*]\s*)?forbidden\s*:/im)[0] || "";
  if (!allowedText) {
    const scopeHeadingIndex = lines.findIndex(line => /allowed.*(?:forbidden|scope)|scope.*allowed/i.test(line.trim()));
    const allowedIndex = lines.findIndex((line, index) =>
      index > scopeHeadingIndex && /^\s*(?:[-*]\s*)?allowed\s*:/i.test(line));
    const forbiddenIndex = lines.findIndex((line, index) =>
      index > allowedIndex && /^\s*(?:[-*]\s*)?forbidden\s*:/i.test(line));
    if (allowedIndex >= 0) {
      allowedText = lines.slice(allowedIndex, forbiddenIndex >= 0 ? forbiddenIndex : lines.length).join("\n");
    }
  }
  const allowedMarker = allowedText.match(/(?:^|\n)\s*(?:[-*]\s*)?allowed\s*:\s*([\s\S]*)/i);
  const paths = extractPathTokens(allowedMarker ? allowedMarker[1] : allowedText);

  for (const line of lines) {
    if (/expected test (?:file|path)|test file|verification file/i.test(line)) {
      paths.push(...extractPathTokens(line));
    }
  }
  return [...new Set(paths)];
}

export function routeIssue(issue) {
  const summary = String(issue.summary || "").toLowerCase();
  const description = routingDescription(issue.description);
  const fullText = `${summary}\n${description}`;
  let persona = "backend-engineer";
  let skills = ["api-design", "backend-testing", "minimal-change"];
  let reasons = ["Default engineering route"];
  let bestScore = 0;

  for (const route of routes) {
    const result = routeScore(route, summary, description);
    if (result.score > bestScore) {
      bestScore = result.score;
      ({ persona, skills } = route);
      reasons = [`Matched: ${result.matches.join(", ")}`];
    }
  }

  const highRisk = [
    "credential",
    "secret",
    "auth",
    "authentication",
    "authorization",
    "permission",
    "privacy",
    "gdpr",
    "migration",
    "concurrency",
    "production",
    "delete",
    "payment"
  ].some((token) => fullText.includes(token));
  if (highRisk) {
    skills = [...skills, "security-review"];
    reasons.push("Security-sensitive task");
  }
  const crossService =
    ["frontend", "backend", "database", "cv-engine"].filter((marker) =>
      fullText.includes(marker)
    ).length > 1;

  const cleanSkills = skills.filter((s) => s !== "minimal-change");
  cleanSkills.push("minimal-change");

  return {
    persona,
    skills: cleanSkills,
    risk: highRisk ? "high" : "normal",
    parallelSafe: !crossService,
    reasons
  };
}
