export class CodeIntelligenceProvider {
  constructor(name, config) {
    this.name = name;
    this.config = config;
  }

  async health() { throw new Error("Not implemented"); }
  async getArchitecture(scope) { throw new Error("Not implemented"); }
  async searchCode(query) { throw new Error("Not implemented"); }
  async tracePath(request) { throw new Error("Not implemented"); }
  async detectChanges(request) { throw new Error("Not implemented"); }
  async impactAnalysis(request) { throw new Error("Not implemented"); }
  async checkCoverage(request) { throw new Error("Not implemented"); }
  async getSnippet(request) { throw new Error("Not implemented"); }
}

export class McpCodeIntelligenceProvider extends CodeIntelligenceProvider {
  constructor(name, config) {
    super(name, config);
  }

  mcpEntry() {
    if (this.config.enabled === false || !Array.isArray(this.config.command)) return null;
    return {
      name: this.name,
      transport: this.config.transport || "stdio",
      command: this.config.command[0],
      args: this.config.command.slice(1)
    };
  }
}

export function configuredCodeIntelligenceProviders(settings) {
  return settings.data.codeIntelligence?.providers || {};
}

export function selectedCodeIntelligenceProviderName(settings) {
  const providers = configuredCodeIntelligenceProviders(settings);
  return settings.data.codeIntelligence?.defaultProvider || Object.keys(providers)[0] || null;
}

export function createCodeIntelligenceProvider(settings) {
  const selected = selectedCodeIntelligenceProviderName(settings);
  if (!selected) return null;
  const config = configuredCodeIntelligenceProviders(settings)[selected];
  if (!config) throw new Error(`Unknown code intelligence provider: ${selected}`);
  if (!["mcp", "codebase-memory-mcp"].includes(config.type || "mcp")) {
    throw new Error(`Unsupported code intelligence provider type: ${config.type}`);
  }
  return new McpCodeIntelligenceProvider(selected, config);
}

export function describeCodeIntelligenceProviders(settings) {
  const selected = selectedCodeIntelligenceProviderName(settings);
  return Object.entries(configuredCodeIntelligenceProviders(settings)).map(([name, config]) => ({
    id: name,
    type: config.type || name,
    selected: name === selected,
    enabled: config.enabled !== false,
    transport: config.transport || "stdio",
    commandConfigured: Array.isArray(config.command) && config.command.length > 0,
    readOnly: config.readOnly !== false,
    capabilities: Array.isArray(config.capabilities) ? config.capabilities : []
  }));
}

export function codeIntelligenceMcpEntry(settings) {
  return createCodeIntelligenceProvider(settings)?.mcpEntry() || null;
}
