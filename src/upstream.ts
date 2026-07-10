import {
  completeSimple,
  getModel,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "./pi-compat.js";
import type { ConcreteReasoningEffort, DefaultReasoningEffort, ReasoningEffort, UpstreamRoute } from "./types.js";

export interface UpstreamClient {
  stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  complete(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage>;
}

export const compatUpstreamClient: UpstreamClient = {
  stream: (model, context, options) => streamSimple(model, context, options),
  complete: (model, context, options) => completeSimple(model, context, options),
};

export function routeToModel(route: UpstreamRoute): Model<Api> {
  const builtin = getModel(route.provider as never, route.model) as Model<Api> | undefined;
  return {
    id: route.model,
    name: builtin?.name ?? route.model,
    api: route.api ?? builtin?.api ?? "openai-completions",
    provider: route.provider,
    baseUrl: route.baseUrl ?? builtin?.baseUrl ?? "",
    reasoning: route.reasoning ?? builtin?.reasoning ?? false,
    thinkingLevelMap: route.thinkingLevelMap ?? builtin?.thinkingLevelMap,
    input: route.input ?? builtin?.input ?? ["text"],
    cost: route.cost ?? builtin?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: route.contextWindow ?? builtin?.contextWindow ?? 128000,
    maxTokens: route.maxTokens ?? builtin?.maxTokens ?? 4096,
    headers: route.headers ?? builtin?.headers,
    compat: route.compat ?? builtin?.compat,
  } as Model<Api>;
}

export function resolveConfigValue(value: string | undefined, label = "config value"): string | undefined {
  if (!value) return undefined;
  const envName = value.startsWith("${") && value.endsWith("}")
    ? value.slice(2, -1)
    : value.startsWith("$")
      ? value.slice(1)
      : undefined;
  if (!envName) return value;
  const resolved = process.env[envName];
  if (!resolved) throw new Error(`gsd-moa: environment variable ${envName} referenced by ${label} is not set`);
  return resolved;
}

export function streamOptionsForRoute(route: UpstreamRoute, options?: SimpleStreamOptions, defaultEffort: DefaultReasoningEffort = "high"): SimpleStreamOptions {
  const apiKey = resolveConfigValue(route.apiKey, "route apiKey");
  const { apiKey: _providerApiKey, reasoning: _hostReasoning, ...rest } = options ?? {};
  const headers = Object.fromEntries(
    Object.entries(route.headers ?? {}).map(([key, value]) => [key, resolveConfigValue(value, `route header ${key}`) ?? ""]),
  );
  const resolvedEffort = resolveEffortForRoute(route, options, defaultEffort);
  return {
    ...rest,
    ...(resolvedEffort === "none" ? { omitReasoningEffort: true } : {}),
    ...(resolvedEffort !== undefined && resolvedEffort !== "none" ? { reasoning: resolvedEffort as SimpleStreamOptions["reasoning"] } : {}),
    ...(route.temperature !== undefined ? { temperature: route.temperature } : {}),
    ...(apiKey ? { apiKey } : {}),
    headers: { ...(options?.headers ?? {}), ...headers },
  };
}

export function resolveEffortForRoute(route: UpstreamRoute, options: SimpleStreamOptions | undefined, defaultEffort: DefaultReasoningEffort): ReasoningEffort | undefined {
  if (route.effort !== undefined) return route.effort;
  const envEffort = parseEnvEffort(process.env.GSD_MOA_EFFORT);
  if (envEffort === "none") return "none";
  if (options?.disableReasoning) return undefined;
  if (options?.reasoning !== undefined) {
    return defaultEffort === "none" && envEffort === undefined
      ? "none"
      : options.reasoning as ConcreteReasoningEffort;
  }
  if (envEffort === "inherit") return undefined;
  if (envEffort !== undefined) return envEffort;
  if (defaultEffort === "inherit") return undefined;
  return defaultEffort;
}

export function generationOptionsForRoute(route: UpstreamRoute, options?: SimpleStreamOptions, defaultEffort: DefaultReasoningEffort = "high"): SimpleStreamOptions {
  const resolvedEffort = resolveEffortForRoute(route, options, defaultEffort);
  const { reasoning: _callerReasoning, ...rest } = options ?? {};
  return {
    ...rest,
    ...(resolvedEffort === "none" ? { reasoning: undefined, omitReasoningEffort: true } : {}),
    ...(resolvedEffort !== undefined && resolvedEffort !== "none" ? { reasoning: resolvedEffort as SimpleStreamOptions["reasoning"] } : {}),
    ...(route.temperature !== undefined ? { temperature: route.temperature } : {}),
  } as SimpleStreamOptions;
}

export function generationControlsForCache(options: SimpleStreamOptions): Record<string, unknown> {
  const excluded = new Set([
    "apiKey", "signal", "providerSessionState", "onPayload", "onResponse", "onSseEvent",
    "providerRetryWait", "fetch", "execHandlers", "cursorExecHandlers", "cursorOnToolResult",
  ]);
  const controls: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options).sort(([left], [right]) => left.localeCompare(right))) {
    if (excluded.has(key)) continue;
    const normalized = cacheOptionValue(value, new WeakSet<object>());
    if (normalized !== undefined) controls[key] = normalized;
  }
  return controls;
}

function cacheOptionValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    normalized = value.map((item) => cacheOptionValue(item, seen));
  } else if (value instanceof Date) {
    normalized = value.toISOString();
  } else if (value instanceof Map) {
    normalized = [...value.entries()]
      .map(([key, item]) => [String(key), cacheOptionValue(item, seen)] as const)
      .sort(([left], [right]) => left.localeCompare(right));
  } else if (value instanceof Set) {
    normalized = [...value].map((item) => cacheOptionValue(item, seen)).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  } else {
    const record = value as Record<string, unknown>;
    normalized = Object.fromEntries(
      Object.keys(record).sort().flatMap((key) => {
        const item = cacheOptionValue(record[key], seen);
        return item === undefined ? [] : [[key, item]];
      }),
    );
  }
  seen.delete(value);
  return normalized;
}

export function effortForTrace(options: SimpleStreamOptions | undefined): string | undefined {
  if (!options) return undefined;
  const maybeOmit = options as SimpleStreamOptions & { omitReasoningEffort?: boolean };
  if (maybeOmit.omitReasoningEffort === true && options.reasoning === undefined) return "none";
  return options.reasoning;
}

function parseEnvEffort(value: string | undefined): ReasoningEffort | "inherit" | undefined {
  if (value === undefined) return undefined;
  if (["minimal", "low", "medium", "high", "xhigh", "none", "inherit"].includes(value)) return value as ReasoningEffort | "inherit";
  throw new Error("GSD_MOA_EFFORT must be one of: minimal, low, medium, high, xhigh, none, inherit");
}
