import type { Context, SimpleStreamOptions, Usage } from "./pi-compat.js";
import { readCacheByKey, referenceCacheKey, writeAdvisorCache } from "./cache.js";
import { assistantText } from "./context.js";
import type { TraceRecorder, TraceReferenceCall } from "./trace.js";
import { referenceBudgetMs } from "./time.js";
import type { GsdMoaConfig, TimeState, UpstreamRoute } from "./types.js";
import { effortForTrace, resolveEffortForRoute, routeToModel, streamOptionsForRoute, type UpstreamClient } from "./upstream.js";

export interface ReferenceCallMetadata {
  role: TraceReferenceCall["role"];
  id?: string;
  label?: string;
  cacheScope: string;
  promptVersion: string;
  maxTokens?: number;
}

export interface ReferenceCallResult {
  text: string;
  usage?: Usage;
  cacheHit: boolean;
  key: string;
  provider: string;
  model: string;
  durationMs: number;
  effort?: string;
}

export async function runReferenceCall(
  config: GsdMoaConfig,
  route: UpstreamRoute,
  context: Context,
  metadata: ReferenceCallMetadata,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
  timeState?: TimeState,
): Promise<ReferenceCallResult> {
  const startedAt = Date.now();
  const cacheControls = referenceCacheControlsForRoute(config, route, metadata, options);
  const key = referenceCacheKey(config, context, route, metadata.cacheScope, metadata.promptVersion, cacheControls);
  const cache = readCacheByKey(config, key, process.cwd());
  const traceBase = {
    role: metadata.role,
    id: metadata.id,
    label: metadata.label,
    route,
    effort: cacheControls.effort,
    context,
    cacheKey: key,
    startedAt,
  };

  if (cache.hit) {
    const endedAt = Date.now();
    trace?.recordReferenceCall({
      ...traceBase,
      cacheHit: true,
      cachedText: cache.text,
      endedAt,
    });
    return {
      text: cache.text,
      usage: undefined,
      cacheHit: true,
      provider: route.provider,
      model: route.model,
      key,
      durationMs: endedAt - startedAt,
      effort: cacheControls.effort,
    };
  }

  try {
    const callOptions = referenceStreamOptionsForRoute(config, route, metadata, options, timeState);
    const model = routeToModel(route);
    const message = await upstream.complete(model, context, callOptions);
    const text = assistantText(message).trim();
    if (text) writeAdvisorCache(config, key, text, message.usage);
    const endedAt = Date.now();
    trace?.recordReferenceCall({
      ...traceBase,
      message,
      cacheHit: false,
      endedAt,
    });
    return {
      text,
      usage: message.usage,
      cacheHit: false,
      provider: route.provider,
      model: route.model,
      key,
      durationMs: endedAt - startedAt,
      effort: effortForTrace(callOptions),
    };
  } catch (error) {
    trace?.recordReferenceFailure({
      ...traceBase,
      cacheHit: false,
      error: errorMessage(error),
      endedAt: Date.now(),
    });
    throw error;
  }
}

function referenceCacheControlsForRoute(config: GsdMoaConfig, route: UpstreamRoute, metadata: ReferenceCallMetadata, options?: SimpleStreamOptions) {
  const effort = resolveEffortForRoute(route, options, config.defaultEffort);
  const maxTokens = referenceMaxTokensForMetadata(config, metadata);
  return {
    ...(effort !== undefined ? { effort } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function referenceMaxTokensForMetadata(config: GsdMoaConfig, metadata: ReferenceCallMetadata): number | undefined {
  return metadata.role === "synthesizer" ? undefined : metadata.maxTokens ?? config.referenceMaxTokens;
}

function referenceStreamOptionsForRoute(config: GsdMoaConfig, route: UpstreamRoute, metadata: ReferenceCallMetadata, options?: SimpleStreamOptions, timeState?: TimeState): SimpleStreamOptions {
  const base = streamOptionsForRoute(route, options, config.defaultEffort);
  const referenceMaxTokens = referenceMaxTokensForMetadata(config, metadata);
  const timeBudgetMs = referenceBudgetMs(config.timeAware, timeState);
  const effectiveTimeoutMs = timeBudgetMs === undefined
    ? config.referenceTimeoutMs
    : Math.max(5_000, Math.min(config.referenceTimeoutMs, Math.floor(timeBudgetMs)));
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
  const signals = [options?.signal, timeoutSignal].filter((signal): signal is AbortSignal => Boolean(signal));
  return {
    ...base,
    ...(referenceMaxTokens !== undefined ? { maxTokens: referenceMaxTokens } : {}),
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
