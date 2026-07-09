import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AliasConfig, AliasMode, FullMoaProposerConfig, GsdMoaConfig, UpstreamRoute } from "./types.js";

export interface AliasPresetEntry {
  id: string;
  name: string;
  mode: AliasMode;
  /** Optional config transform; identity for plain aliases. Must be pure: clone before mutating. */
  apply?: (config: GsdMoaConfig) => GsdMoaConfig;
  /** Model-card metadata override; wins over derived primary-route metadata. */
  card?: Partial<Pick<ProviderModelConfig, "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens">>;
  checkpointScopes?: AliasConfig["checkpointScopes"];
}

const DEFAULT_CLIPROXY_BASE_URL = "http://127.0.0.1:8318/v1";
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_GEMINI_FLASH_MODEL = "gemini-3-flash";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
const DEFAULT_CLAUDE_OPUS_MODEL = "claude-opus-4-8";

const CLIPROXY_ROUTE_PRESET: Partial<UpstreamRoute> = {
  api: "openai-completions",
  baseUrl: DEFAULT_CLIPROXY_BASE_URL,
  apiKey: "$CLIPROXY_API_KEY",
  compat: {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  },
};

const CODEX_METADATA: Partial<UpstreamRoute> = {
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};

const GEMINI_METADATA: Partial<UpstreamRoute> = {
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_576,
  maxTokens: 65_536,
};

const CLAUDE_METADATA: Partial<UpstreamRoute> = {
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

const DEFAULT_MODEL_CARD: Pick<ProviderModelConfig, "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"> = {
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
};

type AliasTransform = (config: GsdMoaConfig) => GsdMoaConfig;

function codexModel(): string {
  return process.env.GSD_MOA_CODEX_MODEL || DEFAULT_CODEX_MODEL;
}

function codexModelRef(): string {
  return `openai-codex/${codexModel()}`;
}

function geminiModelRef(): string {
  return `antigravity/${process.env.GSD_MOA_GEMINI_MODEL || DEFAULT_GEMINI_FLASH_MODEL}`;
}

function claudeModelRef(): string {
  return `antigravity/${process.env.GSD_MOA_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL}`;
}

function claudeOpusModelRef(): string {
  return `antigravity/${process.env.GSD_MOA_CLAUDE_OPUS_MODEL || process.env.GSD_MOA_CLAUDE_MODEL || DEFAULT_CLAUDE_OPUS_MODEL}`;
}

function mergeUpstreamRoute(base: UpstreamRoute, override: Partial<UpstreamRoute> | undefined): UpstreamRoute {
  if (!override) return cloneRoute(base);
  return {
    ...cloneRoute(base),
    ...override,
    headers: override.headers ? { ...override.headers } : base.headers ? { ...base.headers } : undefined,
    compat: override.compat ? { ...base.compat, ...override.compat } : base.compat ? { ...base.compat } : undefined,
    cost: override.cost ? { ...base.cost, ...override.cost } as UpstreamRoute["cost"] : base.cost ? { ...base.cost } : undefined,
    input: override.input ? [...override.input] : base.input ? [...base.input] : undefined,
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

function glmPrimaryRoute(cfg: GsdMoaConfig): UpstreamRoute {
  return mergeUpstreamRoute(
    mergeUpstreamRoute({ provider: "zai", model: "glm-5.2" }, cfg.routePresets["zai-coding-plan"]),
    {
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 8192,
    },
  );
}

function geminiReferenceRoute(cfg: GsdMoaConfig): UpstreamRoute {
  return mergeUpstreamRoute(
    mergeUpstreamRoute({ provider: "antigravity", model: process.env.GSD_MOA_GEMINI_MODEL || DEFAULT_GEMINI_FLASH_MODEL }, cfg.routePresets.cliproxyapi),
    GEMINI_METADATA,
  );
}

function geminiSpecialist(): FullMoaProposerConfig {
  return {
    id: "gemini35flash",
    label: "Gemini 3.5 Flash multimodal/coding specialist via CLIProxyAPI Antigravity OAuth",
    modelRef: geminiModelRef(),
    routePreset: "cliproxyapi",
    route: { ...GEMINI_METADATA },
    when: {
      anyCapability: ["image", "video", "audio"],
      anyKeyword: ["youtube", "video", "transcribe", "screenshot", "diagram", "ocr", "multimodal"],
    },
  };
}

function geminiUnconditionalReference(): FullMoaProposerConfig {
  return {
    id: "gemini35flash",
    label: "Gemini 3.5 Flash reference via CLIProxyAPI Antigravity OAuth",
    enabled: true,
    modelRef: geminiModelRef(),
    routePreset: "cliproxyapi",
    route: { ...GEMINI_METADATA },
  };
}

function claudeSpecialist(): FullMoaProposerConfig {
  return {
    id: "claude46",
    label: "Claude Sonnet 4.6 specialist via CLIProxyAPI Antigravity OAuth",
    enabled: false,
    modelRef: claudeModelRef(),
    routePreset: "cliproxyapi",
    route: {
      ...CLAUDE_METADATA,
      ...(process.env.GSD_MOA_CLAUDE_BASE_URL ? { baseUrl: process.env.GSD_MOA_CLAUDE_BASE_URL } : {}),
    },
    when: {
      anyKeyword: ["hard reasoning", "refactor", "architecture", "security", "bug", "debug", "ambiguous", "edge case"],
    },
  };
}

function claudeOpusUnconditionalReference(): FullMoaProposerConfig {
  return {
    id: "claudeopus48",
    label: "Claude Opus 4.8 reference via CLIProxyAPI Antigravity OAuth",
    enabled: true,
    modelRef: claudeOpusModelRef(),
    routePreset: "cliproxyapi",
    route: {
      ...CLAUDE_METADATA,
      ...(process.env.GSD_MOA_CLAUDE_BASE_URL ? { baseUrl: process.env.GSD_MOA_CLAUDE_BASE_URL } : {}),
    },
  };
}

export function composeAliasPreset(...transforms: AliasTransform[]): AliasTransform {
  return (config) => transforms.reduce((cfg, transform) => transform(cfg), config);
}

export function applyNoSynthesisPreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.fullMoa.synthesis.enabled = false;
  return cfg;
}

export function applyGlmOnlyReferencePreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.fullMoa.proposers = cfg.fullMoa.proposers.filter((proposer) => proposer.id === "glm52");
  return cfg;
}

export function applyInitialOnlyCheckpointPreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.checkpoint.enabled = false;
  return cfg;
}

