import type { Context, SimpleStreamOptions, Usage } from "./pi-compat.js";
import { readCacheByKey, referenceCacheKey, writeAdvisorCache } from "./cache.js";
import { assistantText } from "./context.js";
import type { TraceRecorder, TraceReferenceCall } from "./trace.js";
import type { GsdMoaConfig, UpstreamRoute } from "./types.js";
import { routeToModel, streamOptionsForRoute, type UpstreamClient } from "./upstream.js";

export interface ReferenceCallMetadata {
  role: TraceReferenceCall["role"];
  id?: string;
  label?: string;
  cacheScope: string;
  promptVersion: string;
}

export interface ReferenceCallResult {
  text: string;
  usage?: Usage;
  cacheHit: boolean;
  key: string;
  provider: string;
  model: string;
}

export async function runReferenceCall(
  config: GsdMoaConfig,
  route: UpstreamRoute,
  context: Context,
  metadata: ReferenceCallMetadata,
  upstream: UpstreamClient,
  options?: SimpleStreamOptions,
  trace?: TraceRecorder,
): Promise<ReferenceCallResult> {
  const key = referenceCacheKey(config, context, route, metadata.cacheScope, metadata.promptVersion);
  const cache = readCacheByKey(config, key, process.cwd());
  const startedAt = Date.now();
  const traceBase = {
    role: metadata.role,
    id: metadata.id,
    label: metadata.label,
    route,
    context,
    cacheKey: key,
    startedAt,
  };

  if (cache.hit) {
    trace?.recordReferenceCall({
      ...traceBase,
      cacheHit: true,
      cachedText: cache.text,
      endedAt: Date.now(),
    });
    return {
      text: cache.text,
      usage: undefined,
      cacheHit: true,
      provider: route.provider,
      model: route.model,
      key,
    };
  }

  try {
    const model = routeToModel(route);
    const message = await upstream.complete(model, context, referenceStreamOptionsForRoute(config, route, options));
    const text = assistantText(message).trim();
    if (text) writeAdvisorCache(config, key, text, message.usage);
    trace?.recordReferenceCall({
      ...traceBase,
      message,
      cacheHit: false,
      endedAt: Date.now(),
    });
    return {
      text,
      usage: message.usage,
      cacheHit: false,
      provider: route.provider,
      model: route.model,
      key,
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

function referenceStreamOptionsForRoute(config: GsdMoaConfig, route: UpstreamRoute, options?: SimpleStreamOptions): SimpleStreamOptions {
  const base = streamOptionsForRoute(route, options);
  const timeoutSignal = AbortSignal.timeout(config.referenceTimeoutMs);
  const signals = [options?.signal, timeoutSignal].filter((signal): signal is AbortSignal => Boolean(signal));
  return {
    ...base,
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
