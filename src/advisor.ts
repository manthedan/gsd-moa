import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { readAdvisorCache, writeAdvisorCache } from "./cache.js";
import { assistantText, sanitizeReferenceContext } from "./context.js";
import type { TraceRecorder } from "./trace.js";
import type { AdvisorResult, GsdMoaConfig, PolicyDecision } from "./types.js";
import { routeToModel, streamOptionsForRoute, type UpstreamClient } from "./upstream.js";

export async function runAdvisor(
  config: GsdMoaConfig,
  context: Context,
  policy: PolicyDecision,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
): Promise<AdvisorResult> {
  const referenceContext = buildAdvisorContext(config, context, policy);
  const cache = readAdvisorCache(config, referenceContext);
  const startedAt = Date.now();
  if (cache.hit) {
    trace?.recordReferenceCall({
      role: "reference",
      route: config.reference,
      context: referenceContext,
      cacheHit: true,
      cacheKey: cache.key,
      cachedText: cache.text,
      startedAt,
      endedAt: Date.now(),
    });
    return { text: cache.text, usage: undefined, cacheHit: true, key: cache.key };
  }

  const referenceModel = routeToModel(config.reference);
  const message = await upstream.complete(referenceModel, referenceContext, streamOptionsForRoute(config.reference, options));
  const text = assistantText(message).trim();
  writeAdvisorCache(config, cache.key, text, message.usage);
  trace?.recordReferenceCall({
    role: "reference",
    route: config.reference,
    context: referenceContext,
    message,
    cacheHit: false,
    cacheKey: cache.key,
    startedAt,
    endedAt: Date.now(),
  });
  return { text, usage: message.usage, cacheHit: false, key: cache.key };
}

export function buildAdvisorContext(config: GsdMoaConfig, context: Context, policy: PolicyDecision): Context {
  const safe = sanitizeReferenceContext(context, policy);
  return {
    ...safe,
    systemPrompt: [
      `You are GLM-5.2 acting as a private advisor for a Pi coding agent provider.`,
      `Prompt version: ${config.prompts.advisorVersion}.`,
      `Give concise critique, risks, missing tests, and implementation advice.`,
      `Do not request or call tools. Do not produce patches.`,
      `Selected route: requested=${policy.requestedMode}, mode=${policy.mode}, reason=${policy.reason}.`,
    ].join("\n"),
    tools: undefined,
  };
}
