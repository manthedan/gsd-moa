import { mergeUpstreamRoute } from "./config.js";
import type { FullMoaProposerConfig, GsdMoaConfig, UpstreamRoute } from "./types.js";

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
  contextWindow: 128_000,
  maxTokens: 16_384,
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

export function applyModelPreset(config: GsdMoaConfig, alias: string): GsdMoaConfig {
  if (alias.startsWith("glm52-zai-gpt55-cliproxycodex-nosynth-")) return applyGlmDriverCodexReferencePreset(config, { synthesis: false });
  if (alias.startsWith("glm52-zai-gpt55-cliproxycodex-")) return applyGlmDriverCodexReferencePreset(config, { synthesis: true });

  let cfg = alias.startsWith("gpt55-cliproxycodex-") ? applyCliproxyCodexPreset(config) : config;
  if (alias.startsWith("gpt55-cliproxycodex-glm52-claudeopus48-")) return applyUnconditionalClaudeOpusPreset(cfg);
  if (alias.startsWith("gpt55-cliproxycodex-glm52-gemini35flash-")) return applyUnconditionalGeminiPreset(cfg);
  if (alias.startsWith("gpt55-glm52-gemini35flash-")) return applyUnconditionalGeminiPreset(cfg);
  if (!alias.startsWith("gpt55-gemini35flash-")) return cfg;

  cfg = structuredClone(cfg);
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

function applyGlmDriverCodexReferencePreset(config: GsdMoaConfig, options: { synthesis: boolean }): GsdMoaConfig {
  const cfg = applyCliproxyCodexPreset(config);
  cfg.primary = glmPrimaryRoute(cfg);
  cfg.fullMoa.synthesis.enabled = options.synthesis;
  cfg.fullMoa.synthesis.modelRef = codexModelRef();
  cfg.fullMoa.synthesis.routePreset = "cliproxyapi-codex";
  cfg.fullMoa.synthesis.route = { ...CODEX_METADATA, ...nonTransportRouteOverrides(cfg.fullMoa.synthesis.route) };
  return cfg;
}

function applyUnconditionalGeminiPreset(config: GsdMoaConfig): GsdMoaConfig {
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

function applyUnconditionalClaudeOpusPreset(config: GsdMoaConfig): GsdMoaConfig {
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

function applyCliproxyCodexPreset(config: GsdMoaConfig): GsdMoaConfig {
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
