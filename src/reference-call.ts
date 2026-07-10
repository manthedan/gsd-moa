import type { AssistantMessage, Context, SimpleStreamOptions, Usage } from "./pi-compat.js";
import { readCacheByKey, referenceCacheKey, writeAdvisorCache } from "./cache.js";
import { assistantText } from "./context.js";
import type { TraceRecorder, TraceReferenceCall } from "./trace.js";
import { referenceBudgetMs } from "./time.js";
import type { GsdMoaConfig, TimeState, UpstreamRoute } from "./types.js";
import { effortForTrace, generationControlsForCache, generationOptionsForRoute, routeToModel, streamOptionsForRoute, type UpstreamClient } from "./upstream.js";

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

export type ReferenceCallFailureDetails = Omit<ReferenceCallResult, "text">;

export class ReferenceCallError extends Error {
  constructor(message: string, readonly details: ReferenceCallFailureDetails) {
    super(message);
    this.name = "ReferenceCallError";
  }
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
  const referenceOptions = withoutProviderSessionState(options);
  const cacheControls = referenceCacheControlsForRoute(config, route, metadata, referenceOptions);
  const key = referenceCacheKey(config, context, route, metadata.cacheScope, metadata.promptVersion, cacheControls);
  // Payload transforms are executable and have no stable identity. Reusing a
  // cached response would skip the transform and may return guidance for a
  // different effective prompt.
  const cacheSafe = referenceOptions?.onPayload === undefined && referenceOptions?.fetch === undefined;
  const cache = cacheSafe ? readCacheByKey(config, key, process.cwd()) : { hit: false as const, key, path: "" };
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

  const { options: callOptions, effectiveTimeoutMs, timeoutSignal } = referenceStreamOptionsForRoute(config, route, metadata, referenceOptions, timeState);
  const model = routeToModel(route);
  let message: AssistantMessage;
  try {
    message = await upstream.complete(model, context, callOptions);
  } catch (error) {
    if (options?.signal?.aborted && !timeoutSignal.aborted) throw error;
    const endedAt = Date.now();
    const messageText = timeoutSignal.aborted
      ? timeoutFailureMessage(effectiveTimeoutMs)
      : errorMessage(error);
    const details = referenceFailureDetails(route, key, false, endedAt - startedAt, undefined, effortForTrace(callOptions));
    trace?.recordReferenceFailure({
      ...traceBase,
      cacheHit: false,
      error: messageText,
      endedAt,
    });
    throw new ReferenceCallError(messageText, details);
  }

  const rawText = assistantText(message).trim();
  const endedAt = Date.now();
  const durationMs = endedAt - startedAt;
  const effort = effortForTrace(callOptions);
  const details = referenceFailureDetails(route, key, false, durationMs, message.usage, effort);
  const classification = classifyReferenceMessage(metadata, message, rawText, effectiveTimeoutMs);
  if (!classification.ok) {
    trace?.recordReferenceFailure({
      ...traceBase,
      message,
      cacheHit: false,
      error: classification.message,
      endedAt,
    });
    throw new ReferenceCallError(classification.message, details);
  }

  const text = classification.text;
  if (text && cacheSafe) {
    try {
      writeAdvisorCache(config, key, text, message.usage);
    } catch {
      // Cache persistence is best-effort. The provider call already completed;
      // never discard its output or billed usage because local storage failed.
    }
  }
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
    durationMs,
    effort,
  };
}

