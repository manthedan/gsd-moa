import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GSD_MOA_MODELS } from "./models.js";
import { streamGsdMoa } from "./stream.js";
import { PROVIDER_ID } from "./types.js";

export default function gsdMoaExtension(pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: "GSD MoA",
    api: "gsd-moa-api",
    baseUrl: "gsd-moa://local",
    apiKey: "$GSD_MOA_API_KEY",
    models: GSD_MOA_MODELS,
    streamSimple: streamGsdMoa,
  });
}

export { runAdvisor, buildAdvisorContext } from "./advisor.js";
export { advisorCacheKey, readAdvisorCache, writeAdvisorCache } from "./cache.js";
export { loadConfig, validateConfig } from "./config.js";
export { sanitizeReferenceContext, withAdvisorGuidance } from "./context.js";
export { GSD_MOA_MODELS, GSD_MOA_MODEL_IDS } from "./models.js";
export { chooseMode, stripMoaMarkers } from "./policy.js";
export { streamGsdMoa } from "./stream.js";
export { PROVIDER_ID } from "./types.js";
export type { GsdMoaConfig, MoaMode, PolicyDecision, UpstreamRoute } from "./types.js";
