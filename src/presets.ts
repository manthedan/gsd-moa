import { mergeUpstreamRoute } from "./config.js";
import type { FullMoaProposerConfig, GsdMoaConfig, UpstreamRoute } from "./types.js";

const DEFAULT_CLIPROXY_BASE_URL = "http://127.0.0.1:8317/v1";
const DEFAULT_GEMINI_FLASH_MODEL = "gemini-3.5-flash-low";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

const CLIPROXY_ROUTE_PRESET: Partial<UpstreamRoute> = {
  api: "openai-completions",
  baseUrl: DEFAULT_CLIPROXY_BASE_URL,
  apiKey: "$CLIPROXY_API_KEY",
  compat: {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  },
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

function geminiModelRef(): string {
  return `antigravity/${process.env.GSD_MOA_GEMINI_MODEL || DEFAULT_GEMINI_FLASH_MODEL}`;
}

function claudeModelRef(): string {
  return `antigravity/${process.env.GSD_MOA_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL}`;
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

export function applyModelPreset(config: GsdMoaConfig, alias: string): GsdMoaConfig {
  if (!alias.startsWith("gpt55-gemini35flash-")) return config;

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
