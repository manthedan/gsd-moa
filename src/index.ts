import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { GSD_MOA_MODELS } from "./models.js";
import { streamGsdMoa } from "./stream.js";
import { PROVIDER_ID } from "./types.js";

const ompStreamSimple: NonNullable<ProviderConfig["streamSimple"]> = (model, context, options) =>
  streamGsdMoa(model as never, context as never, options) as unknown as ReturnType<NonNullable<ProviderConfig["streamSimple"]>>;

export default function gsdMoaExtension(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    api: "gsd-moa-api",
    baseUrl: "gsd-moa://local",
    apiKey: "gsd-moa-local",
    models: GSD_MOA_MODELS,
    streamSimple: ompStreamSimple,
  });
}

export { runAdvisor, buildAdvisorContext } from "./advisor.js";
export { advisorCacheKey, readAdvisorCache, writeAdvisorCache } from "./cache.js";
export { loadConfig, mergeUpstreamRoute, parseModelRef, resolveProposerRoute, resolveSynthesisRoute, validateConfig } from "./config.js";
export { sanitizeReferenceContext, withAdvisorGuidance, withFullMoaGuidance } from "./context.js";
export { buildProposerContext, buildSynthesisContext, runFullMoa, selectPortfolio } from "./moa.js";
export { GSD_MOA_MODELS, GSD_MOA_MODEL_IDS } from "./models.js";
export { chooseAction, chooseMode, stripMoaMarkers } from "./policy.js";
export { applyModelPreset } from "./presets.js";
export { streamGsdMoa } from "./stream.js";
export { createTraceRecorder } from "./trace.js";
export { PROVIDER_ID } from "./types.js";
export type { CheckpointPolicyConfig, CheckpointScope, FullMoaProposal, FullMoaResult, GsdMoaConfig, ModelRef, MoaAction, MoaMode, PolicyDecision, PortfolioDecision, ReferenceWhenConfig, TraceConfig, UpstreamRoute } from "./types.js";