export function applyDoneGatePreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.doneGate.enabled = true;
  return cfg;
}

export function applyGlmZaiSinglePreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.primary = glmPrimaryRoute(cfg);
  return cfg;
}

export function applyGlmDriverCodexReferencePreset(config: GsdMoaConfig, options: { synthesis: boolean }): GsdMoaConfig {
  const cfg = applyCliproxyCodexPreset(config);
  cfg.primary = glmPrimaryRoute(cfg);
  cfg.fullMoa.synthesis.enabled = options.synthesis;
  cfg.fullMoa.synthesis.modelRef = codexModelRef();
  cfg.fullMoa.synthesis.routePreset = "cliproxyapi-codex";
  cfg.fullMoa.synthesis.route = { ...CODEX_METADATA, ...nonTransportRouteOverrides(cfg.fullMoa.synthesis.route) };
  return cfg;
}

export function applyGeminiReferencePreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.routePresets.cliproxyapi = {
    ...CLIPROXY_ROUTE_PRESET,
    ...(cfg.routePresets.cliproxyapi ?? {}),
    ...(process.env.GSD_MOA_GEMINI_BASE_URL ? { baseUrl: process.env.GSD_MOA_GEMINI_BASE_URL } : {}),
  };

  const originalReference = structuredClone(cfg.reference);
  cfg.reference = geminiReferenceRoute(cfg);

  const existingGemini = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gemini35flash");
  const existingClaude = cfg.fullMoa.proposers.find((proposer) => proposer.id === "claude46");
  const withoutPresetSpecialists = cfg.fullMoa.proposers
    .filter((proposer) => proposer.id !== "gemini35flash" && proposer.id !== "claude46")
    .map((proposer) => pinInheritedReferenceProposer(proposer, originalReference));
  cfg.fullMoa.proposers = [
    ...withoutPresetSpecialists,
    mergePresetSpecialist(geminiSpecialist(), existingGemini),
    mergePresetSpecialist(claudeSpecialist(), existingClaude),
  ];

  return cfg;
}

export function applyUnconditionalGeminiPreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.routePresets.cliproxyapi = {
    ...CLIPROXY_ROUTE_PRESET,
    ...(cfg.routePresets.cliproxyapi ?? {}),
    ...(process.env.GSD_MOA_GEMINI_BASE_URL ? { baseUrl: process.env.GSD_MOA_GEMINI_BASE_URL } : {}),
  };

  const existingGemini = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gemini35flash");
  cfg.fullMoa.proposers = [
    ...cfg.fullMoa.proposers.filter((proposer) => proposer.id !== "gemini35flash"),
    mergePresetSpecialist(geminiUnconditionalReference(), existingGemini),
  ];
  const gemini = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gemini35flash");
  if (gemini) {
    gemini.enabled = true;
    gemini.when = undefined;
  }

  return cfg;
}

export function applyUnconditionalClaudeOpusPreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.routePresets.cliproxyapi = {
    ...CLIPROXY_ROUTE_PRESET,
    ...(cfg.routePresets.cliproxyapi ?? {}),
    ...(process.env.GSD_MOA_CLAUDE_BASE_URL ? { baseUrl: process.env.GSD_MOA_CLAUDE_BASE_URL } : {}),
  };

  const existingClaude = cfg.fullMoa.proposers.find((proposer) => proposer.id === "claudeopus48");
  cfg.fullMoa.proposers = [
    ...cfg.fullMoa.proposers.filter((proposer) => proposer.id !== "gemini35flash" && proposer.id !== "claudeopus48"),
    mergePresetSpecialist(claudeOpusUnconditionalReference(), existingClaude),
  ];
  const claude = cfg.fullMoa.proposers.find((proposer) => proposer.id === "claudeopus48");
  if (claude) {
    claude.enabled = true;
    claude.when = undefined;
  }

  return cfg;
}

export function applyCliproxyCodexPreset(config: GsdMoaConfig): GsdMoaConfig {
  const cfg = structuredClone(config);
  cfg.routePresets["cliproxyapi-codex"] = {
    ...CLIPROXY_ROUTE_PRESET,
    ...(cfg.routePresets["cliproxyapi-codex"] ?? {}),
    ...(process.env.GSD_MOA_CODEX_BASE_URL ? { baseUrl: process.env.GSD_MOA_CODEX_BASE_URL } : {}),
  };

  const codexRoute = mergeUpstreamRoute(
    mergeUpstreamRoute({ provider: "openai-codex", model: codexModel() }, cfg.routePresets["cliproxyapi-codex"]),
    CODEX_METADATA,
  );
  cfg.primary = codexRoute;

  const gptReference = cfg.fullMoa.proposers.find((proposer) => proposer.id === "gpt55");
  if (gptReference) {
    gptReference.modelRef = codexModelRef();
    gptReference.routePreset = "cliproxyapi-codex";
    gptReference.route = { ...CODEX_METADATA, ...nonTransportRouteOverrides(gptReference.route) };
  }

  cfg.fullMoa.synthesis.modelRef = codexModelRef();
  cfg.fullMoa.synthesis.routePreset = "cliproxyapi-codex";
  cfg.fullMoa.synthesis.route = { ...CODEX_METADATA, ...nonTransportRouteOverrides(cfg.fullMoa.synthesis.route) };

  return cfg;
}

function nonTransportRouteOverrides(route: Partial<UpstreamRoute> | undefined): Partial<UpstreamRoute> {
  if (!route) return {};
  const {
    provider: _provider,
    model: _model,
    api: _api,
    baseUrl: _baseUrl,
    apiKey: _apiKey,
    headers: _headers,
    authHeader: _authHeader,
    compat: _compat,
    ...rest
  } = route;
  return rest;
}

function pinInheritedReferenceProposer(proposer: FullMoaProposerConfig, originalReference: UpstreamRoute): FullMoaProposerConfig {
  if (proposer.modelRef) return proposer;
  if (proposer.route?.provider && proposer.route.model) return proposer;
  if (proposer.routePreset) {
    return {
      ...proposer,
      modelRef: `${originalReference.provider}/${originalReference.model}`,
    };
  }
  return {
    ...proposer,
    route: {
      ...originalReference,
      ...(proposer.route ?? {}),
    },
  };
}

function mergePresetSpecialist(defaults: FullMoaProposerConfig, override: FullMoaProposerConfig | undefined): FullMoaProposerConfig {
  if (!override) return defaults;
  return {
    ...defaults,
    ...override,
    route: override.route ? { ...defaults.route, ...override.route } : defaults.route,
    when: override.when ?? defaults.when,
  };
}

