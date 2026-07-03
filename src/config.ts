import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getRuntime } from "./pi-compat.js";
import { buildDefaultAliasMap } from "./registry.js";
import type { AliasMode, DefaultReasoningEffort, FullMoaConfig, FullMoaProposerConfig, FullMoaSynthesisConfig, GsdMoaConfig, ModelRef, ReasoningEffort, UpstreamRoute } from "./types.js";
import { PROVIDER_ID } from "./types.js";

export const DEFAULT_CONFIG_PATH = ".pi/gsd-moa.json";

const FACTORY_GPT_METADATA = {
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
};

const GLM_METADATA = {
  reasoning: true,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
};

function zaiCompat(): Record<string, unknown> {
  return {
    thinkingFormat: "zai",
    ...(getRuntime() === "pi" ? { zaiToolStream: true } : {}),
    supportsDeveloperRole: false,
    supportsReasoningParams: true,
    supportsReasoningEffort: true,
    reasoningDisableMode: "zai-thinking-disabled",
    maxTokensField: "max_tokens",
  };
}

export function buildDefaultRoutePresets(): GsdMoaConfig["routePresets"] {
  return {
    "factory-codex-local": {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKey: "$FACTORY_GPT_API_KEY",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningParams: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    },
    "zai-coding-plan": {
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKey: "$ZAI_API_KEY",
      compat: zaiCompat(),
    },
    cliproxyapi: {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8318/v1",
      apiKey: "$CLIPROXY_API_KEY",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningParams: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    },
    "cliproxyapi-codex": {
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8318/v1",
      apiKey: "$CLIPROXY_API_KEY",
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningParams: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
      },
    },
  };
}

export const DEFAULT_ROUTE_PRESETS: GsdMoaConfig["routePresets"] = buildDefaultRoutePresets();

export const DEFAULT_CONFIG: GsdMoaConfig = {
  defaultEffort: "high",
  benchmarkIntegrity: false,
  routePresets: structuredClone(DEFAULT_ROUTE_PRESETS),
  primary: defaultPrimaryRoute(DEFAULT_ROUTE_PRESETS),
  reference: defaultReferenceRoute(DEFAULT_ROUTE_PRESETS),
  fullMoa: {
    enabled: true,
    proposers: [
      {
        id: "glm52",
        label: "GLM-5.2 reference",
      },
      {
        id: "gpt55",
        label: "GPT-5.5 reference",
        modelRef: "factory-codex/gpt-5.5",
        routePreset: "factory-codex-local",
        route: { ...FACTORY_GPT_METADATA },
      },
    ],
    synthesis: {
      enabled: true,
      modelRef: "factory-codex/gpt-5.5",
      routePreset: "factory-codex-local",
      route: { ...FACTORY_GPT_METADATA },
      prompt: "Synthesize the reference responses into a private execution memo for the final acting model, not a user-facing answer. Include: goal, likely tool calls or commands, files/services to inspect, verification commands, risks, and disagreements. If tools are available and the task requires repository, file, terminal, or environment changes, tell the final actor to execute with tools rather than merely describe setup. Do not call tools or write patches.",
    },
  },
  aliases: buildDefaultAliasMap(),
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
    fullMoaVersion: "v2",
  },
  checkpoint: {
    enabled: true,
    maxToolResults: 4,
    driftToolResultThreshold: 3,
  },
  timeAware: {
    enabled: true,
    reserveRatio: 0.10,
    exploreRatio: 0.30,
    implementRatio: 0.60,
    validateRatio: 0.90,
    graceRatio: 0.05,
    minReserveMs: 60_000,
    downgradeInValidate: true,
  },
  asyncAdvisor: {
    enabled: false,
    maxPendingMs: 600_000,
  },
  referenceTimeoutMs: 120000,
  referenceMaxTokens: undefined,
};

