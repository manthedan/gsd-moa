import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRuntime, type Context, type SimpleStreamOptions, type Usage, type UserMessage } from "./pi-compat.js";
import { assistantText, messageText } from "./context.js";
import type { GsdMoaConfig, UpstreamRoute } from "./types.js";
import { effortForTrace, generationControlsForCache, generationOptionsForRoute, resolveConfigValue, routeToModel } from "./upstream.js";

interface CacheEnvelope {
  version: 1;
  createdAt: number;
  expiresAt: number;
  text: string;
  usage?: Usage;
}

export interface AdvisorCacheHit {
  hit: true;
  key: string;
  text: string;
  usage?: Usage;
}

export interface AdvisorCacheMiss {
  hit: false;
  key: string;
  path: string;
}

export type AdvisorCacheResult = AdvisorCacheHit | AdvisorCacheMiss;

export interface ReferenceCacheControls {
  effort?: unknown;
  maxTokens?: unknown;
  temperature?: unknown;
  generation?: unknown;
}

export function advisorCacheKey(config: GsdMoaConfig, context: Context, controls?: ReferenceCacheControls): string {
  const defaults = defaultAdvisorCacheControls(config);
  const merged = { ...defaults, ...controls };
  if (controls && controls.generation === undefined) {
    const generation = { ...(defaults.generation as Record<string, unknown>) };
    if (controls.effort !== undefined) {
      delete generation.reasoning;
      delete generation.omitReasoningEffort;
      if (controls.effort === "none") generation.omitReasoningEffort = true;
      else if (controls.effort !== "inherit") generation.reasoning = controls.effort;
    }
    if (controls.maxTokens !== undefined) generation.maxTokens = controls.maxTokens;
    if (controls.temperature !== undefined) generation.temperature = controls.temperature;
    merged.generation = generation;
  }
  return referenceCacheKey(config, context, config.reference, "advisor", config.prompts.advisorVersion, merged);
}

export function referenceCacheKey(
  config: GsdMoaConfig,
  context: Context,
  route: UpstreamRoute,
  scope: string,
  promptVersion: string,
  controls?: ReferenceCacheControls,
): string {
  const payload = {
    promptVersion,
    scope,
    // Hash the complete non-secret model/request identity. Compatibility flags,
    // feature headers, capabilities, and future serializable route fields can all
    // change provider behavior even when provider/model names stay constant.
    reference: effectiveRouteForCache(route),
    taskDigest: normalizeContext(context),
    controls: {
      ...(controls && controls.effort !== undefined ? { effort: controls.effort } : {}),
      ...(controls && controls.maxTokens !== undefined ? { maxTokens: controls.maxTokens } : {}),
      ...(controls && controls.temperature !== undefined ? { temperature: controls.temperature } : {}),
      ...(controls && controls.generation !== undefined ? { generation: controls.generation } : {}),
    },
    auto: config.auto,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function readAdvisorCache(config: GsdMoaConfig, context: Context, cwd = process.cwd(), controls?: ReferenceCacheControls): AdvisorCacheResult {
  return readCacheByKey(config, advisorCacheKey(config, context, controls), cwd);
}

export function readReferenceCache(
  config: GsdMoaConfig,
  context: Context,
  route: UpstreamRoute,
  scope: string,
  cwd = process.cwd(),
): AdvisorCacheResult {
  return readCacheByKey(config, referenceCacheKey(config, context, route, scope, config.prompts.fullMoaVersion), cwd);
}

export function readCacheByKey(config: GsdMoaConfig, key: string, cwd: string): AdvisorCacheResult {
  const path = cachePath(config, key, cwd);
  if (!config.cache.enabled || !existsSync(path)) return { hit: false, key, path };

  try {
    const envelope = JSON.parse(readFileSync(path, "utf8")) as CacheEnvelope;
    if (envelope.version !== 1 || envelope.expiresAt < Date.now()) {
      unlinkCacheFile(path);
      return { hit: false, key, path };
    }
    return { hit: true, key, text: envelope.text, usage: envelope.usage };
  } catch {
    unlinkCacheFile(path);
    return { hit: false, key, path };
  }
}

export function writeAdvisorCache(
  config: GsdMoaConfig,
  key: string,
  text: string,
  usage: Usage | undefined,
  cwd = process.cwd(),
): void {
  if (!config.cache.enabled || !text.trim()) return;
  const path = cachePath(config, key, cwd);
  mkdirSync(resolve(cwd, config.cache.dir), { recursive: true, mode: 0o700 });
  const envelope: CacheEnvelope = {
    version: 1,
    createdAt: Date.now(),
    expiresAt: Date.now() + config.cache.ttlSeconds * 1000,
    text,
    usage,
  };
  const temporaryPath = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(envelope, null, 2), { mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkCacheFile(temporaryPath);
  }
}

function effectiveRouteForCache(route: UpstreamRoute): Record<string, unknown> {
  const resolvedModel = routeToModel(route);
  const configuredHeaders = resolveRouteHeaders(route.headers);
  const resolvedHeaders = resolveRouteHeaders(resolvedModel.headers as Record<string, string> | undefined);
  return {
    runtime: getRuntime(),
    configured: generationControlsForCache({
      ...route,
      ...(route.headers ? { headers: configuredHeaders } : {}),
    } as unknown as SimpleStreamOptions),
    model: generationControlsForCache({
      ...resolvedModel,
      ...(resolvedModel.headers ? { headers: resolvedHeaders } : {}),
    } as unknown as SimpleStreamOptions),
  };
}

function resolveRouteHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key, resolveConfigValue(value, `route header ${key}`) ?? ""]),
  );
}

