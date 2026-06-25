import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("scaffold-manifest.json", "utf8"));
const errors = [];

for (const file of manifest.orchestration_contracts ?? []) {
  if (!fs.existsSync(file)) errors.push(`Missing orchestration contract: ${file}`);
}

for (const file of [
  "adapters/antigravity/pacebuild-orchestrator/SKILL.md",
  "adapters/codex/pacebuild-orchestrator/SKILL.md",
  "adapters/pacebuild-orchestrator.agent.md"
]) {
  if (!fs.existsSync(file)) {
    errors.push(`Missing orchestrator adapter: ${file}`);
    continue;
  }
  const content = fs.readFileSync(file, "utf8");
  if (!content.includes("PACEBUILD_ORCHESTRATOR.md")) {
    errors.push(`Orchestrator adapter does not load canonical contract: ${file}`);
  }
}

for (const role of manifest.core_agents) {
  const file = `core/agents/${role}/AGENT.md`;
  if (!fs.existsSync(file)) errors.push(`Missing agent: ${file}`);
}

for (const file of manifest.personas) {
  if (!fs.existsSync(file)) {
    errors.push(`Missing persona: ${file}`);
    continue;
  }
  const content = fs.readFileSync(file, "utf8");
  if (!content.startsWith("---")) errors.push(`Missing frontmatter: ${file}`);
  for (const field of ["name:", "description:"]) {
    if (!content.includes(field)) errors.push(`Missing ${field} in ${file}`);
  }
}

for (const file of [...manifest.core_skills, ...manifest.pacebuild_skills]) {
  if (!fs.existsSync(file)) {
    errors.push(`Missing skill: ${file}`);
    continue;
  }
  const content = fs.readFileSync(file, "utf8");
  if (!content.startsWith("---")) errors.push(`Missing frontmatter: ${file}`);
  for (const field of ["name:", "description:", "triggers:"]) {
    if (!content.includes(field)) errors.push(`Missing ${field} in ${file}`);
  }
}

for (const file of [
  ...manifest.upstream_core_skills,
  ...manifest.upstream_pacebuild_skills
]) {
  if (!fs.existsSync(file)) {
    errors.push(`Missing upstream skill: ${file}`);
    continue;
  }
  const content = fs.readFileSync(file, "utf8");
  if (!content.startsWith("---")) errors.push(`Missing frontmatter: ${file}`);
  for (const field of ["name:", "description:"]) {
    if (!content.includes(field)) errors.push(`Missing ${field} in ${file}`);
  }
}

const sourceStubs = [];
function findSourceStubs(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name.startsWith(".tmp-")) continue;
    const full = `${directory}/${entry.name}`;
    if (entry.isDirectory()) findSourceStubs(full);
    if (entry.isFile() && entry.name === "SKILL_SOURCE.md") sourceStubs.push(full);
  }
}
findSourceStubs(".");
if (sourceStubs.length) {
  errors.push(`SKILL_SOURCE stubs remain: ${sourceStubs.join(", ")}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `OK: ${manifest.core_agents.length} agents, ` +
      `${manifest.personas.length} personas, ` +
      `${manifest.orchestration_contracts?.length ?? 0} orchestration contracts, ` +
      `${manifest.core_skills.length} core skills, ` +
      `${manifest.upstream_core_skills.length} upstream core skills, ` +
      `${manifest.pacebuild_skills.length} PaceBuild skills, ` +
      `${manifest.upstream_pacebuild_skills.length} upstream PaceBuild skill`
  );
}