function defaultPrimaryRoute(routePresets: GsdMoaConfig["routePresets"]): UpstreamRoute {
  return mergeRoute({ provider: "factory-codex", model: "gpt-5.5" } as UpstreamRoute, {
    ...routePresets["factory-codex-local"],
    ...FACTORY_GPT_METADATA,
  });
}

function defaultReferenceRoute(routePresets: GsdMoaConfig["routePresets"]): UpstreamRoute {
  return mergeRoute({ provider: "zai", model: "glm-5.2" } as UpstreamRoute, {
    ...routePresets["zai-coding-plan"],
    ...GLM_METADATA,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EFFORT_VALUES = ["minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_EFFORT_VALUES = [...EFFORT_VALUES, "inherit"] as const;

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (EFFORT_VALUES as readonly string[]).includes(value);
}

function isDefaultEffort(value: unknown): value is DefaultReasoningEffort {
  return typeof value === "string" && (DEFAULT_EFFORT_VALUES as readonly string[]).includes(value);
}

function parseDefaultEffort(value: unknown, fallback: DefaultReasoningEffort): DefaultReasoningEffort {
  return value === undefined ? fallback : value as DefaultReasoningEffort;
}

function mergeRoute(defaults: UpstreamRoute, override: unknown): UpstreamRoute {
  if (!isRecord(override)) return cloneRoute(defaults);
  const modelRefRoute = routeFromModelRef(override.modelRef);
  const { modelRef: _modelRef, routePreset: _routePreset, ...routeOverride } = override;
  const base = modelRefRoute ?? defaults;
  return {
    ...cloneRoute(base),
    ...routeOverride,
    ...modelRefRoute,
    headers: isRecord(override.headers) ? (override.headers as Record<string, string>) : base.headers,
    compat: isRecord(override.compat) ? { ...base.compat, ...override.compat } : base.compat,
    cost: isRecord(override.cost) ? { ...base.cost, ...override.cost } as UpstreamRoute["cost"] : base.cost,
    input: Array.isArray(override.input) ? (override.input as ("text" | "image")[]) : base.input,
  };
}

function cloneRoute(route: UpstreamRoute): UpstreamRoute {
  return {
    ...route,
    headers: route.headers ? { ...route.headers } : undefined,
    compat: route.compat ? { ...route.compat } : undefined,
    cost: route.cost ? { ...route.cost } : undefined,
    input: route.input ? [...route.input] : undefined,
  };
}

export function parseModelRef(modelRef: ModelRef): { provider: string; model: string } {
  if (typeof modelRef === "string") {
    const slash = modelRef.indexOf("/");
    if (slash <= 0 || slash === modelRef.length - 1) {
      throw new Error(`modelRef must use provider/model form: ${modelRef}`);
    }
    return { provider: modelRef.slice(0, slash), model: modelRef.slice(slash + 1) };
  }
  return { provider: modelRef.provider, model: modelRef.model };
}

function routeFromModelRef(value: unknown): UpstreamRoute | undefined {
  if (typeof value !== "string" && !isRecord(value)) return undefined;
  const { provider, model } = parseModelRef(value as ModelRef);
  return { provider, model };
}

interface ConfigCacheEntry {
  state: "absent" | "present";
  mtimeMs?: number;
  config: GsdMoaConfig;
}

const configCache = new Map<string, ConfigCacheEntry>();

export function resetConfigCache(): void {
  configCache.clear();
}

export function loadConfig(path = DEFAULT_CONFIG_PATH, cwd = process.cwd()): GsdMoaConfig {
  const fullPath = resolve(cwd, path);
  const base = loadConfigBase(fullPath, path);
  const cfg = structuredClone(base);
  applyEnvOverrides(cfg);
  validateConfig(cfg);
  return cfg;
}

function loadConfigBase(fullPath: string, displayPath: string): GsdMoaConfig {
  const stat = statConfig(fullPath);
  const state = stat ? "present" : "absent";
  const cached = configCache.get(fullPath);
  if (cached && cached.state === state && cached.mtimeMs === stat?.mtimeMs) {
    return cached.config;
  }

  const config = stat ? parseConfigFile(fullPath, displayPath) : structuredClone(DEFAULT_CONFIG);
  validateConfig(config);
  configCache.set(fullPath, { state, mtimeMs: stat?.mtimeMs, config });
  return config;
}

function statConfig(fullPath: string): { mtimeMs: number } | undefined {
  try {
    return { mtimeMs: statSync(fullPath).mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseConfigFile(fullPath: string, displayPath: string): GsdMoaConfig {
  const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${displayPath} must contain a JSON object`);

  const routePresets = isRecord(parsed.routePresets)
    ? mergeRoutePresets(DEFAULT_CONFIG.routePresets, parsed.routePresets)
    : structuredClone(DEFAULT_CONFIG.routePresets);
  return {
    ...structuredClone(DEFAULT_CONFIG),
    defaultEffort: parseDefaultEffort(parsed.defaultEffort, DEFAULT_CONFIG.defaultEffort),
    benchmarkIntegrity: typeof parsed.benchmarkIntegrity === "boolean" ? parsed.benchmarkIntegrity : DEFAULT_CONFIG.benchmarkIntegrity,
    routePresets,
    primary: mergeRoute(defaultPrimaryRoute(routePresets), parsed.primary),
    reference: mergeRoute(defaultReferenceRoute(routePresets), parsed.reference),
    fullMoa: mergeFullMoa(DEFAULT_CONFIG.fullMoa, parsed.fullMoa),
    aliases: isRecord(parsed.aliases)
      ? { ...structuredClone(DEFAULT_CONFIG.aliases), ...(parsed.aliases as GsdMoaConfig["aliases"]) }
      : structuredClone(DEFAULT_CONFIG.aliases),
    auto: isRecord(parsed.auto)
      ? {
          ...structuredClone(DEFAULT_CONFIG.auto),
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
      : structuredClone(DEFAULT_CONFIG.auto),
    cache: isRecord(parsed.cache) ? { ...DEFAULT_CONFIG.cache, ...parsed.cache } as GsdMoaConfig["cache"] : structuredClone(DEFAULT_CONFIG.cache),
    trace: isRecord(parsed.trace) ? { ...DEFAULT_CONFIG.trace, ...parsed.trace } as GsdMoaConfig["trace"] : structuredClone(DEFAULT_CONFIG.trace),
    prompts: isRecord(parsed.prompts) ? { ...DEFAULT_CONFIG.prompts, ...parsed.prompts } as GsdMoaConfig["prompts"] : structuredClone(DEFAULT_CONFIG.prompts),
    checkpoint: isRecord(parsed.checkpoint) ? { ...DEFAULT_CONFIG.checkpoint, ...parsed.checkpoint } as GsdMoaConfig["checkpoint"] : structuredClone(DEFAULT_CONFIG.checkpoint),
    timeAware: isRecord(parsed.timeAware) ? { ...DEFAULT_CONFIG.timeAware, ...parsed.timeAware } as GsdMoaConfig["timeAware"] : structuredClone(DEFAULT_CONFIG.timeAware),
    asyncAdvisor: isRecord(parsed.asyncAdvisor) ? { ...DEFAULT_CONFIG.asyncAdvisor, ...parsed.asyncAdvisor } as GsdMoaConfig["asyncAdvisor"] : structuredClone(DEFAULT_CONFIG.asyncAdvisor),
    referenceTimeoutMs: typeof parsed.referenceTimeoutMs === "number" ? parsed.referenceTimeoutMs : DEFAULT_CONFIG.referenceTimeoutMs,
    referenceMaxTokens: typeof parsed.referenceMaxTokens === "number" ? parsed.referenceMaxTokens : DEFAULT_CONFIG.referenceMaxTokens,
  };
}

function applyEnvOverrides(cfg: GsdMoaConfig): void {
  const originalPrimaryProvider = cfg.primary.provider;
  const originalPrimaryModel = cfg.primary.model;
  const originalReferenceProvider = cfg.reference.provider;
  const originalReferenceModel = cfg.reference.model;
  if (process.env.GSD_MOA_PRIMARY_BASE_URL) {
    cfg.primary.baseUrl = process.env.GSD_MOA_PRIMARY_BASE_URL;
    applyRouteBaseUrlOverride(cfg.fullMoa, cfg.routePresets, cfg.reference, originalPrimaryProvider, originalPrimaryModel, process.env.GSD_MOA_PRIMARY_BASE_URL);
  }
  if (process.env.GSD_MOA_REFERENCE_BASE_URL) {
    cfg.reference.baseUrl = process.env.GSD_MOA_REFERENCE_BASE_URL;
    applyRouteBaseUrlOverride(cfg.fullMoa, cfg.routePresets, cfg.reference, originalReferenceProvider, originalReferenceModel, process.env.GSD_MOA_REFERENCE_BASE_URL);
  }
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
  if (process.env.GSD_MOA_CHECKPOINTS !== undefined) {
    cfg.checkpoint.enabled = /^(1|true|yes|on)$/i.test(process.env.GSD_MOA_CHECKPOINTS);
  }
  if (process.env.GSD_MOA_CHECKPOINT_MAX_TOOL_RESULTS !== undefined) {
    cfg.checkpoint.maxToolResults = Number(process.env.GSD_MOA_CHECKPOINT_MAX_TOOL_RESULTS);
  }
  if (process.env.GSD_MOA_CHECKPOINT_DRIFT_TOOL_RESULTS !== undefined) {
    cfg.checkpoint.driftToolResultThreshold = Number(process.env.GSD_MOA_CHECKPOINT_DRIFT_TOOL_RESULTS);
  }
  if (process.env.GSD_MOA_TIME_AWARE !== undefined) {
    cfg.timeAware.enabled = /^(1|true|yes|on)$/i.test(process.env.GSD_MOA_TIME_AWARE);
  }
  if (process.env.GSD_MOA_BENCH_INTEGRITY !== undefined) {
    cfg.benchmarkIntegrity = /^(1|true|yes|on)$/i.test(process.env.GSD_MOA_BENCH_INTEGRITY);
  }
  if (process.env.GSD_MOA_REFERENCE_TIMEOUT_MS !== undefined) {
    cfg.referenceTimeoutMs = Number(process.env.GSD_MOA_REFERENCE_TIMEOUT_MS);
  }
  if (process.env.GSD_MOA_REFERENCE_MAX_TOKENS !== undefined) {
    cfg.referenceMaxTokens = Number(process.env.GSD_MOA_REFERENCE_MAX_TOKENS);
  }
  if (process.env.GSD_MOA_EFFORT !== undefined) {
    cfg.defaultEffort = parseDefaultEffort(process.env.GSD_MOA_EFFORT, cfg.defaultEffort);
  }
}

function applyRouteBaseUrlOverride(
  fullMoa: FullMoaConfig,
  routePresets: GsdMoaConfig["routePresets"],
  reference: UpstreamRoute,
  provider: string,
  model: string,
  baseUrl: string,
): void {
  for (const proposer of fullMoa.proposers) {
    const route = resolveProposerRoute(reference, proposer, routePresets);
    if (route.provider === provider && route.model === model) proposer.route = { ...(proposer.route ?? {}), baseUrl };
  }
  const synthesisRoute = resolveSynthesisRoute(reference, fullMoa.synthesis, routePresets);
  if (synthesisRoute.provider === provider && synthesisRoute.model === model) {
    fullMoa.synthesis.route = { ...(fullMoa.synthesis.route ?? {}), baseUrl };
  }
}

export function validateConfig(cfg: GsdMoaConfig): void {
  validateDefaultEffort("defaultEffort", cfg.defaultEffort);
  if (typeof cfg.benchmarkIntegrity !== "boolean") throw new Error("benchmarkIntegrity must be boolean");
  validateRoutePresets(cfg.routePresets);
  validateRoute("primary", cfg.primary);
  validateRoute("reference", cfg.reference);
  validateFullMoa(cfg.fullMoa, cfg.reference, cfg.routePresets);

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
  if (typeof cfg.checkpoint.enabled !== "boolean") throw new Error("checkpoint.enabled must be boolean");
  if (!Number.isInteger(cfg.checkpoint.maxToolResults) || cfg.checkpoint.maxToolResults < 1) {
    throw new Error("checkpoint.maxToolResults must be a positive integer");
  }
  if (!Number.isInteger(cfg.checkpoint.driftToolResultThreshold) || cfg.checkpoint.driftToolResultThreshold < 1) {
    throw new Error("checkpoint.driftToolResultThreshold must be a positive integer");
  }
  validateTimeAware(cfg.timeAware);
  if (typeof cfg.asyncAdvisor.enabled !== "boolean") throw new Error("asyncAdvisor.enabled must be boolean");
  if (!Number.isInteger(cfg.asyncAdvisor.maxPendingMs) || cfg.asyncAdvisor.maxPendingMs < 1) {
    throw new Error("asyncAdvisor.maxPendingMs must be a positive integer");
  }
  if (!Number.isInteger(cfg.referenceTimeoutMs) || cfg.referenceTimeoutMs < 1) {
    throw new Error("referenceTimeoutMs must be a positive integer");
  }
  validateOptionalPositiveInteger("referenceMaxTokens", cfg.referenceMaxTokens);
}

function validateTimeAware(timeAware: GsdMoaConfig["timeAware"]): void {
  if (typeof timeAware.enabled !== "boolean") throw new Error("timeAware.enabled must be boolean");
  if (typeof timeAware.downgradeInValidate !== "boolean") throw new Error("timeAware.downgradeInValidate must be boolean");
  const ratios: Array<[string, number]> = [
    ["timeAware.reserveRatio", timeAware.reserveRatio],
    ["timeAware.exploreRatio", timeAware.exploreRatio],
    ["timeAware.implementRatio", timeAware.implementRatio],
    ["timeAware.validateRatio", timeAware.validateRatio],
    ["timeAware.graceRatio", timeAware.graceRatio],
  ];
  for (const [label, value] of ratios) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be a ratio between 0 and 1`);
  }
  if (!(timeAware.exploreRatio <= timeAware.implementRatio && timeAware.implementRatio <= timeAware.validateRatio)) {
    throw new Error("timeAware phase ratios must be cumulative: exploreRatio <= implementRatio <= validateRatio");
  }
  if (!Number.isInteger(timeAware.minReserveMs) || timeAware.minReserveMs < 0) {
    throw new Error("timeAware.minReserveMs must be a non-negative integer");
  }
}

export function mergeUpstreamRoute(base: UpstreamRoute, override: Partial<UpstreamRoute> | undefined): UpstreamRoute {
  if (!override) return cloneRoute(base);
  return mergeRoute(base, override);
}

export function resolveProposerRoute(
  reference: UpstreamRoute,
  proposer: FullMoaProposerConfig,
  routePresets: GsdMoaConfig["routePresets"] = {},
): UpstreamRoute {
  return resolvePortfolioRoute(reference, proposer.modelRef, proposer.routePreset, proposer.route, routePresets);
}

export function resolveSynthesisRoute(
  reference: UpstreamRoute,
  synthesis: FullMoaSynthesisConfig,
  routePresets: GsdMoaConfig["routePresets"] = {},
): UpstreamRoute {
  return resolvePortfolioRoute(reference, synthesis.modelRef, synthesis.routePreset, synthesis.route, routePresets);
}

function resolvePortfolioRoute(
  reference: UpstreamRoute,
  modelRef: ModelRef | undefined,
  routePreset: string | undefined,
  route: Partial<UpstreamRoute> | undefined,
  routePresets: GsdMoaConfig["routePresets"],
): UpstreamRoute {
  const base = modelRef ? parseModelRef(modelRef) as UpstreamRoute : reference;
  const preset = routePreset ? routePresets[routePreset] : undefined;
  if (routePreset && !preset) throw new Error(`unknown routePreset: ${routePreset}`);
  return mergeUpstreamRoute(mergeUpstreamRoute(base, preset), route);
}

function mergeRoutePresets(defaults: GsdMoaConfig["routePresets"], overrides: Record<string, unknown>): GsdMoaConfig["routePresets"] {
  const merged = structuredClone(defaults);
  for (const [name, override] of Object.entries(overrides)) {
    if (!isRecord(override)) continue;
    const existing = merged[name] ?? {};
    merged[name] = mergeRoute(existing as UpstreamRoute, override);
  }
  return merged;
}

function mergeFullMoa(defaults: FullMoaConfig, override: unknown): FullMoaConfig {
  if (!isRecord(override)) return structuredClone(defaults);
  const synthesis = isRecord(override.synthesis)
    ? {
        ...structuredClone(defaults.synthesis),
        ...override.synthesis,
        modelRef: isModelRef(override.synthesis.modelRef) ? override.synthesis.modelRef as ModelRef : defaults.synthesis.modelRef,
        routePreset: typeof override.synthesis.routePreset === "string" ? override.synthesis.routePreset : defaults.synthesis.routePreset,
        route: isRecord(override.synthesis.route)
          ? mergePartialRoute(defaults.synthesis.route, override.synthesis.route)
          : structuredClone(defaults.synthesis.route),
      }
    : structuredClone(defaults.synthesis);
  return {
    ...defaults,
    ...override,
    proposers: Array.isArray(override.proposers)
      ? mergeProposers(defaults.proposers, override.proposers)
      : structuredClone(defaults.proposers),
    synthesis,
  };
}

function mergeProposers(defaults: FullMoaConfig["proposers"], overrides: unknown[]): FullMoaConfig["proposers"] {
  const byId = new Map(defaults.map((proposer) => [proposer.id, structuredClone(proposer)]));
  for (const override of overrides) {
    if (!isRecord(override) || typeof override.id !== "string") continue;
    const existing = byId.get(override.id);
    if (existing) {
      byId.set(override.id, {
        ...existing,
        ...override,
        modelRef: isModelRef(override.modelRef) ? override.modelRef as ModelRef : existing.modelRef,
        routePreset: typeof override.routePreset === "string" ? override.routePreset : existing.routePreset,
        route: isRecord(override.route) ? mergePartialRoute(existing.route, override.route) : existing.route,
        when: isRecord(override.when) ? override.when as FullMoaProposerConfig["when"] : existing.when,
      } as FullMoaConfig["proposers"][number]);
    } else {
      byId.set(override.id, override as unknown as FullMoaConfig["proposers"][number]);
    }
  }
  return [...byId.values()];
}

function mergePartialRoute(defaults: Partial<UpstreamRoute> | undefined, override: unknown): Partial<UpstreamRoute> | undefined {
  if (!isRecord(override)) return defaults ? structuredClone(defaults) : undefined;
  if (!defaults) return override as Partial<UpstreamRoute>;
  return mergeRoute(defaults as UpstreamRoute, override);
}

function isModelRef(value: unknown): value is ModelRef {
  return typeof value === "string" || (isRecord(value) && typeof value.provider === "string" && typeof value.model === "string");
}

function validateRoutePresets(routePresets: GsdMoaConfig["routePresets"]): void {
  if (!isRecord(routePresets)) throw new Error("routePresets must be an object");
  for (const [name, preset] of Object.entries(routePresets)) {
    if (!name.trim()) throw new Error("routePresets must not contain blank names");
    if (!isRecord(preset)) throw new Error(`routePresets.${name} must be an object`);
    validateRouteEffort(`routePresets.${name}.effort`, preset.effort);
    validateRouteTemperature(`routePresets.${name}.temperature`, preset.temperature);
  }
}

function validateDefaultEffort(label: string, effort: unknown): void {
  if (!isDefaultEffort(effort)) throw new Error(`${label} must be one of: ${DEFAULT_EFFORT_VALUES.join(", ")}`);
}

function validateRouteEffort(label: string, effort: unknown): void {
  if (effort !== undefined && !isReasoningEffort(effort)) throw new Error(`${label} must be one of: ${EFFORT_VALUES.join(", ")}`);
}

function validateRouteTemperature(label: string, temperature: unknown): void {
  if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new Error(`${label} must be a number between 0 and 2`);
  }
}

function validateOptionalPositiveInteger(label: string, value: unknown): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function validateFullMoa(fullMoa: FullMoaConfig, reference: UpstreamRoute, routePresets: GsdMoaConfig["routePresets"]): void {
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
    if (proposer.enabled !== undefined && typeof proposer.enabled !== "boolean") {
      throw new Error(`fullMoa proposer ${proposer.id} enabled must be boolean`);
    }
    validateWhen(`fullMoa.proposers.${proposer.id}.when`, proposer.when);
    validateOptionalPositiveInteger(`fullMoa.proposers.${proposer.id}.maxTokens`, proposer.maxTokens);
    if (proposer.routePreset !== undefined && typeof proposer.routePreset !== "string") {
      throw new Error(`fullMoa proposer ${proposer.id} routePreset must be a string`);
    }
    validateRoute(`fullMoa.proposers.${proposer.id}.route`, resolveProposerRoute(reference, proposer, routePresets));
  }
  if (typeof fullMoa.synthesis.enabled !== "boolean") throw new Error("fullMoa.synthesis.enabled must be boolean");
  if (fullMoa.synthesis.enabled && !fullMoa.synthesis.prompt?.trim()) throw new Error("fullMoa.synthesis.prompt is required when enabled");
  if (fullMoa.synthesis.routePreset !== undefined && typeof fullMoa.synthesis.routePreset !== "string") {
    throw new Error("fullMoa.synthesis.routePreset must be a string");
  }
  if (fullMoa.synthesis.route || fullMoa.synthesis.modelRef || fullMoa.synthesis.routePreset) {
    validateRoute("fullMoa.synthesis.route", resolveSynthesisRoute(reference, fullMoa.synthesis, routePresets));
  }
}

function validateWhen(label: string, when: FullMoaProposerConfig["when"]): void {
  if (when === undefined) return;
  if (!isRecord(when)) throw new Error(`${label} must be an object`);
  const allowedCapabilities = new Set(["text", "image", "video", "audio"]);
  if (when.anyCapability !== undefined) {
    if (!Array.isArray(when.anyCapability)) throw new Error(`${label}.anyCapability must be an array`);
    for (const cap of when.anyCapability) {
      if (!allowedCapabilities.has(cap)) throw new Error(`${label}.anyCapability contains unsupported capability: ${cap}`);
    }
  }
  if (when.anyKeyword !== undefined) {
    if (!Array.isArray(when.anyKeyword)) throw new Error(`${label}.anyKeyword must be an array`);
    for (const keyword of when.anyKeyword) {
      if (typeof keyword !== "string" || !keyword.trim()) throw new Error(`${label}.anyKeyword entries must be non-empty strings`);
    }
  }
}

function validateRoute(label: string, route: UpstreamRoute): void {
  if (!route.provider) throw new Error(`${label}.provider is required`);
  if (!route.model) throw new Error(`${label}.model is required`);
  validateRouteEffort(`${label}.effort`, route.effort);
  validateRouteTemperature(`${label}.temperature`, route.temperature);
  if (route.provider === PROVIDER_ID) {
    throw new Error(`${label}.provider must not be '${PROVIDER_ID}' (recursion guard)`);
  }
}

function validateMode(label: string, mode: AliasMode): void {
  if (!["single", "advisor", "full_moa", "auto"].includes(mode)) {
    throw new Error(`${label} must be one of: single, advisor, full_moa, auto`);
  }
}
