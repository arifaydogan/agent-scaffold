import fs from "node:fs";
import path from "node:path";
import { describeCodeIntelligenceProviders } from "./code-intelligence.js";

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

export function buildCapabilityRegistry(settings) {
  const root = path.dirname(settings.source);
  const lock = readJson(path.join(root, "sources.lock.json")) || { sources: [], capabilities: [] };
  const sources = new Map((lock.sources || []).map((source) => [source.id, source]));
  const skills = (lock.capabilities || []).map((capability) => ({
    id: capability.id,
    kind: "skill",
    enabled: true,
    path: capability.skill_path,
    providers: [],
    provenance: (capability.source_ids || []).map((id) => ({
      id,
      repo: sources.get(id)?.repo || null,
      commit: sources.get(id)?.commit || null
    }))
  }));
  const services = describeCodeIntelligenceProviders(settings).map((provider) => ({
    id: provider.id,
    kind: "code-intelligence",
    enabled: provider.enabled,
    path: null,
    providers: [provider.id],
    capabilities: provider.capabilities,
    provenance: []
  }));
  return [...skills, ...services].sort((a, b) => a.id.localeCompare(b.id));
}
