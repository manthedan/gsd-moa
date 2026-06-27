import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AliasMode, GsdMoaConfig, UpstreamRoute } from "./types.js";
import { PROVIDER_ID } from "./types.js";

export const DEFAULT_CONFIG_PATH = ".pi/gsd-moa.json";

export const DEFAULT_CONFIG: GsdMoaConfig = {
  primary: {
    provider: "openai",
    model: "gpt-5.5",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 272000,
    maxTokens: 128000,
  },
  reference: {
    provider: "zai-coding-cn",
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
  aliases: {
    "gpt55-glm52-single": { mode: "single" },
    "gpt55-glm52-advisor": { mode: "advisor" },
    "gpt55-glm52-auto": { mode: "auto" },
  },
  auto: {
    defaultMode: "single",
    advisorKeywords: ["plan", "review", "audit", "verify", "security", "architecture", "debug", "requirements"],
    singleKeywords: ["typo", "format", "small edit", "rename"],
  },
  cache: {
    enabled: true,
    dir: ".pi/gsd-moa-cache",
    ttlSeconds: 7 * 24 * 60 * 60,
  },
  prompts: {
    advisorVersion: "v1",
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
    validateConfig(cfg);
    return cfg;
  }

  const parsed = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object`);

  const cfg: GsdMoaConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    primary: mergeRoute(DEFAULT_CONFIG.primary, parsed.primary),
    reference: mergeRoute(DEFAULT_CONFIG.reference, parsed.reference),
    aliases: isRecord(parsed.aliases) ? (parsed.aliases as GsdMoaConfig["aliases"]) : DEFAULT_CONFIG.aliases,
    auto: isRecord(parsed.auto)
      ? {
          ...DEFAULT_CONFIG.auto,
          ...parsed.auto,
          advisorKeywords: Array.isArray(parsed.auto.advisorKeywords)
            ? (parsed.auto.advisorKeywords as string[])
            : DEFAULT_CONFIG.auto.advisorKeywords,
          singleKeywords: Array.isArray(parsed.auto.singleKeywords)
            ? (parsed.auto.singleKeywords as string[])
            : DEFAULT_CONFIG.auto.singleKeywords,
        }
      : DEFAULT_CONFIG.auto,
    cache: isRecord(parsed.cache) ? { ...DEFAULT_CONFIG.cache, ...parsed.cache } as GsdMoaConfig["cache"] : DEFAULT_CONFIG.cache,
    prompts: isRecord(parsed.prompts) ? { ...DEFAULT_CONFIG.prompts, ...parsed.prompts } as GsdMoaConfig["prompts"] : DEFAULT_CONFIG.prompts,
  };
  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg: GsdMoaConfig): void {
  validateRoute("primary", cfg.primary);
  validateRoute("reference", cfg.reference);

  for (const [name, alias] of Object.entries(cfg.aliases)) {
    if (!name.trim()) throw new Error("aliases must not contain blank model ids");
    validateMode(`aliases.${name}.mode`, alias.mode);
  }

  validateMode("auto.defaultMode", cfg.auto.defaultMode);
  if (!Array.isArray(cfg.auto.advisorKeywords)) throw new Error("auto.advisorKeywords must be an array");
  if (!Array.isArray(cfg.auto.singleKeywords)) throw new Error("auto.singleKeywords must be an array");
  if (typeof cfg.cache.enabled !== "boolean") throw new Error("cache.enabled must be boolean");
  if (!cfg.cache.dir) throw new Error("cache.dir is required");
  if (!Number.isFinite(cfg.cache.ttlSeconds) || cfg.cache.ttlSeconds < 0) {
    throw new Error("cache.ttlSeconds must be a non-negative number");
  }
  if (!cfg.prompts.advisorVersion) throw new Error("prompts.advisorVersion is required");
}

function validateRoute(label: string, route: UpstreamRoute): void {
  if (!route.provider) throw new Error(`${label}.provider is required`);
  if (!route.model) throw new Error(`${label}.model is required`);
  if (route.provider === PROVIDER_ID) {
    throw new Error(`${label}.provider must not be '${PROVIDER_ID}' (recursion guard)`);
  }
}

function validateMode(label: string, mode: AliasMode): void {
  if (!["single", "advisor", "auto"].includes(mode)) {
    throw new Error(`${label} must be one of: single, advisor, auto`);
  }
}