const CLIPROXY_CODEX_THEN_GEMINI = composeAliasPreset(applyCliproxyCodexPreset, applyUnconditionalGeminiPreset);
const CLIPROXY_CODEX_THEN_CLAUDE_OPUS = composeAliasPreset(applyCliproxyCodexPreset, applyUnconditionalClaudeOpusPreset);
const CLIPROXY_CODEX_THEN_NO_SYNTHESIS = composeAliasPreset(applyCliproxyCodexPreset, applyNoSynthesisPreset);
const CLIPROXY_CODEX_THEN_GLM_ONLY_NO_SYNTHESIS = composeAliasPreset(applyCliproxyCodexPreset, applyNoSynthesisPreset, applyGlmOnlyReferencePreset);
const CLIPROXY_CODEX_THEN_DONE_GATE = composeAliasPreset(applyCliproxyCodexPreset, applyDoneGatePreset);
const CLIPROXY_CODEX_HERMES_FULL = composeAliasPreset(applyCliproxyCodexPreset, applyNoSynthesisPreset, applyInitialOnlyCheckpointPreset);

export const ALIAS_PRESETS = [
  { id: "gpt55-glm52-single", name: "GSD MoA: GPT-5.5 + GLM-5.2 (Single)", mode: "single" },
  { id: "gpt55-glm52-advisor", name: "GSD MoA: GPT-5.5 + GLM-5.2 (Advisor)", mode: "advisor" },
  { id: "gpt55-glm52-full", name: "GSD MoA: GPT-5.5 + GLM-5.2 (Full MoA)", mode: "full_moa" },
  { id: "gpt55-glm52-auto", name: "GSD MoA: GPT-5.5 + GLM-5.2 (Auto)", mode: "auto" },
  { id: "gpt55-gemini35flash-single", name: "GSD MoA: GPT-5.5 + Gemini 3.5 Flash (Single)", mode: "single", apply: applyGeminiReferencePreset },
  { id: "gpt55-gemini35flash-advisor", name: "GSD MoA: GPT-5.5 + Gemini 3.5 Flash (Advisor)", mode: "advisor", apply: applyGeminiReferencePreset },
  { id: "gpt55-gemini35flash-full", name: "GSD MoA: GPT-5.5 + Gemini 3.5 Flash (Full MoA)", mode: "full_moa", apply: applyGeminiReferencePreset },
  { id: "gpt55-gemini35flash-auto", name: "GSD MoA: GPT-5.5 + Gemini 3.5 Flash (Auto)", mode: "auto", apply: applyGeminiReferencePreset },
  { id: "gpt55-glm52-gemini35flash-full", name: "GSD MoA: GPT-5.5 + GLM-5.2 + Gemini 3.5 Flash (Full MoA)", mode: "full_moa", apply: applyUnconditionalGeminiPreset },
  { id: "gpt55-cliproxycodex-single", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex (Single)", mode: "single", apply: applyCliproxyCodexPreset },
  { id: "gpt55-cliproxycodex-donegate", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex (Single + Done Gate)", mode: "single", apply: CLIPROXY_CODEX_THEN_DONE_GATE },
  { id: "gpt55-cliproxycodex-advisor", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 (Advisor)", mode: "advisor", apply: applyCliproxyCodexPreset },
  { id: "gpt55-cliproxycodex-full", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 (Full MoA)", mode: "full_moa", apply: applyCliproxyCodexPreset },
  { id: "gpt55-cliproxycodex-auto", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 (Auto)", mode: "auto", apply: applyCliproxyCodexPreset },
  { id: "gpt55-cliproxycodex-glm52-rescue", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 (Rescue)", mode: "auto", apply: applyCliproxyCodexPreset, checkpointScopes: { initial: false, drift: false, failure: true } },
  { id: "gpt55-cliproxycodex-glm52-rescue-donegate", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 (Rescue + Done Gate)", mode: "auto", apply: CLIPROXY_CODEX_THEN_DONE_GATE, checkpointScopes: { initial: false, drift: false, failure: true } },
  { id: "gpt55-cliproxycodex-glm52-nosynth-full", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 refs (No Synth)", mode: "full_moa", apply: CLIPROXY_CODEX_THEN_NO_SYNTHESIS },
  { id: "gpt55-cliproxycodex-glm52only-nosynth-full", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2-only refs (No Synth)", mode: "full_moa", apply: CLIPROXY_CODEX_THEN_GLM_ONLY_NO_SYNTHESIS },
  { id: "gpt55-cliproxycodex-glm52-hermes-full", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 refs (Hermes-style Full MoA)", mode: "full_moa", apply: CLIPROXY_CODEX_HERMES_FULL },
  { id: "gpt55-cliproxycodex-glm52-gemini35flash-full", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 + Gemini Flash (Full MoA)", mode: "full_moa", apply: CLIPROXY_CODEX_THEN_GEMINI },
  { id: "gpt55-cliproxycodex-glm52-claudeopus48-full", name: "GSD MoA: GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 + Claude Opus 4.8 (Full MoA)", mode: "full_moa", apply: CLIPROXY_CODEX_THEN_CLAUDE_OPUS },
  { id: "glm52-zai-single", name: "GSD MoA: GLM-5.2 via Z.ai (Single)", mode: "single", apply: applyGlmZaiSinglePreset },
  { id: "glm52-zai-gpt55-cliproxycodex-full", name: "GSD MoA: GLM-5.2 driver + GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 refs (Full MoA)", mode: "full_moa", apply: (config: GsdMoaConfig) => applyGlmDriverCodexReferencePreset(config, { synthesis: true }) },
  { id: "glm52-zai-gpt55-cliproxycodex-nosynth-full", name: "GSD MoA: GLM-5.2 driver + GPT-5.5 via CLIProxyAPI Codex + GLM-5.2 refs (No Synth)", mode: "full_moa", apply: (config: GsdMoaConfig) => applyGlmDriverCodexReferencePreset(config, { synthesis: false }) },
] as const satisfies readonly AliasPresetEntry[];

export type BuiltinAliasId = (typeof ALIAS_PRESETS)[number]["id"];

export const ALIAS_PRESET_IDS = new Set<string>(ALIAS_PRESETS.map((entry) => entry.id));

export function buildDefaultAliasMap(entries: readonly AliasPresetEntry[] = ALIAS_PRESETS): Record<string, AliasConfig> {
  return Object.fromEntries(entries.map((entry) => [entry.id, { mode: entry.mode, ...(entry.checkpointScopes ? { checkpointScopes: entry.checkpointScopes } : {}) }])) as Record<string, AliasConfig>;
}

export function findAliasPreset(alias: string, entries: readonly AliasPresetEntry[] = ALIAS_PRESETS): AliasPresetEntry | undefined {
  return entries.find((entry) => entry.id === alias);
}

export function applyAliasPreset(config: GsdMoaConfig, alias: string, entries: readonly AliasPresetEntry[] = ALIAS_PRESETS): GsdMoaConfig {
  const entry = findAliasPreset(alias, entries);
  return entry?.apply ? entry.apply(config) : config;
}

export function modelCardFromPrimaryRoute(route: UpstreamRoute): Pick<ProviderModelConfig, "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens"> {
  return {
    reasoning: route.reasoning ?? DEFAULT_MODEL_CARD.reasoning,
    input: route.input ? [...route.input] : [...DEFAULT_MODEL_CARD.input],
    cost: route.cost ? { ...route.cost } : { ...DEFAULT_MODEL_CARD.cost },
    contextWindow: route.contextWindow ?? DEFAULT_MODEL_CARD.contextWindow,
    maxTokens: route.maxTokens ?? DEFAULT_MODEL_CARD.maxTokens,
  };
}

export function providerModelConfigForEntry(baseConfig: GsdMoaConfig, entry: AliasPresetEntry): ProviderModelConfig {
  const effectiveConfig = entry.apply ? entry.apply(structuredClone(baseConfig)) : structuredClone(baseConfig);
  return {
    id: entry.id,
    name: entry.name,
    ...modelCardFromPrimaryRoute(effectiveConfig.primary),
    ...entry.card,
  };
}

export function providerModelConfigForAliasConfig(id: string, alias: AliasConfig, config: GsdMoaConfig): ProviderModelConfig {
  return {
    id,
    name: `GSD MoA: ${id} (${alias.mode})`,
    ...modelCardFromPrimaryRoute(config.primary),
  };
}

export function buildProviderModelConfigs(
  baseConfig: GsdMoaConfig,
  entries: readonly AliasPresetEntry[] = ALIAS_PRESETS,
): ProviderModelConfig[] {
  return entries.map((entry) => providerModelConfigForEntry(baseConfig, entry));
}
