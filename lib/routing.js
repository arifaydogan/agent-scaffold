const routes = [
  {
    keywords: ["jira", "confluence", "requirement", "backlog", "prd"],
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
    keywords: ["database", "timescale", "sql", "migration", "etl"],
    persona: "data-engineer",
    skills: ["database-patterns", "tsdb-patterns", "data-pipeline", "minimal-change"]
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

export function routeIssue(issue) {
  const text = `${issue.summary}\n${issue.description}`.toLowerCase();
  let persona = "backend-engineer";
  let skills = ["api-design", "backend-testing", "minimal-change"];
  let reasons = ["Default engineering route"];
  for (const route of routes) {
    const matches = route.keywords.filter((keyword) => text.includes(keyword));
    if (matches.length) {
      ({ persona, skills } = route);
      reasons = [`Matched: ${matches.join(", ")}`];
      break;
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
  ].some((token) => text.includes(token));
  if (highRisk) {
    skills = [...skills, "security-review"];
    reasons.push("Security-sensitive task");
  }
  const crossService =
    ["frontend", "backend", "database", "cv-engine"].filter((marker) =>
      text.includes(marker)
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