function referenceCacheControlsForRoute(config: GsdMoaConfig, route: UpstreamRoute, metadata: ReferenceCallMetadata, options?: SimpleStreamOptions) {
  const referenceMaxTokens = referenceMaxTokensForMetadata(config, metadata);
  const inheritedMaxTokens = options?.maxTokens ?? routeToModel(route).maxTokens;
  const effectiveOptions: SimpleStreamOptions = {
    ...generationOptionsForRoute(route, options, config.defaultEffort),
    ...(referenceMaxTokens !== undefined
      ? { maxTokens: referenceMaxTokens }
      : typeof inheritedMaxTokens === "number"
        ? { maxTokens: inheritedMaxTokens }
        : {}),
  };
  const effort = effortForTrace(effectiveOptions);
  return {
    ...(effort !== undefined ? { effort } : {}),
    ...(effectiveOptions.maxTokens !== undefined ? { maxTokens: effectiveOptions.maxTokens } : {}),
    ...(effectiveOptions.temperature !== undefined ? { temperature: effectiveOptions.temperature } : {}),
    generation: generationControlsForCache(effectiveOptions),
  };
}

function withoutProviderSessionState(options?: SimpleStreamOptions): SimpleStreamOptions | undefined {
  if (!options) return undefined;
  const {
    providerSessionState: _providerSessionState,
    previousInteractionId: _previousInteractionId,
    ...stateless
  } = options;
  return stateless;
}

function referenceMaxTokensForMetadata(config: GsdMoaConfig, metadata: ReferenceCallMetadata): number | undefined {
  return metadata.role === "synthesizer" ? undefined : metadata.maxTokens ?? config.referenceMaxTokens;
}

function effectiveReferenceCallOptions(config: GsdMoaConfig, route: UpstreamRoute, metadata: ReferenceCallMetadata, options?: SimpleStreamOptions): SimpleStreamOptions {
  const base = streamOptionsForRoute(route, options, config.defaultEffort);
  const referenceMaxTokens = referenceMaxTokensForMetadata(config, metadata);
  return {
    ...base,
    ...(referenceMaxTokens !== undefined ? { maxTokens: referenceMaxTokens } : {}),
  };
}

function referenceStreamOptionsForRoute(config: GsdMoaConfig, route: UpstreamRoute, metadata: ReferenceCallMetadata, options?: SimpleStreamOptions, timeState?: TimeState): { options: SimpleStreamOptions; effectiveTimeoutMs: number; timeoutSignal: AbortSignal } {
  const base = effectiveReferenceCallOptions(config, route, metadata, options);
  const timeBudgetMs = referenceBudgetMs(config.timeAware, timeState);
  const effectiveTimeoutMs = timeBudgetMs === undefined
    ? config.referenceTimeoutMs
    : Math.max(5_000, Math.min(config.referenceTimeoutMs, Math.floor(timeBudgetMs)));
  const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
  const signals = [options?.signal, timeoutSignal].filter((signal): signal is AbortSignal => Boolean(signal));
  return {
    options: {
      ...base,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    },
    effectiveTimeoutMs,
    timeoutSignal,
  };
}

function classifyReferenceMessage(metadata: ReferenceCallMetadata, message: AssistantMessage, text: string, effectiveTimeoutMs: number): { ok: true; text: string } | { ok: false; message: string } {
  if (message.stopReason === "aborted") return { ok: false, message: timeoutFailureMessage(effectiveTimeoutMs) };
  if (message.stopReason === "error") return { ok: false, message: message.errorMessage?.trim() || "reference provider returned an error" };
  if (message.stopReason === "length" && metadata.role !== "synthesizer") {
    if (text.length < 500) return { ok: false, message: "hit token limit" };
    return { ok: true, text: `${text}\n\n[advisory truncated at token limit]` };
  }
  return { ok: true, text };
}

function timeoutFailureMessage(effectiveTimeoutMs: number): string {
  return `timed out after ${formatSeconds(effectiveTimeoutMs)}s (partial output discarded)`;
}

function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1).replace(/\.0$/, "");
}

function referenceFailureDetails(route: UpstreamRoute, key: string, cacheHit: boolean, durationMs: number, usage: Usage | undefined, effort: string | undefined): ReferenceCallFailureDetails {
  return { usage, cacheHit, key, provider: route.provider, model: route.model, durationMs, effort };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
