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
import type { DefaultReasoningEffort, ReasoningEffort, UpstreamRoute } from "./types.js";

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
  const { apiKey: _providerApiKey, ...rest } = options ?? {};
  const headers = Object.fromEntries(
    Object.entries(route.headers ?? {}).map(([key, value]) => [key, resolveConfigValue(value, `route header ${key}`) ?? ""]),
  );
  const resolvedEffort = resolveEffort(route, options, defaultEffort);
  return {
    ...rest,
    ...(resolvedEffort !== undefined ? { reasoning: resolvedEffort } : {}),
    ...(apiKey ? { apiKey } : {}),
    headers: { ...(options?.headers ?? {}), ...headers },
  };
}

function resolveEffort(route: UpstreamRoute, options: SimpleStreamOptions | undefined, defaultEffort: DefaultReasoningEffort): SimpleStreamOptions["reasoning"] | undefined {
  if (route.effort !== undefined) return route.effort as SimpleStreamOptions["reasoning"];
  if (options?.reasoning !== undefined) return options.reasoning;
  const envEffort = parseEnvEffort(process.env.GSD_MOA_EFFORT);
  if (envEffort === "inherit") return undefined;
  if (envEffort !== undefined) return envEffort as SimpleStreamOptions["reasoning"];
  if (defaultEffort === "inherit") return undefined;
  return defaultEffort as SimpleStreamOptions["reasoning"];
}

function parseEnvEffort(value: string | undefined): ReasoningEffort | "inherit" | undefined {
  if (value === undefined) return undefined;
  if (["minimal", "low", "medium", "high", "xhigh", "inherit"].includes(value)) return value as ReasoningEffort | "inherit";
  throw new Error("GSD_MOA_EFFORT must be one of: minimal, low, medium, high, xhigh, inherit");
}