function defaultAdvisorCacheControls(config: GsdMoaConfig): ReferenceCacheControls {
  const inheritedMaxTokens = routeToModel(config.reference).maxTokens;
  const effective: SimpleStreamOptions = {
    ...generationOptionsForRoute(config.reference, undefined, config.defaultEffort),
    ...(config.referenceMaxTokens !== undefined
      ? { maxTokens: config.referenceMaxTokens }
      : config.reference.maxTokens !== undefined
        ? { maxTokens: config.reference.maxTokens }
        : typeof inheritedMaxTokens === "number"
          ? { maxTokens: inheritedMaxTokens }
          : {}),
  };
  const effort = effortForTrace(effective);
  return {
    ...(effort !== undefined ? { effort } : {}),
    ...(effective.maxTokens !== undefined ? { maxTokens: effective.maxTokens } : {}),
    ...(effective.temperature !== undefined ? { temperature: effective.temperature } : {}),
    generation: generationControlsForCache(effective),
  };
}

function cachePath(config: GsdMoaConfig, key: string, cwd: string): string {
  return join(resolve(cwd, config.cache.dir), `${key}.json`);
}

function unlinkCacheFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Cache cleanup should never make a cache miss fail.
  }
}

function normalizeUserMessage(message: UserMessage): string {
  if (typeof message.content === "string") return messageText(message);
  return message.content.map((item) => {
    if (item.type === "text") return item.text;
    if (item.type === "image") {
      const { data: rawData, ...metadata } = item as typeof item & { data?: unknown };
      const digest = createHash("sha256").update(String(rawData ?? "")).digest("hex").slice(0, 24);
      const normalizedMetadata = generationControlsForCache(metadata as unknown as SimpleStreamOptions);
      return `[image:${JSON.stringify({ ...normalizedMetadata, digest })}]`;
    }
    return "[content]";
  }).join("\n");
}

function normalizeContext(context: Context): string {
  // Cache identity must be lossless for model-visible text. Truncating history or
  // collapsing whitespace can alias different tasks (especially indentation-
  // sensitive code) and return guidance generated for another conversation.
  return JSON.stringify({
    systemPrompt: context.systemPrompt ?? null,
    messages: context.messages.map((msg) => {
      if (msg.role === "user") return { role: msg.role, content: normalizeUserMessage(msg) };
      if (msg.role === "assistant") return { role: msg.role, content: assistantText(msg) };
      if (msg.role === "developer") {
        return {
          role: msg.role,
          content: typeof msg.content === "string"
            ? msg.content
            : msg.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n"),
        };
      }
      return {
        role: msg.role,
        toolName: msg.toolName,
        content: msg.content.map((item) => item.type === "text" ? item.text : "[image]").join("\n"),
      };
    }),
  });
}
