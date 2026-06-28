import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AliasMode, FullMoaConfig, GsdMoaConfig, UpstreamRoute } from "./types.js";
import { PROVIDER_ID } from "./types.js";

export const DEFAULT_CONFIG_PATH = ".pi/gsd-moa.json";

export const DEFAULT_CONFIG: GsdMoaConfig = {
  primary: {
    provider: "factory-codex",
    model: "gpt-5.5",
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: "$FACTORY_GPT_API_KEY",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    compat: {
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  },
  reference: {
    provider: "zai",
    model: "glm-5.2",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKey: "$ZAI_API_KEY",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 8192,
    compat: {
      thinkingFormat: "zai",
      zaiToolStream: true,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  },
  fullMoa: {
    enabled: true,
    proposers: [
      {
        id: "architect",
        label: "Architecture proposer",
        prompt: "Propose a robust architecture or plan. Emphasize boundaries, interfaces, sequencing, and tradeoffs.",
      },
      {
        id: "reviewer",
        label: "Critical reviewer",
        prompt: "Critique the request and likely solution. Find bugs, missing requirements, risks, and tests that would fail.",
      },
      {
        id: "implementer",
        label: "Implementation proposer",
        prompt: "Draft a practical implementation approach. Emphasize concrete steps, edge cases, and verification.",
      },
    ],
    synthesis: {
      enabled: true,
      prompt: "Synthesize the proposal bundle into concise guidance for the final acting model. Preserve disagreements and important risks; do not call tools or write patches.",
    },
  },
  aliases: {
    "gpt55-glm52-single": { mode: "single" },
    "gpt55-glm52-advisor": { mode: "advisor" },
    "gpt55-glm52-full": { mode: "full_moa" },
    "gpt55-glm52-auto": { mode: "auto" },
  },
  auto: {
    defaultMode: "single",
    advisorKeywords: ["plan", "review", "audit", "verify", "security", "architecture", "debug", "requirements"],
    fullMoaKeywords: ["full moa", "multi-agent", "deep review", "architecture critique", "milestone audit", "threat model"],
    singleKeywords: ["typo", "format", "small edit", "rename"],
  },
  cache: {
    enabled: true,
    dir: ".pi/gsd-moa-cache",
    ttlSeconds: 7 * 24 * 60 * 60,
  },
  trace: {
    enabled: false,
    dir: ".proof/traces",
    includeContexts: true,
    includeOutputs: true,
  },
  prompts: {
    advisorVersion: "v1",
    fullMoaVersion: "v1",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRoute(defaults: UpstreamRoute, override: unknown): UpstreamRoute {
  if (!isRecord(override)) return { ...defaults };
  return {
    ...defaults,
    ...override,
    headers: isRecord(override.headers) ? (override.headers as Record<string, string>) : defaults.headers,
    compat: isRecord(override.compat) ? { ...defaults.compat, ...override.compat } : defaults.compat,
    cost: isRecord(override.cost) ? { ...defaults.cost, ...override.cost } as UpstreamRoute["cost"] : defaults.cost,
    input: Array.isArray(override.input) ? (override.input as ("text" | "image")[]) : defaults.input,
  };
}

export function loadConfig(path = DEFAULT_CONFIG_PATH, cwd = process.cwd()): GsdMoaConfig {
  const fullPath = resolve(cwd, path);
  if (!existsSync(fullPath)) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    applyEnvOverrides(cfg);
    validateConfig(cfg);
    return cfg;
  }

  const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);

  const cfg: GsdMoaConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    primary: mergeRoute(DEFAULT_CONFIG.primary, parsed.primary),
    reference: mergeRoute(DEFAULT_CONFIG.reference, parsed.reference),
    fullMoa: mergeFullMoa(DEFAULT_CONFIG.fullMoa, parsed.fullMoa),
    aliases: isRecord(parsed.aliases)
      ? { ...DEFAULT_CONFIG.aliases, ...(parsed.aliases as GsdMoaConfig["aliases"]) }
      : DEFAULT_CONFIG.aliases,
    auto: isRecord(parsed.auto)
      ? {
          ...DEFAULT_CONFIG.auto,
          ...parsed.auto,
          advisorKeywords: Array.isArray(parsed.auto.advisorKeywords)
            ? (parsed.auto.advisorKeywords as string[])
            : DEFAULT_CONFIG.auto.advisorKeywords,
          fullMoaKeywords: Array.isArray(parsed.auto.fullMoaKeywords)
            ? (parsed.auto.fullMoaKeywords as string[])
            : DEFAULT_CONFIG.auto.fullMoaKeywords,
          singleKeywords: Array.isArray(parsed.auto.singleKeywords)
            ? (parsed.auto.singleKeywords as string[])
            : DEFAULT_CONFIG.auto.singleKeywords,
        }
      : DEFAULT_CONFIG.auto,
    cache: isRecord(parsed.cache) ? { ...DEFAULT_CONFIG.cache, ...parsed.cache } as GsdMoaConfig["cache"] : structuredClone(DEFAULT_CONFIG.cache),
    trace: isRecord(parsed.trace) ? { ...DEFAULT_CONFIG.trace, ...parsed.trace } as GsdMoaConfig["trace"] : structuredClone(DEFAULT_CONFIG.trace),
    prompts: isRecord(parsed.prompts) ? { ...DEFAULT_CONFIG.prompts, ...parsed.prompts } as GsdMoaConfig["prompts"] : structuredClone(DEFAULT_CONFIG.prompts),
  };
  applyEnvOverrides(cfg);
  validateConfig(cfg);
  return cfg;
}

function applyEnvOverrides(cfg: GsdMoaConfig): void {
  if (process.env.GSD_MOA_PRIMARY_BASE_URL) cfg.primary.baseUrl = process.env.GSD_MOA_PRIMARY_BASE_URL;
  if (process.env.GSD_MOA_REFERENCE_BASE_URL) cfg.reference.baseUrl = process.env.GSD_MOA_REFERENCE_BASE_URL;
  if (process.env.GSD_MOA_TRACE !== undefined) {
    cfg.trace.enabled = /^(1|true|yes|on)$/i.test(process.env.GSD_MOA_TRACE);
  }
  if (process.env.GSD_MOA_TRACE_DIR) cfg.trace.dir = process.env.GSD_MOA_TRACE_DIR;
  if (process.env.GSD_MOA_TRACE_INCLUDE_CONTEXTS !== undefined) {
    cfg.trace.includeContexts = /^(1|true|yes|on)$/i.test(process.env.GSD_MOA_TRACE_INCLUDE_CONTEXTS);
  }
  if (process.env.GSD_MOA_TRACE_INCLUDE_OUTPUTS !== undefined) {
    cfg.trace.includeOutputs = /^(1|true|yes|on)$/i.test(process.env.GSD_MOA_TRACE_INCLUDE_OUTPUTS);
  }
}

export function validateConfig(cfg: GsdMoaConfig): void {
  validateRoute("primary", cfg.primary);
  validateRoute("reference", cfg.reference);
  validateFullMoa(cfg.fullMoa, cfg.reference);

  for (const [name, alias] of Object.entries(cfg.aliases)) {
    if (!name.trim()) throw new Error("aliases must not contain blank model ids");
    validateMode(`aliases.${name}.mode`, alias.mode);
  }

  validateMode("auto.defaultMode", cfg.auto.defaultMode);
  if (!Array.isArray(cfg.auto.advisorKeywords)) throw new Error("auto.advisorKeywords must be an array");
  if (!Array.isArray(cfg.auto.fullMoaKeywords)) throw new Error("auto.fullMoaKeywords must be an array");
  if (!Array.isArray(cfg.auto.singleKeywords)) throw new Error("auto.singleKeywords must be an array");
  if (typeof cfg.cache.enabled !== "boolean") throw new Error("cache.enabled must be boolean");
  if (!cfg.cache.dir) throw new Error("cache.dir is required");
  if (!Number.isFinite(cfg.cache.ttlSeconds) || cfg.cache.ttlSeconds < 0) {
    throw new Error("cache.ttlSeconds must be a non-negative number");
  }
  if (typeof cfg.trace.enabled !== "boolean") throw new Error("trace.enabled must be boolean");
  if (!cfg.trace.dir) throw new Error("trace.dir is required");
  if (typeof cfg.trace.includeContexts !== "boolean") throw new Error("trace.includeContexts must be boolean");
  if (typeof cfg.trace.includeOutputs !== "boolean") throw new Error("trace.includeOutputs must be boolean");
  if (!cfg.prompts.advisorVersion) throw new Error("prompts.advisorVersion is required");
  if (!cfg.prompts.fullMoaVersion) throw new Error("prompts.fullMoaVersion is required");
}

export function mergeUpstreamRoute(base: UpstreamRoute, override: Partial<UpstreamRoute> | undefined): UpstreamRoute {
  if (!override) return { ...base, headers: base.headers ? { ...base.headers } : undefined, compat: base.compat ? { ...base.compat } : undefined, cost: base.cost ? { ...base.cost } : undefined, input: base.input ? [...base.input] : undefined };
  return mergeRoute(base, override);
}

function mergeFullMoa(defaults: FullMoaConfig, override: unknown): FullMoaConfig {
  if (!isRecord(override)) return structuredClone(defaults);
  const synthesis = isRecord(override.synthesis)
    ? { ...defaults.synthesis, ...override.synthesis }
    : defaults.synthesis;
  return {
    ...defaults,
    ...override,
    proposers: Array.isArray(override.proposers)
      ? mergeProposers(defaults.proposers, override.proposers)
      : defaults.proposers,
    synthesis,
  };
}

function mergeProposers(defaults: FullMoaConfig["proposers"], overrides: unknown[]): FullMoaConfig["proposers"] {
  const byId = new Map(defaults.map((proposer) => [proposer.id, structuredClone(proposer)]));
  for (const override of overrides) {
    if (!isRecord(override) || typeof override.id !== "string") continue;
    const existing = byId.get(override.id);
    byId.set(override.id, existing ? { ...existing, ...override } as FullMoaConfig["proposers"][number] : override as unknown as FullMoaConfig["proposers"][number]);
  }
  return [...byId.values()];
}

function validateFullMoa(fullMoa: FullMoaConfig, reference: UpstreamRoute): void {
  if (typeof fullMoa.enabled !== "boolean") throw new Error("fullMoa.enabled must be boolean");
  if (!Array.isArray(fullMoa.proposers) || fullMoa.proposers.length < 2) {
    throw new Error("fullMoa.proposers must contain at least two proposers");
  }
  const ids = new Set<string>();
  for (const proposer of fullMoa.proposers) {
    if (!proposer.id?.trim()) throw new Error("fullMoa.proposers[].id is required");
    if (ids.has(proposer.id)) throw new Error(`duplicate fullMoa proposer id: ${proposer.id}`);
    ids.add(proposer.id);
    if (!proposer.label?.trim()) throw new Error(`fullMoa proposer ${proposer.id} label is required`);
    if (!proposer.prompt?.trim()) throw new Error(`fullMoa proposer ${proposer.id} prompt is required`);
    validateRoute(`fullMoa.proposers.${proposer.id}.route`, mergeUpstreamRoute(reference, proposer.route));
  }
  if (typeof fullMoa.synthesis.enabled !== "boolean") throw new Error("fullMoa.synthesis.enabled must be boolean");
  if (fullMoa.synthesis.enabled && !fullMoa.synthesis.prompt?.trim()) throw new Error("fullMoa.synthesis.prompt is required when enabled");
  if (fullMoa.synthesis.route) validateRoute("fullMoa.synthesis.route", mergeUpstreamRoute(reference, fullMoa.synthesis.route));
}

function validateRoute(label: string, route: UpstreamRoute): void {
  if (!route.provider) throw new Error(`${label}.provider is required`);
  if (!route.model) throw new Error(`${label}.model is required`);
  if (route.provider === PROVIDER_ID) {
    throw new Error(`${label}.provider must not be '${PROVIDER_ID}' (recursion guard)`);
  }
}

function validateMode(label: string, mode: AliasMode): void {
  if (!["single", "advisor", "full_moa", "auto"].includes(mode)) {
    throw new Error(`${label} must be one of: single, advisor, full_moa, auto`);
  }
}
