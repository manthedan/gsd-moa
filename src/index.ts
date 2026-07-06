import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { loadConfig } from "./config.js";
import { getRuntime } from "./pi-compat.js";
import { GSD_MOA_MODELS } from "./models.js";
import { ALIAS_PRESET_IDS, providerModelConfigForAliasConfig } from "./registry.js";
import { streamGsdMoa } from "./stream.js";
import { PROVIDER_ID } from "./types.js";

const ompStreamSimple: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) =>
  streamGsdMoa(model as never, context as never, options) as unknown as ReturnType<NonNullable<ProviderConfig["streamSimple"]>>;

function registeredModels(): ProviderModelConfig[] {
  const models = [...GSD_MOA_MODELS];
  try {
    const config = loadConfig();
    for (const [id, alias] of Object.entries(config.aliases)) {
      if (!ALIAS_PRESET_IDS.has(id)) models.push(providerModelConfigForAliasConfig(id, alias, config));
    }
  } catch {
    // Keep extension load resilient. The configuration error is reported on first stream call.
  }
  return models;
}

export default function gsdMoaExtension(pi: ExtensionAPI) {
  const providerConfig: ProviderConfig & { name?: string } = {
    api: "gsd-moa-api",
    baseUrl: "gsd-moa://local",
    apiKey: "gsd-moa-local",
    models: registeredModels(),
    streamSimple: ompStreamSimple,
  };
  if (getRuntime() === "pi") providerConfig.name = "GSD MoA";
  pi.registerProvider(PROVIDER_ID, providerConfig);
}

export { runAdvisor, buildAdvisorContext } from "./advisor.js";
export { resetAsyncAdvisor } from "./async-advisor.js";
export { advisorCacheKey, readAdvisorCache, writeAdvisorCache } from "./cache.js";
export { loadConfig, mergeUpstreamRoute, parseModelRef, resetConfigCache, resolveProposerRoute, resolveSynthesisRoute, validateConfig } from "./config.js";
export { countAdvisorInjections, sanitizeReferenceContext, withAdvisorGuidance, withFullMoaGuidance } from "./context.js";
export { getRuntime, resetRuntimeCache } from "./pi-compat.js";
export { buildProposerContext, buildSynthesisContext, runFullMoa, selectPortfolio } from "./moa.js";
export { GSD_MOA_MODELS, GSD_MOA_MODEL_IDS } from "./models.js";
export { chooseAction, chooseMode, stripMoaMarkers } from "./policy.js";
export { applyModelPreset } from "./presets.js";
export { ALIAS_PRESETS, applyAliasPreset, buildDefaultAliasMap, buildProviderModelConfigs, modelCardFromPrimaryRoute, providerModelConfigForAliasConfig, providerModelConfigForEntry } from "./registry.js";
export type { AliasPresetEntry, BuiltinAliasId } from "./registry.js";
export { streamGsdMoa } from "./stream.js";
export { computeTimeState } from "./time.js";
export { createTraceRecorder } from "./trace.js";
export { PROVIDER_ID } from "./types.js";
export type { AsyncAdvisorConfig, CheckpointPolicyConfig, CheckpointScope, DefaultReasoningEffort, FullMoaFailure, FullMoaProposal, FullMoaResult, GsdMoaConfig, ModelRef, MoaAction, MoaMode, PolicyDecision, PortfolioDecision, ReasoningEffort, ReferenceWhenConfig, RescuePolicyConfig, TimeAwareConfig, TimeState, TraceConfig, UpstreamRoute } from "./types.js";
